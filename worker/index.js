/* index.js — облачный API для загрузки каналов по ссылке.
   Заменяет локальный serve.py там, где его нет: одна страница превью t.me за запрос,
   разбор целиком в облаке (2–3 мс CPU на страницу), клиент листает страницы и собирает отчёт.

   GET /health                        → {ok:true}
   GET /page?channel=имя&before=12345 → {channel, posts:[…], next_before}
*/
import { parsePage, normalizeChannel, fetchPage, FetchError } from './parser.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // кому можно: страницы сервиса, file:// (Origin: null) и запросы без Origin (curl, скрипты)
    const allow = String((env && env.ALLOWED_ORIGINS) || '*').split(',').map(v => v.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    if (!allow.includes('*') && origin && origin !== 'null' && !allow.includes(origin)) {
      return json({ error: 'источник не разрешён' }, 403);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'tg-analytics', pages: true });
    }

    if (url.pathname === '/page') {
      const raw = url.searchParams.get('channel') || '';
      const before = (url.searchParams.get('before') || '').replace(/\D/g, '');
      let channel;
      try {
        channel = normalizeChannel(raw);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
      const key = new Request(`https://tg-cache.internal/${channel}/${before || 0}`, request);
      const cache = caches.default;
      const hit = await cache.match(key);
      if (hit) return hit;                     // одинаковые страницы не дёргаем повторно

      try {
        const page = await fetchPage(channel, before || null);
        const { posts, next_before } = parsePage(page, channel);
        const body = JSON.stringify({ channel, posts, next_before, count: posts.length });
        const res = new Response(body, {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=120',
            'X-Posts': String(posts.length),
            ...CORS,
          },
        });
        ctx.waitUntil(cache.put(key, res.clone()));
        if (posts.length === 0 && !/tgme_widget_message/.test(page)) {
          return json({ error: `«${channel}»: публичных постов не нашлось. Канал не существует, закрыт, ` +
            'приватный или у него отключено веб-превью' }, 404);
        }
        return res;
      } catch (e) {
        const msg = e instanceof FetchError ? e.message : `не удалось прочитать страницу: ${e.message}`;
        return json({ error: msg }, 502);
      }
    }

    return json({ error: 'неизвестный маршрут. Есть /health и /page?channel=…&before=…' }, 404);
  },
};
