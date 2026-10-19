#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Замеры канала: копим снимки просмотров и реакций во времени, чтобы считать скорость набора.

    python3 scripts/snapshot.py https://t.me/канал          # замер сейчас (публичное превью)
    python3 scripts/snapshot.py --from-jsonl corpus.jsonl --taken-at 2026-10-16T20:00
    python3 scripts/snapshot.py --list                      # что уже накоплено

Каждый запуск дописывает строки в data/snapshots/<канал>.jsonl:
    {"taken_at": "...", "post_id": 123, "views": 456, "reactions": 12, "date": "публикация"}
Два и более замера с разницей во времени → scripts/growth.py считает скорость:
просмотры в сутки, долю набранного между замерами и оценку времени насыщения.

Ставить на ежедневный cron (или запускать руками) — тогда через неделю будет видно,
какие рубрики набирают охват быстро, а какие «умирают» в первые сутки.
"""
import argparse, json, os, sys, time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from fetch_channel import fetch_channel, normalize_channel, FetchError  # noqa: E402

SNAP_DIR = os.path.join(ROOT, 'data', 'snapshots')


def snap_path(channel):
    return os.path.join(SNAP_DIR, f'{channel}.jsonl')


def load_snapshots(channel):
    path = snap_path(channel)
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def append_snapshot(channel, rows, taken_at):
    os.makedirs(SNAP_DIR, exist_ok=True)
    with open(snap_path(channel), 'a', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps({'taken_at': taken_at, 'post_id': r['post_id'],
                                'views': r['views'], 'reactions': r['reactions'],
                                'date': r.get('date', '')}, ensure_ascii=False) + '\n')


def main():
    ap = argparse.ArgumentParser(description='Замер просмотров канала')
    ap.add_argument('channel', nargs='?', help='ссылка на канал (или имя, если есть файл выгрузки)')
    ap.add_argument('--from-jsonl', help='взять замер из архивной выгрузки')
    ap.add_argument('--taken-at', help='момент замера для --from-jsonl (ISO, по умолчанию — mtime файла)')
    ap.add_argument('--months', type=int, default=6, help='глубина для ссылки: месяцев')
    ap.add_argument('--max-posts', type=int, default=200)
    ap.add_argument('--list', action='store_true', help='показать, что уже собрано')
    args = ap.parse_args()

    if args.list:
        if not os.path.isdir(SNAP_DIR):
            print('замеров пока нет')
            return 0
        for fn in sorted(os.listdir(SNAP_DIR)):
            if not fn.endswith('.jsonl'):
                continue
            channel = fn[:-6]
            rows = load_snapshots(channel)
            stamps = sorted({r['taken_at'] for r in rows})
            print(f'{channel}: замеров {len(stamps)}, постов {len({r["post_id"] for r in rows})}')
            for s in stamps:
                n = sum(1 for r in rows if r['taken_at'] == s)
                print(f'   {s}  ({n} постов)')
        return 0

    if not args.channel:
        ap.error('нужна ссылка на канал или --list')

    if args.from_jsonl:
        channel = normalize_channel(args.channel) if args.channel else os.path.basename(args.from_jsonl).split('.')[0]
        taken_at = args.taken_at or datetime.fromtimestamp(
            os.path.getmtime(args.from_jsonl), tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        rows = [json.loads(l) for l in open(args.from_jsonl, encoding='utf-8') if l.strip()]
    else:
        channel = normalize_channel(args.channel)
        try:
            rows = fetch_channel(channel, months=args.months, max_posts=args.max_posts, delay=0.6)
        except FetchError as e:
            print(f'ошибка: {e}', file=sys.stderr)
            return 1
        taken_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    rows = [r for r in rows if r.get('text', '').strip() or args.from_jsonl]
    append_snapshot(channel, rows, taken_at)
    total = load_snapshots(channel)
    stamps = sorted({r['taken_at'] for r in total})
    print(f'{channel}: замер {taken_at} записан, постов {len(rows)}')
    print(f'всего замеров: {len(stamps)}' + ('' if len(stamps) > 1 else ' — нужен второй, чтобы посчитать скорость'))
    if len(stamps) > 1:
        print('посчитать скорость: python3 scripts/growth.py ' + channel)
    return 0


if __name__ == '__main__':
    sys.exit(main())
