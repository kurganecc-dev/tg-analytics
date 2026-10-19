/* charts.js — минималистичная библиотека графиков на чистом SVG (без зависимостей).
   Все функции: (el, data, opts) → рисуют внутрь el. Тема — через CSS-переменные. */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs = {}, text) {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(w, h) {
    const s = el('svg', { viewBox: `0 0 ${w} ${h}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' });
    return s;
  }
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const f = v / p;
    const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * p;
  }
  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1).replace('.0', '') + ' тыс';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + ' тыс';
    return String(Math.round(n * 100) / 100);
  }
  function tip(node, html) {
    node.addEventListener('mousemove', e => {
      let t = document.getElementById('chart-tip');
      if (!t) {
        t = document.createElement('div'); t.id = 'chart-tip'; document.body.appendChild(t);
      }
      t.innerHTML = html;
      t.style.left = (e.clientX + 14) + 'px';
      t.style.top = (e.clientY - 10) + 'px';
      t.style.opacity = 1;
    });
    node.addEventListener('mouseleave', () => {
      const t = document.getElementById('chart-tip'); if (t) t.style.opacity = 0;
    });
  }

  // ---------- линейный график (несколько серий) ----------
  function lineChart(host, { labels, series, yLabel = '', height = 260, logScale = false, area = true }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 16, r: 14, b: 34, l: 52 };
    const s = svg(W, H);
    const all = series.flatMap(x => x.values).filter(v => v != null && !isNaN(v));
    if (!all.length) { host.appendChild(s); return; }
    let min = Math.min(...all), max = Math.max(...all);
    if (logScale) { min = Math.max(1, min); max = Math.max(10, max); }
    else { min = Math.min(0, min); }
    max = niceMax(max);
    const X = i => P.l + (labels.length === 1 ? 0 : (i * (W - P.l - P.r)) / (labels.length - 1));
    const Y = v => {
      if (logScale) {
        const lv = Math.log10(Math.max(min, v)), l0 = Math.log10(min), l1 = Math.log10(max);
        return H - P.b - ((lv - l0) / (l1 - l0 || 1)) * (H - P.t - P.b);
      }
      return H - P.b - ((v - min) / (max - min || 1)) * (H - P.t - P.b);
    };
    // сетка
    for (let g = 0; g <= 4; g++) {
      const v = min + ((max - min) * g) / 4;
      s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      s.appendChild(el('text', { x: P.l - 8, y: Y(v) + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)));
    }
    // деления по X
    const step = Math.max(1, Math.ceil(labels.length / 8));
    labels.forEach((lb, i) => {
      if (i % step) return;
      s.appendChild(el('text', { x: X(i), y: H - 12, class: 'axis', 'text-anchor': 'middle' }, lb));
    });
    series.forEach(ser => {
      const pts = ser.values.map((v, i) => v == null ? null : [X(i), Y(v)]).filter(Boolean);
      if (!pts.length) return;
      if (area && series.length === 1) {
        s.appendChild(el('path', {
          d: `M ${pts[0][0]} ${H - P.b} ` + pts.map(p => `L ${p[0]} ${p[1]}`).join(' ') + ` L ${pts[pts.length - 1][0]} ${H - P.b} Z`,
          class: 'fill', fill: ser.color || 'var(--accent)',
        }));
      }
      s.appendChild(el('path', {
        d: 'M ' + pts.map(p => `${p[0]} ${p[1]}`).join(' L '),
        fill: 'none', stroke: ser.color || 'var(--accent)', 'stroke-width': ser.width || 2, 'stroke-linejoin': 'round',
      }));
      if (ser.dots !== false && labels.length <= 90) {
        pts.forEach((p, i) => {
          const c = el('circle', { cx: p[0], cy: p[1], r: 2.6, fill: ser.color || 'var(--accent)', class: 'pt' });
          tip(c, `<b>${esc(labels[series[0].values.indexOf(ser.values[i])] || labels[i] || '')}</b><br>${esc(ser.name)}: ${fmt(ser.values[i])}`);
          s.appendChild(c);
        });
      }
    });
    host.appendChild(s);
    host.appendChild(legend(series));
  }

  // ---------- столбики ----------
  function barChart(host, { labels, values, color = 'var(--accent)', height = 260, horizontal = false, valueFmt = fmt, tipFmt }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const s = svg(W, H);
    if (!values.length) { host.appendChild(s); return; }
    const max = niceMax(Math.max(...values, 1));
    if (horizontal) {
      const P = { t: 8, r: 60, b: 8, l: 150 };
      const bh = (H - P.t - P.b) / values.length;
      values.forEach((v, i) => {
        const w = ((W - P.l - P.r) * v) / max;
        const y = P.t + i * bh;
        const r = el('rect', { x: P.l, y: y + bh * 0.18, width: Math.max(1, w), height: bh * 0.64, rx: 3, fill: color, class: 'bar' });
        tip(r, tipFmt ? tipFmt(i) : `<b>${esc(labels[i])}</b><br>${valueFmt(v)}`);
        s.appendChild(r);
        s.appendChild(el('text', { x: P.l - 8, y: y + bh * 0.62, class: 'axis', 'text-anchor': 'end' }, String(labels[i]).slice(0, 26)));
        s.appendChild(el('text', { x: P.l + w + 6, y: y + bh * 0.62, class: 'axis value' }, valueFmt(v)));
      });
    } else {
      const P = { t: 16, r: 10, b: 46, l: 52 };
      const bw = (W - P.l - P.r) / values.length;
      for (let g = 0; g <= 4; g++) {
        const v = (max * g) / 4, y = H - P.b - ((v / max) * (H - P.t - P.b));
        s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid' }));
        s.appendChild(el('text', { x: P.l - 8, y: y + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)));
      }
      values.forEach((v, i) => {
        const h = ((v / max) * (H - P.t - P.b));
        const x = P.l + i * bw;
        const r = el('rect', { x: x + bw * 0.15, y: H - P.b - h, width: bw * 0.7, height: Math.max(1, h), rx: 3, fill: color, class: 'bar' });
        tip(r, tipFmt ? tipFmt(i) : `<b>${esc(labels[i])}</b><br>${valueFmt(v)}`);
        s.appendChild(r);
        const stp = Math.max(1, Math.ceil(values.length / 12));
        if (i % stp === 0) s.appendChild(el('text', { x: x + bw / 2, y: H - 26, class: 'axis', 'text-anchor': 'middle' }, String(labels[i]).slice(0, 12)));
      });
    }
    host.appendChild(s);
  }

  // ---------- гистограмма (лог-шкала по X) ----------
  function histogram(host, { values, buckets = 12, height = 220, log = true, label = 'просмотры' }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 14, r: 12, b: 40, l: 52 };
    const s = svg(W, H);
    const pos = values.filter(v => v > 0);
    if (!pos.length) { host.appendChild(s); return; }
    const lo = log ? Math.log10(Math.max(1, Math.min(...pos))) : Math.min(...pos);
    const hi = log ? Math.log10(Math.max(...pos)) : Math.max(...pos);
    const counts = new Array(buckets).fill(0), centers = [];
    pos.forEach(v => {
      const x = log ? Math.log10(v) : v;
      let i = Math.floor(((x - lo) / (hi - lo || 1)) * buckets);
      i = Math.min(buckets - 1, Math.max(0, i));
      counts[i]++;
    });
    for (let i = 0; i < buckets; i++) {
      const a = lo + ((hi - lo) * i) / buckets, b = lo + ((hi - lo) * (i + 1)) / buckets;
      centers.push((log ? Math.round(10 ** a) : Math.round(a)) + '–' + (log ? Math.round(10 ** b) : Math.round(b)));
    }
    const max = niceMax(Math.max(...counts, 1));
    const bw = (W - P.l - P.r) / buckets;
    for (let g = 0; g <= 4; g++) {
      const v = (max * g) / 4, y = H - P.b - ((v / max) * (H - P.t - P.b));
      s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid' }));
      s.appendChild(el('text', { x: P.l - 8, y: y + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)));
    }
    const zero = values.length - pos.length;
    counts.forEach((c, i) => {
      const h = ((c / max) * (H - P.t - P.b));
      const x = P.l + i * bw;
      const r = el('rect', { x: x + bw * 0.12, y: H - P.b - h, width: bw * 0.76, height: Math.max(1, h), rx: 3, fill: 'var(--accent)', class: 'bar' });
      tip(r, `<b>${label} ${centers[i]}</b><br>постов: ${c}${zero && i === 0 ? `<br>без просмотров: ${zero}` : ''}`);
      s.appendChild(r);
      if (i % 2 === 0) s.appendChild(el('text', { x: x + bw / 2, y: H - 24, class: 'axis', 'text-anchor': 'middle' }, centers[i]));
    });
    host.appendChild(s);
  }

  // ---------- тепловая карта 7×24 ----------
  function heatmap(host, { grid, height = 240, valueOf, tipOf }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 16, r: 10, b: 30, l: 46 };
    const s = svg(W, H);
    const cw = (W - P.l - P.r) / 24, ch = (H - P.t - P.b) / 7;
    const vals = [];
    grid.forEach(row => row.forEach(c => vals.push(valueOf(c))));
    const max = Math.max(...vals, 1);
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const order = [1, 2, 3, 4, 5, 6, 0];
    order.forEach((dow, r) => {
      s.appendChild(el('text', { x: P.l - 8, y: P.t + r * ch + ch * 0.62, class: 'axis', 'text-anchor': 'end' }, days[dow]));
      for (let h = 0; h < 24; h++) {
        const c = grid[dow][h];
        const v = valueOf(c);
        const t = v / max;
        const rect = el('rect', {
          x: P.l + h * cw + 0.5, y: P.t + r * ch + 0.5, width: cw - 1, height: ch - 1, rx: 2,
          fill: c.n ? `color-mix(in oklab, var(--accent) ${Math.round(12 + t * 88)}%, var(--card))` : 'var(--border-soft)',
        });
        tip(rect, tipOf(dow, h, c));
        s.appendChild(rect);
      }
    });
    [0, 3, 6, 9, 12, 15, 18, 21].forEach(h => {
      s.appendChild(el('text', { x: P.l + h * cw + cw / 2, y: H - 10, class: 'axis', 'text-anchor': 'middle' }, String(h).padStart(2, '0')));
    });
    host.appendChild(s);
    host.appendChild(legend([{ name: 'мало', color: 'color-mix(in oklab, var(--accent) 15%, var(--card))' }, { name: 'много', color: 'var(--accent)' }]));
  }

  // ---------- пончик ----------
  function donut(host, { items, height = 240, valueKey = 'count', tipFmt }) {
    host.innerHTML = '';
    const W = Math.max(360, host.clientWidth || 520), H = height;
    const s = svg(W, H);
    const total = items.reduce((a, b) => a + b[valueKey], 0) || 1;
    const cx = H / 2, cy = H / 2, R = H / 2 - 12, r = R * 0.58;
    let ang = -Math.PI / 2;
    const palette = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)', 'var(--c9)', 'var(--c10)', 'var(--c11)', 'var(--c12)'];
    items.forEach((it, i) => {
      const frac = it[valueKey] / total;
      const a2 = ang + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      const [x1, y1] = p(R, ang), [x2, y2] = p(R, a2), [x3, y3] = p(r, a2), [x4, y4] = p(r, ang);
      const path = el('path', {
        d: `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${large} 0 ${x4} ${y4} Z`,
        fill: it.color || palette[i % palette.length], class: 'seg',
      });
      if (tipFmt) tip(path, tipFmt(it, i));
      s.appendChild(path);
      ang = a2;
    });
    s.appendChild(el('text', { x: cx, y: cy - 2, class: 'donut-center-top', 'text-anchor': 'middle' }, fmt(total)));
    s.appendChild(el('text', { x: cx, y: cy + 16, class: 'axis', 'text-anchor': 'middle' }, 'всего'));
    host.appendChild(s);
    const lg = legend(items.slice(0, 12).map((it, i) => ({ name: `${it.name} · ${fmt(it[valueKey])}`, color: it.color || palette[i % palette.length] })));
    host.appendChild(lg);
  }

  // ---------- диаграмма рассеяния ----------
  function scatter(host, { points, height = 280, xLabel = 'просмотры', yLabel = 'реакции' }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 16, r: 16, b: 40, l: 56 };
    const s = svg(W, H);
    const xs = points.map(p => p.x).filter(v => v > 0), ys = points.map(p => p.y).filter(v => v > 0);
    if (!xs.length || !ys.length) { host.appendChild(s); return; }
    const lx = v => Math.log10(Math.max(1, v));
    const x0 = lx(Math.min(...xs)), x1 = lx(niceMax(Math.max(...xs)));
    const y0 = 0, y1 = lx(Math.max(niceMax(Math.max(...ys)), 10));
    const X = v => P.l + ((lx(v) - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
    const Y = v => H - P.b - ((lx(Math.max(1, v)) - y0) / (y1 - y0 || 1)) * (H - P.t - P.b);
    for (let g = 0; g <= 4; g++) {
      const yy = P.t + ((H - P.t - P.b) * g) / 4;
      s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: yy, y2: yy, class: 'grid' }));
      s.appendChild(el('text', { x: P.l - 8, y: yy + 4, class: 'axis', 'text-anchor': 'end' }, fmt(10 ** (y0 + ((y1 - y0) * (4 - g)) / 4))));
    }
    [0.25, 0.5, 0.75, 1].forEach(f => {
      const v = 10 ** (x0 + (x1 - x0) * f);
      s.appendChild(el('text', { x: X(v), y: H - 14, class: 'axis', 'text-anchor': 'middle' }, fmt(v)));
    });
    s.appendChild(el('text', { x: (W + P.l) / 2, y: H - 1, class: 'axis dim', 'text-anchor': 'middle' }, xLabel + ' (лог)'));
    s.appendChild(el('text', { x: 14, y: P.t + 4, class: 'axis dim' }, yLabel));
    points.forEach(p => {
      const c = el('circle', { cx: X(Math.max(1, p.x)), cy: Y(Math.max(1, p.y)), r: 3.4, fill: p.color || 'var(--accent)', opacity: 0.75, class: 'pt' });
      tip(c, p.tip || `просмотры ${fmt(p.x)}<br>реакции ${fmt(p.y)}`);
      s.appendChild(c);
    });
    host.appendChild(s);
  }

  // ---------- граф связей (SVG + простая физика) ----------
  function graph(host, { nodes, edges, height = 460 }) {
    host.innerHTML = '';
    const W = Math.max(640, host.clientWidth || 900), H = height;
    const s = svg(W, H);
    s.classList.add('graph-svg');

    // детерминированная начальная раскладка по кругу + шум
    nodes.forEach((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2;
      n.x = W / 2 + Math.cos(a) * (Math.min(W, H) * 0.33) * (0.6 + 0.4 * Math.sin(i * 12.9898));
      n.y = H / 2 + Math.sin(a) * (Math.min(W, H) * 0.33) * (0.6 + 0.4 * Math.cos(i * 78.233));
      n.vx = n.vy = 0;
    });
    const idx = new Map(nodes.map(n => [n.id, n]));
    const links = edges.filter(e => idx.has(e.source) && idx.has(e.target));
    for (let it = 0; it < 320; it++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy || 0.01;
          if (d2 > 90000) continue;
          const f = 900 / d2, d = Math.sqrt(d2);
          dx /= d; dy /= d;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
      }
      links.forEach(l => {
        const a = idx.get(l.source), b = idx.get(l.target);
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 70) * 0.012;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      });
      nodes.forEach(n => {
        const k = n.r >= 9 ? 0.007 : 0.0016;   // крупные узлы-темы держим ближе к центру
        n.vx += (W / 2 - n.x) * k; n.vy += (H / 2 - n.y) * k;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x = Math.max(14, Math.min(W - 14, n.x + n.vx));
        n.y = Math.max(14, Math.min(H - 14, n.y + n.vy));
      });
    }
    // финальные проходы: разводим слипшиеся узлы, мягко удерживая в поле
    const jitter = (n, i) => { n.x += Math.cos(i * 1.7) * 3; n.y += Math.sin(i * 2.3) * 3; };
    for (let it = 0; it < 80; it++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.sqrt(dx * dx + dy * dy);
          const min = a.r + b.r + 8;
          if (d < 0.5) { jitter(a, i + it); jitter(b, j + it + 7); d = 0.5; dx = b.x - a.x; dy = b.y - a.y || 0.5; }
          if (d < min) {
            const push = (min - d) / d * 0.5;
            dx *= push; dy *= push;
            a.x -= dx; a.y -= dy; b.x += dx; b.y += dy;
          }
        }
      }
      nodes.forEach(n => {
        const m = n.r + 10;
        if (n.x < m) n.x += (m - n.x) * 0.5;
        if (n.x > W - m) n.x -= (n.x - (W - m)) * 0.5;
        if (n.y < m) n.y += (m - n.y) * 0.5;
        if (n.y > H - m) n.y -= (n.y - (H - m)) * 0.5;
      });
    }
    // рёбра
    links.forEach(l => {
      const a = idx.get(l.source), b = idx.get(l.target);
      s.appendChild(el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: l.kind === 'dup' ? 'rgba(252,64,58,.55)' : l.kind === 'link' ? 'rgba(42,114,238,.55)' : 'rgba(150,155,170,.25)',
        'stroke-width': l.kind === 'series' ? 0.7 : 1.3,
      }));
    });
    // узлы
    nodes.forEach(n => {
      const c = el('circle', { cx: n.x, cy: n.y, r: n.r, fill: n.color, class: 'node', 'fill-opacity': .9 });
      const title = el('title');
      title.textContent = n.tip ? n.tip.replace(/<br>/g, ' · ').replace(/<[^>]+>/g, '') : n.id;
      c.appendChild(title);
      if (n.onClick) {
        c.style.cursor = 'pointer';
        c.addEventListener('click', n.onClick);
      }
      s.appendChild(c);
      if (n.label) {
        s.appendChild(el('text', { x: n.x + n.r + 3, y: n.y + 3.5, class: 'axis node-label' }, n.label.slice(0, 26)));
      }
    });
    host.appendChild(s);
    host.appendChild(legend([
      { name: 'дубли/почти-дубли (красные)', color: 'rgba(252,64,58,.8)' },
      { name: 'ссылка внутри канала (синие)', color: 'rgba(42,114,238,.8)' },
      { name: 'серия одной темы ≤ 10 дней (серые)', color: 'rgba(150,155,170,.5)' },
    ]));
  }

  // ---------- «ящик с усами»: сравнение распределений ----------
  function boxPlot(host, { groups, height = 260, log = true }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 26, r: 16, b: 38, l: 62 };
    const s = svg(W, H);
    const all = groups.flatMap(g => [g.min, g.max]).filter(v => v > 0);
    if (!all.length) { host.appendChild(s); return; }
    const lv = v => log ? Math.log10(Math.max(1, v)) : v;
    const lo = lv(Math.min(...all)), hi = lv(niceMax(Math.max(...all)));
    const Y = v => H - P.b - ((lv(v) - lo) / (hi - lo || 1)) * (H - P.t - P.b);
    for (let g = 0; g <= 4; g++) {
      const v = 10 ** (lo + ((hi - lo) * g) / 4);
      s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      s.appendChild(el('text', { x: P.l - 8, y: Y(v) + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)));
    }
    const bw = (W - P.l - P.r) / groups.length;
    groups.forEach((g, i) => {
      const x = P.l + bw * (i + 0.5), w = Math.min(74, bw * 0.5);
      const box = el('rect', { x: x - w / 2, y: Y(g.p75), width: w, height: Math.max(1, Y(g.p25) - Y(g.p75)), rx: 4, fill: 'var(--accent)', opacity: .28, stroke: 'var(--accent)' });
      tip(box, `<b>${esc(g.name)}</b><br>медиана ${fmt(g.p50)}<br>P25–P75: ${fmt(g.p25)}…${fmt(g.p75)}<br>P10–P90: ${fmt(g.p10)}…${fmt(g.p90)}<br>постов: ${g.n}`);
      s.appendChild(box);
      s.appendChild(el('line', { x1: x, x2: x, y1: Y(g.p90), y2: Y(g.p10), stroke: 'var(--accent)', 'stroke-width': 1.3, opacity: .7 }));
      [g.p10, g.p90].forEach(v => s.appendChild(el('line', { x1: x - w / 4, x2: x + w / 4, y1: Y(v), y2: Y(v), stroke: 'var(--accent)', 'stroke-width': 1.3, opacity: .7 })));
      s.appendChild(el('line', { x1: x - w / 2, x2: x + w / 2, y1: Y(g.p50), y2: Y(g.p50), stroke: 'var(--fg)', 'stroke-width': 2 }));
      s.appendChild(el('text', { x, y: H - 14, class: 'axis', 'text-anchor': 'middle' }, g.name.slice(0, 16)));
    });
    host.appendChild(s);
    host.appendChild(legend([{ name: 'медиана', color: 'var(--fg)' }, { name: 'P25–P75 (половина постов)', color: 'var(--accent)' }, { name: 'P10–P90', color: 'var(--accent)' }]));
  }

  // ---------- таблица ----------
  function table(host, { columns, rows, empty = 'нет данных' }) {
    host.innerHTML = '';
    if (!rows.length) { host.innerHTML = `<div class="empty">${esc(empty)}</div>`; return; }
    const t = document.createElement('table');
    t.className = 'tbl';
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    columns.forEach(c => { const th = document.createElement('th'); th.textContent = c.title; if (c.align) th.style.textAlign = c.align; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.forEach(r => {
      const row = document.createElement('tr');
      columns.forEach(c => {
        const td = document.createElement('td');
        if (c.align) td.style.textAlign = c.align;
        const v = c.render ? c.render(r) : r[c.key != null ? c.key : c.title];
        if (v instanceof Node) td.appendChild(v); else td.innerHTML = v == null ? '' : String(v);
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb); host.appendChild(t);
  }

  // ---------- прогноз: история + прогноз с интервалом ----------
  function forecastChart(host, { history, forecast, height = 280 }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const P = { t: 16, r: 14, b: 36, l: 58 };
    const s = svg(W, H);
    const labels = history.map(h => h.label).concat(forecast.map(f => f.month));
    const hi = Math.max(...history.map(h => h.value), ...forecast.map(f => f.hi));
    const lo = Math.min(...history.map(h => h.value), ...forecast.map(f => f.lo));
    const max = niceMax(hi), min = Math.max(0, lo * 0.6);
    const X = i => P.l + (labels.length === 1 ? 0 : (i * (W - P.l - P.r)) / (labels.length - 1));
    const Y = v => H - P.b - ((v - min) / (max - min || 1)) * (H - P.t - P.b);
    for (let g = 0; g <= 4; g++) {
      const v = min + ((max - min) * g) / 4;
      s.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: Y(v), y2: Y(v), class: 'grid' }));
      s.appendChild(el('text', { x: P.l - 8, y: Y(v) + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)));
    }
    const step = Math.max(1, Math.ceil(labels.length / 8));
    labels.forEach((lb, i) => { if (i % step === 0) s.appendChild(el('text', { x: X(i), y: H - 12, class: 'axis', 'text-anchor': 'middle' }, lb)); });

    // интервал прогноза
    const fStart = history.length - 1;
    const upper = forecast.map((f, k) => [X(fStart + 1 + k), Y(f.hi)]);
    const lower = forecast.map((f, k) => [X(fStart + 1 + k), Y(f.lo)]).reverse();
    s.appendChild(el('path', {
      d: `M ${X(fStart)} ${Y(history[history.length - 1].value)} ` +
        upper.map(p => `L ${p[0]} ${p[1]}`).join(' ') + ' ' + lower.map(p => `L ${p[0]} ${p[1]}`).join(' ') + ' Z',
      fill: 'var(--accent)', opacity: 0.16,
    }));
    // история
    s.appendChild(el('path', {
      d: 'M ' + history.map((h, i) => `${X(i)} ${Y(h.value)}`).join(' L '),
      fill: 'none', stroke: 'var(--c2)', 'stroke-width': 2,
    }));
    // прогноз
    s.appendChild(el('path', {
      d: 'M ' + [X(fStart), ...forecast.map((f, k) => X(fStart + 1 + k))].map((x, i) => `${x} ${Y(i === 0 ? history[history.length - 1].value : forecast[i - 1].point)}`).join(' L '),
      fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-dasharray': '5 4',
    }));
    forecast.forEach((f, k) => {
      const c = el('circle', { cx: X(fStart + 1 + k), cy: Y(f.point), r: 3.4, fill: 'var(--accent)' });
      tip(c, `<b>${f.month}</b><br>прогноз ${fmt(f.point)}<br>интервал ${fmt(f.lo)}…${fmt(f.hi)}`);
      s.appendChild(c);
    });
    s.appendChild(el('line', { x1: X(fStart), x2: X(fStart), y1: P.t, y2: H - P.b, stroke: 'var(--muted)', 'stroke-dasharray': '3 3', opacity: .5 }));
    host.appendChild(s);
    host.appendChild(legend([{ name: 'факт (медиана за месяц)', color: 'var(--c2)' }, { name: 'прогноз и 95 % интервал', color: 'var(--accent)' }]));
  }

  // ---------- полоса сегментов динамики ----------
  function segments(host, { segments: segs, labels, height = 90, color = 'var(--c3)' }) {
    host.innerHTML = '';
    const W = Math.max(560, host.clientWidth || 700), H = height;
    const s = svg(W, H);
    const P = { t: 22, r: 12, b: 18, l: 12 };
    const max = niceMax(Math.max(...labels.map(l => l.value), 1));
    const bw = (W - P.l - P.r) / labels.length;
    labels.forEach((l, i) => {
      const h = ((l.value / max) * (H - P.t - P.b));
      const r = el('rect', { x: P.l + i * bw + 0.5, y: H - P.b - h, width: Math.max(1, bw - 1), height: h, fill: 'var(--border)', class: 'bar' });
      tip(r, `<b>${l.label}</b><br>медиана ${fmt(l.value)}`);
      s.appendChild(r);
    });
    segs.forEach((seg, i) => {
      const i1 = labels.findIndex(l => l.label === seg.from), i2 = labels.findIndex(l => l.label === seg.to);
      if (i1 < 0 || i2 < 0) return;
      const x1 = P.l + i1 * bw, x2 = P.l + (i2 + 1) * bw;
      s.appendChild(el('line', { x1, x2, y1: 12, y2: 12, stroke: color, 'stroke-width': 3, opacity: i % 2 ? .55 : .95 }));
      s.appendChild(el('text', { x: (x1 + x2) / 2, y: 8, class: 'axis', 'text-anchor': 'middle' }, `${seg.from}…${seg.to}: ${fmt(seg.median)}`));
    });
    host.appendChild(s);
    host.appendChild(legend([{ name: 'медиана просмотров по месяцам', color: 'var(--border)' },
      { name: 'сегмент с устойчивым уровнем', color: 'var(--c3)' }]));
  }

  function legend(items) {
    const d = document.createElement('div');
    d.className = 'legend';
    items.forEach(it => {
      const s = document.createElement('span');
      s.innerHTML = `<i style="background:${it.color}"></i>${esc(it.name)}`;
      d.appendChild(s);
    });
    return d;
  }

  global.Charts = { boxPlot, lineChart, barChart, histogram, heatmap, donut, scatter, graph, table, legend, forecastChart, segments, fmt, esc };
})(window);
