#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локальный сервер сервиса: статика + загрузка канала по ссылке.

    python3 scripts/serve.py                 # → http://127.0.0.1:8000
    python3 scripts/serve.py --port 9000
    python3 scripts/serve.py --host 0.0.0.0  # если нужно открыть с телефона в той же сети

Что умеет сверх статики:
    GET /api/channel?url=<ссылка>&months=12&max_posts=150
        скачивает публичные посты канала через t.me/s/<канал> и отдаёт JSON для дашборда.
Ручной ввод подписчиков и все расчёты остаются в браузере — сервер только скачивает и раздаёт файлы.
"""
import argparse, json, os, re, sys, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from fetch_channel import fetch_channel, normalize_channel, FetchError  # noqa: E402
from growth import growth  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    server_version = 'TG-Analytics/1.0'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '/api/' in (self.path or ''):
            sys.stderr.write(f'[{self.log_date_time_string()}] {fmt % args}\n')

    def _json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ('/api/channel', '/api/channel/'):
            return self.api_channel(parse_qs(parsed.query))
        if parsed.path in ('/api/growth', '/api/growth/'):
            return self.api_growth(parse_qs(parsed.query))
        if parsed.path in ('/api/snapshots', '/api/snapshots/'):
            return self.api_snapshots()
        if parsed.path == '/api/health':
            return self._json({'ok': True, 'root': ROOT})
        return super().do_GET()

    def api_growth(self, q):
        channel = (q.get('channel') or [''])[0].strip().lstrip('@').lower()
        for part in ('https://t.me/', 'http://t.me/', 't.me/', 'https://telegram.me/'):
            channel = channel.replace(part, '')
        channel = channel.split('/')[0]
        if not channel:
            return self._json({'error': 'не указан канал'}, 400)
        g = growth(channel)
        return self._json(g, 200 if 'error' not in g else 404)

    def api_snapshots(self):
        from snapshot import load_snapshots, SNAP_DIR
        out = []
        if os.path.isdir(SNAP_DIR):
            for fn in sorted(os.listdir(SNAP_DIR)):
                if not fn.endswith('.jsonl'):
                    continue
                ch = fn[:-6]
                rows = load_snapshots(ch)
                out.append({'channel': ch, 'snapshots': sorted({r['taken_at'] for r in rows}),
                            'posts': len({r['post_id'] for r in rows}), 'rows': len(rows)})
        return self._json({'snapshots': out})

    def api_channel(self, q):
        raw = (q.get('url') or q.get('channel') or [''])[0]
        try:
            months = max(0, min(120, int((q.get('months') or ['12'])[0])))
        except ValueError:
            months = 12
        try:
            # 0 = без потолка: глубину истории задаёт months. Раньше здесь молча стояло 150 постов,
            # из-за чего канал любой длины скачивался примерно за 2–3 месяца
            max_posts = max(0, min(20000, int((q.get('max_posts') or ['0'])[0])))
        except ValueError:
            max_posts = 0
        if not raw.strip():
            return self._json({'error': 'не указана ссылка на канал'}, 400)
        # ссылки-инвайты (+hash): веб-превью у них нет, и в query-строке «+» декодируется в пробел
        if '+' in raw or re.search(r't\.me/\s', raw):
            return self._json({'error': 'приватные ссылки-приглашения (t.me/+hash) веб-превью не отдают — '
                                       'нужна обычная публичная ссылка вида https://t.me/имя_канала'}, 400)
        try:
            channel = normalize_channel(raw)
        except FetchError as e:
            return self._json({'error': str(e)}, 400)
        try:
            posts = fetch_channel(channel, months=months, max_posts=max_posts,
                                  delay=0.6, progress=lambda m: sys.stderr.write(f'  {m}\n'))
        except FetchError as e:
            return self._json({'error': f'не удалось скачать «{channel}»: {e}'}, 502)
        with_text = [p for p in posts if p['text'].strip()]
        if not with_text:
            return self._json({'error': f'«{channel}»: публичных постов с текстом не нашлось. '
                                       f'Канал не существует, закрыт, приватный или у него отключено веб-превью'}, 404)
        self._json({
            'name': channel,
            'count': len(with_text),
            'max_posts': max_posts,
            'capped': bool(max_posts) and len(posts) >= max_posts,
            'media_only': len(posts) - len(with_text),
            'months': months,
            'period': [with_text[0]['date'][:10], with_text[-1]['date'][:10]],
            'posts': with_text,
        })


def main():
    ap = argparse.ArgumentParser(description='Локальный сервер TG Analytics')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f'http://{"127.0.0.1" if args.host in ("0.0.0.0", "") else args.host}:{args.port}/'
    print(f'TG Analytics → {url}')
    if args.host in ('0.0.0.0', ''):
        # сервер открыт для сети: показываем адрес, по которому до него дойдут телефон и другой компьютер
        import socket
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(('8.8.8.8', 80))
            lan = probe.getsockname()[0]
            probe.close()
            if lan and not lan.startswith('127.'):
                print(f'В локальной сети → http://{lan}:{args.port}/  (загрузка по ссылке работает)')
        except Exception:
            pass
    print('Ссылка на канал работает прямо в интерфейсе (сервер скачает публичные посты).')
    print('Остановить: Ctrl+C')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nостановлено')
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
