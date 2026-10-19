/* xp.js — оконная оболочка в стиле Windows XP: заголовок, меню, панель задач, строка состояния.
   Не трогает аналитику: команды нажимают те же кнопки, что и раньше, поэтому ничего не ломается. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const root = document.documentElement;
  const body = document.body;

  // ---------------- оформление ----------------
  function setTheme(name) {
    root.setAttribute('data-theme', name === 'dark' ? 'dark' : 'xp');
    try { localStorage.setItem('tga-theme', name); } catch (e) { /* приватный режим */ }
    const p = $('#xp-status-theme');
    if (p) p.textContent = 'оформление: ' + (name === 'dark' ? 'тёмное' : 'Windows XP');
    // подпись кнопки в шапке: видно и в XP, и в тёмной теме
    const lbl = $('#theme-toggle-label');
    if (lbl) lbl.textContent = name === 'dark' ? 'Windows XP' : 'тёмное';
    const tg = $('#theme-toggle');
    if (tg) tg.title = (name === 'dark' ? 'Включить оформление Windows XP' : 'Включить тёмное оформление') + ' (Ctrl+Shift+T)';
    const a = $('#xp-theme-xp'), b = $('#xp-theme-dark');
    if (a) a.querySelector('.tick').textContent = name === 'dark' ? '' : '•';
    if (b) b.querySelector('.tick').textContent = name === 'dark' ? '•' : '';
  }
  try { setTheme(localStorage.getItem('tga-theme') || 'xp'); } catch (e) { setTheme('xp'); }

  // ---------------- всплывающая подсказка в стиле XP ----------------
  function balloon(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(balloon._t);
    balloon._t = setTimeout(() => t.classList.remove('show'), 3800);
  }

  // ---------------- окно ----------------
  function setWindowState(st) {
    body.setAttribute('data-window', st);
    const btn = $('#xp-task-app');
    if (btn) btn.classList.toggle('active', st !== 'min');
  }
  setWindowState('normal');

  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

  on('#xp-btn-min', 'click', () => { setWindowState('min'); balloon('Окно свёрнуто в панель задач'); });
  on('#xp-btn-close', 'click', () => { setWindowState('min'); balloon('Окно скрыто. Открыть — кнопкой на панели задач'); });
  on('#xp-btn-max', 'click', () => setWindowState(body.getAttribute('data-window') === 'max' ? 'normal' : 'max'));
  on('#xp-restore', 'click', () => setWindowState('normal'));
  on('#xp-task-app', 'click', () => setWindowState(body.getAttribute('data-window') === 'min' ? 'normal' : 'min'));
  on('#theme-toggle', 'click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'xp' : 'dark';
    setTheme(next);
    balloon(next === 'dark' ? 'Тёмное оформление. Вернуть окно XP — этой же кнопкой' : 'Оформление Windows XP');
  });

  // ---------------- меню ----------------
  function closeMenus() {
    document.querySelectorAll('.menu.on').forEach(m => m.classList.remove('on'));
    const sm = $('#xp-startmenu');
    if (sm) sm.classList.remove('on');
    const st = $('#xp-start');
    if (st) st.classList.remove('on');
  }
  document.querySelectorAll('.menu > button').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const menu = btn.parentElement;
      const wasOpen = menu.classList.contains('on');
      closeMenus();
      if (!wasOpen) menu.classList.add('on');
    });
    // наведение при открытом меню — как в Windows
    btn.addEventListener('mouseenter', () => {
      if (document.querySelector('.menu.on') && !btn.parentElement.classList.contains('on')) {
        closeMenus();
        btn.parentElement.classList.add('on');
      }
    });
  });
  on('#xp-start', 'click', ev => {
    ev.stopPropagation();
    const sm = $('#xp-startmenu');
    const open = sm.classList.toggle('on');
    $('#xp-start').classList.toggle('on', open);
  });
  document.addEventListener('click', ev => {
    if (!ev.target.closest('.menu') && !ev.target.closest('#xp-startmenu') && !ev.target.closest('#xp-start')) closeMenus();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closeMenus(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'o') { ev.preventDefault(); openFile(); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'p') { ev.preventDefault(); const b = $('#btn-print'); if (b) b.click(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 't') {   // быстрый переключатель оформления
      ev.preventDefault();
      const next = root.getAttribute('data-theme') === 'dark' ? 'xp' : 'dark';
      setTheme(next);
      balloon(next === 'dark' ? 'Тёмное оформление' : 'Оформление Windows XP');
    }
  });

  // ---------------- команды меню ----------------
  function openFile() { const f = $('#file-input'); if (f) f.click(); }
  function gotoUrl() {
    const row = $('#ch-url');
    if (row) { row.focus(); row.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function clickIf(sel) { const b = $(sel); if (b) { b.click(); return true; } return false; }
  function openTab(name) {
    const t = [...document.querySelectorAll('.tab')].find(x => x.dataset.tab === name);
    if (t) { t.click(); t.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  }

  const commands = {
    'open-file': openFile,
    'open-url': gotoUrl,
    export: () => clickIf('#btn-export'),
    print: () => clickIf('#btn-print'),
    reset: () => clickIf('#btn-reset'),
    subs: () => { const i = $('#subs-input'); if (i) { i.focus(); i.select(); } },
    'win-max': () => setWindowState(body.getAttribute('data-window') === 'max' ? 'normal' : 'max'),
    exit: () => { setWindowState('min'); balloon('Окно свёрнуто в панель задач'); },
    about: () => balloon('TG Analytics — разбор Telegram-каналов по выгрузке. Всё считается в браузере, данные никуда не отправляются.'),
    theme: (arg) => { setTheme(arg); balloon(arg === 'dark' ? 'Тёмное оформление' : 'Оформление Windows XP'); },
    tab: (arg) => openTab(arg),
  };

  document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (commands[cmd]) {
      commands[cmd](btn.dataset.arg);
      closeMenus();
    }
  });

  // ---------------- часы и строка состояния ----------------
  function tick() {
    const c = $('#xp-clock');
    if (!c) return;
    const d = new Date();
    c.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    c.title = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  tick();
  setInterval(tick, 20000);

  function setStatus(detail) {
    const d = detail || {};
    const ch = $('#xp-status-channel');
    const po = $('#xp-status-posts');
    const tx = $('#xp-status-text');
    if (ch) ch.textContent = 'канал: ' + (d.channel || '—');
    if (po) po.textContent = 'постов: ' + (d.posts == null ? '—' : d.posts) + (d.period ? ' · ' + d.period : '');
    if (tx && d.message) tx.textContent = d.message;
    const tt = $('#xp-task-title');
    if (tt && d.channel) tt.textContent = 'TG Analytics — ' + d.channel;
    const th = $('#xp-title');
    if (th && d.channel) th.textContent = 'TG Analytics — ' + d.channel + (d.posts ? ' · постов ' + d.posts : '');
    const sh = $('#xp-sm-head');
    if (sh && d.channel) sh.textContent = d.channel + ' · разбор канала';
  }

  document.addEventListener('tga:render', ev => setStatus(ev.detail));
  document.addEventListener('tga:status', ev => setStatus(ev.detail));
  if (window.__TGA_STATUS) setStatus(window.__TGA_STATUS);
})();
