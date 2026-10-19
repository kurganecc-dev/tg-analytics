/* compete.js — сравнение каналов: A/B со статистикой, распределения, темы, стиль, рейтинг.
   Требование честности: если период у каналов разный, сравнение считается ещё и на пересечении дат. */
(function (global) {
  'use strict';
  const A = global.TGA;
  const D = global.TGA2;
  const median = A.median, pct = A.pct;

  function period(posts) {
    const ds = posts.map(p => p.date).filter(Boolean).sort();
    return ds.length ? { from: ds[0].slice(0, 10), to: ds[ds.length - 1].slice(0, 10) } : null;
  }

  // обрезка обоих каналов до общего периода — иначе эпохи разные и сравнение ложно
  function overlapSlice(list) {
    const periods = list.map(ps => period(ps));
    if (periods.some(p => !p)) return null;
    const from = periods.map(p => p.from).sort().pop();
    const to = periods.map(p => p.to).sort()[0];
    if (from > to) return null;
    return { from, to, slices: list.map(ps => ps.filter(p => p.date.slice(0, 10) >= from && p.date.slice(0, 10) <= to)) };
  }

  function channelStats(posts, subs) {
    const withV = posts.filter(p => p.views > 0);
    const views = withV.map(p => p.views);
    const react = posts.map(p => p.reactions);
    const erPost = withV.map(p => p.views ? (100 * p.reactions) / p.views : 0);
    const span = period(posts);
    let days = 1;
    if (span) days = Math.max(1, (new Date(span.to) - new Date(span.from)) / 86400000);
    const chars = posts.map(p => A.clen(p.text));
    const emoji = posts.map(p => A.emojiCount(p.text));
    const share = (re) => posts.length ? (100 * posts.filter(p => re.test(p.text)).length) / posts.length : 0;
    const aud = subs ? A.audienceMetrics(posts, subs) : null;
    return {
      posts: posts.length, period: span, days,
      perWeek: (posts.length / days) * 7,
      viewsMedian: median(views), viewsMean: views.length ? views.reduce((a, b) => a + b, 0) / views.length : 0,
      viewsP90: A.percentile(views, 90), virality: median(views) ? A.percentile(views, 90) / median(views) : 0,
      reactMedian: median(react), reactPerPost: posts.length ? react.reduce((a, b) => a + b, 0) / posts.length : 0,
      erByViews: views.length ? (100 * react.reduce((a, b) => a + b, 0)) / views.reduce((a, b) => a + b, 0) : 0,
      erMedianPost: median(erPost),
      charsMedian: median(chars), emojiMedian: median(emoji),
      quoteShare: share(/«/), sourceShare: share(/по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик/i),
      ctaShare: share(/подписывайт|по ссылк|оставляйт\w* заявк|листайт/i),
      linkShare: share(/https?:\/\//),
      hypeShare: share(/шок|сенсаци|уникальный шанс|вы не поверите/i),
      audience: aud,
    };
  }

  // z-тест для долей (два независимых пула)
  function proportionsTest(k1, n1, k2, n2) {
    if (!n1 || !n2) return null;
    const p1 = k1 / n1, p2 = k2 / n2, pool = (k1 + k2) / (n1 + n2);
    const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
    const z = se ? (p1 - p2) / se : 0;
    return { p: 2 * (1 - D.normalCdf(Math.abs(z))), z, delta: p1 - p2 };
  }

  // метрика: числовая (Манн—Уитни + Клифф) или доля (z-тест)
  function metricRow(name, a, b, kind, opts = {}) {
    const row = { name, kind, a: opts.aValue, b: opts.bValue,
      higherBetter: opts.higherBetter === undefined ? true : opts.higherBetter };
    if (kind === 'proportion') {
      const k1 = a.filter(Boolean).length, k2 = b.filter(Boolean).length;
      const t = proportionsTest(k1, a.length, k2, b.length);
      Object.assign(row, {
        a: 100 * k1 / (a.length || 1), b: 100 * k2 / (b.length || 1),
        diffPct: t ? t.delta * 100 : 0, p: t ? t.p : null, effect: t ? t.delta : null,
        suffix: '%',
      });
    } else {
      const t = D.compareGroups(a, b);
      const va = opts.aValue != null ? opts.aValue : median(a);
      const vb = opts.bValue != null ? opts.bValue : median(b);
      Object.assign(row, {
        a: va, b: vb,
        diffPct: vb ? ((va - vb) / vb) * 100 : 0,
        p: t.p, effect: t.cliff, suffix: opts.suffix || '',
      });
    }
    const minEffect = 0.1;
    row.significant = row.p != null && row.p < 0.05 && Math.abs(row.effect) >= minEffect;
    if (row.p == null) row.verdict = 'мало данных';
    else if (row.p >= 0.05) row.verdict = 'не доказано';
    else if (Math.abs(row.effect) < minEffect) row.verdict = 'различие мало';
    else if (row.higherBetter === null) row.verdict = row.a > row.b ? 'A больше' : 'B больше';
    else row.verdict = (row.a > row.b) === row.higherBetter ? 'A лучше' : 'B лучше';
    return row;
  }

  function headToHead(postsA, postsB, subsA, subsB) {
    const withA = postsA.filter(p => p.views > 0), withB = postsB.filter(p => p.views > 0);
    const rows = [
      metricRow('Медиана просмотров', withA.map(p => p.views), withB.map(p => p.views), 'number'),
      metricRow('Средние просмотры', withA.map(p => p.views), withB.map(p => p.views), 'number',
        { aValue: withA.length ? withA.reduce((s, p) => s + p.views, 0) / withA.length : 0, bValue: withB.length ? withB.reduce((s, p) => s + p.views, 0) / withB.length : 0 }),
      metricRow('P90 просмотров', withA.map(p => p.views), withB.map(p => p.views), 'number',
        { aValue: A.percentile(withA.map(p => p.views), 90), bValue: A.percentile(withB.map(p => p.views), 90) }),
      metricRow('Медиана реакций', postsA.map(p => p.reactions), postsB.map(p => p.reactions), 'number'),
      metricRow('ER поста (медиана), %', withA.map(p => (100 * p.reactions) / p.views), withB.map(p => (100 * p.reactions) / p.views), 'number'),
      metricRow('Длина поста, знаков', postsA.map(p => A.clen(p.text)), postsB.map(p => A.clen(p.text)), 'number', { higherBetter: null }),
      metricRow('Эмодзи на пост', postsA.map(p => A.emojiCount(p.text)), postsB.map(p => A.emojiCount(p.text)), 'number', { higherBetter: null }),
      metricRow('Постов с источником', postsA.map(p => /по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик/i.test(p.text)), postsB.map(p => /по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик/i.test(p.text)), 'proportion'),
      metricRow('Постов с «ёлочками»', postsA.map(p => p.text.includes('«')), postsB.map(p => p.text.includes('«')), 'proportion'),
      metricRow('Постов с призывом', postsA.map(p => /подписывайт|по ссылк|оставляйт\w* заявк|листайт/i.test(p.text)), postsB.map(p => /подписывайт|по ссылк|оставляйт\w* заявк|листайт/i.test(p.text)), 'proportion'),
      metricRow('Постов с внешней ссылкой', postsA.map(p => /https?:\/\//.test(p.text)), postsB.map(p => /https?:\/\//.test(p.text)), 'proportion'),
    ];
    return rows;
  }

  function percentileTable(posts) {
    const v = posts.filter(p => p.views > 0).map(p => p.views);
    return { n: v.length, p10: A.percentile(v, 10), p25: A.percentile(v, 25), p50: median(v), p75: A.percentile(v, 75), p90: A.percentile(v, 90), max: Math.max(...v, 0) };
  }

  // темы: доля и «превышение» над собственной медианой канала
  function topicMatrix(channels) {
    const names = new Set();
    const per = channels.map(ch => {
      const map = {};
      ch.posts.forEach(p => {
        const t = p.topic || A.topicOf(p.text);
        (map[t] = map[t] || []).push(p);
        names.add(t);
      });
      const base = median(ch.posts.filter(p => p.views > 0).map(p => p.views));
      const out = {};
      Object.entries(map).forEach(([t, list]) => {
        const views = list.filter(p => p.views > 0).map(p => p.views);
        out[t] = {
          count: list.length, share: (100 * list.length) / ch.posts.length,
          median: median(views), lift: base && views.length ? ((median(views) - base) / base) * 100 : 0,
        };
      });
      return out;
    });
    return { names: Array.from(names), per };
  }

  // по месяцам, выровненные по меткам (для наложения графиков)
  function alignMonthly(models) {
    const labels = Array.from(new Set(models.flatMap(m => m.monthly.map(x => x.month)))).sort();
    const series = models.map(m => {
      const map = new Map(m.monthly.map(x => [x.month, x]));
      return labels.map(l => (map.get(l) ? map.get(l).viewsMedian : null));
    });
    return { labels, series };
  }

  function indexed(series) {
    // приведение к 100 на первом непустом значении: сравнение формы, а не масштаба
    return series.map(line => {
      const first = line.find(v => v != null && v > 0);
      return line.map(v => (v == null || !first) ? null : (100 * v) / first);
    });
  }

  function leaderboard(items, key, higherBetter = true) {
    const valid = items.filter(i => typeof i[key] === 'number' && isFinite(i[key]));
    const sorted = valid.slice().sort((a, b) => higherBetter ? b[key] - a[key] : a[key] - b[key]);
    return sorted.map((it, i) => ({
      ...it, rank: i + 1, of: sorted.length,
      toBest: sorted[0] && sorted[0][key] ? ((it[key] - sorted[0][key]) / Math.abs(sorted[0][key])) * 100 : 0,
    }));
  }

  global.TGA3 = { period, overlapSlice, channelStats, headToHead, metricRow, proportionsTest, percentileTable, topicMatrix, alignMonthly, indexed, leaderboard };
})(window);
