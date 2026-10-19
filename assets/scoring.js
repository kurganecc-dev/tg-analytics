/* scoring.js — оценка черновика поста: попадёт ли выше медианы канала, почему, и чек-лист стиля.
   Модель: логистическая регрессия на признаках текста и слота, обученная на истории канала.
   Всё детерминировано (полный градиентный спуск, фиксированные итерации) — чтобы расчёт можно было
   перепроверить независимой реализацией на Python. */
(function (global) {
  'use strict';
  const A = global.TGA, D = global.TGA2;
  const median = A.median;

  // ---------- признаки (порядок фиксирован: от него зависит сопоставимость с проверкой) ----------
  const BIN = [
    'эмодзи-маркер в первой строке', 'цифра в заголовке', 'вопрос в первой строке', 'восклицание в первой строке',
    'заголовок с двоеточием', 'цитата эксперта «…»', 'должность + компания', 'ссылка на источник',
    'список 🔴', 'тире-список', 'нумерованный список', 'заканчивается вопросом', 'финал-эмодзи',
    'хэштег', 'внешняя ссылка', 'длинный пост (>800 знаков)', 'короткий пост (<250 знаков)',
    'много эмодзи (>5)', 'без эмодзи', 'абзацев ≥ 4', 'цифра/процент в теле',
  ];
  const HOUR_BANDS = ['ночь 00–05', 'утро 06–11', 'день 12–17', 'вечер 18–23'];
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const RUBRIC_TOP = 6;                     // рубрики-дамы: 5 признаков, база — самая частая рубрика канала

  function bandOf(hour) {
    if (hour < 6) return 0;
    if (hour < 12) return 1;
    if (hour < 18) return 2;
    return 3;
  }

  // слот: либо из даты поста, либо передан пользователем (плановая публикация)
  function slotOf(post, slot) {
    if (slot && slot.dow != null && slot.hour != null) return slot;
    const d = new Date(post.date);
    if (isNaN(d)) return { dow: 0, hour: 18 };
    return { dow: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };   // 0 = Пн
  }

  // context нужен для признаков, которые нельзя посчитать по одному тексту
  function vector(text, post, slot, ctx, rubrics) {
    const f = D.features({ text, views: 0, reactions: 0, date: '', url: '' });
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const emoji = A.emojiCount(text);
    const c = ctx || {};
    const x = [];
    BIN.forEach(k => x.push(f[k] ? 1 : 0));                       // 21 бинарный признак
    x.push(Math.log(A.clen(text) + 1));                            // длина в знаках (лог)
    x.push(Math.log(emoji + 1));                                   // эмодзи
    x.push(Math.min(30, lines.length));                            // абзацев
    x.push(c.postsInDay == null ? NaN : Math.min(10, c.postsInDay));                 // конкурентов в тот же день
    x.push(c.hoursSincePrev == null ? NaN : Math.log1p(Math.min(240, c.hoursSincePrev)));   // пауза с прошлого поста
    const s = slotOf(post || { date: '' }, slot);
    const band = bandOf(s.hour);
    x.push(band === 1 ? 1 : 0); x.push(band === 2 ? 1 : 0); x.push(band === 3 ? 1 : 0);   // база: ночь
    const dow = ((s.dow % 7) + 7) % 7;
    for (let k = 1; k <= 6; k++) x.push(dow === k ? 1 : 0);        // база: понедельник
    if (rubrics) {
      const r = D.rubricOf({ text });
      rubrics.slice(1).forEach(name => x.push(r === name ? 1 : 0));   // база: самая частая рубрика
    }
    return x;
  }

  function names(rubrics) {
    const out = BIN.slice();
    out.push('длина (лог знаков)', 'эмодзи (лог)', 'абзацев');
    out.push('постов в тот же день', 'пауза с прошлого поста');
    out.push('утро 06–11', 'день 12–17', 'вечер 18–23');
    WEEKDAYS.slice(1).forEach(d => out.push(d));
    if (rubrics) rubrics.slice(1).forEach(r => out.push('рубрика: ' + r));
    return out;
  }

  // какие рубрики попадут в модель: самые частые, базовая — первая
  function topRubrics(posts) {
    const cnt = {};
    posts.forEach(p => {
      const r = D.rubricOf(p);
      cnt[r] = (cnt[r] || 0) + 1;
    });
    return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, RUBRIC_TOP).map(e => e[0]);
  }

  // медиана постов в окне ±дней: цель модели — «выше типичного для этих же месяцев»,
  // иначе модель учится на падении просмотров по годам, а не на тексте
  function localMedians(sorted, halfDays) {
    const t = sorted.map(p => new Date(p.date).getTime());
    const half = halfDays * 86400000;
    const out = [];
    let lo = 0, hi = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (lo < i && t[i] - t[lo] > half) lo++;
      while (hi + 1 < sorted.length && t[hi + 1] - t[i] <= half) hi++;
      const from = Math.min(lo, i), to = Math.max(hi, i);
      const vals = [];
      for (let j = from; j <= to; j++) vals.push(sorted[j].views);
      out.push({ median: median(vals), n: vals.length });
    }
    return out;
  }

  // ---------- обучение ----------
  function sigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }

  function standardize(X) {
    const n = X.length, p = X[0].length;
    const mean = new Array(p).fill(0), sd = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j];
      mean[j] = s / n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (X[i][j] - mean[j]) ** 2;
      sd[j] = Math.sqrt(v / n) || 1;
    }
    return { mean, sd, Z: X.map(row => row.map((v, j) => (v - mean[j]) / sd[j])) };
  }

  function fit(Z, y, { iters = 400, lr = 0.5, l2 = 0.01 } = {}) {
    const n = Z.length, p = Z[0].length;
    const w = new Array(p).fill(0);
    let b = 0;
    for (let it = 0; it < iters; it++) {
      const gw = new Array(p).fill(0);
      let gb = 0;
      for (let i = 0; i < n; i++) {
        let z = b;
        for (let j = 0; j < p; j++) z += w[j] * Z[i][j];
        const e = sigmoid(z) - y[i];
        for (let j = 0; j < p; j++) gw[j] += e * Z[i][j];
        gb += e;
      }
      for (let j = 0; j < p; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
      b -= lr * (gb / n);
    }
    return { w, b };
  }

  function auc(scores, labels) {
    const pairs = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
    const n = pairs.length;
    let rankSumPos = 0, pos = 0, neg = 0;
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && pairs[j + 1][0] === pairs[i][0]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) {
        if (pairs[k][1] === 1) { rankSumPos += r; pos++; } else neg++;
      }
      i = j + 1;
    }
    if (!pos || !neg) return null;
    return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
  }

  // континуальные блоки по времени: соседние посты коррелируют, случайный сплит завышает качество
  function foldsByTime(n, k = 5) {
    const out = [];
    const size = Math.floor(n / k);
    for (let i = 0; i < k; i++) {
      const from = i * size, to = i === k - 1 ? n : (i + 1) * size;
      out.push({ from, to });
    }
    return out;
  }

  function train(posts, { slot, halfDays = 45, minWindow = 20 } = {}) {
    const withV = posts.filter(p => p.views > 0);
    if (withV.length < 60) return null;
    const sorted = withV.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const lm = localMedians(sorted, halfDays);
    const thr = median(sorted.map(p => p.views));
    // считаем контекст: сколько постов в тот же день и какая пауза с предыдущего
    const dayCount = {}, times = [];
    sorted.forEach(p => {
      const d = p.date.slice(0, 10);
      dayCount[d] = (dayCount[d] || 0) + 1;
      times.push(new Date(p.date).getTime());
    });
    const rubrics = topRubrics(sorted);
    const keep = [], y = [];
    sorted.forEach((p, i) => {
      if (lm[i].n < minWindow) return;
      keep.push(i);
      y.push(p.views > lm[i].median ? 1 : 0);
    });
    const X = keep.map(i => {
      const p = sorted[i];
      const ctx = {
        postsInDay: dayCount[p.date.slice(0, 10)],
        hoursSincePrev: i > 0 ? (times[i] - times[i - 1]) / 3600000 : null,
      };
      return vector(p.text, p, slot === undefined ? null : slot, ctx, rubrics);
    });
    // NaN (неизвестная пауза) заменяем средним по колонке — иначе стандартизация ломается
    const p0 = X[0].length;
    for (let j = 0; j < p0; j++) {
      let s = 0, n = 0;
      for (const row of X) if (!isNaN(row[j])) { s += row[j]; n++; }
      const fill = n ? s / n : 0;
      for (const row of X) if (isNaN(row[j])) row[j] = fill;
    }
    const { mean, sd, Z } = standardize(X);
    const model = fit(Z, y);
    const folds = foldsByTime(Z.length).map((f, idx) => {
      const tr = [], te = [];
      Z.forEach((row, i) => (i >= f.from && i < f.to ? te : tr).push(i));
      if (tr.length < 40 || te.length < 10) return null;
      const Ztr = tr.map(i => Z[i]), ytr = tr.map(i => y[i]);
      const m = fit(Ztr, ytr);
      const scores = te.map(i => {
        let z = m.b;
        for (let j = 0; j < m.w.length; j++) z += m.w[j] * Z[i][j];
        return z;
      });
      const labels = te.map(i => y[i]);
      const a = auc(scores, labels);
      const acc = scores.reduce((s, z, k) => s + ((z > 0 ? 1 : 0) === labels[k] ? 1 : 0), 0) / scores.length;
      return { fold: idx + 1, n: te.length, auc: a, accuracy: acc };
    }).filter(Boolean);
    const baseRate = y.reduce((a, b) => a + b, 0) / y.length;
    return {
      names: names(rubrics), w: model.w, b: model.b, mean, sd, thr, rubrics, halfDays,
      n: y.length, positives: y.reduce((a, b) => a + b, 0), baseRate,
      folds, aucMean: folds.length ? folds.reduce((s, f) => s + f.auc, 0) / folds.length : null,
      liftOverRandom: folds.length ? folds.reduce((s, f) => s + f.auc, 0) / folds.length - 0.5 : null,
      aucMin: folds.length ? Math.min(...folds.map(f => f.auc)) : null,
      aucMax: folds.length ? Math.max(...folds.map(f => f.auc)) : null,
      accMean: folds.length ? folds.reduce((s, f) => s + f.accuracy, 0) / folds.length : null,
      accBaseline: folds.length ? folds.reduce((s, f) => s + Math.max(f.accuracy, 1 - f.accuracy), 0) / folds.length : null,
      majority: Math.max(baseRate, 1 - baseRate),
      enough: y.length >= 150,
    };
  }

  // типичный пост канала в последние 60 дней — чтобы «порог» в интерфейсе был не абстрактным
  function localLevel(posts) {
    const withV = posts.filter(p => p.views > 0).sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!withV.length) return 0;
    const last = new Date(withV[withV.length - 1].date).getTime();
    const recent = withV.filter(p => last - new Date(p.date).getTime() <= 60 * 86400000);
    return median((recent.length >= 10 ? recent : withV.slice(-30)).map(p => p.views));
  }

  function scoreText(model, text, slot, ctx) {
    if (!model) return null;
    const c = ctx || { postsInDay: null, hoursSincePrev: null };
    const x = vector(text, null, slot, c, model.rubrics);
    x.forEach((v, j) => { if (isNaN(v)) x[j] = model.mean[j]; });   // контекст неизвестен — считаем его обычным
    const z = x.map((v, j) => (v - model.mean[j]) / model.sd[j]);
    let logit = model.b;
    const contrib = [];
    model.names.forEach((name, j) => {
      const c = model.w[j] * z[j];
      logit += c;
      contrib.push({ name, contribution: c, value: x[j], binary: BIN.indexOf(name) >= 0, mean: model.mean[j] });
    });
    contrib.sort((a, b) => b.contribution - a.contribution);
    const prob = sigmoid(logit);
    return {
      prob, logit, localMedian: c.medianLevel != null ? c.medianLevel : model.thr,
      pro: contrib.slice(0, 5).filter(c => c.contribution > 0.01),
      contra: contrib.slice(-5).filter(c => c.contribution < -0.01).reverse(),
      threshold: model.thr,
    };
  }

  // ---------- чек-лист стиля (компактная версия правил «Этажей») ----------
  function checklist(text) {
    const L = text.split('\n').map(s => s.trim()).filter(Boolean);
    const first = L[0] || '';
    const markerOnly = /^[\s:.,;!?%«»—–-]*$/u.test(first.replace(A.EMO_G, ''));
    const head = (markerOnly && L[1]) ? L[1] : first;
    const items = [
      ['эмодзи-маркер отдельной строкой', markerOnly && A.EMO_RE.test(first), 'первая строка — только эмодзи, текст со второй'],
      ['заголовок-факт без точки', head.length > 0 && !head.endsWith('.'), 'заголовок не заканчивается точкой'],
      ['цифра в заголовке', /\d/.test(head), 'цифра или процент в первой строке'],
      ['«Этажи» в ёлочках', !/Этаж/i.test(text) || /«Этаж/i.test(text), 'упоминание бренда — в кавычках-ёлочках'],
      ['кавычки без прямых "', !/"/.test(text), 'прямых кавычек нет'],
      ['«риелтор» через «и»', !/риэлтор/i.test(text), 'по правилам компании — «риелтор»'],
      ['проценты слитно', !/\d\s+%/.test(text), 'проценты пишутся слитно: 8%, без пробела перед знаком'],
      ['нет двойных пробелов', !/\S  +\S/.test(text), 'двойные пробелы не нужны'],
      ['фраза короче 32 слов', L.every(l => !l.split(/[.!?…]+/).some(s => (s.match(/[а-яА-ЯёЁa-zA-Z]{2,}/g) || []).length > 32)), 'длинные фразы разбить'],
      ['есть ссылка на источник', /по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|Домклик|Росреестр|ЦБ|ДОМ\.РФ|URA|72\.RU/i.test(text), 'в новостях указывать источник'],
      ['есть финал: призыв или эмодзи', /подписывайт|по ссылк|оставляйт|листайт|приходите|читайте/i.test(text) || /^[\p{Extended_Pictographic}\uFE0F\s]+$/u.test(L[L.length - 1] || ''), 'финал — призыв, ссылка или эмодзи-акцент'],
      ['нет хайпа', !/шок|сенсаци|уникальный шанс|вы не поверите/i.test(text), 'хайп-лексика запрещена'],
      ['нет канцелярита', !/осуществля|в рамках реализац|производится оформлен|данный объект/i.test(text), 'канцелярит убрать'],
      ['нет гарантий', !/гарантированн[а-яё]* доход|100% одобрен|гарантируем одобрен/i.test(text), 'гарантии и обещания недопустимы'],
    ];
    return items.map(([name, ok, hint]) => ({ name, ok: !!ok, hint }));
  }

  global.TGA4 = { train, scoreText, checklist, vector, names, auc, foldsByTime, fit, standardize, sigmoid, BIN, localMedians, topRubrics, localLevel };
})(window);
