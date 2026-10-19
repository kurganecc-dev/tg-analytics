#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка отчёта для сервиса TG Analytics.

    python3 scripts/build_report.py выгрузка.jsonl [ещё.jsonl ...]
        → data/report-data.json (сервис подхватит его автоматически)

    python3 scripts/build_report.py --embed --out report.html выгрузка.jsonl
        → один самодостаточный HTML-файл (данные и скрипты внутри), работает по file://

Формат входа: JSONL, одна запись на пост:
    {"channel","post_id","text","date","views","reactions","url"}
Токены erid в текстах заменяются на [REDACTED].
"""
import json, os, re, sys, argparse, html, base64

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ERID = re.compile(r'((?:erid|токен)\s*[:=]?\s*)([A-Za-z0-9_\-]{6,})', re.I)
REQUIRED = ('post_id', 'text', 'date')


def redact(text: str) -> str:
    return ERID.sub(r'\1[REDACTED]', text or '')


def load(path: str, name=None):
    posts, bad = [], 0
    with open(path, encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if not any(k in r for k in REQUIRED):
                bad += 1
                continue
            text = redact(str(r.get('text', '')))
            posts.append({
                'channel': r.get('channel') or name or os.path.basename(path),
                'post_id': r.get('post_id', r.get('id')),
                'text': text,
                'date': r.get('date'),
                'views': int(r.get('views') or 0),
                'reactions': int(r.get('reactions') or 0),
                'url': r.get('url') or '',
            })
    posts.sort(key=lambda p: (p.get('date') or ''))
    return posts, bad


def main():
    ap = argparse.ArgumentParser(description='Сборка данных и HTML-отчёта TG Analytics')
    ap.add_argument('files', nargs='+', help='выгрузки .jsonl (или .json со массивом постов)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'report-data.json'),
                    help='куда писать (по умолчанию data/report-data.json)')
    ap.add_argument('--embed', action='store_true',
                    help='собрать самодостаточный HTML со вшитыми данными и скриптами')
    ap.add_argument('--name', help='имя канала для одиночного файла (иначе из данных)')
    ap.add_argument('--subs', type=int, help='число подписчиков — попадёт в отчёт (можно переопределить в интерфейсе)')
    args = ap.parse_args()

    datasets = []
    for path in args.files:
        name = args.name if (args.name and len(args.files) == 1) else None
        if path.endswith('.json'):
            data = json.load(open(path, encoding='utf-8'))
            if isinstance(data, dict) and 'posts' in data:
                posts = data['posts']
                name = name or data.get('channel')
            else:
                posts = data
            posts = [{**p, 'text': redact(str(p.get('text', '')))} for p in posts]
            bad = 0
        else:
            posts, bad = load(path, name)
        if not posts:
            print(f'!! {path}: постов не найдено', file=sys.stderr)
            continue
        datasets.append({
            'name': name or posts[0]['channel'] or os.path.basename(path),
            'source': os.path.abspath(path),
            'count': len(posts),
            'bad_lines': bad,
            'subs': args.subs or 0,
            'posts': posts,
        })
        print(f'{path}: {len(posts)} постов' + (f', битых строк {bad}' if bad else ''))

    if not datasets:
        print('нет данных для отчёта', file=sys.stderr)
        return 1

    if not args.embed:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump({'datasets': [{k: v for k, v in d.items() if k != 'source'} for d in datasets]},
                      f, ensure_ascii=False)
        size = os.path.getsize(args.out) / 1024
        print(f'→ {args.out} ({size:.0f} КБ). Запустите сервис: python3 -m http.server 8000 и откройте http://localhost:8000/')
        return 0

    # --- самодостаточный HTML ---
    idx = os.path.join(ROOT, 'index.html')
    html_doc = open(idx, encoding='utf-8').read()
    css = open(os.path.join(ROOT, 'assets', 'styles.css'), encoding='utf-8').read()
    xp_css = open(os.path.join(ROOT, 'assets', 'xp.css'), encoding='utf-8').read()
    # шрифт вшиваем в CSS: по file:// соседний файл не загрузится
    font = os.path.join(ROOT, 'assets', 'fonts', 'monocraft-subset.woff2')
    if os.path.exists(font):
        b64 = base64.b64encode(open(font, 'rb').read()).decode()
        xp_css = xp_css.replace("url('fonts/monocraft-subset.woff2') format('woff2')",
                                f"url(data:font/woff2;base64,{b64}) format('woff2')")
    css = css + '\n' + xp_css
    js = '\n'.join(open(os.path.join(ROOT, 'assets', n), encoding='utf-8').read()
                   for n in ('analytics.js', 'analytics2.js', 'compete.js', 'scoring.js', 'charts.js', 'app.js', 'xp.js'))
    payload = json.dumps(datasets[0]['posts'], ensure_ascii=False).replace('</', '<\\/')
    name = datasets[0]['name']

    html_doc = (html_doc
                .replace('<link rel="stylesheet" href="assets/styles.css">', f'<style>\n{css}\n</style>')
                .replace('<link rel="stylesheet" href="assets/xp.css">\n', ''))
    scripts = ('<script src="assets/analytics.js"></script>\n'
               '<script src="assets/analytics2.js"></script>\n'
               '<script src="assets/compete.js"></script>\n'
               '<script src="assets/scoring.js"></script>\n'
               '<script src="assets/charts.js"></script>\n'
               '<script src="assets/app.js"></script>\n'
               '<script src="assets/xp.js"></script>')
    embedded = (f'<script id="embedded-data" data-name="{html.escape(name)}" '
                f'data-subs="{datasets[0].get("subs") or 0}" '
                f'type="application/json">{payload}</script>\n<script>\n{js}\n</script>')
    html_doc = html_doc.replace(scripts, embedded)
    if args.out.endswith('.json'):
        args.out = os.path.join(ROOT, 'report.html')
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(html_doc)
    print(f'→ {args.out} ({os.path.getsize(args.out)/1024/1024:.1f} МБ) — открывается двойным кликом, без сервера')
    return 0


if __name__ == '__main__':
    sys.exit(main())
