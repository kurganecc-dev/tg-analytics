/* parser.js — разбор страницы публичного превью t.me (порт scripts/fetch_channel.py).
   Один и тот же код работает в Cloudflare Worker и (для тестов) в Node.
   Логика намеренно повторяет питон построчно: сверка scripts/verify_parser.mjs сравнивает результаты. */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const CHANNEL_RE = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i;
const PLAIN_RE = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/;
const POST_RE = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})\/\d+\/?$/i;
const NUM_RE = /(\d[\d  ]*(?:[.,]\d+)?)\s*([KkMmМм]|тыс|млн)?/;

class FetchError extends Error {}

function normalizeChannel(input) {
  const s = String(input || '').trim().replace(/ /g, '');
  const m = CHANNEL_RE.exec(s) || POST_RE.exec(s) || PLAIN_RE.exec(s);
  if (!m) {
    throw new FetchError(`не похоже на публичную ссылку канала: ${JSON.stringify(input)}. ` +
      'Годится https://t.me/имя_канала, @имя_канала или имя_канала ' +
      '(приватные ссылки +hash и каналы по инвайту веб-превью не отдают)');
  }
  return m[1];
}

function parseViews(raw) {
  if (!raw) return 0;
  const s = String(raw).replace(/\u00a0/g, ' ').trim();
  const m = NUM_RE.exec(s);
  if (!m) return 0;
  let num = parseFloat(m[1].replace(/ /g, '').replace(',', '.'));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'тыс') num *= 1000;
  else if (unit === 'm' || unit === 'млн') num *= 1e6;
  return Math.round(num);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', hellip: '…', copy: '©', reg: '®', deg: '°', plusmn: '±', times: '×',
  divide: '÷', frac12: '½', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  euro: '€', pound: '£', yen: '¥', rarr: '→', larr: '←', uarr: '↑', darr: '↓', prime: '′', Prime: '″',
  numero: '№', thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', shy: '\u00ad', zwj: '\u200d',
};

function unescapeHtml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const v = ENTITIES[body];
    return v === undefined ? all : v;
  });
}

function htmlToText(fragment) {
  let s = fragment;
  s = s.replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1');           // эмодзи — берём сам глиф
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (all, href, label) =>
    href.includes('t.me/') ? ` ${href} ` : label);                          // внутренние ссылки нужны для графа
  s = s.replace(/<(?:b|strong|i|em|u|s|code|pre|span|div|tg-spoiler)\b[^>]*>/gi, '');
  s = s.replace(/<\/(?:b|strong|i|em|u|s|code|pre|span|div|tg-spoiler)>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function parsePage(page, channel) {
  const blocks = page.split(/(?=<div class="tgme_widget_message_wrap)/).slice(1);
  const posts = [];
  const seen = new Set();
  let nextBefore = null;
  for (const b of blocks) {
    const pm = /data-post="([^"]+)"/.exec(b);
    if (!pm) continue;
    const pid = pm[1].split('/').pop();
    if (!/^\d+$/.test(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const dm = /<time datetime="([^"]+)"/.exec(b);
    const tm = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    const vm = /tgme_widget_message_views">([^<]+)</.exec(b);
    let reactions = 0;
    const re = /<span class="tgme_reaction">([\s\S]*?)<\/span>/g;
    let rm;
    while ((rm = re.exec(b)) !== null) {
      const raw = rm[1].replace(/<[^>]+>/g, '').trim();
      const num = /(\d[\d  ]*)\s*$/.exec(raw);
      if (num) reactions += parseInt(num[1].replace(/[ \u00a0]/g, ''), 10);
    }
    posts.push({
      channel,
      post_id: parseInt(pid, 10),
      text: tm ? htmlToText(tm[1]) : '',
      date: dm ? dm[1] : '',
      views: parseViews(vm ? vm[1] : ''),
      reactions,
      url: `https://t.me/${channel}/${pid}`,
    });
    const id = parseInt(pid, 10);
    if (nextBefore === null || id < nextBefore) nextBefore = id;
  }
  const bm = /data-before="(\d+)"/.exec(page);
  if (bm) nextBefore = parseInt(bm[1], 10);
  return { posts, next_before: nextBefore };
}

async function fetchPage(channel, before) {
  const url = `https://t.me/s/${channel}` + (before ? `?before=${before}` : '');
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8', Accept: 'text/html,application/xhtml+xml' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new FetchError(`HTTP ${res.status} на ${url}`);
  return res.text();
}

export { parsePage, parseViews, htmlToText, normalizeChannel, fetchPage, FetchError, UA };
