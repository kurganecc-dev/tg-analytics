/* app.js — интерфейс сервиса: загрузка выгрузок, вкладки, рендер разделов. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const fmt = Charts.fmt;
  // Есть ли на этом адресе сервер с /api/channel. Проверяем фактом, а не по имени хоста:
  // serve.py может быть открыт и по сетевому адресу (--host 0.0.0.0), и тогда ссылка обязана работать.
  let API_OK = false;          // false | 'local' | 'remote'
  let API_BASE = '';           // облачный воркер, если локального сервера нет
  async function loadConfig() {
    const qs = new URLSearchParams(location.search).get('api');   // удобно для проверок и смены адреса
    if (qs) { API_BASE = qs.replace(/\/$/, ''); return; }
    try {
      const r = await fetch('data/config.json', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (j.api) API_BASE = String(j.api).replace(/\/$/, ''); }
    } catch (e) { /* конфига нет — работаем без облака */ }
  }
  async function probeApi() {
    API_OK = false;
    await loadConfig();
    // 1) локальный сервер — быстрее и без лимитов; 2) облачный воркер — если локального нет
    if (location.protocol.startsWith('http')) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('api/health', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) { API_OK = 'local'; return; }
      } catch (e) { /* локального нет */ }
      // статический хостинг отдаёт index.html вместо API — 404 на /api/health это норма
    }
    if (API_BASE) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(API_BASE + '/health', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) API_OK = 'remote';
      } catch (e) { API_OK = false; }
    }
  }
  const hasApi = () => Boolean(API_OK);
  function applyServerMode() {
    const hint = document.getElementById('url-hint');
    const btn = document.getElementById('btn-load-url');
    if (API_OK === 'remote') {
      if (hint) hint.innerHTML = 'Готово к работе: страницы канала скачивает и разбирает облачный сервис, ' +
        'браузер собирает отчёт. Можно вставлять ссылку — глубина задаётся полем «за N мес.».';
      if (btn) { btn.textContent = 'Разобрать канал'; btn.title = 'Страницы скачивает и разбирает облако'; }
      return;
    }
    if (API_OK === 'local') {
      if (hint) hint.innerHTML = 'Готово к работе: канал скачивает локальный сервер (<code>serve.py</code>). ' +
        'Глубина истории — поле «за N мес.».';
      if (btn) { btn.textContent = 'Разобрать канал'; btn.title = 'Отвечает локальный сервер'; }
      return;
    }
    if (hint) hint.innerHTML = location.protocol === 'file:'
      ? 'Файл открыт напрямую, поэтому загрузка по ссылке недоступна. Запустите <code>python3 scripts/serve.py</code> ' +
        'и откройте <code>http://127.0.0.1:8000</code> — тогда ссылка на канал работает прямо здесь.'
      : 'Ссылка на канал не работает на этом адресе: здесь нет API. Вы открыли обычную статику ' +
        '(<code>python3 -m http.server</code> или хостинг). Запустите <code>python3 scripts/serve.py</code> — ' +
        'он отдаёт и страницу, и загрузку канала. Либо загрузите выгрузку файлом.';
    if (btn) { btn.textContent = 'Нужен сервер'; btn.title = 'Ссылка работает через python3 scripts/serve.py или облачный воркер'; }
  }
  const state = { datasets: [], active: 0, model: null, filtered: [] };

  // ---------------- загрузка данных ----------------
  async function boot() {
    await probeApi();
    applyServerMode();
    const emb = document.getElementById('embedded-data');
    if (emb && emb.textContent.trim().length > 10) {
      const parsed = JSON.parse(emb.textContent);
      addDataset(parsed.name || emb.dataset.name || 'канал', parsed.posts || parsed, emb.dataset.subs);
      showApp();
      return render();
    }
    try {
      const r = await fetch('data/report-data.json', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        (j.datasets || []).forEach(d => addDataset(d.name, d.posts, d.subs));
        if (state.datasets.length) { showApp(); return render(); }
      }
    } catch (e) { /* file:// — fetch запрещён, ждём ручную загрузку */ }
    showWelcome();
  }

  const WELCOME_MSG = 'Перетащите файл в окно или выберите вручную. Можно несколько каналов сразу — '
    + 'тогда они сравниваются между собой. Формат: {channel, post_id, text, date, views, reactions, url}.';
  function showWelcome() {
    // на стартовой странице в шапке не должно быть прочерка и «загрузка…»
    const n = document.getElementById('channel-name'), sub = document.getElementById('channel-sub');
    if (n) n.textContent = 'TG Analytics';
    if (sub) sub.textContent = 'вставьте ссылку на канал или загрузите выгрузку .jsonl';
    document.body.setAttribute('data-state', 'welcome');   // на стартовой не нужны кнопки отчёта
    showLoader('');
    const i = document.getElementById('ch-url');
    if (i && !i.value) setTimeout(() => i.focus(), 150);
  }

  function showLoader(msg) {
    $('#loader').classList.remove('hidden');
    if (msg) $('#loader-msg').textContent = msg;
    $('#app').classList.add('hidden');
    applyServerMode();
  }
  function showApp() {
    document.body.removeAttribute('data-state');
    $('#loader').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }

  function addDataset(name, posts, subs) {
    if (!posts || !posts.length) return;
    const clean = posts.map(p => ({
      channel: p.channel || name, post_id: p.post_id != null ? p.post_id : p.id,
      text: String(p.text == null ? '' : p.text), date: p.date,
      views: Number(p.views) || 0, reactions: Number(p.reactions) || 0, url: p.url || '',
    })).filter(p => p.text.trim());
    state.datasets.push({ name, posts: clean, subs: Number(subs) > 0 ? Number(subs) : null });
  }

  async function handleFiles(files) {
    for (const f of files) {
      const text = await f.text();
      try {
        const { posts, bad } = TGA.parseAny(text, f.name.replace(/\.(jsonl|json|txt)$/i, ''));
        if (!posts.length) { toast(`В «${f.name}» не нашлось постов`); continue; }
        addDataset(f.name.replace(/\.(jsonl|json|txt)$/i, ''), posts);
        toast(`Загружено: ${posts.length} постов${bad.length ? `, битых строк: ${bad.length}` : ''}`);
      } catch (e) { toast(`Не разобрать «${f.name}»: ${e.message}`); }
    }
    showApp(); render();
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------------- облачная загрузка по ссылке ----------------
  // Воркер отдаёт по одной странице t.me с готовым разбором; здесь — цикл, граница по месяцам и сборка датасета.
  async function loadViaCloud(raw, months, onProgress) {
    const channel = String(raw).trim().replace(/\s/g, '').replace(/^.*?t\.me\/(?:s\/)?/i, '')
      .replace(/^@/, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(channel)) {
      throw new Error('не похоже на публичную ссылку канала: годится https://t.me/имя_канала или @имя_канала');
    }
    const cutoff = Date.now() - months * 30.44 * 86400000;
    let before = null, pages = 0, next = true;
    const seen = new Set();
    const all = [];
    while (next && pages < 600) {
      const url = `${API_BASE}/page?channel=${encodeURIComponent(channel)}` + (before ? `&before=${before}` : '');
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      pages++;
      for (const p of j.posts || []) {
        if (seen.has(p.post_id)) continue;
        seen.add(p.post_id);
        all.push(p);
      }
      onProgress && onProgress(pages, all.length);
      const stamps = (j.posts || []).map(p => Date.parse(p.date)).filter(t => Number.isFinite(t));
      if (stamps.length && Math.min(...stamps) <= cutoff) break;      // дошли до границы периода
      if (!j.next_before) break;
      before = j.next_before;
      await new Promise(res => setTimeout(res, 120));                  // вежливая пауза между страницами
    }
    const inPeriod = all.filter(p => {
      const t = Date.parse(p.date);
      return !Number.isFinite(t) || t >= cutoff;
    });
    inPeriod.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.post_id - b.post_id));
    const withText = inPeriod.filter(p => (p.text || '').trim());
    if (!withText.length) {
      throw new Error(`«${channel}»: публичных постов с текстом не нашлось. Канал не существует, закрыт, ` +
        'приватный или у него отключено веб-превью');
    }
    return {
      name: channel,
      posts: inPeriod,
      count: withText.length,
      media_only: inPeriod.length - withText.length,
      period: [inPeriod[0].date.slice(0, 10), inPeriod[inPeriod.length - 1].date.slice(0, 10)],
    };
  }

  // ---------------- загрузка канала по ссылке (через локальный сервер) ----------------
  async function loadByUrl() {
    const raw = ($('#ch-url').value || '').trim();
    if (!raw) { toast('Вставьте ссылку на канал: https://t.me/имя_канала'); return; }
    if (!hasApi()) {
      toast('Загрузка по ссылке работает через python3 scripts/serve.py: он отдаёт страницу и API. ' +
            'Либо перетащите выгрузку файлом.');
      return;
    }
    const months = Math.max(1, Math.min(120, Number($('#ch-months').value) || 12));
    const btn = $('#btn-load-url');
    const old = btn.textContent;
    btn.textContent = 'Качаю страницы…'; btn.classList.add('busy');
    // глубокая история — это десятки страниц: показываем, сколько уже идёт, иначе кажется, что зависло
    const t0 = Date.now();
    const expect = months >= 12 ? 'обычно 1–3 минуты' : months >= 6 ? 'обычно до минуты' : 'несколько секунд';
    const tick = () => {
      const sec = Math.round((Date.now() - t0) / 1000);
      $('#url-hint').textContent = `Скачиваю публичные посты за ${months} мес. — ${expect}. Идёт ${sec} с…`;
    };
    tick();
    const ticker = setInterval(tick, 1000);
    try {
      if (API_OK === 'remote') {                 // облако: страницы тянет воркер, листает браузер
        const res = await loadViaCloud(raw, months, (pages, posts) => {
          $('#url-hint').textContent = `Скачиваю за ${months} мес.: страниц ${pages}, постов ${posts}. Идёт ${Math.round((Date.now() - t0) / 1000)} с…`;
        });
        clearInterval(ticker);
        addDataset(res.name, res.posts, 0);
        showApp();
        render();
        toast(`Загружено ${res.count} постов (${res.period[0]} → ${res.period[1]})`
          + (res.media_only ? `, пропущено ${res.media_only} постов без текста` : ''));
        $('#url-hint').textContent = 'Готово. Следующий канал: вставьте другую ссылку и нажмите «Загрузить канал» — '
          + 'каналы можно сравнивать между собой.';
        return;
      }
      const r = await fetch(`api/channel?url=${encodeURIComponent(raw)}&months=${months}`);
      const j = await r.json();
      clearInterval(ticker);
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      addDataset(j.name, j.posts, 0);
      showApp();
      render();
      toast(`Загружено ${j.count} постов (${j.period[0]} → ${j.period[1]})`
        + (j.media_only ? `, пропущено ${j.media_only} постов без текста` : ''));
      $('#url-hint').textContent = 'Готово. Следующий канал: вставьте другую ссылку и нажмите «Загрузить канал» — '
        + 'каналы можно сравнивать между собой.';
    } catch (e) {
      clearInterval(ticker);
      toast('Не получилось: ' + e.message);
      $('#url-hint').textContent = 'Причина: ' + e.message
        + '. Проверьте ссылку и что сервер запущен (python3 scripts/serve.py).';
    } finally {
      btn.textContent = old; btn.classList.remove('busy');
    }
  }

  // ---------------- рендер ----------------
  // оболочка (assets/xp.js) слушает это событие: без него окно не знает, что показать в заголовке
  function announce(m) {
    const posts = m && m.posts ? m.posts.length : 0;
    const per = m && m.overview && m.overview.period ? `${m.overview.period.from} → ${m.overview.period.to}` : '';
    if (window.__TGA_STATUS) window.__TGA_STATUS = { channel: m.channel, posts, period: per, message: 'Готово' };
    document.dispatchEvent(new CustomEvent('tga:render', {
      detail: { channel: m.channel, posts, period: per, message: 'Готово' },
    }));
  }

  function render() {
    if (!state.datasets.length) return;
    state.active = Math.min(state.active, state.datasets.length - 1);
    renderTabs();
    const cur = state.datasets[state.active];
    if (cur.subs == null) {
      let saved = 0;
      try { saved = Number(localStorage.getItem(subsKey(cur.name))) || 0; } catch (e) { saved = 0; }
      cur.subs = saved;
    }
    state.model = TGA.analyze(cur.posts.slice(), { channel: cur.name, subs: cur.subs });
    syncSubsInput();
    renderHeader();
    renderOverview();
    renderDynamics();
    renderRhythm();
    renderTopics();
    renderAnatomy();
    renderConnections();
    announce(state.model);                   // оболочка окна (XP) обновляет заголовок и строку состояния
    state.deep = null;                       // глубокая аналитика считается только при открытии вкладки
    state.score = null;                      // модель скоринга обучается при открытии вкладки «Что делать»
    state.ab = null; state.abNote = ''; state.plan = null; state.planNote = ''; state.onepager = null;
    renderPosts();
    renderMethod();
    const cw = $('#compare-wrap');
    if (cw) cw.classList.toggle('hidden', state.datasets.length < 2);
  }

  function subsKey(ch) { return 'tga.subs.' + ch; }

  function syncSubsInput() {
    const m = state.model;
    const input = $('#subs-input'), hint = $('#subs-hint');
    if (document.activeElement !== input) input.value = m.subs ? String(m.subs) : '';
    if (!m.subs) {
      hint.className = 'subs-hint';
      hint.textContent = 'для ER по аудитории и охвата';
      return;
    }
    const a = m.audience;
    hint.className = 'subs-hint' + (a && a.sanity !== 'ok' ? ' warn' : '');
    hint.textContent = a.sanity === 'low'
      ? 'охват выше 300 % — вероятно, число занижено'
      : a.sanity === 'high'
        ? 'охват ниже 5 % — вероятно, число завышено'
        : `охват поста ${a.reachMedian}% · ER ${a.erPerPost}%`;
  }

  function renderTabs() {
    const box = $('#channel-tabs');
    box.innerHTML = '';
    if (state.datasets.length < 2) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    state.datasets.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (i === state.active ? ' on' : '');
      b.textContent = `${d.name} · ${d.posts.length}`;
      b.onclick = () => { state.active = i; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      box.appendChild(b);
    });
  }

  function renderHeader() {
    const m = state.model, o = m.overview;
    $('#channel-name').textContent = m.channel;
    $('#channel-sub').textContent = o.period
      ? `${fmt(o.n)} постов · ${o.period.from} → ${o.period.to} · ${o.period.days} дней`
      : `${fmt(o.n)} постов`;
  }

  function kpi(label, value, sub, tone) {
    return `<div class="kpi ${tone || ''}"><div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}</div><div class="kpi-sub">${sub || ''}</div></div>`;
  }

  function renderOverview() {
    const m = state.model, o = m.overview, a = m.anatomy, aud = m.audience;
    const audienceCards = aud ? [
      kpi('ER по подписчикам', aud.erPerPost + '%',
        `медиана ${aud.reactPerPostMedian} реакций на пост · средняя ${aud.reactPerPostMean}`, 'ok-aud'),
      kpi('Охват поста', aud.reachMedian + '%',
        `среднее ${aud.reachMean}% · P90 ${aud.reachP90}% от ${fmt(aud.subs)} подписчиков`),
      kpi('Просмотров на подписчика', aud.viewsPerSub,
        `реакций на подписчика за всю историю: ${aud.reactPerSubTotal}`),
    ] : [];
    $('#kpi-grid').innerHTML = [
      kpi('Постов', fmt(o.n), `${o.perWeek} в неделю`),
      kpi('Медиана просмотров', fmt(o.views.median), `среднее ${fmt(o.views.mean)} · P90 ${fmt(o.views.p90)}`),
      kpi('Реакции', fmt(o.react.total), `медиана ${o.react.median} · на пост ${o.react.mean}`),
      kpi('ER по просмотрам', o.er.byViews + '%', `медиана поста ${o.er.medianPostEr}% · P90 ${o.er.p90PostEr}%`, 'accent'),
      kpi('Реакций на пост', o.er.perPost, `у ${o.withReactionsPct}% постов есть реакции`),
    ].concat(audienceCards, [
      kpi('Виральность P90/медиана', '×' + o.virality, `топ-10% постов собрали ${o.top10Share}% просмотров`),
      kpi('Тишина', fmt(o.zeroView) + ' постов', 'без просмотров (служебные/опросы)'),
      kpi('Медиана длины', `${a.chars.median} симв.`, `${a.words.median} слов · ${a.lines.median} строк`),
    ]).join('');

    const labels = m.monthly.map(x => x.month);
    Charts.lineChart($('#chart-views-line'), {
      labels,
      series: [
        { name: 'медиана просмотров', values: m.monthly.map(x => x.viewsMedian), color: 'var(--accent)' },
        { name: 'среднее просмотров', values: m.monthly.map(x => Math.round(x.viewsTotal / x.count)), color: 'var(--c2)', dots: false },
      ], yLabel: 'просмотры', height: 280,
    });
    Charts.histogram($('#chart-views-hist'), { values: m.posts.map(p => p.views), buckets: 14, label: 'просмотры', height: 240 });
    Charts.scatter($('#chart-scatter'), {
      points: m.posts.filter(p => p.views > 0).map(p => ({
        x: p.views, y: Math.max(1, p.reactions),
        color: p.reactions ? 'var(--accent)' : 'var(--muted)',
        tip: `${Charts.esc(p.date.slice(0, 10))} · ${p.views} просм · ${p.reactions} реакц<br><a href="${p.url}" target="_blank">${p.url}</a>`,
      })), height: 280,
    });

    Charts.table($('#tbl-top'), {
      columns: [
        { title: '#', render: (r, i) => String(r.i + 1) },
        { title: 'дата', render: r => r.p.date.slice(0, 10) },
        { title: 'просмотры', align: 'right', render: r => fmt(r.p.views) },
        { title: 'реакц.', align: 'right', render: r => r.p.reactions },
        { title: 'ER', align: 'right', render: r => r.p.views ? ((100 * r.p.reactions) / r.p.views).toFixed(2) + '%' : '—' },
        { title: 'тема', render: r => r.p.topic },
        { title: 'текст', render: r => link(r.p) },
      ],
      rows: o.top.map((p, i) => ({ p, i })),
    });
    Charts.table($('#tbl-outliers'), {
      columns: [
        { title: 'дата', render: r => r.date.slice(0, 10) },
        { title: 'просмотры', align: 'right', render: r => `<b>${fmt(r.views)}</b>` },
        { title: '×медианы', align: 'right', render: r => '×' + (r.views / (o.views.median || 1)).toFixed(1) },
        { title: 'тема', render: r => r.topic },
        { title: 'текст', render: r => link(r) },
      ],
      rows: o.outliers.slice(0, 20),
    });
    $('#outliers-note').textContent = `Порог: ≥ 3× медианы (${fmt(o.views.median)} просмотров). Найдено ${o.outliers.length}.`;
  }

  function link(p) {
    const t = (p.text.split('\n').filter(Boolean)[0] || '').slice(0, 110);
    return `<a href="#" data-post="${p.channel}/${p.post_id}" class="post-link">${Charts.esc(t)}…</a>`;
  }

  function renderDynamics() {
    const m = state.model;
    Charts.barChart($('#chart-posts-month'), {
      labels: m.monthly.map(x => x.month), values: m.monthly.map(x => x.count), height: 240,
      tipFmt: i => `<b>${m.monthly[i].month}</b><br>постов: ${m.monthly[i].count}<br>медиана просмотров: ${fmt(m.monthly[i].viewsMedian)}<br>ER: ${m.monthly[i].er}%`,
    });
    Charts.lineChart($('#chart-er-line'), {
      labels: m.monthly.map(x => x.month),
      series: (m.subs ? [{ name: 'ER на пост, % от подписчиков', values: m.monthly.map(x => x.erSubsPerPost), color: 'var(--c6)' }] : [])
        .concat([
          { name: 'ER по просмотрам, %', values: m.monthly.map(x => x.er), color: 'var(--c3)', dots: !m.subs },
          { name: 'реакций на пост', values: m.monthly.map(x => x.erPerPost), color: 'var(--c4)', dots: false },
        ]), height: 260,
    });
    Charts.lineChart($('#chart-reach-line'), {
      labels: m.monthly.map(x => x.month),
      series: m.subs
        ? [{ name: 'охват поста, % от подписчиков', values: m.monthly.map(x => x.reachMedian), color: 'var(--c2)' }]
        : [{ name: 'медиана просмотров', values: m.monthly.map(x => x.viewsMedian), color: 'var(--c2)' }],
      height: 260,
    });
    $('#reach-title').textContent = m.subs
      ? 'Охват поста по месяцам (% от подписчиков)'
      : 'Медиана просмотров по месяцам (укажите подписчиков — пересчитается в охват %)';
    Charts.lineChart($('#chart-week-line'), {
      labels: m.weekly.map(x => x.week),
      series: [
        { name: 'медиана просмотров за неделю', values: m.weekly.map(x => x.viewsMedian), color: 'var(--c2)' },
        { name: 'постов за неделю', values: m.weekly.map(x => x.count), color: 'var(--c5)', dots: false },
      ], height: 260,
    });
    const yr = {};
    m.posts.forEach(p => {
      const y = (p.date || '').slice(0, 4); if (!y) return;
      (yr[y] = yr[y] || []).push(p);
    });
    const years = Object.keys(yr).sort();
    const yearCols = [
      { title: 'год', render: r => r.y },
      { title: 'постов', align: 'right', render: r => r.g.length },
      { title: 'медиана просмотров', align: 'right', render: r => fmt(TGA.median(r.g.map(p => p.views))) },
      { title: 'реакций всего', align: 'right', render: r => fmt(TGA.sum(r.g.map(p => p.reactions))) },
      { title: 'ER', align: 'right', render: r => { const v = TGA.sum(r.g.map(p => p.views)), k = TGA.sum(r.g.map(p => p.reactions)); return v ? ((100 * k) / v).toFixed(2) + '%' : '—'; } },
      { title: 'эмодзи/пост', align: 'right', render: r => (TGA.sum(r.g.map(p => TGA.emojiCount(p.text))) / r.g.length).toFixed(1) },
    ];
    if (m.subs) yearCols.splice(3, 0,
      { title: 'охват', align: 'right', render: r => ((100 * TGA.median(r.g.map(p => p.views))) / m.subs).toFixed(1) + '%' },
      { title: 'ER по подписчикам', align: 'right', render: r => ((100 * TGA.median(r.g.map(p => p.reactions))) / m.subs).toFixed(3) + '%' });
    Charts.table($('#tbl-years'), { columns: yearCols, rows: years.map(y => ({ y, g: yr[y] })) });
  }

  function renderRhythm() {
    const m = state.model, days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    Charts.heatmap($('#heat-count'), {
      grid: m.rhythm.grid, height: 230, valueOf: c => c.n,
      tipOf: (dow, h, c) => `<b>${days[dow]} ${String(h).padStart(2, '0')}:00 UTC</b><br>постов: ${c.n}${c.n ? `<br>медиана просмотров: ${fmt(TGA.median(c.views))}` : ''}`,
    });
    Charts.heatmap($('#heat-views'), {
      grid: m.rhythm.grid, height: 230, valueOf: c => c.n ? TGA.median(c.views) : 0,
      tipOf: (dow, h, c) => `<b>${days[dow]} ${String(h).padStart(2, '0')}:00 UTC</b><br>постов: ${c.n}<br>медиана просмотров: ${c.n ? fmt(TGA.median(c.views)) : '—'}`,
    });
    const b = m.rhythm.best;
    const slots = m.rhythm.topSlots || [];
    $('#rhythm-best').innerHTML = b
      ? `Лучший слот по медиане просмотров: <b>${days[b.dow]}, ${String(b.hour).padStart(2, '0')}:00 UTC</b> — ${fmt(b.viewsMedian)} просмотров (на ${b.n} постах).`
        + (slots.length > 1 ? '<br>Дальше: ' + slots.slice(1, 4).map(s => `${days[s.dow]} ${String(s.hour).padStart(2, '0')}:00 — ${fmt(s.viewsMedian)} (${s.n})`).join(' · ') : '')
        + '<br><span class="dim">Время в выгрузке — UTC; для Тюмени (+5) сдвиньте на 5 часов вперёд.</span>'
      : 'Слотов с достаточным числом постов (≥5) не нашлось.';
    // загрузка по дням недели
    const byDow = [0, 0, 0, 0, 0, 0, 0], viewsByDow = Array.from({ length: 7 }, () => []);
    m.posts.forEach(p => { const d = new Date(p.date); if (isNaN(d)) return; byDow[d.getUTCDay()]++; viewsByDow[d.getUTCDay()].push(p.views); });
    const order = [1, 2, 3, 4, 5, 6, 0];
    Charts.barChart($('#chart-dow'), {
      labels: order.map(i => days[i]), values: order.map(i => byDow[i]), height: 220,
      tipFmt: i => `<b>${days[order[i]]}</b><br>постов: ${byDow[order[i]]}<br>медиана просмотров: ${fmt(TGA.median(viewsByDow[order[i]]))}`,
    });
  }

  function renderTopics() {
    const m = state.model, t = m.topics;
    Charts.donut($('#donut-topics'), {
      items: t.slice(0, 12).map(x => ({ name: x.name, count: x.count, er: x.er })),
      height: 250,
      tipFmt: it => `<b>${Charts.esc(it.name)}</b><br>постов: ${it.count}<br>ER: ${it.er}%`,
    });
    Charts.barChart($('#chart-topics-views'), {
      horizontal: true, height: Math.max(240, t.length * 26),
      labels: t.map(x => x.name), values: t.map(x => x.viewsMedian),
      valueFmt: v => fmt(v), tipFmt: i => `<b>${Charts.esc(t[i].name)}</b><br>медиана просмотров: ${fmt(t[i].viewsMedian)}<br>постов: ${t[i].count}<br>ER: ${t[i].er}%`,
    });
    // тренд темы: доля в последние 6 месяцев против предыдущих
    const months = m.monthly.map(x => x.month);
    const cut = months[Math.max(0, months.length - 6)];
    const recent = m.posts.filter(p => p.date.slice(0, 7) >= cut), older = m.posts.filter(p => p.date.slice(0, 7) < cut);
    const share = (arr, topic) => arr.length ? (100 * arr.filter(p => p.topic === topic).length) / arr.length : 0;
    Charts.table($('#tbl-topics'), {
      columns: [
        { title: 'тема', key: 'name' },
        { title: 'постов', align: 'right', render: r => r.count },
        { title: 'доля', align: 'right', render: r => r.share + '%' },
        { title: 'медиана просмотров', align: 'right', render: r => fmt(r.viewsMedian) },
        { title: 'реакций всего', align: 'right', render: r => fmt(r.reactTotal) },
        { title: 'ER', align: 'right', render: r => `<b>${r.er}%</b>` },
        { title: `тренд (с ${cut})`, align: 'right', render: r => { const a = share(recent, r.name), b = share(older, r.name); const d = a - b; return `${a.toFixed(1)}% <span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}</span>`; } },
        { title: 'топ-пост темы', render: r => r.top ? `<a href="${r.top.url}" target="_blank">${fmt(r.top.views)}</a>` : '—' },
      ], rows: t,
    });
  }

  function renderAnatomy() {
    const a = state.model.anatomy;
    $('#anatomy-kpi').innerHTML = [
      kpi('Символов в посте', `${a.chars.median}`, `P90 ${a.chars.p90} · максимум ${a.chars.max}`),
      kpi('Фраза', `${a.sent.median} слов`, `P90 ${a.sent.p90} · самая длинная ${a.sent.max} (в строке-предложении)`),
      kpi('Строк в посте', `${a.lines.median}`, `P90 ${a.lines.p90} · максимум ${a.lines.max}`),
      kpi('Эмодзи', a.emoji.median + ' / пост', `${a.emoji.withPct}% постов с эмодзи · ${a.emoji.startsPct}% начинаются с маркера`),
      kpi('Кавычки-ёлочки', a.content.withQuote + '%', 'постов содержат «…»'),
      kpi('Атрибуция спикера', a.content.withAttr + '%', 'эксперт, имя, должность'),
      kpi('Ссылка на источник', a.content.withSource + '%', 'ТАСС/РБК/ЦБ/ДОМ.РФ и др.'),
      kpi('Реклама с токеном', a.discipline.eridPct + '%', `${a.discipline.ads}% с маркировкой «Реклама.»`, 'warn'),
    ].join('');

    const hooks = Object.entries(a.hooks).sort((x, y) => y[1] - x[1]);
    Charts.barChart($('#chart-hooks'), {
      horizontal: true, height: 220, labels: hooks.map(h => h[0]), values: hooks.map(h => h[1]),
      valueFmt: v => `${v} (${TGA.pct(v, a.n)}%)`,
      tipFmt: i => `<b>${Charts.esc(hooks[i][0])}</b><br>постов: ${hooks[i][1]} (${TGA.pct(hooks[i][1], a.n)}%)`,
    });
    const mk = Object.entries(a.marker).sort((x, y) => y[1] - x[1]);
    Charts.barChart($('#chart-markers'), {
      horizontal: true, height: 220, labels: mk.map(h => h[0]), values: mk.map(h => h[1]),
      valueFmt: v => `${v} (${TGA.pct(v, a.n)}%)`, color: 'var(--c3)',
    });
    const cta = Object.entries(a.cta).sort((x, y) => y[1] - x[1]).filter(x => x[1] > 0);
    Charts.barChart($('#chart-cta'), {
      horizontal: true, height: Math.max(200, cta.length * 26), labels: cta.map(h => h[0]), values: cta.map(h => h[1]),
      valueFmt: v => `${v} (${TGA.pct(v, a.n)}%)`, color: 'var(--c4)',
    });
    Charts.barChart($('#chart-emoji'), {
      horizontal: true, height: Math.max(220, a.emoji.top.length * 24),
      labels: a.emoji.top.slice(0, 14).map(e => e[0]), values: a.emoji.top.slice(0, 14).map(e => e[1]),
      valueFmt: v => String(v), color: 'var(--c5)',
    });
    Charts.table($('#tbl-tails'), {
      columns: [
        { title: 'финальная строка', render: r => Charts.esc(r[0].slice(0, 90)) },
        { title: 'постов', align: 'right', render: r => r[1] },
        { title: 'доля', align: 'right', render: r => TGA.pct(r[1], a.n) + '%' },
      ], rows: a.tails,
    });
    const d = a.discipline;
    const rules = [
      ['«Этажи» в кавычках', d.brandQuoted + '%', d.counts.brandQuoted, 'норма', '«Этажи» в кавычках'],
      ['«Этажи» без кавычек', d.brandUnquoted + '%', d.counts.brandUnquoted, 'ошибка', '«Этажи» без кавычек'],
      ['риелтор через «и»', `${d.rieltorI} постов`, d.rieltorI, 'норма', 'риелтор через «и»'],
      ['риэлтор через «э»', `${d.rieltorE} постов`, d.rieltorE, 'ошибка', 'риэлтор через «э»'],
      ['хэштеги', d.hashtags + '%', d.counts.hashtags, 'нейтрально', 'Хэштеги'],
      ['прямые кавычки "', d.straightQuotes + '%', d.counts.straightQuotes, 'ошибка', 'Прямые кавычки "'],
      ['двойные пробелы', d.doubleSpace + '%', d.counts.doubleSpace, 'ошибка', 'Двойные пробелы'],
      ['латиница внутри кириллицы', d.cyrLatin + '%', d.counts.cyrLatin, 'ошибка', 'Латиница внутри кириллицы'],
      ['процент с пробелом (5 %)', `${d.percentSpaced} шт.`, d.percentSpaced, 'ошибка', 'Процент с пробелом (5 %)', 'uses'],
      ['фразы длиннее 32 слов', `${d.longSentences} постов`, d.longSentences, 'ошибка', 'Фразы длиннее 32 слов'],
      ['хайп-лексика', d.hyped + '%', d.counts.hyped, 'запрещено', 'Хайп-лексика'],
      ['канцелярит', d.cancel + '%', d.counts.cancel, 'запрещено', 'Канцелярит'],
      ['обещания/гарантии', d.promise + '%', d.counts.promise, 'запрещено', 'Обещания и гарантии'],
    ];
    renderDiscipline(rules, a.errors, a.n);
  }

  // раскрываемый «список отступлений»: строка → посты, где правило нарушено
  function snippetOf(text, frag, ctx) {
    if (ctx && ctx.hit) {
      return Charts.esc(ctx.pre || '') + '<mark>' + Charts.esc(ctx.hit) + '</mark>' + Charts.esc(ctx.post || '');
    }
    const firstLine = () => Charts.esc((text.split('\n').filter(Boolean)[0] || '').slice(0, 150)) + '…';
    if (!frag) return firstLine();
    const variants = [frag, ...String(frag).split(/[,\s]+/).filter(w => w.length > 2)]
      .sort((a, b) => b.length - a.length);
    for (const v of variants) {
      const i = text.toLowerCase().indexOf(v.toLowerCase().slice(0, 40));
      if (i < 0) continue;
      const from = Math.max(0, i - 60), to = Math.min(text.length, i + v.length + 60);
      return (from > 0 ? '…' : '') + Charts.esc(text.slice(from, i).replace(/\n/g, ' ')) +
        '<mark>' + Charts.esc(text.slice(i, i + v.length)) + '</mark>' +
        Charts.esc(text.slice(i + v.length, to).replace(/\n/g, ' ')) + (to < text.length ? '…' : '');
    }
    return firstLine();
  }

  function renderDiscipline(rules, errors, total) {
    const touched = new Set();
    Object.values(errors).forEach(list => list.forEach(e => touched.add(e.p)));
    const host = $('#tbl-discipline');
    host.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'dim';
    note.innerHTML = 'Нажмите на строку — раскроется список постов с этим отступлением. ' +
      `Всего отступлений затрагивают <b>${touched.size}</b> постов из ${total}.`;
    host.appendChild(note);

    const t = document.createElement('table');
    t.className = 'tbl tbl-rules';
    t.innerHTML = `<thead><tr><th></th><th>признак</th><th style="text-align:right">значение</th>
      <th style="text-align:right">постов</th><th>оценка</th></tr></thead>`;
    const tb = document.createElement('tbody');
    rules.forEach(([name, value, count, tone, errKey, unit]) => {
      const list = errors[errKey] || [];
      const clickable = list.length > 0;
      const tr = document.createElement('tr');
      tr.className = 'rule-row' + (clickable ? '' : ' flat');
      tr.innerHTML = `<td class="caret">${clickable ? '▶' : ''}</td>
        <td>${Charts.esc(name)}${unit === 'uses' ? ' <span class="dim">упоминаний</span>' : ''}</td>
        <td style="text-align:right">${value}</td>
        <td style="text-align:right">${clickable ? `<b>${list.length}</b>` : ''}</td>
        <td><span class="tag ${tone === 'норма' ? 'ok' : (tone === 'ошибка' || tone === 'запрещено') ? 'bad' : ''}">${tone}</span></td>`;
      tb.appendChild(tr);

      if (!clickable) return;
      const dr = document.createElement('tr');
      dr.className = 'rule-posts hidden';
      const td = document.createElement('td');
      td.colSpan = 5;
      dr.appendChild(td);
      const render = (limit) => {
        td.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'rule-posts-box';
        list.slice(0, limit).forEach(({ p, m, ctx }) => {
          const row = document.createElement('div');
          row.className = 'err-item';
          row.innerHTML = `<div class="err-meta"><a href="${p.url}" target="_blank">${p.post_id}</a>
            · ${p.date.slice(0, 10)} · <b>${fmt(p.views)}</b> просм · ${p.reactions} реакц · ${p.topic}</div>
            <div class="err-text">${snippetOf(p.text, m, ctx)}</div>`;
          row.addEventListener('click', ev => {
            if (ev.target.tagName === 'A') return;
            openPost(p);
          });
          box.appendChild(row);
        });
        td.appendChild(box);
        if (list.length > limit) {
          const more = document.createElement('button');
          more.className = 'btn small';
          more.textContent = `Показать все ${list.length}`;
          more.addEventListener('click', ev => { ev.stopPropagation(); render(list.length); });
          td.appendChild(more);
        }
      };
      render(12);
      tr.addEventListener('click', () => {
        const open = !dr.classList.contains('hidden');
        dr.classList.toggle('hidden', open);
        tr.classList.toggle('open', !open);
      });
      tb.appendChild(dr);
    });
    t.appendChild(tb);
    host.appendChild(t);
  }

  function renderConnections() {
    const c = state.model.connections, m = state.model;
    $('#conn-stats').innerHTML = [
      kpi('Групп дублей', c.stats.dupGroups, `${c.stats.dupPosts} постов-повторов`, 'warn'),
      kpi('Ссылок внутри канала', c.stats.links, 'пост → пост'),
      kpi('Цепочек одной темы', c.stats.chains, `медиана ${c.stats.chainMedian} поста · самая длинная ${c.stats.chainLongest}`),
      kpi('Внешних каналов', c.external.length, 'упомянуты в ссылках и @упоминаниях'),
    ].join('');

    // граф: дубли + ссылки + топ по просмотрам
    const nodeMap = new Map();
    const add = (p, kind, r, color, label) => {
      if (nodeMap.has(p.channel + '/' + p.post_id)) return nodeMap.get(p.channel + '/' + p.post_id);
      const n = {
        id: p.channel + '/' + p.post_id, r, color,
        label, tip: `${p.date.slice(0, 10)} · ${p.views} просм · ${p.reactions} реакц · ${p.topic}<br>${Charts.esc(p.text.split('\n')[1] || p.text.slice(0, 60))}`,
        onClick: () => openPost(p),
      };
      nodeMap.set(n.id, n); return n;
    };
    const edges = [];
    c.dupGroups.forEach(g => {
      g.posts.forEach(p => add(p, 'dup', 7, 'rgba(252,64,58,.9)', null));
      for (let i = 1; i < g.posts.length; i++) edges.push({ source: g.posts[0].channel + '/' + g.posts[0].post_id, target: g.posts[i].channel + '/' + g.posts[i].post_id, kind: 'dup' });
    });
    c.linkEdges.forEach(e => {
      add(e.from, 'link', 6, 'rgba(42,114,238,.9)', null);
      add(e.to, 'link', 6, 'rgba(42,114,238,.9)', null);
      edges.push({ source: e.from.channel + '/' + e.from.post_id, target: e.to.channel + '/' + e.to.post_id, kind: 'link' });
    });
    const linked = new Set(edges.flatMap(e => [e.source, e.target]));
    m.overview.top.slice(0, 40).forEach(p => {
      if (!nodeMap.has(p.channel + '/' + p.post_id)) add(p, 'top', 5, 'rgba(42,114,238,.45)', null);
    });
    // кластеры серий: центры по темам
    const topicCenters = {};
    m.topics.slice(0, 12).forEach(t => {
      const p = t.top; if (!p) return;
      const n = add(p, 'topic', 10, 'rgba(252,64,58,.35)', t.name);
      topicCenters[t.name] = n.id;
    });
    c.seriesEdges.filter((_, i) => i % Math.max(1, Math.floor(c.seriesEdges.length / 120)) === 0).forEach(e => {
      const a = add(e.from, 'series', 3, 'rgba(140,140,150,.5)', null);
      const b = add(e.to, 'series', 3, 'rgba(140,140,150,.5)', null);
      edges.push({ source: a.id, target: b.id, kind: 'series' });
    });
    const nodes = Array.from(nodeMap.values());
    $('#graph-note').textContent = `Узлов: ${nodes.length}, связей: ${edges.length} (серии показаны выборкой из ${c.seriesEdges.length} смежных пар). Клик по узлу — карточка поста.`;
    if (nodes.length > 1) Charts.graph($('#graph'), { nodes, edges, height: 460 });

    Charts.table($('#tbl-dups'), {
      columns: [
        { title: 'постов в группе', align: 'right', render: r => r.posts.length },
        { title: 'похожесть', align: 'right', render: r => (r.similarity * 100).toFixed(0) + '%' },
        { title: 'даты', render: r => r.posts.map(p => p.date.slice(0, 10)).join(' → ') },
        { title: 'просмотры', render: r => r.posts.map(p => fmt(p.views)).join(' / ') },
        { title: 'первый пост', render: r => link(r.posts[0]) },
      ], rows: c.dupGroups.slice(0, 30),
    });
    Charts.table($('#tbl-links'), {
      columns: [
        { title: 'откуда', render: r => `<a href="${r.from.url}" target="_blank">${r.from.post_id}</a>` },
        { title: 'дата', render: r => r.from.date.slice(0, 10) },
        { title: 'куда', render: r => `<a href="${r.to.url}" target="_blank">${r.to.post_id}</a>` },
        { title: 'текст источника', render: r => Charts.esc(r.from.text.split('\n').filter(Boolean)[0].slice(0, 80)) },
      ], rows: c.linkEdges.slice(0, 40), empty: 'ссылок на собственные посты не найдено',
    });
    Charts.table($('#tbl-chains'), {
      columns: [
        { title: 'постов', align: 'right', render: r => r.chain.length },
        { title: 'тема', render: r => r.chain[0].topic },
        { title: 'период', render: r => `${r.chain[0].date.slice(0, 10)} → ${r.chain[r.chain.length - 1].date.slice(0, 10)}` },
        { title: 'медиана просмотров', align: 'right', render: r => fmt(TGA.median(r.chain.map(p => p.views))) },
        { title: 'просмотры по постам', render: r => r.chain.slice(0, 12).map(p => `<a href="${p.url}" target="_blank">${fmt(p.views)}</a>`).join(' · ') + (r.chain.length > 12 ? ' …' : '') },
      ], rows: c.chains.slice(0, 25).map(chain => ({ chain })),
    });
    Charts.table($('#tbl-external'), {
      columns: [
        { title: 'канал/ссылка', render: r => `<a href="https://t.me/${r.channel}" target="_blank">@${r.channel}</a>` },
        { title: 'упоминаний', align: 'right', render: r => r.n },
      ], rows: c.external.slice(0, 25), empty: 'внешних ссылок нет',
    });
    Charts.table($('#tbl-ads'), {
      columns: [
        { title: 'дата', render: r => r.date.slice(0, 10) },
        { title: 'просмотры', align: 'right', render: r => fmt(r.views) },
        { title: 'маркировка', render: () => 'Реклама. ООО «Этажи»' },
        { title: 'токен', render: r => /erid/i.test(r.text) ? '[REDACTED]' : 'не указан' },
        { title: 'текст', render: r => `<a href="${r.url}" target="_blank">открыть пост</a>` },
      ], rows: c.adPosts, empty: 'рекламных постов с маркировкой нет',
    });
  }

  const paging = { page: 1, per: 50 };
  // ---------------- глубокий анализ ----------------
  function loadPool() {
    try { return JSON.parse(localStorage.getItem('tga.pool') || '[]'); } catch (e) { return []; }
  }
  function savePool(pool) {
    try { localStorage.setItem('tga.pool', JSON.stringify(pool)); } catch (e) { /* приватный режим */ }
  }
  function channelSummary(name, m, deep) {
    return {
      name,
      posts: m.overview.n,
      perWeek: m.overview.perWeek,
      reach: m.overview.views.median,
      reachP90: m.overview.views.p90,
      erByViews: m.overview.er.byViews,
      erPerPost: m.overview.er.byPost,
      virality: m.overview.virality,
      emoji: m.anatomy.emoji.median,
      chars: m.anatomy.chars.median,
      flesch: deep ? +deep.copy.flesch.toFixed(1) : null,
      reachAudience: m.audience ? m.audience.reachMedian : null,
      erAudience: m.audience ? m.audience.erPerPost : null,
      subs: m.subs || null,
      updatedAt: new Date().toISOString().slice(0, 10),
    };
  }

  function percentileOf(pool, key, value, higherBetter = true) {
    const vals = pool.map(p => p[key]).filter(v => typeof v === 'number' && isFinite(v));
    if (!vals.length || typeof value !== 'number' || !isFinite(value)) return null;
    const below = vals.filter(v => v < value).length, equal = vals.filter(v => v === value).length;
    const pct = (100 * (below + 0.5 * equal)) / vals.length;
    return higherBetter ? pct : 100 - pct;
  }

  function renderNeighbours(deep) {
    const nb = deep.neighbourhood;
    if (!nb) { $('#tbl-neighbours').innerHTML = '<div class="empty">мало постов для анализа соседства</div>'; $('#neighbours-note').textContent = ''; return; }
    Charts.table($('#tbl-neighbours'), {
      columns: [
        { title: 'интервал до предыдущего поста', render: r => Charts.esc(r.name) },
        { title: 'постов', align: 'right', render: r => r.n },
        { title: 'уровень охвата', align: 'right', render: r => (r.median * 100).toFixed(0) + '%' },
        { title: 'к остальным', align: 'right', render: r => r.lift == null ? '—' : `<span class="${r.lift >= 0 ? 'up' : 'down'}">${r.lift >= 0 ? '+' : ''}${r.lift.toFixed(0)}%</span>` },
        { title: 'p', align: 'right', render: r => r.p == null ? '—' : (r.p < 0.001 ? '< 0.001' : r.p.toFixed(3)) },
        { title: 'вывод', render: r => r.p == null ? '<span class="tag">мало данных</span>'
            : r.p < 0.05 ? `<span class="tag ${r.cliff > 0 ? 'ok' : 'bad'}">${r.cliff > 0 ? 'лучше' : 'хуже'} остальных</span>`
            : '<span class="tag">не доказано</span>' },
      ], rows: nb.gaps,
    });
    $('#neighbours-note').innerHTML =
      `Уровень охвата считается от обычного для канала (100 % — типичный пост) и очищен от общего тренда: ` +
      `иначе сравнение показывало бы «эпоху», а не эффект. Медианный интервал между постами — ${nb.medianGapHours.toFixed(1)} ч. ` +
      `Связь с предыдущим постом: Спирмен ${nb.spearmanPrev == null ? '—' : nb.spearmanPrev.toFixed(2)} ` +
      `(${Math.abs(nb.spearmanPrev || 0) < 0.15 ? 'переноса нет' : (nb.spearmanPrev > 0 ? 'есть перенос: удачный пост тянет следующий' : 'после удачного поста следующий проседает')}).`;
    const b = nb.burstTest;
    Charts.barChart($('#chart-burst'), {
      labels: ['день с 1 постом', `день с 2+ постами (${nb.daysBusy.n})`],
      values: [nb.daysCalm.median * 100, nb.daysBusy.median * 100], height: 200, color: 'var(--c3)',
      valueFmt: v => v.toFixed(0) + '%',
      tipFmt: i => i === 0 ? `<b>один пост в день</b><br>уровень охвата ${(nb.daysCalm.median * 100).toFixed(0)} % (n = ${nb.daysCalm.n} дней)`
                           : `<b>два и более постов</b><br>уровень охвата ${(nb.daysBusy.median * 100).toFixed(0)} % (n = ${nb.daysBusy.n} дней)`,
    });
    const dPct = (nb.daysBusy.median - nb.daysCalm.median) * 100;
    const tiny = Math.abs(dPct) < 10 || Math.abs(b.cliff) < 0.1;
    $('#burst-note').innerHTML = b
      ? `Разница ${dPct >= 0 ? '+' : ''}${dPct.toFixed(0)} п.п. от обычного уровня (p = ${b.p.toFixed(3)}, размер эффекта ${b.cliff.toFixed(2)}). ` +
        (tiny ? 'Разница мала по величине — практического вывода делать нельзя, даже если p мало.'
         : b.p < 0.05 ? (dPct > 0 ? 'В плотные дни охват выше.' : 'В плотные дни охват ниже: стоит разнести публикации.') : 'Значимого различия нет.')
      : 'недостаточно дней каждого типа для сравнения.';
  }

  function renderDeep() {
    if (state.deep) return;                  // уже посчитано для этого канала
    const m = state.model;
    $('#findings').innerHTML = '<div class="finding neutral"><span class="dot"></span>Считаю статистику: бутстрэп, перестановочные тесты, драйверы, прогноз… это несколько секунд на большой истории.</div>';
    const deep = state.deep = TGA2.analyzeDeep(m.posts, m);

    $('#findings').innerHTML = deep.findings.map(f =>
      `<div class="finding ${f.level}"><span class="dot"></span>${f.text}</div>`).join('');

    const sigDrivers = deep.drivers.filter(d => d.significant);
    const fr = deep.forecast ? deep.forecast.points[0] : null;
    const fleschTone = deep.copy.flesch >= 60 ? 'просто' : deep.copy.flesch >= 45 ? 'средне' : 'сложно';
    $('#deep-kpi').innerHTML = [
      kpi('Медиана просмотров', fmt(deep.median),
        `ДИ 95 %: ${fmt(deep.medianCI.lo)}…${fmt(deep.medianCI.hi)} (бутстрэп, n = ${deep.medianCI.n})`),
      kpi('Среднее', fmt(deep.meanCI.point), `ДИ: ${fmt(deep.meanCI.lo)}…${fmt(deep.meanCI.hi)} · σ = ${fmt(deep.meanCI.sd)}`),
      kpi('Тренд', `${deep.trend.monthlyPct >= 0 ? '+' : ''}${deep.trend.monthlyPct.toFixed(1)} %`,
        `в месяц · ДИ ${deep.trend.lo.toFixed(1)}…${deep.trend.hi.toFixed(1)} % · R² = ${deep.trend.r2.toFixed(2)}`,
        deep.trend.lo > 0 ? 'ok-aud' : deep.trend.hi < 0 ? 'warn' : ''),
      kpi('Прогноз на ' + (fr ? fr.month : '—'), fr ? fmt(fr.point) : '—',
        fr ? `интервал ${fmt(fr.lo)}…${fmt(fr.hi)}${fr.seasonal ? ' · учтена сезонность месяца' : ''}` : 'мало месяцев для прогноза'),
      kpi('Читабельность', deep.copy.flesch.toFixed(0), `Flesch (рус.): ${fleschTone} · ${deep.copy.asl.toFixed(1)} слов/фраза, ${deep.copy.asw.toFixed(2)} слога/слово`),
      kpi('Значимых драйверов', `${sigDrivers.length} из ${deep.drivers.length}`,
        'связаны с просмотрами при p < 0.05 и заметном эффекте'),
    ].join('');

    const hist = m.monthly.filter(x => x.count >= 2).map(x => ({ label: x.month, value: x.viewsMedian }));
    if (deep.forecast) {
      Charts.forecastChart($('#chart-forecast'), { history: hist, forecast: deep.forecast.points });
      $('#forecast-note').textContent =
        `Наивная модель: тренд по логарифму медианы за последние ${deep.forecast.basedOnMonths} месяцев плюс средняя сезонность месяца; ` +
        `σ остатков ${deep.forecast.sigma.toFixed(2)}. Интервал расширяется с горизонтом (95 %). ` +
        `Прогноз показывает уровень, а не гарантию: разовые вирусные посты и внешние всплески модель не знает.`;
    } else {
      $('#chart-forecast').innerHTML = '<div class="empty">для прогноза нужно минимум 8 месяцев с данными</div>';
      $('#forecast-note').textContent = '';
    }

    Charts.segments($('#chart-segments'), { segments: deep.changepoints.segments, labels: hist });
    $('#changepoints-note').innerHTML = deep.changepoints.cuts.length
      ? `Точки перелома (бинарная сегментация по медианам, L1): ${deep.changepoints.cuts.join(', ')}. ` +
        deep.changepoints.segments.map(s => `${s.from}…${s.to} — медиана ${fmt(s.median)} (${s.n} мес.)`).join('; ') + '.'
      : 'Устойчивых переломов не нашлось: динамика выглядит как один режим.';

    Charts.table($('#tbl-drivers'), {
      columns: [
        { title: 'признак', render: r => Charts.esc(r.feature) },
        { title: 'постов с', align: 'right', render: r => r.nWith },
        { title: 'медиана с', align: 'right', render: r => fmt(r.medianWith) },
        { title: 'медиана без', align: 'right', render: r => fmt(r.medianWithout) },
        { title: 'эффект', align: 'right', render: r => `<span class="${r.lift >= 0 ? 'up' : 'down'}">${r.lift >= 0 ? '+' : ''}${r.lift.toFixed(0)}%</span>` },
        { title: 'p', align: 'right', render: r => r.p < 0.001 ? '< 0.001' : r.p.toFixed(3) },
        { title: 'размер эффекта', align: 'right', render: r => r.cliff.toFixed(2) },
        { title: 'вывод', render: r => r.significant
            ? `<span class="tag ${r.cliff > 0 ? 'ok' : 'bad'}">${r.cliff > 0 ? 'повышает' : 'понижает'}</span>`
            : '<span class="tag">не доказано</span>' },
      ], rows: deep.drivers,
    });

    Charts.table($('#tbl-slots'), {
      columns: [
        { title: 'слот (UTC)', render: r => `${['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][r.dow]}, ${String(r.hour).padStart(2, '0')}:00` },
        { title: 'постов', align: 'right', render: r => r.n },
        { title: 'медиана', align: 'right', render: r => fmt(r.median) },
        { title: 'ДИ 95 %', align: 'right', render: r => `${fmt(r.lo)}…${fmt(r.hi)}` },
        { title: 'вывод', render: r => r.better ? '<span class="tag ok">выше среднего</span>'
            : r.worse ? '<span class="tag bad">ниже среднего</span>' : '<span class="tag">как везде</span>' },
      ], rows: deep.slots.cells.slice(0, 12),
    });
    Charts.barChart($('#chart-bands'), {
      labels: deep.slots.bandStats.map(b => b.band), values: deep.slots.bandStats.map(b => b.median),
      height: 220, color: 'var(--c6)',
      tipFmt: i => { const b = deep.slots.bandStats[i]; return `<b>${b.band}</b><br>постов: ${b.n}<br>медиана: ${fmt(b.median)}<br>ДИ: ${fmt(b.lo)}…${fmt(b.hi)}`; },
    });

    Charts.table($('#tbl-rubrics'), {
      columns: [
        { title: 'рубрика', render: r => Charts.esc(r.name) },
        { title: 'постов', align: 'right', render: r => r.count },
        { title: 'доля', align: 'right', render: r => r.share.toFixed(1) + '%' },
        { title: 'медиана просмотров', align: 'right', render: r => fmt(r.median) },
        { title: 'ДИ 95 %', align: 'right', render: r => r.lo ? `${fmt(r.lo)}…${fmt(r.hi)}` : '—' },
        { title: 'к медиане канала', align: 'right', render: r => `<span class="${r.lift >= 0 ? 'up' : 'down'}">${r.lift >= 0 ? '+' : ''}${r.lift.toFixed(0)}%</span>` },
        { title: 'ER', align: 'right', render: r => r.er.toFixed(2) + '%' },
        { title: 'p', align: 'right', render: r => r.p == null ? '—' : (r.p < 0.001 ? '< 0.001' : r.p.toFixed(3)) },
        { title: 'знаков', align: 'right', render: r => r.chars },
        { title: 'лучший пост', render: r => r.best ? `<a href="${r.best.url}" target="_blank">${fmt(r.best.views)} просмотров</a>` : '—' },
      ], rows: deep.rubrics,
    });

    const c = deep.copy;
    Charts.table($('#tbl-copy'), {
      columns: [
        { title: 'показатель', render: r => r[0] },
        { title: 'значение', align: 'right', render: r => r[1] },
        { title: 'как читать', render: r => r[2] },
      ],
      rows: [
        ['Индекс читабельности Flesch (рус.)', c.flesch.toFixed(1), c.flesch >= 60 ? 'легко читается' : c.flesch >= 45 ? 'средняя сложность' : 'тяжело: длинные фразы и много слогов'],
        ['Слов во фразе (в среднем)', c.asl.toFixed(1), 'ориентир для соцсетей — до 12'],
        ['Слогов на слово', c.asw.toFixed(2), 'чем больше, тем «тяжелее» текст'],
        ['Фразы длиннее 25 слов', c.sent.longShare.toFixed(1) + '%', 'такие фразы теряют читателя'],
        ['Вопросительных фраз', c.questionShare.toFixed(1) + '%', 'вопросы вовлекают'],
        ['Восклицательных фраз', c.exclaimShare.toFixed(1) + '%', 'больше 15 % — крикливо'],
        ['«Мы / наш» в тексте', c.weShare.toFixed(1) + '%', 'корпоративное «мы» вместо «вы»'],
        ['Пассивные конструкции', c.passiveShare.toFixed(1) + '%', 'актив звучит проще'],
        ['Постов с клише, на 100', c.clichePer100.toFixed(1), 'штампы обесценивают текст'],
        ['Постов с канцеляритом, на 100', c.cancelPer100.toFixed(1), '«осуществляется», «в рамках», «данный»'],
      ],
    });
    Charts.table($('#tbl-cliche'), {
      columns: [
        { title: 'штамп', render: r => '«' + Charts.esc(r.phrase) + '»' },
        { title: 'постов', align: 'right', render: r => r.posts },
      ], rows: c.clicheList, empty: 'штампов из списка не найдено — хорошо',
    });

    Charts.table($('#tbl-drift'), {
      columns: [
        { title: 'год', render: r => r.year },
        { title: 'постов', align: 'right', render: r => r.posts },
        { title: 'знаков', align: 'right', render: r => r.chars },
        { title: 'эмодзи/пост', align: 'right', render: r => r.emoji },
        { title: '«ёлочки», %', align: 'right', render: r => r.quotes + '%' },
        { title: 'ссылка на источник, %', align: 'right', render: r => r.source + '%' },
        { title: 'вопрос, %', align: 'right', render: r => r.question + '%' },
      ], rows: c.drift,
    });

    renderNeighbours(deep);
    renderBenchmark(deep);
    renderAnomalies(deep);
    renderGrowth();
  }

  function renderBenchmark(deep) {
    const m = state.model;
    const pool = loadPool();
    const me = channelSummary(m.channel, m, deep);
    const list = pool.filter(p => p.name !== me.name);
    const all = list.concat([me]);
    const metrics = [
      ['Медиана просмотров', 'reach', 'median', true],
      ['P90 просмотров', 'reachP90', 'median', true],
      ['Постов в неделю', 'perWeek', 'count', true],
      ['ER по просмотрам, %', 'erByViews', 'percent', true],
      ['Реакций на пост', 'erPerPost', 'count', true],
      ['Виральность P90/медиана', 'virality', 'x', true],
      ['Эмодзи на пост', 'emoji', 'count', true],
      ['Знаков в посте', 'chars', 'count', false],
      ['Читабельность Flesch', 'flesch', 'count', true],
    ].filter(([, key]) => all.some(p => typeof p[key] === 'number' && isFinite(p[key])));
    const rows = metrics.map(([title, key, kind, higherBetter]) => {
      const val = me[key];
      const pct = percentileOf(all, key, val, higherBetter);
      const withVal = all.filter(p => typeof p[key] === 'number' && isFinite(p[key]));
      const best = withVal.slice().sort((a, b) => higherBetter ? b[key] - a[key] : a[key] - b[key])[0];
      return { title, val, pct, n: withVal.length, best, key, kind };
    });
    Charts.table($('#tbl-bench'), {
      columns: [
        { title: 'показатель', render: r => r.title },
        { title: `${Charts.esc(m.channel)}`, align: 'right', render: r => r.kind === 'percent' ? r.val + '%' : fmt(r.val) },
        { title: 'перцентиль', align: 'right', render: r => r.pct == null ? '—' : `<b>${Math.round(r.pct)}</b>` },
        { title: 'каналов в пуле', align: 'right', render: r => r.n },
        { title: 'лучший в пуле', render: r => r.best ? `${Charts.esc(r.best.name)} — ${r.kind === 'percent' ? r.best[r.key] + '%' : fmt(r.best[r.key])}` : '—' },
      ], rows,
    });
    $('#pool-note').textContent = list.length
      ? `В пуле ${list.length} канал(ов) помимо текущего. Перцентиль — доля каналов пула, которые этот канал превосходит. ` +
        `Добавляйте конкурентов по ссылке и в пул — сравнение сохранится между сессиями.`
      : 'Пул пуст: добавьте каналы (загрузите их по ссылке или файлом) и нажмите «Добавить канал в пул сравнения» — ' +
        'после этого появится место в распределении. Пул хранится в браузере, его можно экспортировать и перенести.';
  }

  function renderAnomalies(deep) {
    const m = state.model;
    const med = deep.median;
    const noReact = m.posts.filter(p => p.views >= med * 3 && p.reactions === 0)
      .sort((a, b) => b.views - a.views);
    const frozen = m.posts.filter(p => /Channel (photo updated|created)/i.test(p.text));
    Charts.table($('#tbl-anomalies'), {
      columns: [
        { title: 'тип', render: r => Charts.esc(r.type) },
        { title: 'дата', render: r => r.p.date.slice(0, 10) },
        { title: 'просмотры', align: 'right', render: r => fmt(r.p.views) },
        { title: 'реакции', align: 'right', render: r => r.p.reactions },
        { title: 'z (MAD)', align: 'right', render: r => r.z == null ? '—' : r.z.toFixed(1) },
        { title: 'тема', render: r => r.p.topic },
        { title: 'текст', render: r => link(r.p) },
      ],
      rows: deep.outliers.map(o => ({ type: 'всплеск охвата', p: o.p, z: o.z }))
        .concat(noReact.map(p => ({ type: 'охват без реакций', p, z: null })))
        .concat(frozen.map(p => ({ type: 'служебная запись', p, z: null })))
        .slice(0, 30),
      empty: 'аномалий не найдено',
    });
  }

  async function renderGrowth() {
    const m = state.model;
    const note = $('#growth-note');
    if (!hasApi()) {
      note.innerHTML = 'Замеры скорости доступны при запуске через сервер: <code>python3 scripts/serve.py</code>. ' +
        'Сами замеры делаются командой <code>python3 scripts/snapshot.py https://t.me/канал</code>.';
      $('#growth-kpi').innerHTML = ''; $('#tbl-growth').innerHTML = ''; $('#chart-growth').innerHTML = '';
      return;
    }
    note.textContent = 'считаю замеры…';
    try {
      const r = await fetch(`api/growth?channel=${encodeURIComponent(m.channel)}`);
      const g = await r.json();
      if (!r.ok || g.error) throw new Error(g.error || `HTTP ${r.status}`);
      if (!g.pairs) {
        note.innerHTML = `Замеров пока ${g.snapshots}: чтобы посчитать скорость, нужно ≥2. ` +
          `Сделайте замер сейчас и повторите позже: <code>python3 scripts/snapshot.py https://t.me/${Charts.esc(m.channel)}</code>`;
        $('#growth-kpi').innerHTML = ''; $('#tbl-growth').innerHTML = ''; $('#chart-growth').innerHTML = '';
        return;
      }
      note.innerHTML = `Окно наблюдения <b>${g.windowHours.toFixed(1)} ч</b>: ` +
        `${Charts.esc(g.from)} → ${Charts.esc(g.to)}. Растут <b>${g.growing} из ${g.pairs}</b> постов (${g.growingShare.toFixed(0)} %).`;
      $('#growth-kpi').innerHTML = [
        kpi('Скорость растущих постов', g.perDayMedian.toFixed(1), 'просмотров в сутки (медиана)'),
        kpi('Прирост за замер', g.shareGainedMedian.toFixed(1) + '%', 'от текущих просмотров поста'),
        kpi('Рост прекращается к', g.growthStopAge != null ? g.growthStopAge.toFixed(1) + ' сут' : '—',
          'после публикации (по наблюдению)'),
        kpi('Насыщение τ', g.tau && g.tau.reliable ? `${(g.tau.hours).toFixed(0)} ч` : 'мало данных',
          g.tau ? g.tau.note : `замеров: ${g.snapshots}`),
      ].join('');
      Charts.barChart($('#chart-growth'), {
        labels: g.buckets.map(b => b.bucket), values: g.buckets.map(b => b.perDayMedian),
        height: 220, color: 'var(--c6)',
        tipFmt: i => `<b>${g.buckets[i].bucket}</b><br>просмотров в сутки: ${g.buckets[i].perDayMedian.toFixed(1)}<br>постов: ${g.buckets[i].n}`,
      });
      Charts.table($('#tbl-growth'), {
        columns: [
          { title: 'пост', render: r => `<a href="https://t.me/${Charts.esc(m.channel)}/${r.post_id}" target="_blank">${r.post_id}</a>` },
          { title: 'возраст', align: 'right', render: r => r.age_days == null ? '—' : r.age_days.toFixed(1) + ' сут' },
          { title: 'просмотры: было → стало', align: 'right', render: r => `${fmt(r.views_first)} → <b>${fmt(r.views_last)}</b>` },
          { title: 'прирост', align: 'right', render: r => `<span class="up">+${r.views_added}</span>` },
          { title: 'в сутки', align: 'right', render: r => r.per_day.toFixed(1) },
          { title: '% от текущих', align: 'right', render: r => r.share_gained.toFixed(2) + '%' },
        ], rows: g.top.slice(0, 12),
      });
    } catch (e) {
      note.innerHTML = `Замеров нет или сервер не отвечает (${Charts.esc(e.message)}). ` +
        `Сделайте замеры командой <code>python3 scripts/snapshot.py https://t.me/${Charts.esc(m.channel)}</code>.`;
      $('#growth-kpi').innerHTML = ''; $('#tbl-growth').innerHTML = ''; $('#chart-growth').innerHTML = '';
    }
  }

  // ---------------- сравнение каналов ----------------
  // в сравнении нужны точные числа: округление до «1 тыс» съедает разницу, которую мы измеряем
  function precise(v) {
    if (v == null || !isFinite(v)) return '—';
    if (Math.abs(v) >= 100000) return fmt(v);
    return Number.isInteger(v) ? v.toLocaleString('ru-RU') : v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  function cmpSelected() {
    const idx = state.cmp || [];
    return idx.map(i => state.datasets[i]).filter(Boolean);
  }

  function renderCompareTab() {
    if (state.datasets.length < 2) {
      $('#cmp-pickers').innerHTML = '';
      $('#cmp-note').innerHTML = 'Для сравнения нужны минимум два канала: загрузите их по ссылке ' +
        '(<code>+ Канал по ссылке</code>) или выберите файлы. Каналы можно докидывать в любой момент.';
      ['#cmp-profiles', '#tbl-h2h', '#tbl-pct', '#tbl-cmp-topics', '#tbl-cmp-style', '#tbl-rank'].forEach(s => { const el = $(s); if (el) el.innerHTML = ''; });
      $('#cmp-box').innerHTML = ''; $('#chart-cmp-month').innerHTML = '';
      return;
    }
    if (!state.cmp || state.cmp.length < 2) state.cmp = [0, 1];

    // выбор каналов A/B
    $('#cmp-pickers').innerHTML = `<span class="dim" style="align-self:center">канал A и B:</span>`;
    state.datasets.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (state.cmp.includes(i) ? ' on' : '');
      b.textContent = `${i === state.cmp[0] ? 'A · ' : i === state.cmp[1] ? 'B · ' : ''}${d.name} · ${d.posts.length}`;
      b.onclick = () => {
        const pos = state.cmp.indexOf(i);
        if (pos >= 0) { if (state.cmp.length > 2) state.cmp.splice(pos, 1); }
        else { state.cmp = [state.cmp[1] !== undefined ? state.cmp[1] : state.cmp[0], i].filter(x => x !== undefined).slice(-2); }
        renderCompareTab();
      };
      $('#cmp-pickers').appendChild(b);
    });
    const extra = document.createElement('button');
    extra.className = 'chip';
    extra.textContent = '+ добавить канал по ссылке';
    extra.onclick = () => { $('#btn-url').click(); };
    $('#cmp-pickers').appendChild(extra);

    const [dA, dB] = cmpSelected();
    if (!dA || !dB) return;
    const useOverlap = $('#cmp-overlap').checked;
    const ov = TGA3.overlapSlice([dA.posts, dB.posts]);
    let pA = dA.posts, pB = dB.posts;
    if (useOverlap && ov) { pA = ov.slices[0]; pB = ov.slices[1]; }

    const stA = TGA3.channelStats(pA, dA.subs), stB = TGA3.channelStats(pB, dB.subs);
    $('#cmp-note').innerHTML = useOverlap && ov
      ? `Сравнение по общему периоду <b>${ov.from} → ${ov.to}</b>: у A осталось ${pA.length} постов из ${dA.posts.length}, ` +
        `у B — ${pB.length} из ${dB.posts.length}. Так честнее: разные годы несравнимы из-за рынка и размера канала.`
      : `Сравниваются полные истории: A ${stA.period ? stA.period.from + ' → ' + stA.period.to : '—'}, ` +
        `B ${stB.period ? stB.period.from + ' → ' + stB.period.to : '—'}. Периоды разные — держите это в голове.`;

    // профили
    const prof = (name, st, d) => `
      <div class="kpi">
        <div class="kpi-label">${Charts.esc(name)}</div>
        <div class="kpi-value">${precise(st.viewsMedian)}</div>
        <div class="kpi-sub">медиана просмотров · постов ${st.posts} · ${st.perWeek.toFixed(1)} в неделю<br>
          ER ${st.erByViews.toFixed(2)} % · реакции на пост ${st.reactPerPost.toFixed(1)} · виральность ×${st.virality.toFixed(2)}<br>
          ${st.audience ? `охват ${st.audience.reachMedian} % при ${fmt(d.subs)} подписчиках · ER по подписчикам ${st.audience.erPerPost} %` : 'подписчиков не указано — охват и ER по аудитории недоступны'}</div>
      </div>`;
    $('#cmp-profiles').innerHTML = `<div class="kpis">${prof(dA.name, stA, dA)}${prof(dB.name, stB, dB)}</div>`;

    // лицом к лицу
    const rows = TGA3.headToHead(pA, pB, dA.subs, dB.subs);
    Charts.table($('#tbl-h2h'), {
      columns: [
        { title: 'показатель', render: r => Charts.esc(r.name) },
        { title: `A · ${Charts.esc(dA.name)}`, align: 'right', render: r => precise(r.a) + r.suffix },
        { title: `B · ${Charts.esc(dB.name)}`, align: 'right', render: r => precise(r.b) + r.suffix },
        { title: 'разница', align: 'right', render: r => `<span class="${r.diffPct >= 0 ? 'up' : 'down'}">${r.diffPct >= 0 ? '+' : ''}${r.diffPct.toFixed(0)}%</span>` },
        { title: 'p', align: 'right', render: r => r.p == null ? '—' : r.p < 0.001 ? '< 0.001' : r.p.toFixed(3) },
        { title: 'размер эффекта', align: 'right', render: r => r.effect == null ? '—' : Math.abs(r.effect).toFixed(2) },
        { title: 'вывод', render: r => `<span class="tag ${!r.significant ? '' : (r.verdict === 'A лучше' ? 'ok' : r.verdict === 'B лучше' ? 'bad' : '')}">${r.verdict}</span>` },
      ], rows,
    });

    // распределения: ящик с усами + перцентили
    const pctA = TGA3.percentileTable(pA), pctB = TGA3.percentileTable(pB);
    Charts.boxPlot($('#cmp-box'), {
      groups: [
        { name: dA.name, ...pctA }, { name: dB.name, ...pctB },
      ], height: 280,
    });
    Charts.table($('#tbl-pct'), {
      columns: [
        { title: 'полоса', render: r => r[0] },
        { title: `A · ${Charts.esc(dA.name)}`, align: 'right', render: r => precise(r[1]) },
        { title: `B · ${Charts.esc(dB.name)}`, align: 'right', render: r => precise(r[2]) },
        { title: 'A / B', align: 'right', render: r => r[2] ? `<span class="${r[1] / r[2] >= 1 ? 'up' : 'down'}">×${(r[1] / r[2]).toFixed(2)}</span>` : '—' },
      ],
      rows: [
        ['постов в выборке', pctA.n, pctB.n],
        ['P10', pctA.p10, pctB.p10], ['P25', pctA.p25, pctB.p25], ['медиана', pctA.p50, pctB.p50],
        ['P75', pctA.p75, pctB.p75], ['P90', pctA.p90, pctB.p90], ['максимум', pctA.max, pctB.max],
      ],
    });

    // динамика
    const models = [TGA.analyze(pA.slice(), { channel: dA.name, subs: dA.subs }),
                    TGA.analyze(pB.slice(), { channel: dB.name, subs: dB.subs })];
    const al = TGA3.alignMonthly(models);
    const useIdx = $('#cmp-index').checked;
    const series = useIdx
      ? TGA3.indexed(al.series).map((vals, i) => ({ name: models[i].channel + ' (100 = первый месяц)', values: vals, color: i ? 'var(--c3)' : 'var(--accent)' }))
      : al.series.map((vals, i) => ({ name: models[i].channel, values: vals, color: i ? 'var(--c3)' : 'var(--accent)', dots: false }));
    Charts.lineChart($('#chart-cmp-month'), { labels: al.labels, series, height: 280, logScale: !useIdx });

    // темы
    const tm = TGA3.topicMatrix([{ name: dA.name, posts: pA }, { name: dB.name, posts: pB }]);
    const topicRows = tm.names.map(t => ({ t, A: tm.per[0][t], B: tm.per[1][t] }))
      .sort((x, y) => ((y.A ? y.A.count : 0) + (y.B ? y.B.count : 0)) - ((x.A ? x.A.count : 0) + (x.B ? x.B.count : 0)))
      .slice(0, 18);
    Charts.table($('#tbl-cmp-topics'), {
      columns: [
        { title: 'тема', render: r => Charts.esc(r.t) },
        { title: 'A: постов', align: 'right', render: r => r.A ? r.A.count : 0 },
        { title: 'A: доля', align: 'right', render: r => r.A ? r.A.share.toFixed(1) + '%' : '—' },
        { title: 'A: лучше своего обычного', align: 'right', render: r => r.A && r.A.count >= 5 ? `<span class="${r.A.lift >= 0 ? 'up' : 'down'}">${r.A.lift >= 0 ? '+' : ''}${r.A.lift.toFixed(0)}%</span>` : '—' },
        { title: 'B: постов', align: 'right', render: r => r.B ? r.B.count : 0 },
        { title: 'B: доля', align: 'right', render: r => r.B ? r.B.share.toFixed(1) + '%' : '—' },
        { title: 'B: лучше своего обычного', align: 'right', render: r => r.B && r.B.count >= 5 ? `<span class="${r.B.lift >= 0 ? 'up' : 'down'}">${r.B.lift >= 0 ? '+' : ''}${r.B.lift.toFixed(0)}%</span>` : '—' },
      ], rows: topicRows,
    });

    // стиль
    const styleRows = [
      ['Знаков в посте (медиана)', stA.charsMedian, stB.charsMedian, 0],
      ['Эмодзи на пост (медиана)', stA.emojiMedian, stB.emojiMedian, 1],
      ['Постов с «ёлочками»', stA.quoteShare, stB.quoteShare, '%'],
      ['Постов со ссылкой на источник', stA.sourceShare, stB.sourceShare, '%'],
      ['Постов с призывом', stA.ctaShare, stB.ctaShare, '%'],
      ['Постов с внешней ссылкой', stA.linkShare, stB.linkShare, '%'],
      ['Постов с хайп-лексикой', stA.hypeShare, stB.hypeShare, '%'],
      ['Постов в неделю', stA.perWeek, stB.perWeek, 1],
      ['Читабельность Flesch (рус.)', TGA2.copyQuality(pA).flesch, TGA2.copyQuality(pB).flesch, 1],
    ];
    Charts.table($('#tbl-cmp-style'), {
      columns: [
        { title: 'показатель', render: r => r[0] },
        { title: `A · ${Charts.esc(dA.name)}`, align: 'right', render: r => (r[3] === '%' ? r[1].toFixed(1) + '%' : r[1].toFixed(r[3] === 1 ? 1 : 0)) },
        { title: `B · ${Charts.esc(dB.name)}`, align: 'right', render: r => (r[3] === '%' ? r[2].toFixed(1) + '%' : r[2].toFixed(r[3] === 1 ? 1 : 0)) },
      ], rows: styleRows,
    });

    // рейтинг
    const metricOptions = [
      ['медиана просмотров', 'viewsMedian'], ['P90 просмотров', 'viewsP90'],
      ['ER по просмотрам', 'erByViews'], ['реакций на пост', 'reactPerPost'],
      ['виральность', 'virality'], ['постов в неделю', 'perWeek'],
      ['эмодзи на пост', 'emojiMedian'], ['длина поста', 'charsMedian'],
    ];
    const sel = $('#rank-metric');
    if (!sel.options.length) sel.innerHTML = metricOptions.map(([t, k]) => `<option value="${k}">${t}</option>`).join('');
    const key = sel.value || 'viewsMedian';
    const items = state.datasets.map(d => {
      const st = TGA3.channelStats(d.posts, d.subs);
      return { name: d.name, ...st };
    });
    const board = TGA3.leaderboard(items, key, key !== 'charsMedian');
    Charts.table($('#tbl-rank'), {
      columns: [
        { title: 'место', align: 'right', render: r => r.rank + ' / ' + r.of },
        { title: 'канал', render: r => Charts.esc(r.name) + (state.datasets[state.cmp[0]] && r.name === state.datasets[state.cmp[0]].name ? ' <span class="tag">A</span>' : state.datasets[state.cmp[1]] && r.name === state.datasets[state.cmp[1]].name ? ' <span class="tag">B</span>' : '') },
        { title: 'значение', align: 'right', render: r => precise(r[key]) },
        { title: 'к лидеру', align: 'right', render: r => r.rank === 1 ? '—' : `<span class="down">${r.toBest.toFixed(0)}%</span>` },
        { title: 'постов в выборке', align: 'right', render: r => r.posts },
        { title: 'период', render: r => r.period ? `${r.period.from} → ${r.period.to}` : '—' },
      ], rows: board,
    });
    $('#rank-note').textContent = 'Рейтинг считается по полным историям каналов (не по обрезанному периоду). ' +
      'Если у каналов разная длина истории или размер аудитории, это сравнение ловит не только качество контента — ' +
      'смотрите на A/B выше, где период выровнен.';
  }

  // ---------------- что делать: скоринг, A/B по дате, план, one-pager ----------------
  function renderActions() {
    const m = state.model;
    if (!state.score || state.score.channel !== m.channel) {
      state.score = { channel: m.channel, model: TGA4.train(m.posts, {}) };
    }
    const model = state.score.model;
    if (state.score.level == null) state.score.level = TGA4.localLevel(m.posts);   // типичный пост канала сейчас
    const hourSel = $('#score-hour');
    if (!hourSel.options.length) {
      hourSel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === 15 ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    }
    const best = m.rhythm.best;
    if (best && !state.score.slotSet) {
      $('#score-dow').value = String((best.dow + 6) % 7);
      hourSel.value = String(best.hour);
      state.score.slotSet = true;
    }

    // --- качество модели: без этого скоринг превращается в гадание ---
    if (!model) {
      $('#score-note').innerHTML = 'Для обучения модели мало данных: нужно минимум 60 постов с просмотрами.';
      $('#score-result').innerHTML = ''; $('#score-checklist').innerHTML = '';
    } else {
      const aucTxt = model.aucMean == null ? '—' : model.aucMean.toFixed(3);
      const quality = model.aucMean == null
        ? { level: 'warn', text: 'не удалось оценить качество' }
        : model.aucMean >= 0.65 ? { level: 'ok-aud', text: 'модель различает лучше случайного' }
          : model.aucMean >= 0.58 ? { level: '', text: 'различает слабо: используйте как подсказку' }
            : { level: 'warn', text: 'почти не различает: признаки текста мало объясняют охват в этом канале' };
      $('#score-note').innerHTML = `Модель обучена на <b>${model.n}</b> постах канала. Цель — «выше типичного для этих же месяцев»: ` +
        `для каждого поста берётся медиана соседей в окне ±${model.halfDays} дней, поэтому сравнение не ломается о падение просмотров по годам ` +
        `(медиана канала за всю историю — ${precise(model.thr)}, сейчас типичный пост — около ${precise(state.score.level)} просмотров). ` +
        `Проверка на 5 последовательных временных блоках: AUC <b>${aucTxt}</b> (от ${model.aucMin == null ? '—' : model.aucMin.toFixed(3)} до ${model.aucMax == null ? '—' : model.aucMax.toFixed(3)}). ` +
        `Точность ${model.accMean == null ? '—' : (model.accMean * 100).toFixed(0)} % при равных долях классов мало о чём говорит — качество показывает именно AUC. ` +
        `Уровень: <b>${quality.text}</b>.`;
    }

    // --- A/B по дате ---
    const dateInput = $('#ab-date');
    if (!dateInput.value) {
      const last = m.posts[m.posts.length - 1];
      dateInput.value = last ? last.date.slice(0, 10) : '';
    }
    $('#ab-result').innerHTML = state.ab || '<div class="empty">выберите дату и нажмите «Сравнить до и после»</div>';
    if (state.abNote) $('#ab-note').innerHTML = state.abNote;
    if (state.plan) $('#plan-note').innerHTML = state.planNote || '';
    $('#plan-result').innerHTML = state.plan || '';
    $('#onepager-preview').innerHTML = state.onepager || '<div class="empty">нажмите кнопку — сводка соберётся и откроется печать (сохранить как PDF)</div>';
  }

  function runScore() {
    const m = state.model, model = state.score && state.score.model;
    const text = ($('#draft').value || '').trim();
    if (!text) { toast('Вставьте текст черновика'); return; }
    if (!model) { toast('Мало данных для модели: нужно ≥60 постов с просмотрами'); return; }
    const slot = { dow: Number($('#score-dow').value), hour: Number($('#score-hour').value) };
    const ctx = { postsInDay: Math.max(1, Math.min(10, Number($('#score-daycount').value) || 1)), hoursSincePrev: null, medianLevel: state.score.level };
    const s = TGA4.scoreText(model, text, slot, ctx);
    const verdict = s.prob >= 0.65 ? { cls: 'ok-aud', txt: 'скорее выше медианы' }
      : s.prob <= 0.35 ? { cls: 'warn', txt: 'скорее ниже медианы' } : { cls: '', txt: 'в пределах обычного разброса' };
    $('#score-result').innerHTML = `
      <div class="kpis">
        ${kpi('Выше типичного в эти месяцы', (s.prob * 100).toFixed(0) + '%', `типичный пост сейчас — ${precise(s.localMedian)} просмотров`, verdict.cls)}
        ${kpi('Вердикт', verdict.txt, 'оценка по признакам текста и слота, а не гарантия охвата')}
        ${kpi('Качество модели', model.aucMean == null ? '—' : 'AUC ' + model.aucMean.toFixed(2), '0.5 — монетка, 1.0 — идеал', model.aucMean >= 0.6 ? 'ok-aud' : 'warn')}
      </div>
      <div class="grid-2">
        <div class="card" style="margin:0"><h3>Что тянет вверх</h3>${listContrib(s.pro, model)}</div>
        <div class="card" style="margin:0"><h3>Что тянет вниз</h3>${listContrib(s.contra, model)}</div>
      </div>`;
    const cl = TGA4.checklist(text);
    const okN = cl.filter(c => c.ok).length;
    Charts.table($('#score-checklist'), {
      columns: [
        { title: 'правило стиля', render: r => (r.ok ? '✓ ' : '✗ ') + Charts.esc(r.name) },
        { title: 'что нужно', render: r => Charts.esc(r.hint) },
        { title: '', align: 'right', render: r => r.ok ? '<span class="tag ok">ок</span>' : '<span class="tag bad">поправить</span>' },
      ], rows: cl,
    });
    const warn = okN < 10 ? 'warn' : okN >= cl.length - 1 ? 'ok-aud' : '';
    $('#score-checklist').insertAdjacentHTML('afterbegin',
      `<p class="${warn === 'warn' ? '' : 'dim'}">Чек-лист стиля «Этажей»: выполнено <b>${okN} из ${cl.length}</b>. ` +
      `Правила — из разбора корпуса канала, они не влияют на вероятность выше (та считается по модели), но влияют на то, как текст читается.` +
      (okN < 10 ? ' <b>Стиль нарушен больше чем в трети правил — вероятность выше медианы это не отменяет, но такой текст не в стиле канала.</b>' : '') + '</p>');
  }

  function listContrib(items, model) {
    if (!items || !items.length) return '<p class="dim">ничего заметно не влияет</p>';
    return '<div class="findings">' + items.map(c =>
      `<div class="finding ${c.contribution > 0 ? 'good' : 'bad'}"><span class="dot"></span>` +
      `<b>${Charts.esc(c.name)}</b> — ${c.contribution > 0 ? 'усиливает' : 'ослабляет'} на ${Math.abs(c.contribution).toFixed(2)} логита ` +
      `${c.binary ? (c.value ? '(признак есть)' : '(признака нет)') : `(значение ${precise(Math.round(c.value * 10) / 10)}, обычно ${precise(Math.round(c.mean * 10) / 10)})`}</div>`).join('') + '</div>';
  }

  function runAB() {
    const m = state.model;
    const date = $('#ab-date').value;
    const win = Math.max(14, Math.min(730, Number($('#ab-window').value) || 90));
    if (!date) { toast('Выберите дату изменения'); return; }
    const t0 = new Date(date + 'T00:00:00Z').getTime();
    const ms = win * 86400000;
    const before = m.posts.filter(p => {
      const t = new Date(p.date).getTime();
      return t >= t0 - ms && t < t0 && p.views > 0;
    });
    const after = m.posts.filter(p => {
      const t = new Date(p.date).getTime();
      return t >= t0 && t < t0 + ms && p.views > 0;
    });
    if (before.length < 5 || after.length < 5) {
      $('#ab-note').textContent = `Мало постов в окнах: до ${before.length}, после ${after.length}. Увеличьте окно или выберите другую дату.`;
      $('#ab-result').innerHTML = '';
      state.ab = '';
      return;
    }
    const rows = TGA3.headToHead(after, before, m.subs, m.subs);   // A = после, B = до
    Charts.table($('#ab-result'), {
      columns: [
        { title: 'показатель', render: r => Charts.esc(r.name) },
        { title: 'до', align: 'right', render: r => precise(r.b) + r.suffix },
        { title: 'после', align: 'right', render: r => precise(r.a) + r.suffix },
        { title: 'изменение', align: 'right', render: r => `<span class="${r.diffPct >= 0 ? 'up' : 'down'}">${r.diffPct >= 0 ? '+' : ''}${r.diffPct.toFixed(0)}%</span>` },
        { title: 'p', align: 'right', render: r => r.p == null ? '—' : r.p < 0.001 ? '< 0.001' : r.p.toFixed(3) },
        { title: 'размер эффекта', align: 'right', render: r => r.effect == null ? '—' : Math.abs(r.effect).toFixed(2) },
        { title: 'вывод (A — после, B — до)', render: r => `<span class="tag ${!r.significant ? '' : r.verdict === 'A лучше' ? 'ok' : r.verdict === 'B лучше' ? 'bad' : ''}">${r.verdict === 'A лучше' ? 'после лучше' : r.verdict === 'B лучше' ? 'после хуже' : r.verdict}</span>` },
      ], rows,
    });
    const medRow = rows[0];
    $('#ab-note').innerHTML = `Окно по ${win} дней вокруг ${date}: до — ${before.length} постов, после — ${after.length}. ` +
      `Медиана просмотров ${precise(medRow.b)} → ${precise(medRow.a)} (${medRow.diffPct >= 0 ? '+' : ''}${medRow.diffPct.toFixed(0)} %, p = ${medRow.p == null ? '—' : medRow.p < 0.001 ? '< 0.001' : medRow.p.toFixed(3)}). ` +
      (medRow.significant ? 'Изменение доказано статистикой.' : 'Изменение в пределах случайного разброса — не спешите делать вывод.');
  }

  function runPlan() {
    const m = state.model;
    const want = Math.max(1, Math.min(21, Number($('#plan-count').value) || 5));
    const rub = TGA2.rubrics(m.posts);
    const rubByName = new Map(rub.map(r => [r.name, r]));
    // эмпирика по слотам: полосы суток × дни недели уже посчитаны в глубоком анализе
    const deep = state.deep || (state.deep = TGA2.analyzeDeep(m.posts, m));
    const slots = deep.slots.cells.slice(0, 24);
    // режим канала: медианы слотов посчитаны по всей истории, а канал сейчас в другом масштабе —
    // без пересчёта план обещает охват 2021 года
    const level = state.score && state.score.level != null ? state.score.level : TGA4.localLevel(m.posts);
    const hist = TGA.median(m.posts.filter(p => p.views > 0).map(p => p.views)) || 1;
    const regime = level / hist;
    const plan = [];
    const used = new Set();
    const perDay = {};
    // сначала по одному слоту на каждый день недели, потом добираем остальные по медиане
    const passes = [slot => (perDay[slot.dow] || 0) < 1, slot => true];
    passes.forEach(cond => slots.forEach(c => {
      if (plan.length >= want) return;
      if (!cond(c)) return;
      const posts = m.posts.filter(p => {
        const d = new Date(p.date);
        if (isNaN(d) || !p.views) return false;
        return (d.getUTCDay() + 6) % 7 === ((c.dow + 6) % 7) && d.getUTCHours() === c.hour;
      });
      // лучшая рубрика этого слота по медиане, при достаточном числе наблюдений
      const byRub = {};
      posts.forEach(p => {
        const r = TGA2.rubricOf(p);
        (byRub[r] = byRub[r] || []).push(p.views);
      });
      const bestRub = Object.entries(byRub).map(([name, v]) => ({ name, n: v.length, med: TGA.median(v) }))
        .filter(x => x.n >= 3).sort((a, b) => b.med - a.med)[0];
      const key = `${c.dow}-${c.hour}`;
      if (used.has(key)) return;
      used.add(key);
      perDay[c.dow] = (perDay[c.dow] || 0) + 1;
      plan.push({
        dow: c.dow, hour: c.hour, n: c.n, median: c.median, lo: c.lo, hi: c.hi, better: c.better,
        expected: c.median * regime, loNow: c.lo * regime, hiNow: c.hi * regime,
        rubric: bestRub ? bestRub.name : null, rubricN: bestRub ? bestRub.n : 0, rubricMed: bestRub ? bestRub.med : null,
        rubricLift: bestRub && rubByName.get(bestRub.name) ? rubByName.get(bestRub.name).lift : null,
      });
    }));
    plan.sort((a, b) => a.dow - b.dow || a.hour - b.hour);
    const expected = plan.reduce((s, x) => s + x.expected, 0);
    const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    Charts.table($('#plan-result'), {
      columns: [
        { title: '#', render: (r, i) => String(r.i + 1) },
        { title: 'слот', render: r => `${days[r.dow]}, ${String(r.hour).padStart(2, '0')}:00 UTC <span class="dim">(${String((r.hour + 3) % 24).padStart(2, '0')}:00 МСК)</span>` },
        { title: 'медиана в истории слота', align: 'right', render: r => precise(r.median) },
        { title: 'ожидание сейчас', align: 'right', render: r => precise(Math.round(r.expected)) },
        { title: 'ДИ 95 % сейчас', align: 'right', render: r => `${precise(Math.round(r.loNow))}…${precise(Math.round(r.hiNow))}` },
        { title: 'постов в слоте', align: 'right', render: r => r.n },
        { title: 'рубрика-фаворит слота', render: r => r.rubric ? `${Charts.esc(r.rubric)} <span class="dim">(${r.rubricN} постов, медиана ${precise(r.rubricMed)})</span>` : '<span class="dim">мало данных</span>' },
        { title: 'слот выше среднего', render: r => r.better ? '<span class="tag ok">да</span>' : '<span class="tag">как везде</span>' },
      ], rows: plan.map((x, i) => ({ ...x, i })),
    });
    $('#plan-note').innerHTML = `План на ${plan.length} публикаций, разложенных по разным дням недели. ` +
      `Слоты выбраны по историческим медианам, но показаны в масштабе текущего канала: типичный пост сейчас — ${precise(level)} просмотров, ` +
      `за всю историю — ${precise(hist)}, множитель <b>${regime.toFixed(2)}</b>. ` +
      `Ожидаемая сумма просмотров ≈ <b>${precise(Math.round(expected))}</b> — это ориентир по прошлому, а не гарантия: ` +
      `у слотов с пометкой «как везде» преимущество не доказано, а сам канал сейчас публикует реже и собирает меньше.`;
  }

  function buildOnePager() {
    const m = state.model;
    const deep = state.deep || (state.deep = TGA2.analyzeDeep(m.posts, m));
    const o = m.overview;
    const top = deep.findings.slice(0, 5);
    const planFirst = state.planNote ? state.planNote.replace(/<[^>]+>/g, '') : 'план не собирался';
    const html = `
      <div class="onepager">
        <h2>${Charts.esc(m.channel)} — сводка за ${o.period ? o.period.from + ' → ' + o.period.to : 'весь период'}</h2>
        <p class="dim">Отчёт собран ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · постов ${o.n} · медиана ${precise(o.views.median)} просмотров · ER по просмотрам ${o.er.byViews}%${m.subs ? ` · подписчиков ${precise(m.subs)} · охват ${m.audience.reachMedian}%` : ''}</p>
        <h3>Что происходит</h3>
        <ol>${top.map(f => `<li>${f.text}</li>`).join('')}</ol>
        <h3>Что делать</h3>
        <ul>
          <li>Ставить посты в слоты с доказанным превосходством: ${(deep.slots.cells.filter(c => c.better).slice(0, 3).map(c => { const d = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][c.dow]; return `${d} ${String(c.hour).padStart(2, '0')}:00`; }).join(', ')) || 'значимых слотов не найдено'}</li>
          <li>Усиливать рубрики-локомотивы: ${deep.rubrics.filter(r => r.count >= 8).sort((a, b) => b.lift - a.lift).slice(0, 3).map(r => `${r.name} (${r.lift >= 0 ? '+' : ''}${r.lift.toFixed(0)}%)`).join(', ')}</li>
          <li>Держать признаки, связанные с охватом: ${deep.drivers.filter(d => d.significant && d.cliff > 0).slice(0, 3).map(d => d.feature).join(', ') || 'не найдено'}</li>
          <li>Убрать дубли: ${m.connections.stats.dupGroups} групп повторов (${m.connections.stats.dupPosts} постов) — это потерянный охват</li>
          <li>План публикаций: ${planFirst}</li>
        </ul>
      </div>`;
    state.onepager = html;
    $('#onepager-preview').innerHTML = html;
    // печатаем именно сводку: класс держим до окончания печати, а не «успеем-не успеем»
    document.body.classList.add('print-exec');
    const done = () => {
      document.body.classList.remove('print-exec');
      window.removeEventListener('afterprint', done);
      clearTimeout(fallback);
    };
    const fallback = setTimeout(done, 30000);        // страховка, если afterprint не придёт
    window.addEventListener('afterprint', done, { once: true });
    setTimeout(() => window.print(), 120);
  }

  function renderPosts() {
    const m = state.model;
    const q = ($('#post-search').value || '').toLowerCase().trim();
    const topic = $('#post-topic').value;
    const sort = $('#post-sort').value;
    const dir = ($('#post-sort-mode') && $('#post-sort-mode').checked) ? 1 : -1;
    const minV = Number($('#post-minviews').value) || 0;

    const opts = m.topics.map(t => t.name);
    const sel = $('#post-topic');
    if (sel.options.length !== opts.length + 1) {
      sel.innerHTML = '<option value="">все темы</option>' + opts.map(o => `<option>${o}</option>`).join('');
    }
    sel.value = topic;

    let rows = m.posts.filter(p => (!topic || p.topic === topic) && p.views >= minV &&
      (!q || p.text.toLowerCase().includes(q)));
    if (sort === 'views') rows = rows.slice().sort((a, b) => dir * (a.views - b.views));
    else if (sort === 'er') rows = rows.slice().sort((a, b) => dir * ((a.views ? a.reactions / a.views : 0) - (b.views ? b.reactions / b.views : 0)));
    else if (sort === 'react') rows = rows.slice().sort((a, b) => dir * (a.reactions - b.reactions));
    else rows = rows.slice().sort((a, b) => dir * (new Date(a.date) - new Date(b.date)));
    state.filtered = rows;

    const pages = Math.max(1, Math.ceil(rows.length / paging.per));
    paging.page = Math.min(paging.page, pages);
    const slice = rows.slice((paging.page - 1) * paging.per, paging.page * paging.per);
    $('#posts-note').innerHTML = `Найдено постов: <b>${rows.length}</b> из ${m.posts.length} · страница ${paging.page}/${pages}`;
    Charts.table($('#tbl-posts'), {
      columns: [
        { title: 'post_id', render: r => `<a href="${r.url}" target="_blank">${r.post_id}</a>` },
        { title: 'дата', render: r => r.date.slice(0, 16).replace('T', ' ') },
        { title: 'просм.', align: 'right', render: r => fmt(r.views) },
        { title: 'реакц.', align: 'right', render: r => r.reactions },
        { title: 'ER', align: 'right', render: r => r.views ? ((100 * r.reactions) / r.views).toFixed(2) + '%' : '—' },
        { title: 'тема', render: r => r.topic },
        { title: 'текст', render: r => link(r) },
      ], rows: slice,
    });
    $('#post-pager').innerHTML = pages > 1
      ? `<button data-pg="${Math.max(1, paging.page - 1)}">← назад</button><span>${paging.page} / ${pages}</span><button data-pg="${Math.min(pages, paging.page + 1)}">вперёд →</button>`
      : '';
  }

  function renderMethod() {
    const m = state.model, aud = m.audience;
    $('#method-info').innerHTML = `
      <p><b>ER по подписчикам</b>${aud ? ` (для ${fmt(aud.subs)} подписчиков)` : ''} = реакции на пост / подписчики × 100 %.
      ${aud ? `Сейчас медиана — ${aud.reactPerPostMedian} реакций на пост, то есть ${aud.erPerPost} % (по среднему ${aud.erPerPostMean} %);
        за всю историю канал набрал ${aud.reactPerSubTotal} реакции на подписчика.`
            : 'Укажите число подписчиков в поле сверху — метрика появится в KPI, в динамике и в срезах по годам.'}
      Суммировать реакции за годы нельзя: число подписчиков — снимок на сегодня, поэтому корректная метрика считается на пост.</p>
      <p><b>Охват поста</b> = медиана просмотров / подписчики × 100 %${aud ? ` — сейчас ${aud.reachMedian} % (средний ${aud.reachMean} %, P90 ${aud.reachP90} %)` : ''}.
      Просмотры в Telegram включают внешний трафик (поиск, пересылки, рекомендации), поэтому охват может быть больше 100 % — это нормально.</p>
      <p><b>ER по просмотрам (ERR)</b> = реакции / просмотры × 100%. Это метрика качества контента без опоры на размер аудитории;
      ER по подписчикам нужен, чтобы сравнивать каналы разного размера.</p>
      <p><b>ER на пост</b> = сумма реакций / число постов. <b>Виральность</b> = P90 просмотров / медиана:
      во сколько раз топ-10 % постов обгоняют обычный пост.</p>
      <p><b>Темы</b> определяются по ключевым словам и приоритетам (первое совпадение побеждает), это
      эвристика для группировки, а не ручная разметка. Один пост = одна тема.</p>
      <p><b>Связи</b>: дубли и почти-дубли — совпадение первых 10 слов и близости по Жаккару ≥ 0,7;
      ссылки — прямое упоминание <code>t.me/&lt;канал&gt;/&lt;id&gt;</code>; серия — посты одной темы подряд с шагом ≤ 10 дней.</p>
      <p><b>Скоринг черновика</b> («Что делать») — логистическая регрессия на 40 признаках текста, слота и окружения поста
      (эмодзи-маркер, цифра в заголовке, длина, абзацы, рубрика, день недели и час, сколько постов выходит в тот же день,
      пауза с предыдущего поста). Цель — «выше типичного для этих же месяцев»: для каждого поста берётся медиана соседей
      в окне ±45 дней. Так сделано намеренно: по всей истории цель ломается о падение просмотров по годам, и модель
      начинает предсказывать календарь, а не текст. Качество измеряется на 5 последовательных временных блоках
      (случайное разбиение завышало бы AUC, потому что соседние посты коррелируют) и показывается в интерфейсе:
      AUC около 0.5 — модель бесполезна, 0.6 — слабая подсказка, 0.7+ — есть на что опираться. Обучение детерминировано
      (полный градиентный спуск, 400 итераций, L2 = 0.01), поэтому расчёт перепроверяется независимой реализацией
      на Python: <code>python3 scripts/verify_scoring.py выгрузка.jsonl</code>.</p>
      <p><b>A/B по дате</b> — сравнение метрик в окне «до» и «после» выбранной даты: те же тесты, что в сравнении каналов
      (Манн—Уитни и размер эффекта Клиффа для чисел, z-тест для долей). Это проверка вмешательства: смена формата,
      рубрики, тона. Окна одинаковой длины, поэтому сезонность частично гасится, но не исчезает — резкие события рынка
      могут объяснить разницу не хуже вашей правки.</p>
      <p><b>План на неделю</b> строится на исторических медианах слотов «день недели × час» с интервалами 95 %,
      по одному посту на день. Ожидание пересчитывается в масштаб текущего канала (отношение медианы последних
      60 дней к медиане за всю историю): без этого план обещает охват эпохи, которой уже нет. Слоты с пометкой
      «как везде» преимущества не доказали — это указание «ждать как обычно», а не приглашение публиковаться.</p>
      <p><b>Ограничения:</b> просмотры и реакции — снимок на момент выгрузки, без динамики по дням
      (скорость набора просмотров по такому файлу не считается); время публикации — UTC из выгрузки;
      число подписчиков в выгрузке отсутствует и задаётся вручную — охват и ER по подписчикам для прошлых
      месяцев считаются против <i>текущего</i> числа, это нижняя оценка при росте канала;
      служебные посты («Channel photo updated», «Channel created») остаются в данных и занижают метрики —
      проверяйте раздел «Тишина» и таблицу постов.</p>
      <p>Канал: <b>${Charts.esc(m.channel)}</b> · постов: ${m.overview.n}${m.subs ? ` · подписчиков: <b>${fmt(m.subs)}</b>` : ''} · отчёт построен локально в браузере,
      данные никуда не отправляются. Excel-выгрузка <code>erid</code>: значения токенов в отчёте заменены на <b>[REDACTED]</b>.</p>`;
  }

  function renderCompare() {                       // компактная сводка для вкладки «Обзор»
    $('#compare-wrap').classList.remove('hidden');
    const models = state.datasets.map(d => {
      if (d.subs == null) {
        let saved = 0;
        try { saved = Number(localStorage.getItem(subsKey(d.name))) || 0; } catch (e) { saved = 0; }
        d.subs = saved;
      }
      return { name: d.name, m: TGA.analyze(d.posts.slice(), { channel: d.name, subs: d.subs }) };
    });
    const metrics = [
      ['Постов', m => m.overview.n],
      ['Период', m => m.overview.period ? `${m.overview.period.from} → ${m.overview.period.to}` : '—'],
      ['Постов в неделю', m => m.overview.perWeek],
      ['Медиана просмотров', m => fmt(m.overview.views.median)],
      ['Средние просмотры', m => fmt(m.overview.views.mean)],
      ['Виральность', m => '×' + m.overview.virality],
      ['ER по просмотрам', m => m.overview.er.byViews + '%'],
      ['Реакций на пост', m => m.overview.er.perPost],
      ['Подписчиков', m => m.subs ? fmt(m.subs) : 'не указано'],
      ['ER по подписчикам', m => m.audience ? m.audience.erPerPost + '%' : '—'],
      ['Охват поста', m => m.audience ? m.audience.reachMedian + '%' : '—'],
      ['Эмодзи на пост', m => m.anatomy.emoji.median],
      ['Медиана фразы, слов', m => m.anatomy.sent.median],
      ['Доля с источником', m => m.anatomy.content.withSource + '%'],
      ['Топ-тема', m => (m.topics[0] || {}).name || '—'],
      ['Лучший слот', m => m.rhythm.best ? `${['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][m.rhythm.best.dow]} ${String(m.rhythm.best.hour).padStart(2, '0')}:00 UTC` : '—'],
    ];
    Charts.table($('#tbl-compare'), {
      columns: [{ title: 'показатель', key: 'title' }].concat(models.map(x => ({ title: x.name, align: 'right', render: r => r.vals[x.name] }))),
      rows: metrics.map(([title, fn]) => {
        const vals = {}; models.forEach(x => { vals[x.name] = fn(x.m); });
        return { title, vals };
      }),
    });
  }

  // ---------------- карточка поста ----------------
  function openPost(p) {
    const modal = $('#modal');
    const er = p.views ? ((100 * p.reactions) / p.views).toFixed(2) + '%' : '—';
    $('#modal-body').innerHTML = `
      <h3>${p.channel} · пост ${p.post_id}</h3>
      <div class="meta">
        <span>${p.date.slice(0, 16).replace('T', ' ')} UTC</span>
        <span>тема: ${p.topic}</span>
        <span>просмотры: <b>${fmt(p.views)}</b></span>
        <span>реакции: <b>${p.reactions}</b></span>
        <span>ER: <b>${er}</b></span>
        <a href="${p.url}" target="_blank">открыть в Telegram ↗</a>
      </div>
      <pre class="post-text">${Charts.esc(p.text.replace(/((?:erid|Токен)\s*[:=]?\s*)[A-Za-z0-9_\-]{6,}/gi, '$1[REDACTED]'))}</pre>`;
    modal.classList.add('open');
  }

  // ---------------- события ----------------
  function wire() {
    $('#file-input').addEventListener('change', e => e.target.files.length && handleFiles(e.target.files));
    $('#btn-load-picked').addEventListener('click', () => {
      const f = $('#file-input').files;
      if (f && f.length) handleFiles(f); else toast('Сначала выберите файл — или перетащите .jsonl в окно');
    });
    $('#btn-load-url').addEventListener('click', loadByUrl);
    $('#ch-url').addEventListener('keydown', e => { if (e.key === 'Enter') loadByUrl(); });
    $('#btn-url').addEventListener('click', () => {
      showLoader(window.location.protocol === 'file:'
        ? 'Ссылка работает через локальный сервер: запустите python3 scripts/serve.py и откройте http://127.0.0.1:8000 — либо перетащите .jsonl сюда.'
        : 'Вставьте ссылку на канал — сервер сам скачает публичные посты.');
      const input = $('#ch-url');
      input.focus();
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.add('on'); }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'drop') { $('#drop').classList.remove('on'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }
      else if (e.target === document.documentElement) $('#drop').classList.remove('on');
    }));
    $('#post-search').addEventListener('input', () => { paging.page = 1; renderPosts(); });
    $('#post-topic').addEventListener('change', () => { paging.page = 1; renderPosts(); });
    $('#post-sort').addEventListener('change', renderPosts);
    $('#post-sort-mode').addEventListener('change', renderPosts);
    $('#post-minviews').addEventListener('input', () => { paging.page = 1; renderPosts(); });
    document.addEventListener('click', e => {
      const pg = e.target.getAttribute && e.target.getAttribute('data-pg');
      if (pg) { paging.page = Number(pg); renderPosts(); const el = $('#tbl-posts'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      const pl = e.target.closest && e.target.closest('[data-post]');
      if (pl) {
        e.preventDefault();
        const [ch, id] = pl.getAttribute('data-post').split('/');
        const p = state.model.posts.find(x => x.channel === ch && String(x.post_id) === id);
        if (p) openPost(p);
      }
      if (e.target.closest && e.target.closest('.tab')) {
        const t = e.target.closest('.tab').dataset.tab;
        $$('.tab').forEach(x => x.classList.toggle('on', x === e.target.closest('.tab')));
        $$('.panel').forEach(x => x.classList.toggle('on', x.id === 'panel-' + t));
        if (t === 'deep' && !state.deep) setTimeout(() => renderDeep(), 30);   // сначала отдаём кадр, потом считаем
        if (t === 'compare') setTimeout(() => renderCompareTab(), 20);
        if (t === 'actions') setTimeout(() => renderActions(), 20);
      }
      if (e.target.id === 'modal' || (e.target.closest && e.target.closest('#modal-close'))) $('#modal').classList.remove('open');
    });
    $('#btn-export').addEventListener('click', () => {
      const m = state.model;
      const payload = {
        channel: m.channel, generatedAt: m.generatedAt, subscribers: m.subs || null,
        overview: m.overview, audience: m.audience,
        scoring: state.score && state.score.model ? {
          n: state.score.model.n, threshold: state.score.model.thr, baseRate: state.score.model.baseRate,
          aucMean: state.score.model.aucMean, aucMin: state.score.model.aucMin, aucMax: state.score.model.aucMax,
          accuracy: state.score.model.accMean,
          weights: state.score.model.names.map((name, i) => ({ name, weight: state.score.model.w[i] })),
        } : null,
        deep: state.deep ? {
          findings: state.deep.findings,
          medianCI: state.deep.medianCI, meanCI: state.deep.meanCI,
          trend: state.deep.trend, changepoints: state.deep.changepoints,
          forecast: state.deep.forecast,
          drivers: state.deep.drivers.map(d => ({ feature: d.feature, nWith: d.nWith, medianWith: d.medianWith, medianWithout: d.medianWithout, lift: d.lift, p: d.p, cliff: d.cliff, significant: d.significant })),
          slots: state.deep.slots.cells.slice(0, 24), bands: state.deep.slots.bandStats,
          rubrics: state.deep.rubrics.map(r => ({ name: r.name, count: r.count, median: r.median, lift: r.lift, er: r.er, p: r.p })),
          copy: { flesch: state.deep.copy.flesch, asl: state.deep.copy.asl, asw: state.deep.copy.asw, longShare: state.deep.copy.sent.longShare, clichePer100: state.deep.copy.clichePer100, drift: state.deep.copy.drift },
          outliers: state.deep.outliers.map(o => ({ post_id: o.p.post_id, z: o.z, views: o.p.views })),
        } : null,
        monthly: m.monthly, topics: m.topics, anatomy: m.anatomy, rhythmBest: m.rhythm.best,
        connections: { stats: m.connections.stats, external: m.connections.external, dupGroups: m.connections.dupGroups.map(g => ({ ids: g.ids, similarity: g.similarity })) },
      };
      const blob = new Blob([JSON.stringify(payload, (k, v) => (k === 'posts' ? undefined : v), 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tg-report-${m.channel}.json`;
      a.click(); toast('Отчёт выгружен в JSON');
    });
    $('#subs-input').addEventListener('change', () => {
      const cur = state.datasets[state.active];
      if (!cur) return;
      const v = Math.max(0, Math.floor(Number($('#subs-input').value) || 0));
      cur.subs = v;
      try {
        if (v) localStorage.setItem(subsKey(cur.name), String(v));
        else localStorage.removeItem(subsKey(cur.name));
      } catch (e) { /* приватный режим — просто не запоминаем */ }
      render();
      toast(v ? `Подписчиков: ${v.toLocaleString('ru-RU')} — ER по подписчикам и охват пересчитаны` : 'Число подписчиков очищено');
    });
    $('#subs-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    $('#btn-pool-add').addEventListener('click', () => {
      if (!state.deep) return;
      const me = channelSummary(state.model.channel, state.model, state.deep);
      const pool = loadPool().filter(p => p.name !== me.name);
      pool.push(me);
      savePool(pool);
      renderBenchmark(state.deep);
      toast(`«${me.name}» добавлен в пул сравнения (всего каналов: ${pool.length})`);
    });
    $('#btn-pool-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ pool: loadPool() }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tg-analytics-pool.json';
      a.click();
      toast('Пул сравнения выгружен');
    });
    $('#btn-pool-clear').addEventListener('click', () => {
      savePool([]);
      if (state.deep) renderBenchmark(state.deep);
      toast('Пул сравнения очищен');
    });
    $('#pool-import').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const incoming = Array.isArray(j) ? j : (j.pool || []);
        const pool = loadPool();
        incoming.forEach(item => {
          if (!item || !item.name) return;
          const i = pool.findIndex(p => p.name === item.name);
          if (i >= 0) pool[i] = item; else pool.push(item);
        });
        savePool(pool);
        if (state.deep) renderBenchmark(state.deep);
        toast(`Пул обновлён: ${pool.length} каналов`);
      } catch (err) { toast('Не разобрать файл пула: ' + err.message); }
    });
    ['#cmp-overlap', '#cmp-index', '#rank-metric'].forEach(sel => {
      const el = $(sel);
      if (el) el.addEventListener('change', () => renderCompareTab());
    });
    $('#btn-goto-compare').addEventListener('click', () => {
      const tab = [...document.querySelectorAll('.tab')].find(x => x.dataset.tab === 'compare');
      if (tab) { tab.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
    $('#btn-print').addEventListener('click', () => window.print());
    $('#btn-score').addEventListener('click', runScore);
    $('#btn-score-clear').addEventListener('click', () => { $('#draft').value = ''; $('#score-result').innerHTML = ''; $('#score-checklist').innerHTML = ''; });
    $('#btn-ab').addEventListener('click', runAB);
    $('#btn-plan').addEventListener('click', runPlan);
    $('#btn-onepager').addEventListener('click', buildOnePager);
    $('#btn-reset').addEventListener('click', () => { state.datasets = []; state.active = 0; showWelcome(); });
  }

  document.addEventListener('DOMContentLoaded', () => { wire(); boot(); });
})();
