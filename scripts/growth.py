#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Скорость набора просмотров по замерам (нужно ≥2 снимка в data/snapshots/<канал>.jsonl).

    python3 scripts/growth.py nedvij_etagi            # сводка в консоль
    python3 scripts/growth.py nedvij_etagi --json     # машинный вид (для сервиса)

Считает по каждому посту, который есть в двух и более замерах:
  • Δпросмотров и Δвремени, просмотров в сутки;
  • долю прироста от текущего значения (насколько пост «ещё живой»);
  • для пар «старый → новый» замер — прирост по возрастным группам и оценку
    времени насыщения τ в модели V(t) = V∞ · (1 − e^(−t/τ)) (сеточный подбор).
"""
import argparse, json, math, os, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from snapshot import load_snapshots  # noqa: E402


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def median(v):
    if not v:
        return 0
    s = sorted(v)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def growth(channel):
    rows = load_snapshots(channel)
    if not rows:
        return {'error': f'нет замеров для {channel}: сначала scripts/snapshot.py'}
    by_post = {}
    for r in rows:
        by_post.setdefault(r['post_id'], []).append(r)
    stamps = sorted({r['taken_at'] for r in rows})
    pairs = []
    for pid, lst in by_post.items():
        lst.sort(key=lambda r: r['taken_at'])
        first, last = lst[0], lst[-1]
        t0, t1 = parse_ts(first['taken_at']), parse_ts(last['taken_at'])
        if t0 is None or t1 is None or t1 - t0 < 3600:            # меньше часа — шум
            continue
        dt_days = (t1 - t0) / 86400
        d_views = last['views'] - first['views']
        pub = parse_ts(last.get('date') or '')
        age_days = ((t1 - pub) / 86400) if pub else None
        pairs.append({
            'post_id': pid,
            'views_first': first['views'], 'views_last': last['views'],
            'views_added': d_views, 'per_day': d_views / dt_days,
            'dt_days': dt_days,
            'share_gained': (d_views / last['views'] * 100) if last['views'] else 0,
            'age_days': age_days,
            'date': last.get('date', ''),
        })
    pairs.sort(key=lambda p: -p['per_day'])
    buckets = {}
    for p in pairs:
        if p['age_days'] is None:
            continue
        a = p['age_days']
        key = '0–1 сут' if a <= 1 else '1–3 сут' if a <= 3 else '3–7 сут' if a <= 7 else '7–30 сут' if a <= 30 else '30+ сут'
        buckets.setdefault(key, []).append(p['per_day'])
    order = ['0–1 сут', '1–3 сут', '3–7 сут', '7–30 сут', '30+ сут']
    bucket_stats = [{'bucket': k, 'n': len(v), 'perDayMedian': median(v)} for k, v in buckets.items() if v]
    bucket_stats.sort(key=lambda b: order.index(b['bucket']) if b['bucket'] in order else 99)

    growing = [p for p in pairs if p['views_added'] >= 1]
    growth_stop_age = max((p['age_days'] for p in growing if p['age_days']), default=None)
    # оценка τ только по постам, которые ещё растут: иначе модель не идентифицируется
    # (у насыщенных постов первый и второй замер совпадают — любое τ подходит)
    tau = None
    pts = [p for p in growing if p['age_days'] and p['age_days'] > 0 and p['views_last'] > 0]
    if len(pts) >= 10:
        best = None
        for tau_h in range(2, 24 * 30, 2):                       # 2 часа … 30 суток
            t_c = tau_h / 24
            err = 0
            for p in pts:
                pred = p['views_last'] * (1 - math.exp(-p['age_days'] / t_c))
                err += abs(pred - p['views_first']) / max(1, p['views_last'])
            if best is None or err < best[1]:
                best = (t_c, err)
        tau = {'days': best[0], 'hours': best[0] * 24, 'relativeError': best[1] / len(pts), 'posts': len(pts),
               'reliable': best[0] > 0.25,
               'note': 'модель V(t) = V∞(1 − e^(−t/τ)) по постам, которые ещё растут; '
                       'τ — время, за которое набирается 63 % итоговых просмотров'}
    elif growing:
        tau = {'reliable': False, 'posts': len(pts),
               'note': f'растущих постов всего {len(growing)} — для оценки τ нужно минимум 10; '
                       'помогут ежедневные замеры (scripts/snapshot.py) на свежих постах'}
    return {
        'channel': channel, 'snapshots': len(stamps), 'from': stamps[0], 'to': stamps[-1],
        'posts': len(by_post), 'pairs': len(pairs),
        'growing': len(growing), 'growingShare': (100 * len(growing) / len(pairs)) if pairs else 0,
        'perDayMedian': median([p['per_day'] for p in growing]) if growing else 0,
        'perDayMedianAll': median([p['per_day'] for p in pairs]),
        'shareGainedMedian': median([p['share_gained'] for p in growing]) if growing else 0,
        'growthStopAge': growth_stop_age,
        'windowHours': (parse_ts(stamps[-1]) - parse_ts(stamps[0])) / 3600 if len(stamps) > 1 else 0,
        'buckets': bucket_stats, 'tau': tau,
        'top': pairs[:15],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('channel')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    g = growth(args.channel)
    if args.json:
        json.dump(g, sys.stdout, ensure_ascii=False)
        return 0 if 'error' not in g else 1
    if 'error' in g:
        print(g['error'], file=sys.stderr)
        return 1
    print(f"{g['channel']}: замеров {g['snapshots']} ({g['from']} → {g['to']}), постов в сравнении {g['pairs']}")
    print(f"  окно наблюдения: {g['windowHours']:.1f} ч · растут {g['growing']} из {g['pairs']} постов ({g['growingShare']:.0f} %)")
    print(f"  скорость растущих: {g['perDayMedian']:.1f} просмотров в сутки (медиана прироста {g['shareGainedMedian']:.1f} % от текущих)")
    if g['growthStopAge'] is not None:
        print(f"  прирост прекращается примерно к {g['growthStopAge']:.1f} сут после публикации")
    if g['tau'] and not g['tau'].get('reliable', True):
        print(f"  насыщение: {g['tau']['note']}")
    if g['buckets']:
        print('  по возрасту поста:')
        for b in g['buckets']:
            print(f"    {b['bucket']:>8}: {b['perDayMedian']:.1f} просм./сут (n = {b['n']})")
    if g['tau'] and g['tau'].get('reliable'):
        print(f"  насыщение: τ ≈ {g['tau']['hours']:.0f} ч ({g['tau']['days']:.1f} сут) по {g['tau']['posts']} растущим постам, "
              f"относительная ошибка {g['tau']['relativeError']:.3f}")
    print('  самые быстрорастущие:')
    for p in g['top'][:5]:
        print(f"    #{p['post_id']} +{p['views_added']} ({p['per_day']:.1f}/сут) за {p['dt_days']:.2f} сут, "
              f"возраст {p['age_days']:.1f} сут" if p['age_days'] else '')
    return 0


if __name__ == '__main__':
    sys.exit(main())
