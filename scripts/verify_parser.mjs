#!/usr/bin/env node
/* verify_parser.mjs — сверка JS-парсера (worker/parser.js) с питоновским (scripts/fetch_channel.py)
   на сохранённых страницах t.me.
   node scripts/verify_parser.mjs /tmp/tgpages/p1.html /tmp/tgpages/p2.html ...
   Страницы: curl -A "<UA>" https://t.me/s/канал -o p1.html */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePage } from '../worker/parser.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = process.argv.slice(2);
if (!files.length) {
  console.error('укажите пути к сохранённым страницам');
  process.exit(1);
}

const py = `
import json, sys, os
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
from fetch_channel import parse_page
out = {}
for f in sys.argv[1:]:
    page = open(f, encoding='utf-8', errors='replace').read()
    channel = os.path.basename(f).split('.')[0]
    if channel.startswith('p') and channel[1:].isdigit():
        channel = 'testchannel'
    posts, nxt = parse_page(page, channel)
    out[f] = {'posts': posts, 'next_before': nxt}
print(json.dumps(out, ensure_ascii=False))
`;
const pyOut = JSON.parse(execFileSync('python3', ['-c', py, ...files], { encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 }));

let errors = 0, checked = 0, t0 = Date.now(), jsMs = 0;
for (const f of files) {
  const page = fs.readFileSync(f, 'utf-8');
  const channel = 'testchannel';
  const started = Date.now();
  const js = parsePage(page, channel);
  jsMs += Date.now() - started;
  const ref = pyOut[f];
  if (js.posts.length !== ref.posts.length) {
    console.log(`  ${path.basename(f)}: постов JS ${js.posts.length} != Python ${ref.posts.length}`);
    errors++;
    continue;
  }
  const cmp = (typeof js.next_before === 'number' ? String(js.next_before) : js.next_before);
  const cmpRef = ref.next_before == null ? null : String(ref.next_before);
  if (cmp !== cmpRef) { console.log(`  ${path.basename(f)}: next_before JS ${cmp} != Python ${cmpRef}`); errors++; }
  for (let i = 0; i < js.posts.length; i++) {
    const a = js.posts[i], b = ref.posts[i];
    checked++;
    for (const k of ['post_id', 'date', 'views', 'reactions', 'text', 'url']) {
      if (String(a[k]) !== String(b[k])) {
        errors++;
        if (errors <= 8) {
          const av = String(a[k]).slice(0, 90).replace(/\n/g, '⏎');
          const bv = String(b[k]).slice(0, 90).replace(/\n/g, '⏎');
          console.log(`  ${path.basename(f)} пост ${a.post_id} поле ${k}:\n      JS: ${av}\n      PY: ${bv}`);
        }
      }
    }
  }
  console.log(`  ${path.basename(f)}: ${js.posts.length} постов, next_before ${cmp} — ок`);
}

const perPage = (Date.now() - t0) / files.length;
console.log(`\nпроверено постов: ${checked}, страниц: ${files.length}`);
console.log(`разбор одной страницы: ${(jsMs / files.length).toFixed(1)} мс на странице ${(fs.statSync(files[0]).size / 1024).toFixed(0)} КБ`);
if (errors) {
  console.log(`РАСХОЖДЕНИЙ: ${errors}`);
  process.exit(2);
}
console.log('JS-парсер совпал с Python на всех страницах');
