#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Загрузка постов публичного канала прямо по ссылке — без выгрузки JSONL.

    python3 scripts/fetch_channel.py https://t.me/nedvij_etagi --months 12
    python3 scripts/fetch_channel.py @nedvij_etagi --max-posts 300 --build

Источник — публичное веб-превью Telegram (t.me/s/<канал>), без авторизации и без API-ключей.
Что доступно: текст, дата (точно), просмотры (целые числа для небольших каналов, у крупных
могут быть округлены до «1.2K»), реакции (сумма по реакциям), ссылка на пост.
Чего нет: число подписчиков — его вводите в интерфейсе.

Ограничение: у закрытых каналов, каналов «по инвайту» и приватных ссылок веб-превью нет.
"""
import argparse, html, json, os, re, sys, time
from datetime import datetime
import urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
      '(KHTML, like Gecko) Version/17.0 Safari/605.1.15')
CHANNEL_RE = re.compile(
    r'^(?:https?://)?(?:(?:t\.me|telegram\.me)/(?:s/)?)?@?([A-Za-z][A-Za-z0-9_]{3,31})/?$', re.I)
POST_RE = re.compile(
    r'^(?:https?://)?(?:t\.me|telegram\.me)/(?:s/)?@?([A-Za-z][A-Za-z0-9_]{3,31})/\d+/?$', re.I)
NUM_RE = re.compile(r'(\d[\d\s\u00a0]*(?:[.,]\d+)?)\s*([KkMmМм]|тыс|млн)?')


class FetchError(RuntimeError):
    pass


def normalize_channel(url_or_name: str) -> str:
    """'https://t.me/s/nedvij_etagi?x=1' → 'nedvij_etagi'; ссылка на пост тоже годится; мусор → ошибка."""
    s = (url_or_name or '').strip().replace(' ', '')
    m = CHANNEL_RE.match(s) or POST_RE.match(s)   # ссылку на конкретный пост тоже принимаем — берём канал
    if not m:
        raise FetchError(
            f'не похоже на публичную ссылку канала: {url_or_name!r}. '
            'Годится https://t.me/имя_канала, @имя_канала или имя_канала '
            '(приватные ссылки +hash и каналы по инвайту веб-превью не отдают)')
    return m.group(1)


def http_get(url: str, timeout: int = 25) -> str:
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept-Language': 'ru,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        raise FetchError(f'HTTP {e.code} на {url}') from e
    except urllib.error.URLError as e:
        raise FetchError(f'сеть недоступна: {e.reason}') from e


def parse_views(raw: str) -> int:
    if not raw:
        return 0
    raw = raw.replace('\u00a0', ' ').strip()
    m = NUM_RE.search(raw)
    if not m:
        return 0
    num = float(m.group(1).replace(' ', '').replace(',', '.'))
    unit = (m.group(2) or '').lower()
    if unit in ('k', 'тыс'):
        num *= 1000
    elif unit in ('m', 'млн'):
        num *= 1_000_000
    return int(round(num))


def link_repl(m: re.Match) -> str:
    href, label = m.group(1), m.group(2)
    if 't.me/' in href:                     # внутренние ссылки важны для графа связей
        return f' {href} '
    return label


def html_to_text(fragment: str) -> str:
    s = fragment
    s = re.sub(r'<tg-emoji[^>]*>(.*?)</tg-emoji>', r'\1', s, flags=re.S)  # эмодзи — берём сам глиф
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r'<a\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>', link_repl, s, flags=re.S)
    s = re.sub(r'<(?:b|strong|i|em|u|s|code|pre|span|div|tg-spoiler)\b[^>]*>', '', s, flags=re.I)
    s = re.sub(r'</(?:b|strong|i|em|u|s|code|pre|span|div|tg-spoiler)>', '', s, flags=re.I)
    s = re.sub(r'<[^>]+>', '', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t\u00a0]+', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def parse_page(page: str, channel: str):
    blocks = re.split(r'(?=<div class="tgme_widget_message_wrap)', page)[1:]
    posts, next_before, seen = [], None, set()
    for b in blocks:
        pm = re.search(r'data-post="([^"]+)"', b)
        if not pm:
            continue
        _, _, pid = pm.group(1).partition('/')
        if not pid.isdigit() or pid in seen:
            continue
        seen.add(pid)
        dm = re.search(r'<time datetime="([^"]+)"', b)
        tm = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b, re.S)
        vm = re.search(r'tgme_widget_message_views">([^<]+)<', b)
        reactions = 0
        for rm in re.finditer(r'<span class="tgme_reaction">(.*?)</span>', b, re.S):
            # внутри спана бывает и глиф-эмодзи («🔥5»), и пустая заглушка tg-emoji («</tg-emoji>3»),
            # поэтому берём число в конце, а не требуем цифры во всей строке
            raw = re.sub(r'<[^>]+>', '', rm.group(1)).strip()
            num = re.search(r'(\d[\d\s\u00a0]*)\s*$', raw)
            if num:
                reactions += int(num.group(1).replace(' ', '').replace('\u00a0', ''))
        text = html_to_text(tm.group(1)) if tm else ''
        posts.append({
            'channel': channel,
            'post_id': int(pid),
            'text': text,
            'date': dm.group(1) if dm else '',
            'views': parse_views(vm.group(1) if vm else ''),
            'reactions': reactions,
            'url': f'https://t.me/{channel}/{pid}',
        })
        next_before = pid if next_before is None or int(pid) < int(next_before) else next_before
    bm = re.search(r'data-before="(\d+)"', page)
    if bm:
        next_before = bm.group(1)
    return posts, next_before


def _ts(iso: str):
    """Время поста в секундах. Раньше граница по дате сравнивалась строками в локальном времени —
    это давало сдвиг на часы и на переходах года."""
    try:
        return datetime.fromisoformat(str(iso).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def fetch_channel(channel: str, months: int = 0, max_posts: int = 0,
                  delay: float = 0.7, progress=None, stop_at_id: int = 0, max_pages: int = 600):
    """Идёт по страницам превью назад от последнего поста.
    months > 0 — остановка по дате; max_posts > 0 — дополнительный потолок (0 = без потолка);
    max_pages — аварийный предел, чтобы не листать канал бесконечно."""
    cutoff = time.time() - months * 30.44 * 86400 if months else 0
    out, before, seen = [], None, set()
    pages = 0
    while True:
        if max_posts and len(out) >= max_posts:
            if progress:
                progress(f'достигнут потолок в {max_posts} постов')
            break
        if pages >= max_pages:
            if progress:
                progress(f'остановился на пределе {max_pages} страниц — история канала длиннее')
            break
        url = f'https://t.me/s/{channel}' + (f'?before={before}' if before else '')
        try:
            page = http_get(url)
        except FetchError as e:
            if out:
                if progress:
                    progress(f'остановился на {url}: {e}')
                break
            raise
        pages += 1
        posts, next_before = parse_page(page, channel)
        fresh = [p for p in posts if p['post_id'] not in seen]
        for p in fresh:
            seen.add(p['post_id'])
        if not fresh:
            break
        out.extend(fresh)
        if stop_at_id and min(p['post_id'] for p in fresh) <= stop_at_id:
            break
        if progress:
            progress(f'страница {pages}: получено {len(out)} постов, самый старый {min(p["post_id"] for p in fresh)}')
        if cutoff:
            stamps = [t for t in (_ts(p['date']) for p in fresh if p.get('date')) if t is not None]
            if stamps and min(stamps) <= cutoff:
                if progress:
                    progress(f'дошли до границы {months} мес. — останавливаюсь')
                break
        if not next_before or next_before in seen:
            break
        before = next_before
        time.sleep(delay)
    out.sort(key=lambda p: (p['date'], p['post_id']))
    if cutoff:
        # страница могла заехать за границу периода: оставляем ровно запрошенные месяцы
        out = [p for p in out if (_ts(p['date']) or 0) >= cutoff]
    if max_posts:
        out = out[-max_posts:]
    return out


def main():
    ap = argparse.ArgumentParser(description='Загрузка постов канала по ссылке (публичное превью t.me)')
    ap.add_argument('channel', help='ссылка вида https://t.me/канал или @канал')
    ap.add_argument('--months', type=int, default=12, help='за сколько последних месяцев (0 — без ограничения)')
    ap.add_argument('--max-posts', type=int, default=0,
                    help='потолок числа постов (0 — без потолка: границу задаёт --months)')
    ap.add_argument('--delay', type=float, default=0.7, help='пауза между страницами, сек (вежливость к t.me)')
    ap.add_argument('--out', help='куда писать JSONL (по умолчанию data/<канал>.jsonl)')
    ap.add_argument('--name', help='имя канала в отчёте (по умолчанию — из ссылки)')
    ap.add_argument('--subs', type=int, help='число подписчиков для отчёта')
    ap.add_argument('--build', action='store_true', help='сразу собрать data/report-data.json и report.html')
    ap.add_argument('--json', action='store_true', help='вывести посты в stdout как JSON (для API)')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    channel = normalize_channel(args.channel)
    log = (lambda *a: None) if (args.quiet or args.json) else (lambda m: print(m, file=sys.stderr))
    try:
        posts = fetch_channel(channel, args.months, args.max_posts, args.delay, progress=log)
    except FetchError as e:
        print(f'ошибка: {e}', file=sys.stderr)
        return 1
    with_text = [p for p in posts if p['text'].strip()]
    media_only = len(posts) - len(with_text)

    if args.json:
        json.dump({'name': channel, 'count': len(with_text), 'media_only': media_only,
                   'posts': with_text}, sys.stdout, ensure_ascii=False)
        return 0

    out = args.out or os.path.join(ROOT, 'data', f'{channel}.jsonl')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        for p in with_text:
            f.write(json.dumps(p, ensure_ascii=False) + '\n')
    print(f'{channel}: {len(with_text)} постов с текстом'
          + (f' (+{media_only} без текста — только медиа, в отчёт не попадают)' if media_only else ''))
    if with_text:
        print(f'  период: {with_text[0]["date"][:10]} → {with_text[-1]["date"][:10]}')
    print(f'  → {out}')

    if args.build:
        cmd = [sys.executable, os.path.join(ROOT, 'scripts', 'build_report.py'), out, '--name', args.name or channel]
        if args.subs:
            cmd += ['--subs', str(args.subs)]
        os.execv(sys.executable, cmd)
    return 0


if __name__ == '__main__':
    sys.exit(main())
