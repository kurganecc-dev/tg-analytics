/* analytics.js — движок расчётов TG-аналитики.
   Вход: массив постов {channel, post_id, text, date, views, reactions, url}.
   Ничего не рисует: только считает. Все определения метрик — в методике. */
(function (global) {
  'use strict';

  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{203C}\u{2049}\u{20E3}\u{2B50}\u{2B55}]/u;
  const EMOJI_G = new RegExp(EMOJI_RE.source, 'gu');
  const SENT_RE = /[.!?…]+(?=\s|$)/;
  const WORD_RE = /[а-яА-ЯёЁa-zA-Z]{2,}/g;
  const CYR = /[а-яА-ЯёЁ]/;
  const LAT = /[a-zA-Z]/;

  const MARKERS = {
    bulletRed: /^\s*🔴/m,
    dashList: /^\s*[—–]\s/m,
    dots: /^\s*▫️/m,
    checks: /^\s*✅/m,
    bullets: /^\s*•\s/m,
    numbered: /^\s*\d[️⃣]/m,
  };

  const CTA_RULES = {
    'подписывайтесь': /подписывайт/i,
    'переходите по ссылке': /переход[а-яё]+ по ссылк/i,
    'по ссылке (нейтр.)': /по ссылк/i,
    'оставляйте заявку': /оставляйт[а-яё]* заявк/i,
    'листайте карточки': /листайт[а-яё]+ (карточк|карусел)/i,
    'в карточках': /в карточках/i,
    'читайте в статье': /читайте в (статье|нашей)/i,
    'на сайт (etagi/сайт)': /etagi\.com|на (нашем )?сайте/i,
    'смотрите видео': /смотрите (видео|ролик|до конца)/i,
    'ставьте реакции': /ставьте (реакци|лайк)|поставьте реакци/i,
    'пишите в комментариях': /пишит?е? в комментариях/i,
    'делитесь в комментариях': /делитесь в комментариях/i,
    'приходите в офис': /приходите в «?(офис|этаж)/i,
  };

  const HYPE = /шок|сенсаци|уникальный шанс|вы не поверите/i;
  const CANCEL = /осуществляет деятельность|в рамках реализации|производится оформление|данный объект/i;
  const PROMISE = /гарантированн[а-яё]* доход|100% одобрен|гарантируем одобрен|рост цен неизбежен/i;

  // ---- темы: порядок = приоритет классификации ----
  const TOPICS = [
    ['Ставка ЦБ', /ключев[а-яё]* ставк|ставка цб|цб рф|центробанк|набиуллин|совет директоров/i],
    ['Семейная ипотека', /семейн[а-яё]+ ипотек|семейной ипотек/i],
    ['Льготные программы', /льготн[а-яё]*|господдержк|ит-ипотек|it-ипотек|дальневосточн|арктическ|сельск[а-яё]+ ипотек|военн[а-яё]+ ипотек/i],
    ['Ипотека', /ипотек|дду|первоначальн[а-яё]+ взнос|рефинансир/i],
    ['Новостройки', /новостро|первичн[а-яё]+ рын|застройщик|девелопер|дду|котлован/i],
    ['Загородка и ИЖС', /ижс|загородн|участк|дач[аиуе]|коттедж|таунхаус|изб[а-яё]*|снт|лпх/i],
    ['Вторичка', /вторичк|вторичн[а-яё]+|готовое жиль|готовых квартир/i],
    ['Аренда', /аренд|съемн|съёмн|снять квартир|сдат[а-яё]+|наймодател|квартирант/i],
    ['Цены и скидки', /цен[аыуо]|стоимость|дисконт|скидк|подорожал|подешевел|кв\. ?м|квадратн[а-яё]+ метр/i],
    ['Рынок и спрос', /спрос|предложени|сделк|рынок недвижимости|покупател/i],
    ['Законы и налоги', /закон|госдум|минфин|минстрой|постановлен|налог|вычет|маткапитал|материнск|госуслуг|росреестр/i],
    ['Компания', /этажи|этажей|этажам|этажах/i],
    ['HR и команда', /работодател|ваканс|команд|сотрудник|\bhr\b|наставник|персонал/i],
    ['Награды и партнёрства', /награ|преми|рейтинг|победит|партнёрств|сотрудничеств/i],
    ['Благотворительность', /фонд|благотвор|лейкеми|доброшрифт|пожертв|добрые дела|короб добра/i],
    ['Обучение и форумы', /вебинар|курс|обучен|школ|вшэ|конференц|форум|эфир|слёт|слет/i],
    ['Акции и розыгрыши', /розыгрыш|разыгра|акци|дарим|конкурс|флешмоб/i],
    ['Поздравления', /с дн[её]м|поздравля|с праздником|c 8 марта|с новым годом/i],
    ['Мемы и тренды', /#[^\s#]+|тренд|мем|нейросет|ии(?![а-яё])|гороскоп|предсказан|тест|кубик|астролог/i],
  ];

  // ---------- утилиты ----------
  // знаки считаем код-поинтами (как len() в Python), а не UTF-16-единицами, иначе эмодзи «весят» два
  // единый набор эмодзи для всего приложения: расхождение наборов даёт разные медианы
  const EMO_SRC = '[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{203C}\u{2049}\u{20E3}\u{2B50}\u{2B55}]';
  const EMO_RE = new RegExp(EMO_SRC, 'u');
  const EMO_G = new RegExp(EMO_SRC, 'gu');
  function emojiCount(str) { return (String(str).match(EMO_G) || []).length; }

  function clen(str) { let n = 0; for (const _ of str) n++; return n; }

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentile(arr, p) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }
  function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
  function round(x, d = 2) { const k = 10 ** d; return Math.round(x * k) / k; }
  function pct(part, whole) { return whole ? round((100 * part) / whole, 1) : 0; }

  function parseJSONL(text, sourceName) {
    const posts = [];
    const bad = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const s = line.trim();
      if (!s) return;
      try {
        const r = JSON.parse(s);
        const t = String(r.text == null ? '' : r.text).trim();
        posts.push({
          channel: r.channel || sourceName || 'unknown',
          post_id: r.post_id != null ? r.post_id : r.id,
          text: t,
          date: r.date,
          views: Number(r.views) || 0,
          reactions: Number(r.reactions) || 0,
          url: r.url || '',
        });
      } catch (e) { bad.push(i + 1); }
    });
    return { posts, bad };
  }

  function parseAny(text, name) {
    const s = text.trim();
    if (s.startsWith('[')) {
      const arr = JSON.parse(s);
      return { posts: arr.map(r => ({
        channel: r.channel || name || 'unknown',
        post_id: r.post_id != null ? r.post_id : r.id,
        text: String(r.text || '').trim(),
        date: r.date, views: Number(r.views) || 0,
        reactions: Number(r.reactions) || 0, url: r.url || '',
      })), bad: [] };
    }
    return parseJSONL(text, name);
  }

  function detectChannel(posts) {
    const c = {}; posts.forEach(p => { c[p.channel] = (c[p.channel] || 0) + 1; });
    const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : 'unknown';
  }

  function sentences(p) {
    const out = [];
    p.text.split('\n').forEach(line => {
      line.split(SENT_RE).forEach(s => {
        const w = (s.match(WORD_RE) || []).length;
        if (w) out.push(w);
      });
    });
    return out;
  }

  // ---------- анатомия текста ----------
  function anatomy(posts) {
    const chars = [], words = [], linesCnt = [], sentAll = [];
    const hooks = { 'утверждение': 0, 'цифра/процент в первой строке': 0, 'вопрос': 0, 'вопрос без «?»': 0, 'восклицание': 0, 'тема: подзаголовок': 0 };
    const tails = {}, emoji = {}, emojiPerPost = [];
    const marker = { 'разделитель 🔴': 0, 'тире-список': 0, 'точки ▫️': 0, 'галочки ✅': 0, 'маркеры •': 0, 'цифры-эмодзи': 0 };
    let withEmoji = 0, startsEmoji = 0, withDigit = 0, withQuote = 0, withAttr = 0, withSource = 0;
    let doubleSpace = 0, straightQuotes = 0, cyrLatin = 0, hyped = 0, cancel = 0, promise = 0;
    let brandQuoted = 0, brandUnquoted = 0, rieltorI = 0, rieltorE = 0, ads = 0, erid = 0, hashtags = 0;
    let percentSpaced = 0, longSentences = 0;
    const cta = {}; Object.keys(CTA_RULES).forEach(k => { cta[k] = 0; });
    const lens = [];
    // найденные отступления: правило → список постов с фрагментом-нарушителем
    const errors = {};
    const addErr = (rule, p, frag, text, idx, len) => {
      let ctx = null;
      if (text && typeof idx === 'number' && idx >= 0) {
        const from = Math.max(0, idx - 60), to = Math.min(text.length, idx + len + 60);
        ctx = {
          pre: (from > 0 ? '…' : '') + text.slice(from, idx).replace(/\n/g, ' '),
          hit: text.slice(idx, idx + len),
          post: text.slice(idx + len, to).replace(/\n/g, ' ') + (to < text.length ? '…' : ''),
        };
      }
      (errors[rule] = errors[rule] || []).push({ p, m: String(frag || '').trim().slice(0, 120), ctx });
    };

    posts.forEach(p => {
      const t = p.text;
      const L = t.split('\n').map(s => s.trim()).filter(Boolean);
      chars.push(clen(t)); linesCnt.push(L.length || 1);
      words.push((t.match(WORD_RE) || []).length);
      const sents = sentences(p); sentAll.push(...sents);
      const longest = L.map(l => l.split(SENT_RE)).reduce((a, b) => a.concat(b), [])
        .map(s => ({ s: s.trim(), w: (s.match(WORD_RE) || []).length }))
        .filter(x => x.w)
        .sort((a, b) => b.w - a.w)[0];
      if (longest && longest.w > 32) { longSentences++; }
      lens.push(clen(t));

      const first = L[0] || '';
      const head = (EMOJI_RE.test(first) && first.replace(EMOJI_G, '').trim().length <= 3 && L[1]) ? L[1] : first;
      if (/\d/.test(head)) hooks['цифра/процент в первой строке']++;
      else if (/^(как|что|почему|где|когда|кто|сколько|зачем|можно ли)(?![а-яё])/i.test(head) && !/\?$/.test(head)) hooks['вопрос без «?»']++;
      else if (head.trim().endsWith('?')) hooks['вопрос']++;
      else if (head.trim().endsWith('!')) hooks['восклицание']++;
      else if (head.includes(':')) hooks['тема: подзаголовок']++;
      else hooks['утверждение']++;

      const last = L[L.length - 1] || '';
      tails[last] = (tails[last] || 0) + 1;

      const em = t.match(EMOJI_G) || [];
      emojiPerPost.push(em.length);
      if (em.length) withEmoji++;
      em.forEach(e => { emoji[e] = (emoji[e] || 0) + 1; });
      if (EMOJI_RE.test(first) && first.replace(EMOJI_G, '').trim().length <= 3) startsEmoji++;

      if (MARKERS.bulletRed.test(t)) marker['разделитель 🔴']++;
      if (MARKERS.dashList.test(t)) marker['тире-список']++;
      if (MARKERS.dots.test(t)) marker['точки ▫️']++;
      if (MARKERS.checks.test(t)) marker['галочки ✅']++;
      if (MARKERS.bullets.test(t)) marker['маркеры •']++;
      if (MARKERS.numbered.test(t)) marker['цифры-эмодзи']++;

      if (/\d/.test(t)) withDigit++;
      if (/«/.test(t)) withQuote++;
      if (/комментари|прокомментиров|отмети(л|ла)|рассказа(л|ла)|считает|по (его|её) словам/i.test(t)) withAttr++;
      if (/по данным|по подсч|подсчитал|сообщил|рассказал|утвердил|ТАСС|РБК|Извести|Коммерсант|Минфин|Минстрой|Минтруд|Минцифры|ДОМ\.РФ|Росреестр|ЦБ|Домклик|Сбер|ВТБ|Альфа-Банк/i.test(t)) withSource++;

      // --- отступления: сохраняем пост и точный фрагмент с контекстом ---
      let m;
      const reDouble = /\S  +\S/g;
      while ((m = reDouble.exec(t)) !== null) addErr('Двойные пробелы', p, m[0], t, m.index, m[0].length);
      if (/\S  +\S/.test(t)) doubleSpace++;

      const reStraight = /"[^"\n]{0,60}"/g;
      if (reStraight.test(t)) {
        straightQuotes++;
        reStraight.lastIndex = 0;
        while ((m = reStraight.exec(t)) !== null) addErr('Прямые кавычки "', p, m[0], t, m.index, m[0].length);
      }

      const stripped = t.replace(/#[^\s#]+/g, ' ').replace(/\S*\.(com|ru|click|net)\S*/gi, ' ');
      const badMixed = (stripped.match(/[А-Яа-яЁёA-Za-z]{4,}/g) || []).filter(w => CYR.test(w) && LAT.test(w));
      if (badMixed.length) { cyrLatin++; addErr('Латиница внутри кириллицы', p, badMixed[0], stripped, stripped.indexOf(badMixed[0]), badMixed[0].length); }

      const addBySearch = (rule, re) => {
        const i = t.search(re);
        if (i < 0) return false;
        const hit = (t.slice(i).match(re) || [''])[0];
        addErr(rule, p, hit, t, i, hit.length);
        return true;
      };
      if (addBySearch('Хайп-лексика', HYPE)) hyped++;
      if (addBySearch('Канцелярит', CANCEL)) cancel++;
      if (addBySearch('Обещания и гарантии', PROMISE)) promise++;

      const rePct = /\d+\s+%/g;
      while ((m = rePct.exec(t)) !== null) { percentSpaced++; addErr('Процент с пробелом (5 %)', p, m[0], t, m.index, m[0].length); }

      if (/«Этаж/i.test(t)) { brandQuoted++; addBySearch('«Этажи» в кавычках', /«Этаж[^»]*»/i); }
      // подпись канала («Этажи | NewsRoom», «Подписывайтесь на Этажи NewsRoom») — это имя канала, не бренд в тексте;
      // исключаем также хэштеги (#этажи_новости), любые кавычки и этажность («до 5 этажей»)
      const SIGNATURE = /^\s*(этаж[ией]\s*\||подписывайтесь на этаж|а еще у нас есть)/i;
      const bodyText = L.filter(line => !SIGNATURE.test(line)).join('\n');
      const unq = /(?<![а-яёА-ЯЁ#_«"“])(?<![0-9])(?<![0-9] )этаж(и|ей|ам|ах)(?![»”"])(?![а-яёА-ЯЁ])/gi;
      while ((m = unq.exec(bodyText)) !== null) { brandUnquoted++; addErr('«Этажи» без кавычек', p, m[0], bodyText, m.index, m[0].length); }
      if (addBySearch('риелтор через «и»', /риелтор[а-яё]*/i)) rieltorI++;
      if (addBySearch('риэлтор через «э»', /риэлтор[а-яё]*/i)) rieltorE++;
      if (/Реклама\.|Токен/i.test(t)) ads++;
      if (/erid|Токен:/i.test(t)) erid++;
      const reHash = /#[^\s#]+/g;
      if (reHash.test(t)) { hashtags++; reHash.lastIndex = 0; if ((m = reHash.exec(t))) addErr('Хэштеги', p, m[0], t, m.index, m[0].length); }

      if (longest && longest.w > 32) {
        const i = t.indexOf(longest.s);
        addErr('Фразы длиннее 32 слов', p, longest.s, i >= 0 ? t : '', i >= 0 ? i : 0, longest.s.length);
      }

      Object.entries(CTA_RULES).forEach(([k, re]) => { if (re.test(t)) cta[k]++; });
    });

    const n = posts.length || 1;
    const topEmoji = Object.entries(emoji).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const topTails = Object.entries(tails).sort((a, b) => b[1] - a[1]).slice(0, 12);
    // в списках отступлений посты держим по одному разу (без повторов внутри правила)
    Object.keys(errors).forEach(rule => {
      const seen = new Set();
      errors[rule] = errors[rule]
        .filter(e => !seen.has(e.p) && (seen.add(e.p), true))
        .sort((a, b) => (b.p.views || 0) - (a.p.views || 0));
    });
    return {
      n,
      chars: { median: median(chars), p90: percentile(chars, 90), min: Math.min(...chars, 0), max: Math.max(...chars, 0) },
      words: { median: median(words), p90: percentile(words, 90) },
      lines: { median: median(linesCnt), p90: percentile(linesCnt, 90), max: Math.max(...linesCnt, 0) },
      sent: { median: median(sentAll), p90: percentile(sentAll, 90), max: Math.max(...sentAll, 0), total: sentAll.length },
      hooks, tails: topTails, marker, errors,
      emoji: { top: topEmoji, withPct: pct(withEmoji, n), median: median(emojiPerPost), startsPct: pct(startsEmoji, n), total: sum(emojiPerPost) },
      discipline: {
        doubleSpace: pct(doubleSpace, n), straightQuotes: pct(straightQuotes, n), cyrLatin: pct(cyrLatin, n),
        hyped: pct(hyped, n), cancel: pct(cancel, n), promise: pct(promise, n),
        brandQuoted: pct(brandQuoted, n), brandUnquoted: pct(brandUnquoted, n),
        rieltorI, rieltorE, ads: pct(ads, n), eridPct: pct(erid, n), hashtags: pct(hashtags, n),
        percentSpaced, longSentences,
        counts: {
          doubleSpace, straightQuotes, cyrLatin, hyped, cancel, promise,
          brandQuoted, brandUnquoted, hashtags,
        },
      },
      content: { withDigit: pct(withDigit, n), withQuote: pct(withQuote, n), withAttr: pct(withAttr, n), withSource: pct(withSource, n) },
      cta,
    };
  }

  // ---------- темы ----------
  function topicOf(text) {
    for (const [name, re] of TOPICS) if (re.test(text)) return name;
    return 'Прочее';
  }

  function topics(posts) {
    const map = {};
    posts.forEach(p => {
      const t = p.topic || (p.topic = topicOf(p.text));
      (map[t] = map[t] || { name: t, posts: [], views: [], react: [] });
      map[t].posts.push(p); map[t].views.push(p.views); map[t].react.push(p.reactions);
    });
    backfillTopics(posts, map);
    const total = posts.length || 1;
    return Object.values(map).map(g => {
      const views = sum(g.views), react = sum(g.react);
      return {
        name: g.name, count: g.posts.length, share: pct(g.posts.length, total),
        viewsMedian: median(g.views), viewsMean: Math.round(views / g.posts.length),
        reactMedian: median(g.react), reactTotal: react,
        er: views ? round((100 * react) / views, 2) : 0,
        erPerPost: round(react / g.posts.length, 1),
        top: g.posts.slice().sort((a, b) => b.views - a.views)[0],
      };
    }).sort((a, b) => b.count - a.count);
  }

  function backfillTopics() { /* тема уже записана в p.topic */ }

  // ---------- динамика ----------
  function monthly(posts) {
    const map = {};
    posts.forEach(p => {
      const key = (p.date || '').slice(0, 7);
      if (!key) return;
      (map[key] = map[key] || []).push(p);
    });
    return Object.keys(map).sort().map(k => {
      const g = map[k];
      const views = g.map(p => p.views), react = g.map(p => p.reactions);
      const sumV = sum(views), sumR = sum(react);
      return {
        month: k, count: g.length, viewsTotal: sumV, reactTotal: sumR,
        viewsMedian: median(views), reactMedian: median(react),
        er: sumV ? round((100 * sumR) / sumV, 2) : 0,
        erPerPost: round(sumR / g.length, 1),
      };
    });
  }

  function weekly(posts) {
    const map = {};
    posts.forEach(p => {
      const d = new Date(p.date);
      if (isNaN(d)) return;
      const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
      const key = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      (map[key] = map[key] || []).push(p);
    });
    return Object.keys(map).sort().map(k => {
      const g = map[k], views = g.map(p => p.views), react = g.map(p => p.reactions);
      const sumV = sum(views), sumR = sum(react);
      return { week: k, count: g.length, viewsMedian: median(views), er: sumV ? round((100 * sumR) / sumV, 2) : 0 };
    });
  }

  // ---------- ритм публикаций ----------
  function rhythm(posts) {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, views: [], react: [] })));
    posts.forEach(p => {
      const d = new Date(p.date);
      if (isNaN(d)) return;
      const cell = grid[d.getUTCDay()][d.getUTCHours()];
      cell.n++; cell.views.push(p.views); cell.react.push(p.reactions);
    });
    let best = null;
    const slots = [];
    grid.forEach((row, dow) => row.forEach((c, h) => {
      if (c.n >= 5) slots.push({ dow, hour: h, viewsMedian: median(c.views), n: c.n });
    }));
    slots.sort((a, b) => b.viewsMedian - a.viewsMedian);
    best = slots[0] || null;
    return { grid, best, topSlots: slots.slice(0, 6) };
  }

  // ---------- связи постов ----------
  function normalizeText(t) {
    return t.toLowerCase()
      .replace(EMOJI_G, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^а-яёa-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function connections(posts, ownChannel) {
    const dupGroups = [], linkEdges = [], seriesEdges = [], extChannels = {};
    const byId = new Map();
    posts.forEach(p => byId.set(`${p.channel}/${p.post_id}`, p));

    // 1) повторы и почти-повторы: сигнатура из первых 10 слов + длина
    const buckets = new Map();
    posts.forEach(p => {
      const norm = normalizeText(p.text);
      const sig = norm.split(' ').slice(0, 10).join(' ');
      const lenK = Math.round(norm.length / 40);
      const key = `${sig}|${lenK}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ p, norm });
    });
    const seen = new Set();
    buckets.forEach(group => {
      if (group.length < 2) return;
      const clusters = [];
      group.forEach(item => {
        let placed = false;
        for (const cl of clusters) {
          const j = jaccard(item.norm, cl[0].norm);
          if (j >= 0.7) { cl.push(item); placed = true; break; }
        }
        if (!placed) clusters.push([item]);
      });
      clusters.filter(c => c.length > 1).forEach(c => {
        const items = c.map(x => x.p);
        items.forEach(p => seen.add(p));
        dupGroups.push({
          ids: items.map(p => p.post_id),
          posts: items,
          first: items[0],
          similarity: round(jaccard(c[0].norm, c[1].norm), 2),
        });
      });
    });

    // 2) ссылки: внутренние (пост → пост) и внешние каналы
    const RESERVED = new Set(['boost', 'joinchat', 'addstickers', 'share', 'iv', 'proxy', 'socks', 'telegram', 's', 'c', 'setlanguage']);
    const linkRe = /t\.me\/(?:s\/)?([A-Za-z0-9_]{3,})(?:\/(\d+))?/gi;
    const atRe = /(?:^|[\s(«"])@([A-Za-z0-9_]{4,})\b/g;
    posts.forEach(p => {
      let m;
      for (const re of [linkRe, atRe]) {
        re.lastIndex = 0;
        while ((m = re.exec(p.text)) !== null) {
          const ch = m[1], id = m[2];
          if (RESERVED.has(ch.toLowerCase())) continue;
          if (id) {
            const target = byId.get(`${ch}/${Number(id)}`) ||
                           (ch.toLowerCase() === String(ownChannel).toLowerCase() ? byId.get(`${ch}/${Number(id)}`) : null);
            if (target && target !== p) { linkEdges.push({ from: p, to: target, kind: 'link' }); continue; }
          }
          if (ch.toLowerCase() !== String(ownChannel).toLowerCase()) {
            extChannels[ch] = (extChannels[ch] || 0) + 1;
          }
        }
      }
    });

    // 3) цепочки одной темы (посты подряд с шагом ≤ 10 дней)
    const byTopic = {};
    posts.forEach(p => { (byTopic[p.topic] = byTopic[p.topic] || []).push(p); });
    const chains = [];
    Object.values(byTopic).forEach(list => {
      list.sort((a, b) => new Date(a.date) - new Date(b.date));
      let cur = [list[0]];
      for (let i = 1; i < list.length; i++) {
        const dt = (new Date(list[i].date) - new Date(list[i - 1].date)) / 86400000;
        if (dt <= 10) { seriesEdges.push({ from: list[i - 1], to: list[i], kind: 'series' }); cur.push(list[i]); }
        else { if (cur.length > 1) chains.push(cur); cur = [list[i]]; }
      }
      if (cur.length > 1) chains.push(cur);
    });
    chains.sort((a, b) => b.length - a.length);

    const adPosts = posts.filter(p => /Реклама\.|Токен:/i.test(p.text));
    return {
      dupGroups, linkEdges, seriesEdges, chains,
      external: Object.entries(extChannels).map(([ch, n]) => ({ channel: ch, n })).sort((a, b) => b.n - a.n),
      adPosts,
      stats: {
        dupPosts: seen.size, dupGroups: dupGroups.length,
        links: linkEdges.length, series: seriesEdges.length,
        chains: chains.length, chainMedian: median(chains.map(c => c.length)),
        chainLongest: chains[0] ? chains[0].length : 0,
      },
    };
  }

  function jaccard(a, b) {
    const A = new Set(a.split(' ').filter(w => w.length > 3));
    const B = new Set(b.split(' ').filter(w => w.length > 3));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(w => { if (B.has(w)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  // ---------- обзор ----------
  function overview(posts) {
    const views = posts.map(p => p.views), react = posts.map(p => p.reactions);
    const totalV = sum(views), totalR = sum(react);
    const dates = posts.map(p => new Date(p.date)).filter(d => !isNaN(d)).sort((a, b) => a - b);
    const days = dates.length ? Math.max(1, Math.round((dates[dates.length - 1] - dates[0]) / 86400000)) : 1;
    const withReactions = posts.filter(p => p.reactions > 0).length;
    const sortedV = views.slice().sort((a, b) => a - b);
    const top10 = sortedV.slice(Math.floor(sortedV.length * 0.9));
    const erVals = posts.filter(p => p.views > 0).map(p => (100 * p.reactions) / p.views);
    const outliers = posts.filter(p => p.views >= Math.max(3 * median(views), 1)).sort((a, b) => b.views - a.views);
    const zeroView = posts.filter(p => !p.views).length;
    return {
      n: posts.length,
      period: dates.length ? { from: dates[0].toISOString().slice(0, 10), to: dates[dates.length - 1].toISOString().slice(0, 10), days } : null,
      perWeek: round((posts.length / days) * 7, 1),
      views: { total: totalV, median: median(views), mean: Math.round(totalV / (posts.length || 1)), p90: percentile(views, 90), max: Math.max(...views, 0) },
      react: { total: totalR, median: median(react), mean: round(totalR / (posts.length || 1), 1), max: Math.max(...react, 0) },
      er: { byViews: totalV ? round((100 * totalR) / totalV, 2) : 0, perPost: round(totalR / (posts.length || 1), 1), medianPostEr: round(median(erVals), 2), p90PostEr: round(percentile(erVals, 90), 2) },
      withReactionsPct: pct(withReactions, posts.length || 1),
      virality: median(views) ? round(percentile(views, 90) / median(views), 2) : 0,
      top10Share: totalV ? pct(sum(top10), totalV) : 0,
      outliers, zeroView,
      top: posts.slice().sort((a, b) => b.views - a.views).slice(0, 10),
      worst: posts.filter(p => p.views > 0).sort((a, b) => a.views - b.views).slice(0, 5),
      topEr: posts.filter(p => p.views >= 200).sort((a, b) => (b.reactions / b.views) - (a.reactions / a.views)).slice(0, 10)
        .map(p => ({ ...p, er: round((100 * p.reactions) / p.views, 2) })),
    };
  }

  // ---------- метрики по аудитории (когда известно число подписчиков) ----------
  function audienceMetrics(posts, subs) {
    const s = Number(subs);
    if (!s || s <= 0) return null;
    const n = posts.length || 1;
    const views = posts.map(p => p.views), react = posts.map(p => p.reactions);
    const totalV = sum(views), totalR = sum(react);
    const medV = median(views), p90V = percentile(views, 90);
    const medR = median(react), meanR = totalR / n;
    let sanity = 'ok';
    if (medV > s * 3) sanity = 'low';          // просмотров в разы больше подписчиков — число занижено
    else if (medV < s * 0.05) sanity = 'high'; // охват меньше 5 % — число завышено или канал в простое
    return {
      subs: s,
      // ER по подписчикам: реакции на пост к размеру аудитории (главная метрика)
      erPerPost: round((100 * medR) / s, 3),
      erPerPostMean: round((100 * meanR) / s, 3),
      reactPerPostMedian: medR,
      reactPerPostMean: round(meanR, 1),
      reactPerSubTotal: round(totalR / s, 2),   // сколько реакций на подписчика набрал канал за историю
      reachMedian: round((100 * medV) / s, 1),
      reachMean: round((100 * (totalV / n)) / s, 1),
      reachP90: round((100 * p90V) / s, 1),
      viewsPerSub: round(totalV / s, 1),
      sanity,
    };
  }

  function analyze(rawPosts, opts = {}) {
    const posts = rawPosts.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const channel = opts.channel || detectChannel(posts);
    posts.forEach(p => { p.topic = topicOf(p.text); });
    const subs = Number(opts.subs) || 0;
    const ov = overview(posts);
    const monthlyStats = monthly(posts);
    const aud = audienceMetrics(posts, subs);
    if (aud) {
      monthlyStats.forEach(m => {
        const g = posts.filter(p => (p.date || '').slice(0, 7) === m.month);
        if (!g.length) return;
        m.reachMedian = round((100 * median(g.map(p => p.views))) / subs, 1);
        m.erSubsPerPost = round((100 * median(g.map(p => p.reactions))) / subs, 3); // ER на пост, % от подписчиков
        m.reactPerSubMonth = round((100 * sum(g.map(p => p.reactions))) / subs, 1); // реакций на подписчика за месяц
        m.viewsPerSub = round(sum(g.map(p => p.views)) / subs, 1);
      });
    }
    return {
      channel,
      subs,
      generatedAt: new Date().toISOString(),
      overview: ov,
      audience: aud,
      monthly: monthlyStats,
      weekly: weekly(posts),
      rhythm: rhythm(posts),
      topics: topics(posts),
      anatomy: anatomy(posts),
      connections: connections(posts, channel),
      posts,
    };
  }

  global.TGA = { clen, emojiCount, EMO_RE, EMO_G, EMO_SRC, parseAny, parseJSONL, analyze, audienceMetrics, overview, monthly, weekly, rhythm, topics, anatomy, connections, topicOf, median, percentile, sum, round, pct };
})(window);
