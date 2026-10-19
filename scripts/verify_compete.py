#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Независимая проверка сравнения каналов: те же расчёты на Python против движка в Node.

    python3 scripts/verify_compete.py corpus_A.jsonl corpus_B.jsonl

Сверяет: общий период, профили каналов, таблицу «лицом к лицу» (U-критерий, размер эффекта,
z-тест для долей), перцентили. Числа должны совпадать до 1e-6.
"""
import argparse, json, math, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from verify_deep import median, percentile, mann_whitney_u, normal_cdf  # noqa: E402

EMO = re.compile('[\U0001F000-\U0001FAFF\u2600-\u27BF\U0001F1E6-\U0001F1FF\u2190-\u21FF\u2B00-\u2BFF\uFE0F\u203C\u2049\u20E3\u2B50\u2B55]')
SOURCE = re.compile(r'по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик', re.I)
CTA = re.compile(r'подписывайт|по ссылк|оставляйт[а-яё]* заявк|листайт', re.I)
HYPE = re.compile(r'шок|сенсаци|уникальный шанс|вы не поверите', re.I)


def load(path):
    posts = []
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        posts.append({'post_id': r['post_id'], 'text': r['text'], 'date': r['date'],
                      'views': int(r.get('views') or 0), 'reactions': int(r.get('reactions') or 0)})
    return posts


def period(posts):
    ds = sorted(p['date'] for p in posts if p['date'])
    return (ds[0][:10], ds[-1][:10]) if ds else (None, None)


def channel_stats(posts):
    with_v = [p for p in posts if p['views'] > 0]
    views = [p['views'] for p in with_v]
    react = [p['reactions'] for p in posts]
    from_date, to_date = period(posts)
    days = 1.0
    if from_date:
        import datetime
        d1 = datetime.datetime.fromisoformat(from_date)
        d2 = datetime.datetime.fromisoformat(to_date)
        days = max(1.0, (d2 - d1).total_seconds() / 86400)
    share = lambda f: 100 * sum(1 for p in posts if f(p['text'])) / (len(posts) or 1)
    return {
        'posts': len(posts),
        'perWeek': (len(posts) / days) * 7,
        'viewsMedian': median(views),
        'viewsP90': percentile(views, 90),
        'reactPerPost': (sum(react) / len(posts)) if posts else 0,
        'erByViews': (100 * sum(react) / sum(views)) if views else 0,
        'charsMedian': median([len(p['text']) for p in posts]),
        'emojiMedian': median([len(EMO.findall(p['text'])) for p in posts]),
        'quoteShare': share(lambda t: '«' in t),
        'sourceShare': share(lambda t: bool(SOURCE.search(t))),
        'ctaShare': share(lambda t: bool(CTA.search(t))),
        'linkShare': share(lambda t: bool(re.search(r'https?://', t))),
        'hypeShare': share(lambda t: bool(HYPE.search(t))),
    }


def proportions_test(k1, n1, k2, n2):
    p1, p2 = k1 / n1, k2 / n2
    pool = (k1 + k2) / (n1 + n2)
    se = math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2))
    z = (p1 - p2) / se if se else 0
    return {'p': 2 * (1 - normal_cdf(abs(z))), 'delta': p1 - p2}


def metric_row(name, a, b, kind, a_value=None, b_value=None, higher_better=True):
    if kind == 'proportion':
        k1, k2 = sum(1 for x in a if x), sum(1 for x in b if x)
        t = proportions_test(k1, len(a), k2, len(b))
        va, vb = 100 * k1 / len(a), 100 * k2 / len(b)
        diff, p, eff = t['delta'] * 100, t['p'], t['delta']
    else:
        t = mann_whitney_u(a, b)
        va = a_value if a_value is not None else median(a)
        vb = b_value if b_value is not None else median(b)
        diff = ((va - vb) / vb * 100) if vb else 0
        p, eff = t['p'], t['cliff']
    significant = p is not None and p < 0.05 and eff is not None and abs(eff) >= 0.1
    if p is None:
        verdict = 'мало данных'
    elif p >= 0.05:
        verdict = 'не доказано'
    elif abs(eff) < 0.1:
        verdict = 'различие мало'
    elif higher_better is None:
        verdict = 'A больше' if va > vb else 'B больше'
    else:
        verdict = 'A лучше' if (va > vb) == higher_better else 'B лучше'
    return {'name': name, 'kind': kind, 'a': va, 'b': vb, 'diffPct': diff, 'p': p,
            'effect': eff, 'significant': significant, 'verdict': verdict}


def head_to_head(posts_a, posts_b):
    with_a = [p for p in posts_a if p['views'] > 0]
    with_b = [p for p in posts_b if p['views'] > 0]
    vA = [p['views'] for p in with_a]
    vB = [p['views'] for p in with_b]
    emoA = [len(EMO.findall(p['text'])) for p in posts_a]
    emoB = [len(EMO.findall(p['text'])) for p in posts_b]
    return [
        metric_row('Медиана просмотров', vA, vB, 'number'),
        metric_row('Средние просмотры', vA, vB, 'number',
                   a_value=sum(vA) / len(vA), b_value=sum(vB) / len(vB)),
        metric_row('P90 просмотров', vA, vB, 'number',
                   a_value=percentile(vA, 90), b_value=percentile(vB, 90)),
        metric_row('Медиана реакций', [p['reactions'] for p in posts_a], [p['reactions'] for p in posts_b], 'number'),
        metric_row('ER поста (медиана), %',
                   [100 * p['reactions'] / p['views'] for p in with_a],
                   [100 * p['reactions'] / p['views'] for p in with_b], 'number'),
        metric_row('Длина поста, знаков', [len(p['text']) for p in posts_a], [len(p['text']) for p in posts_b],
                   'number', higher_better=None),
        metric_row('Эмодзи на пост', emoA, emoB, 'number', higher_better=None),
        metric_row('Постов с источником', [bool(SOURCE.search(p['text'])) for p in posts_a],
                   [bool(SOURCE.search(p['text'])) for p in posts_b], 'proportion'),
        metric_row('Постов с «ёлочками»', ['«' in p['text'] for p in posts_a],
                   ['«' in p['text'] for p in posts_b], 'proportion'),
        metric_row('Постов с призывом', [bool(CTA.search(p['text'])) for p in posts_a],
                   [bool(CTA.search(p['text'])) for p in posts_b], 'proportion'),
        metric_row('Постов с внешней ссылкой', [bool(re.search(r'https?://', p['text'])) for p in posts_a],
                   [bool(re.search(r'https?://', p['text'])) for p in posts_b], 'proportion'),
    ]


def close(a, b, tol=1e-6):
    if a is None or b is None:
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tol * max(1.0, abs(a), abs(b))
    return a == b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a')
    ap.add_argument('b')
    args = ap.parse_args()

    r = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'node_harness.js'), args.a, '--compete', args.b],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:])
        return 1
    js = json.loads(r.stdout)
    A, B = load(args.a), load(args.b)
    from_date = max(period(A)[0], period(B)[0])
    to_date = min(period(A)[1], period(B)[1])
    pA = [p for p in A if from_date <= p['date'][:10] <= to_date]
    pB = [p for p in B if from_date <= p['date'][:10] <= to_date]

    errs = []
    exp_overlap = {'from': from_date, 'to': to_date, 'nA': len(pA), 'nB': len(pB)}
    if js['overlap'] != exp_overlap:
        errs.append(f"общий период: JS {js['overlap']} != Python {exp_overlap}")
    for key, py_stats in (('statsA', channel_stats(pA)), ('statsB', channel_stats(pB))):
        for k, v in py_stats.items():
            jv = js[key].get(k)
            if not close(jv, v):
                errs.append(f'{key}.{k}: JS {jv!r} != Python {v!r}')
    py_h2h = head_to_head(pA, pB)
    js_h2h = {row['name']: row for row in js['headToHead']}
    if len(py_h2h) != len(js_h2h):
        errs.append(f'лицом к лицу: строк JS {len(js_h2h)} != Python {len(py_h2h)}')
    for row in py_h2h:
        jr = js_h2h.get(row['name'])
        if not jr:
            errs.append(f"нет строки {row['name']} в JS")
            continue
        for k, v in row.items():
            if k in ('a', 'b') and abs(v) < 0.01 and abs(jr.get(k, 0)) < 0.01:
                continue                      # p-значения вида 0 / 1e-300 сравниваем отдельно
            if k == 'p' and v is not None and jr.get('p') == 0 and v < 1e-12:
                continue
            if not close(jr.get(k), v):
                errs.append(f"{row['name']}.{k}: JS {jr.get(k)!r} != Python {v!r}")
    for key, pixels in (('pctA', percentile_table(pA)), ('pctB', percentile_table(pB))):
        for k, v in pixels.items():
            if not close(js[key].get(k), v):
                errs.append(f'{key}.{k}: JS {js[key].get(k)!r} != Python {v!r}')

    if errs:
        print(f'РАСХОЖДЕНИЙ: {len(errs)}')
        for e in errs[:25]:
            print('  ', e)
        return 2
    print(f'сравнение A/B проверено: {len(pA)} × {len(pB)} постов за общий период {from_date} → {to_date}')
    print('совпали: общий период, профили каналов, U-критерий и размеры эффекта, z-тесты для долей, перцентили')
    return 0


def percentile_table(posts):
    v = [p['views'] for p in posts if p['views'] > 0]
    return {'n': len(v), 'p10': percentile(v, 10), 'p25': percentile(v, 25), 'p50': median(v),
            'p75': percentile(v, 75), 'p90': percentile(v, 90), 'max': max(v) if v else 0}


if __name__ == '__main__':
    sys.exit(main())
