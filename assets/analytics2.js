/* analytics2.js — глубокий анализ: статистика со значимостью, драйверы, рубрики,
   качество текста, тренды и прогноз. Всё детерминировано (свой PRNG), чтобы числа
   можно было перепроверять независимым расчётом. */
(function (global) {
  'use strict';
  const A = global.TGA;

  // ---------- детерминированный PRNG (mulberry32) — тот же алгоритм в Python-проверке ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const median = A.median;

  // медиана через выбор k-го элемента: в циклах бутстрэпа сортировка всего массива дороже
  function kth(arr, k) {
    const a = arr;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const p = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < p) i++;
        while (a[j] > p) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
    return a[k];
  }
  function qmedian(values) {
    const n = values.length;
    if (!n) return 0;
    const a = values.slice();
    const mid = n >> 1;
    if (n % 2) return kth(a, mid);
    const hi = kth(a, mid);
    const lo = kth(a.slice(), mid - 1);
    return (lo + hi) / 2;
  }

  // ---------- описательная статистика с интервалами ----------
  function bootstrapCI(values, { seed = 42, iters = 1000, alpha = 0.05 } = {}) {
    if (!values.length) return null;
    const rnd = mulberry32(seed), n = values.length, out = new Array(iters);
    for (let i = 0; i < iters; i++) {
      const s = new Array(n);
      for (let j = 0; j < n; j++) s[j] = values[(rnd() * n) | 0];
      out[i] = qmedian(s);
    }
    out.sort((a, b) => a - b);
    const lo = out[Math.floor(iters * alpha / 2)], hi = out[Math.min(iters - 1, Math.floor(iters * (1 - alpha / 2)))];
    return { point: median(values), lo, hi, iters, n };
  }

  function meanCI(values) {
    const n = values.length;
    if (n < 2) return null;
    const m = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    const se = sd / Math.sqrt(n), t = 1.96;                    // нормальное приближение, n ≥ 30 обычно
    return { point: m, lo: m - t * se, hi: m + t * se, sd, n };
  }

  // перестановочный тест на разницу (двусторонний) + размер эффекта Клиффа
  function permutationTest(a, b, { seed = 42, iters = 2000 } = {}) {
    if (!a.length || !b.length) return null;
    const obs = median(a) - median(b);
    const all = a.concat(b), na = a.length;
    const rnd = mulberry32(seed);
    let ge = 0;
    for (let i = 0; i < iters; i++) {
      for (let k = all.length - 1; k > 0; k--) {
        const j = (rnd() * (k + 1)) | 0;
        const t = all[k]; all[k] = all[j]; all[j] = t;
      }
      const d = median(all.slice(0, na)) - median(all.slice(na));
      if (Math.abs(d) >= Math.abs(obs) - 1e-12) ge++;
    }
    return { diff: obs, p: (ge + 1) / (iters + 1), cliff: cliffsDelta(a, b), nA: a.length, nB: b.length };
  }

  function cliffsDelta(a, b) {
    let gt = 0, lt = 0;
    for (const x of a) for (const y of b) { if (x > y) gt++; else if (x < y) lt++; }
    return (gt - lt) / (a.length * b.length);
  }

  function mannWhitneyU(a, b) {
    // ранжируем объединённую выборку, средние ранги для связей, поправка на связи в дисперсии
    const all = a.map(v => [v, 0]).concat(b.map(v => [v, 1])).sort((x, y) => x[0] - y[0]);
    const n = all.length, n1 = a.length, n2 = b.length;
    let ra = 0, tieSum = 0;
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && all[j + 1][0] === all[i][0]) j++;
      const r = (i + j) / 2 + 1;
      const t = j - i + 1;
      tieSum += t * t * t - t;
      for (let k = i; k <= j; k++) if (all[k][1] === 0) ra += r;
      i = j + 1;
    }
    const U = ra - n1 * (n1 + 1) / 2;
    const mu = n1 * n2 / 2;
    const sd = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tieSum / (n * (n - 1))));
    const z = sd ? (U - mu) / sd : 0;
    return { U, z, p: 2 * (1 - normalCdf(Math.abs(z))), cliff: (2 * U) / (n1 * n2) - 1 };
  }

  // единая функция сравнения двух групп: U-критерий (быстро) + размер эффекта
  function compareGroups(a, b) {
    const r = mannWhitneyU(a, b);
    return { p: r.p, cliff: r.cliff, U: r.U, z: r.z };
  }

  function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (x > 0) p = 1 - p;
    return p;
  }

  // устойчивый выброс: z по медиане и MAD (0.6745 — перевод в сигмы)
  function robustZ(values) {
    const med = median(values);
    const mad = median(values.map(v => Math.abs(v - med)));
    return values.map(v => mad === 0 ? 0 : (0.6745 * (v - med)) / mad);
  }

  function spearman(x, y) {
    if (x.length !== y.length || x.length < 3) return null;
    const rx = avgRanks(x), ry = avgRanks(y), n = x.length;
    const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  }

  function avgRanks(arr) {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) out[idx[k][1]] = r;
      i = j + 1;
    }
    return out;
  }

  // ---------- тренд: OLS по логарифму, наклон в % за месяц с 95 % интервалом ----------
  function trend(pairs) {
    // pairs: [[t, value]] в порядке времени
    const pts = pairs.filter(p => p[1] > 0);
    if (pts.length < 4) return null;
    const ys = pts.map(p => Math.log(p[1]));
    const xs = pts.map((_, i) => i);
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const resid = ys.map((y, i) => y - (intercept + slope * xs[i]));
    const s2 = resid.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 2);
    const se = Math.sqrt(s2 / sxx);
    const monthly = Math.exp(slope) - 1;
    return {
      slopePerStep: slope,
      monthlyPct: monthly * 100,
      lo: (Math.exp(slope - 1.96 * se) - 1) * 100,
      hi: (Math.exp(slope + 1.96 * se) - 1) * 100,
      r2: (() => {
        const sst = ys.reduce((a, b) => a + (b - my) ** 2, 0);
        const sse = resid.reduce((a, b) => a + b * b, 0);
        return sst ? 1 - sse / sst : 0;
      })(),
      n,
    };
  }

  // ---------- точки перелома: бинарная сегментация по медианам ----------
  function changepoints(series, { minSeg = 6, maxCuts = 4 } = {}) {
    // series: [{label, value}]
    if (series.length < minSeg * 2) return { segments: [], cuts: [] };
    const cost = (arr) => {
      const med = median(arr.map(x => x.value));
      return arr.reduce((a, x) => a + Math.abs(x.value - med), 0);   // L1-стоимость устойчивее к выбросам
    };
    const segments = [{ from: 0, to: series.length - 1 }];
    const cuts = [];
    for (let step = 0; step < maxCuts; step++) {
      let best = null;
      segments.forEach((seg, si) => {
        const len = seg.to - seg.from + 1;
        if (len < minSeg * 2) return;
        for (let cut = seg.from + minSeg - 1; cut <= seg.to - minSeg; cut++) {
          const left = series.slice(seg.from, cut + 1), right = series.slice(cut + 1, seg.to + 1);
          const gain = cost(series.slice(seg.from, seg.to + 1)) - (cost(left) + cost(right));
          if (!best || gain > best.gain) best = { gain, cut, si };
        }
      });
      if (!best || best.gain <= 0) break;
      const seg = segments[best.si];
      const left = { from: seg.from, to: best.cut }, right = { from: best.cut + 1, to: seg.to };
      segments.splice(best.si, 1, left, right);
      cuts.push(series[best.cut].label);
    }
    segments.sort((a, b) => a.from - b.from);
    cuts.sort();
    return {
      cuts,
      segments: segments.map(s => ({
        from: series[s.from].label, to: series[s.to].label,
        n: s.to - s.from + 1,
        median: median(series.slice(s.from, s.to + 1).map(x => x.value)),
      })),
    };
  }

  // ---------- драйверы: что связано с просмотрами ----------
  const EMO = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{203C}\u{2049}\u{20E3}\u{2B50}\u{2B55}]/u;
  const EMO_G = new RegExp(EMO.source, 'gu');
  // «строка только из маркера»: после удаления эмодзи остаются лишь пробелы и пунктуация
  const MARKER_ONLY = /^[\s:.,;!?%«»—–-]*$/u;

  const CTA_LIST = {
    'призыв подписаться': /подписывайт/i,
    'ссылка/переход': /по ссылк|etagi\.com|переход[а-яё]+ по ссылк|на (нашем )?сайте/i,
    'заявка/офис': /оставляйт[а-яё]* заявк|приходите в/i,
    'карточки/листать': /листайт|в карточках|карусел/i,
    'читать статью': /читайте в (статье|журнале|нашей)/i,
    'вопрос в конце': /\?\s*$/m,
  };

  function features(p) {
    const L = p.text.split('\n').map(s => s.trim()).filter(Boolean);
    const first = L[0] || '';
    const firstStripped = first.replace(EMO_G, '').trim();
    const isMarkerLine = firstStripped.length <= 3 && MARKER_ONLY.test(firstStripped);
    const head = (isMarkerLine && L[1]) ? L[1] : first;
    const emoji = (p.text.match(EMO_G) || []).length;
    return {
      'эмодзи-маркер в первой строке': EMO.test(first) && isMarkerLine,
      'цифра в заголовке': /\d/.test(head),
      'вопрос в первой строке': /\?\s*$/.test(head),
      'восклицание в первой строке': /!\s*$/.test(head),
      'заголовок с двоеточием': head.includes(':'),
      'цитата эксперта «…»': /«[^»]{25,}»/.test(p.text) || /рассказал|отметил|по словам|считает|прокомментировал/i.test(p.text),
      'должность + компания': /(директор|руководител|эксперт|аналитик|управляющ|президент|основател)/i.test(p.text),
      'ссылка на источник': /по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|Минстрой|ДОМ\.РФ|Росреестр|ЦБ|Домклик|URA\.RU|72\.RU/i.test(p.text),
      'список 🔴': /^\s*🔴/m.test(p.text),
      'тире-список': /^\s*[—–]\s/m.test(p.text),
      'нумерованный список': /^\s*\d[️⃣)]/m.test(p.text),
      'заканчивается вопросом': /\?\s*$/.test(p.text.trim()),
      'финал-эмодзи': L.length > 1 && EMO.test(L[L.length - 1]) && MARKER_ONLY.test(L[L.length - 1].replace(EMO_G, '')),
      'хэштег': /#[^\s#]+/.test(p.text),
      'внешняя ссылка': /https?:\/\/(?!t\.me)/.test(p.text),
      'длинный пост (>800 знаков)': A.clen(p.text) > 800,
      'короткий пост (<250 знаков)': A.clen(p.text) < 250,
      'много эмодзи (>5)': emoji > 5,
      'без эмодзи': emoji === 0,
      'абзацев ≥ 4': L.length >= 4,
      'цифра/процент в теле': /\d+([.,]\d+)?\s?%/.test(p.text),
    };
  }

  function drivers(posts, { minGroup = 25 } = {}) {
    const withViews = posts.filter(p => p.views > 0);
    const med = median(withViews.map(p => p.views));
    const cache = new Map();
    withViews.forEach(p => cache.set(p, features(p)));
    const names = new Set();
    cache.forEach(f => Object.keys(f).forEach(k => names.add(k)));
    const out = [];
    names.forEach(name => {
      const a = [], b = [];
      withViews.forEach(p => ((cache.get(p)[name]) ? a : b).push(p.views));
      if (a.length < minGroup || b.length < minGroup) return;
      const test = compareGroups(a, b);
      out.push({
        feature: name, nWith: a.length, nWithout: b.length,
        medianWith: median(a), medianWithout: median(b),
        lift: med ? (median(a) - median(b)) / med * 100 : 0,
        cliff: test.cliff, p: test.p,
        significant: test.p < 0.05 && Math.abs(test.cliff) > 0.1,
      });
    });
    return out.sort((x, y) => Math.abs(y.cliff) - Math.abs(x.cliff));
  }

  // ---------- слоты публикации с интервалами ----------
  function slots(posts, { minN = 6 } = {}) {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
    posts.forEach(p => {
      const d = new Date(p.date);
      if (isNaN(d) || !p.views) return;
      grid[d.getUTCDay()][d.getUTCHours()].push(p.views);
    });
    const all = posts.filter(p => p.views > 0).map(p => p.views);
    const channelMedian = median(all);
    const channelCI = bootstrapCI(all, { seed: 7, iters: 500 });
    const cells = [];
    grid.forEach((row, dow) => row.forEach((vals, hour) => {
      if (vals.length < minN) return;
      const ci = bootstrapCI(vals, { seed: 100 + dow * 100 + hour, iters: 300 });
      cells.push({
        dow, hour, n: vals.length, median: median(vals), lo: ci.lo, hi: ci.hi,
        better: ci.lo > channelCI.hi,          // интервал слота целиком выше интервала канала
        worse: ci.hi < channelCI.lo,
      });
    }));
    cells.sort((a, b) => b.median - a.median);
    const bands = {};
    posts.forEach(p => {
      const d = new Date(p.date);
      if (isNaN(d) || !p.views) return;
      const h = d.getUTCHours();
      const band = h < 6 ? 'ночь 00–05' : h < 12 ? 'утро 06–11' : h < 18 ? 'день 12–17' : 'вечер 18–23';
      (bands[band] = bands[band] || []).push(p.views);
    });
    const bandStats = Object.entries(bands).map(([k, v]) => {
      const ci = bootstrapCI(v, { seed: 999 + k.length, iters: 300 });
      return { band: k, n: v.length, median: median(v), lo: ci.lo, hi: ci.hi };
    }).sort((a, b) => b.median - a.median);
    return { cells, channelMedian, channelCI, bandStats };
  }

  // ---------- рубрики (шаблоны-форматы) ----------
  const RUBRICS = [
    ['Дайджест', /дайджест|главное за неделю|топ новостей|новости недели/i],
    ['Карточки-ликбез', /карточк|листайт|карусел|разбираем|объясняем/i],
    ['Словарь/алфавит', /словарь|алфавит недвижимости|что такое/i],
    ['Игровые рубрики', /гороскоп|предсказан|тест|викторин|кубик|угадай/i],
    ['Поздравления', /с дн[её]м|поздравля|с праздником|с новым годом/i],
    ['Аналитика/экспертиза', /аналитик|исследован|по данным|эксперт|прогноз/i],
    ['Мгновенная новость', /ключев[а-яё]* ставк|только что|срочно|официально/i],
    ['Розыгрыш/акция', /розыгрыш|разыгра|акци|дарим|конкурс/i],
    ['HR и команда', /ваканс|работодател|в команду|наставник|карьер/i],
    ['Кейс/история', /кейс|история клиента|как (мы|семья|клиент)|отзыв/i],
    ['Регулирование', /закон|госдум|минфин|минстрой|постановлен|налог|вычет|льготн/i],
    ['Реклама компании', /Реклама\.|ООО «Этажи»|наши услуги|запишитесь/i],
  ];

  function rubricOf(p) {
    for (const [name, re] of RUBRICS) if (re.test(p.text)) return name;
    return 'Прочее';
  }

  function rubrics(posts) {
    const map = {};
    posts.forEach(p => {
      const r = rubricOf(p);
      (map[r] = map[r] || []).push(p);
    });
    const all = posts.filter(p => p.views > 0).map(p => p.views);
    const base = median(all);
    return Object.entries(map).map(([name, list]) => {
      const views = list.filter(p => p.views > 0).map(p => p.views);
      const react = list.map(p => p.reactions);
      const ci = views.length >= 5 ? bootstrapCI(views, { seed: 31, iters: 300 }) : null;
      const test = views.length >= 8 ? compareGroups(views, all) : null;
      return {
        name, count: list.length, share: list.length / posts.length * 100,
        median: views.length ? median(views) : 0, lift: base && views.length ? (median(views) - base) / base * 100 : 0,
        er: views.length ? (100 * react.reduce((a, b) => a + b, 0)) / views.reduce((a, b) => a + b, 0) : 0,
        lo: ci ? ci.lo : null, hi: ci ? ci.hi : null,
        p: test ? test.p : null,
        best: list.slice().sort((a, b) => b.views - a.views)[0],
        emoji: list.reduce((a, p) => a + ((p.text.match(EMO_G) || []).length), 0) / (list.length || 1),
        chars: median(list.map(p => A.clen(p.text))),
      };
    }).sort((a, b) => b.median - a.median);
  }

  // ---------- качество текста ----------
  const CLICHE = [
    'в современном мире', 'на сегодняшний день', 'играет важную роль', 'не секрет, что',
    'в заключение', 'динамично развивающаяся', 'широкий спектр', 'индивидуальный подход',
    'гибкая система скидок', 'команда профессионалов', 'лидер рынка', 'на рынке уже давно',
  ];
  const CANCEL_WORDS = ['осуществля', 'производится', 'в рамках реализац', 'данный', 'вышеуказанн',
    'в целях', 'надлежащ', 'в соответствии с', 'с целью', 'является'];

  function syllables(word) {
    return (word.toLowerCase().match(/[аеёиоуыэюя]+/g) || []).length || 1;
  }

  function copyQuality(posts) {
    const chars = posts.map(p => A.clen(p.text));
    const sentWords = [], sentChars = [];
    let longSent = 0, totalSent = 0, clicheHits = 0, cancelHits = 0, passive = 0;
    let words = 0, syl = 0, questions = 0, exclaims = 0, firstPerson = 0;
    const perYear = {};

    posts.forEach(p => {
      const L = p.text.split('\n').map(s => s.trim()).filter(Boolean);
      L.forEach(line => {
        line.split(/[.!?…]+(?=\s|$)/).forEach(s => {
          const w = (s.match(/[а-яА-ЯёЁa-zA-Z]{2,}/g) || []);
          if (!w.length) return;
          totalSent++; sentWords.push(w.length); sentChars.push(s.length);
          if (w.length > 25) longSent++;
          words += w.length;
          w.forEach(x => { syl += syllables(x); });
          if (/(?<![а-яёА-ЯЁA-Za-z0-9_])(был|была|было|были|будет|будут)\s+[а-яё]+(н|т)(?![а-яёА-ЯЁA-Za-z0-9_])/i.test(s)) passive++;
          if (s.includes('?')) questions++;
          if (s.includes('!')) exclaims++;
          if (/(?<![а-яёА-ЯЁA-Za-z0-9_])(мы|наш|наши|нам)(?![а-яёА-ЯЁA-Za-z0-9_])/i.test(s)) firstPerson++;
        });
      });
      const low = p.text.toLowerCase();
      CLICHE.forEach(c => { if (low.includes(c)) clicheHits++; });
      CANCEL_WORDS.forEach(w => { if (low.includes(w)) cancelHits++; });

      const y = (p.date || '').slice(0, 4);
      if (y) {
        const e = perYear[y] = perYear[y] || { year: y, n: 0, chars: 0, emoji: 0, quotes: 0, source: 0, q: 0 };
        e.n++;
        e.chars += A.clen(p.text);
        e.emoji += ((p.text.match(EMO_G) || []).length);
        if (/«/.test(p.text)) e.quotes++;
        if (/по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик/i.test(p.text)) e.source++;
        if (/\?/.test(p.text)) e.q++;
      }
    });

    const ASL = sentWords.length ? words / sentWords.length : 0;
    const ASW = words ? syl / words : 0;
    const flesch = 206.835 - 1.3 * ASL - 60.1 * ASW;   // адаптация Оборневой для русского
    const drift = Object.values(perYear).sort((a, b) => a.year.localeCompare(b.year)).map(e => ({
      year: e.year, posts: e.n, chars: Math.round(e.chars / e.n), emoji: +(e.emoji / e.n).toFixed(1),
      quotes: +(100 * e.quotes / e.n).toFixed(1), source: +(100 * e.source / e.n).toFixed(1), question: +(100 * e.q / e.n).toFixed(1),
    }));

    return {
      chars: { median: median(chars), p90: A.percentile(chars, 90) },
      sent: { median: median(sentWords), p90: A.percentile(sentWords, 90), total: totalSent, longShare: totalSent ? 100 * longSent / totalSent : 0 },
      asl: ASL, asw: ASW, flesch,
      clichePer100: posts.length ? 100 * clicheHits / posts.length : 0,
      cancelPer100: posts.length ? 100 * cancelHits / posts.length : 0,
      passiveShare: totalSent ? 100 * passive / totalSent : 0,
      questionShare: totalSent ? 100 * questions / totalSent : 0,
      exclaimShare: totalSent ? 100 * exclaims / totalSent : 0,
      weShare: totalSent ? 100 * firstPerson / totalSent : 0,
      drift,
      clicheList: CLICHE.filter(c => posts.some(p => p.text.toLowerCase().includes(c)))
        .map(c => ({ phrase: c, posts: posts.filter(p => p.text.toLowerCase().includes(c)).length }))
        .sort((a, b) => b.posts - a.posts),
    };
  }

  // ---------- прогноз (наивная модель: тренд + сезонность месяца) ----------
  function forecast(monthly, { horizon = 3 } = {}) {
    const rows = monthly.filter(m => m.count >= 3 && m.viewsMedian > 0);
    if (rows.length < 8) return null;
    const tr = trend(rows.map(m => [m.month, m.viewsMedian]));
    const recent = rows.slice(-24);
    const n = recent.length;
    const xs = recent.map((_, i) => i), ys = recent.map(m => Math.log(m.viewsMedian));
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const slope = sxy / sxx, intercept = my - slope * mx;
    const resid = ys.map((y, i) => y - (intercept + slope * xs[i]));
    const sigma = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 2));
    // сезонность по календарному месяцу, если истории хватает
    const byMonth = {};
    recent.forEach((m, i) => {
      const mm = Number(m.month.slice(5, 7));
      (byMonth[mm] = byMonth[mm] || []).push(Math.log(m.viewsMedian) - (intercept + slope * i));
    });
    const seasonal = {};
    Object.entries(byMonth).forEach(([mm, v]) => {
      if (v.length >= 3) seasonal[mm] = v.reduce((a, b) => a + b, 0) / v.length;   // меньше трёх лет — шум, а не сезонность
    });

    const out = [];
    let lastIdx = n - 1;
    for (let k = 1; k <= horizon; k++) {
      const t = lastIdx + k;
      const base = Math.exp(intercept + slope * t);
      const mm = Number(rows[rows.length - 1].month.slice(5, 7));
      const targetMonth = ((mm - 1 + k) % 12) + 1;
      const s = seasonal[targetMonth] || 0;
      const point = base * Math.exp(s);
      const lo = Math.exp(Math.log(point) - 1.96 * sigma * Math.sqrt(k));
      const hi = Math.exp(Math.log(point) + 1.96 * sigma * Math.sqrt(k));
      const label = new Date(Date.UTC(Number(rows[rows.length - 1].month.slice(0, 4)), mm - 1 + k, 1));
      out.push({ month: label.toISOString().slice(0, 7), point, lo, hi, seasonal: s !== 0 });
    }
    return { points: out, trendMonthlyPct: tr ? tr.monthlyPct : null, sigma, basedOnMonths: rows.length,
             seasonalMonths: Object.keys(seasonal).length };
  }

  // ---------- сводка руководителю: находки с числами ----------
  function findings(model, deep) {
    const out = [];
    const o = model.overview;
    const push = (level, text) => out.push({ level, text });

    // 1. динамика последних 3 месяцев против предыдущих 12
    const m = model.monthly;
    if (m.length >= 6) {
      const last3 = m.slice(-3), prev = m.slice(-15, -3);
      const a = last3.map(x => x.viewsMedian), b = prev.map(x => x.viewsMedian);
      if (a.length >= 2 && b.length >= 4) {
        const t = permutationTest(a, b, { iters: 1200 });
        const d = (median(a) - median(b)) / (median(b) || 1) * 100;
        push(Math.abs(d) < 10 ? 'neutral' : d > 0 ? 'good' : 'bad',
          `Медиана просмотров за последние 3 месяца — ${Math.round(median(a))} против ${Math.round(median(b))} ранее ` +
          `(${d >= 0 ? '+' : ''}${d.toFixed(0)} %, p = ${t.p.toFixed(3)}${t.p < 0.05 ? ' — разница значима' : ' — в пределах случайной'}).`);
      }
    }
    // 2. тренд
    if (deep.trend) {
      push(deep.trend.monthlyPct > 0 ? 'good' : 'bad',
        `Тренд медианы просмотров: ${deep.trend.monthlyPct >= 0 ? '+' : ''}${deep.trend.monthlyPct.toFixed(1)} % в месяц ` +
        `(95 % ДИ ${deep.trend.lo.toFixed(1)}…${deep.trend.hi.toFixed(1)} %, R² = ${deep.trend.r2.toFixed(2)}).`);
    }
    // 3. переломы
    if (deep.changepoints.cuts.length) {
      push('neutral', `Переломы динамики: ${deep.changepoints.cuts.join(', ')} — ` +
        deep.changepoints.segments.map(s => `${s.from}…${s.to}: медиана ${Math.round(s.median)}`).join('; ') + '.');
    }
    // 4. лучший слот
    const best = deep.slots.cells.find(c => c.better) || deep.slots.cells[0];
    if (best) {
      const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      push(best.better ? 'good' : 'neutral',
        `Слот ${days[best.dow]} ${String(best.hour).padStart(2, '0')}:00 UTC — медиана ${Math.round(best.median)} ` +
        `(ДИ ${Math.round(best.lo)}…${Math.round(best.hi)}, n = ${best.n})${best.better ? ', значимо выше среднего по каналу' : '; значимого превосходства над средним нет'}.`);
    }
    // 5. драйверы
    const sig = deep.drivers.filter(d => d.significant).slice(0, 2);
    sig.forEach(d => push(d.cliff > 0 ? 'good' : 'bad',
      `С просмотрами связан признак «${d.feature}»: медиана ${Math.round(d.medianWith)} против ${Math.round(d.medianWithout)} ` +
      `(${d.lift >= 0 ? '+' : ''}${d.lift.toFixed(0)} %, p = ${d.p.toFixed(3)}, размер эффекта ${d.cliff.toFixed(2)}).`));
    // 6. рубрики
    const top = deep.rubrics.filter(r => r.count >= 8).sort((a, b) => b.lift - a.lift)[0];
    const worst = deep.rubrics.filter(r => r.count >= 8).sort((a, b) => a.lift - b.lift)[0];
    if (top && top.lift > 5) push('good', `Локомотив по охвату — «${top.name}»: ${top.count} постов, медиана ${Math.round(top.median)} (${top.lift >= 0 ? '+' : ''}${top.lift.toFixed(0)} % к медиане канала).`);
    if (worst && worst.lift < -20) push('bad', `Слабейшая рубрика — «${worst.name}»: ${worst.count} постов, медиана ${Math.round(worst.median)} (${worst.lift.toFixed(0)} %).`);
    // 7. тишина и служебные
    if (o.zeroView > 5) push('neutral', `Постов без просмотров: ${o.zeroView} — служебные записи и опросы; они занижают медианы, учитывайте при сравнении.`);
    // 8. дубли
    if (model.connections.stats.dupGroups > 3) push('bad',
      `Дубли и почти-дубли: ${model.connections.stats.dupGroups} групп (${model.connections.stats.dupPosts} постов) — часть охвата теряется на повторах.`);
    // 9. стиль
    const dr = deep.copy.drift;
    if (dr.length >= 3) {
      const a = dr[0], b = dr[dr.length - 1];
      push('neutral', `Дрейф стиля ${a.year} → ${b.year}: длина ${a.chars} → ${b.chars} знаков, ` +
        `эмодзи ${a.emoji} → ${b.emoji} на пост, фразы в среднем ${deep.copy.sent.median} слов, ` +
        `читабельность (Flesch) ${deep.copy.flesch.toFixed(0)}.`);
    }
    // 10. подписчики
    if (model.audience) {
      const au = model.audience;
      push(au.sanity === 'ok' ? 'neutral' : 'bad',
        `При ${Math.round(au.subs).toLocaleString('ru-RU')} подписчиках: охват поста ${au.reachMedian} %, ` +
        `ER по подписчикам ${au.erPerPost} %.${au.sanity !== 'ok' ? ' Значение охвата нетипично — проверьте число подписчиков.' : ''}`);
    }
    // 11. прогноз
    if (deep.forecast) {
      const p = deep.forecast.points[0];
      push(deep.forecast.trendMonthlyPct > 0 ? 'good' : 'bad',
        `Прогноз на ${p.month}: медиана просмотров ≈ ${Math.round(p.point).toLocaleString('ru-RU')} ` +
        `(интервал ${Math.round(p.lo).toLocaleString('ru-RU')}…${Math.round(p.hi).toLocaleString('ru-RU')}), ` +
        `тренд ${deep.forecast.trendMonthlyPct >= 0 ? '+' : ''}${deep.forecast.trendMonthlyPct.toFixed(1)} % в месяц.`);
    }
    // 11.5 эффект соседства
    const nb = deep.neighbourhood;
    if (nb && nb.burstTest) {
      const d = nb.daysBusy.median - nb.daysCalm.median;
      const tiny = Math.abs(d) < 0.1 || Math.abs(nb.burstTest.cliff) < 0.1;
      push(tiny ? 'neutral' : d < 0 ? 'bad' : 'good',
        `Плотные дни (2+ поста): ${nb.daysBusy.median.toFixed(2)} против ${nb.daysCalm.median.toFixed(2)} в дни с одним постом ` +
        `(${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)} п.п., p = ${nb.burstTest.p.toFixed(3)}, размер эффекта ${nb.burstTest.cliff.toFixed(2)}, ` +
        `n = ${nb.daysBusy.n}/${nb.daysCalm.n}; сравнение на данных, очищенных от тренда)` +
        (tiny ? ' — разница мала по величине, практического вывода нет.' : '.'));
    }
    if (nb && nb.spearmanPrev != null) {
      const r = nb.spearmanPrev;
      const verdict = Math.abs(r) < 0.15
        ? 'переноса нет: успех или провал поста почти не влияет на следующий'
        : r > 0
          ? 'есть перенос: после удачного поста следующий чаще тоже собирает больше обычного'
          : 'обратный эффект: после удачного поста следующий проседает';
      push(Math.abs(r) < 0.15 ? 'good' : 'neutral',
        `Связь с предыдущим постом (без влияния тренда): Спирмен ${r.toFixed(2)} — ${verdict}. ` +
        `Медианный интервал между постами ${nb.medianGapHours.toFixed(1)} ч.`);
    }
    // 12. качество текста
    if (deep.copy.sent.longShare > 25) push('bad',
      `Каждая ${Math.round(100 / deep.copy.sent.longShare)}-я фраза длиннее 25 слов (${deep.copy.sent.longShare.toFixed(0)} % предложений) — читаемость падает.`);
    if (deep.copy.clichePer100 > 15) push('bad',
      `Штампы: ${deep.copy.clichePer100.toFixed(0)} постов на 100 содержат клише (${deep.copy.clicheList.slice(0, 2).map(c => `«${c.phrase}»`).join(', ')}).`);
    return out;
  }

  // ---------- нормализация от общего тренда ----------
  // просмотры делим на медиану соседних по времени постов: так сравнение не ловит «эпоху»,
  // в которой вышел пост, а показывает отклонение от текущего уровня канала
  function detrended(list, windowDays = 15) {
    const out = [];
    const half = windowDays * 86400000;
    for (const p of list) {
      const t = new Date(p.date).getTime();
      const around = [];
      for (const q of list) {
        const tq = new Date(q.date).getTime();
        if (Math.abs(tq - t) <= half && q.views > 0) around.push(q.views);
      }
      const base = median(around) || p.views || 1;
      out.push({ p, ratio: p.views / base });
    }
    return out;
  }

  // ---------- эффект соседства: как связаны просмотры с частотой и предыдущим постом ----------
  function neighbourhood(posts) {
    const list = posts.filter(p => p.views > 0)
      .slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    if (list.length < 30) return null;
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      const dt = (new Date(list[i].date) - new Date(list[i - 1].date)) / 3600000;   // часы
      gaps.push({ p: list[i], prev: list[i - 1], hours: dt, prevViews: list[i - 1].views });
    }
    const BUCKETS = [
      ['до 1 ч', h => h < 1],
      ['1–3 ч', h => h >= 1 && h < 3],
      ['3–6 ч', h => h >= 3 && h < 6],
      ['6–24 ч', h => h >= 6 && h < 24],
      ['больше суток', h => h >= 24],
    ];
    const norm = new Map(detrended(list).map(x => [x.p, x.ratio]));
    const all = list.map(p => norm.get(p));
    const base = 1;                                     // нормализованная база = «как обычно у канала»
    const byGap = BUCKETS.map(([name, test]) => {
      const inside = gaps.filter(g => test(g.hours)).map(g => norm.get(g.p));
      const outside = gaps.filter(g => !test(g.hours)).map(g => norm.get(g.p));
      if (inside.length < 15 || outside.length < 15) return { name, n: inside.length, median: inside.length ? median(inside) : 0, lift: null, p: null, cliff: null };
      const t = compareGroups(inside, outside);
      return { name, n: inside.length, median: median(inside), lift: (median(inside) - base) * 100, p: t.p, cliff: t.cliff };
    });
    // перенос: связь просмотров с предыдущим постом и с частотой дня
    const rho = spearman(gaps.map(g => norm.get(g.prev)), gaps.map(g => norm.get(g.p)));
    const perDay = {};
    list.forEach(p => {
      const day = p.date.slice(0, 10);
      (perDay[day] = perDay[day] || []).push(p);
    });
    const dayRows = Object.entries(perDay).map(([day, ps]) => ({ day, n: ps.length, median: median(ps.map(x => norm.get(x))) }));
    const busy = dayRows.filter(d => d.n >= 2).map(d => d.median);
    const calm = dayRows.filter(d => d.n === 1).map(d => d.median);
    const bursts = (busy.length >= 15 && calm.length >= 15) ? compareGroups(busy, calm) : null;
    return {
      gaps: byGap, spearmanPrev: rho, base: 1, normalized: true,
      daysBusy: { n: busy.length, median: busy.length ? median(busy) : 0 },
      daysCalm: { n: calm.length, median: calm.length ? median(calm) : 0 },
      burstTest: bursts,
      medianGapHours: median(gaps.map(g => g.hours)),
    };
  }

  function analyzeDeep(posts, model) {
    const withViews = posts.filter(p => p.views > 0);
    const medViews = median(withViews.map(p => p.views));
    const zs = robustZ(withViews.map(p => p.views));
    const outliers = withViews.map((p, i) => ({ p, z: zs[i] })).filter(x => x.z > 3.5).sort((a, b) => b.z - a.z);
    const monthlySeries = model.monthly.filter(m => m.count >= 2)
      .map(m => ({ label: m.month, value: m.viewsMedian }));

    const deep = {
      medianCI: bootstrapCI(withViews.map(p => p.views), { seed: 42, iters: 600 }),
      meanCI: meanCI(withViews.map(p => p.views)),
      trend: trend(monthlySeries.map(s => [s.label, s.value])),
      changepoints: changepoints(monthlySeries),
      outliers: outliers.slice(0, 20),
      drivers: drivers(posts),
      slots: slots(posts),
      rubrics: rubrics(posts),
      copy: copyQuality(posts),
      neighbourhood: neighbourhood(posts),
      median: medViews,
    };
    deep.forecast = forecast(model.monthly);
    deep.findings = findings(model, deep);
    return deep;
  }

  global.TGA2 = {
    analyzeDeep, drivers, slots, rubrics, copyQuality, forecast, findings, neighbourhood, detrended,
    mannWhitneyU, compareGroups, qmedian, normalCdf,
    bootstrapCI, meanCI, permutationTest, mannWhitneyU, cliffsDelta, robustZ, spearman, trend, changepoints,
    mulberry32, rubricOf, features,
  };
})(window);
