/* node_harness.js — прогон движка аналитики в Node без браузера (для сверки с Python).
   Использование: node scripts/node_harness.js путь.jsonl [--deep|--full] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2];
const mode = process.argv[3] || '--deep';
if (!file) { console.error('укажите путь к .jsonl'); process.exit(1); }

const sandbox = { window: {}, console, Math, Date, JSON, RegExp, Number, String, Array, Object, isFinite, isNaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['analytics.js', 'analytics2.js', 'compete.js', 'scoring.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8');
  vm.runInContext(src, sandbox, { filename: f });
}
const { TGA, TGA2, TGA3, TGA4 } = sandbox.window;
if (!TGA || !TGA2) { console.error('движок не загрузился'); process.exit(1); }

if (mode === '--compete') {
  const other = process.argv[4];
  if (!other) { console.error('нужен второй файл'); process.exit(1); }
  const read = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
    const r = JSON.parse(l);
    return { channel: r.channel || 'x', post_id: r.post_id, text: String(r.text || ''), date: r.date, views: Number(r.views) || 0, reactions: Number(r.reactions) || 0, url: r.url || '' };
  });
  const A = read(file), B = read(other);
  const nameA = path.basename(file).replace(/\.[^.]+$/, ''), nameB = path.basename(other).replace(/\.[^.]+$/, '');
  const ov = TGA3.overlapSlice([A, B]);
  const pA = ov.slices[0], pB = ov.slices[1];
  const out = {
    overlap: { from: ov.from, to: ov.to, nA: pA.length, nB: pB.length },
    statsA: TGA3.channelStats(pA, 0), statsB: TGA3.channelStats(pB, 0),
    headToHead: TGA3.headToHead(pA, pB, 0, 0).map(r => ({ name: r.name, kind: r.kind, a: r.a, b: r.b, diffPct: r.diffPct, p: r.p, effect: r.effect, significant: r.significant, verdict: r.verdict })),
    pctA: TGA3.percentileTable(pA), pctB: TGA3.percentileTable(pB),
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

if (mode === '--score') {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'score-fixtures.json'), 'utf8'));
  const read = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
    const r = JSON.parse(l);
    return { channel: r.channel || 'x', post_id: r.post_id, text: String(r.text || ''), date: r.date, views: Number(r.views) || 0, reactions: Number(r.reactions) || 0, url: r.url || '' };
  });
  const model = TGA.analyze(read(file), { channel: path.basename(file).replace(/\.[^.]+$/, '') });
  const m = TGA4.train(model.posts, {});
  if (!m) { console.error('модель не обучена'); process.exit(1); }
  const out = {
    n: m.n, positives: m.positives, baseRate: m.baseRate, thr: m.thr,
    names: m.names, w: m.w, b: m.b, mean: m.mean, sd: m.sd,
    aucMean: m.aucMean, aucMin: m.aucMin, aucMax: m.aucMax, accMean: m.accMean, accBaseline: m.accBaseline, majority: m.majority, halfDays: m.halfDays, rubrics: m.rubrics, folds: m.folds,
    drafts: fixtures.drafts.map(d => {
      const sc = TGA4.scoreText(m, d.text, { dow: 3, hour: 15 }, { postsInDay: 1, hoursSincePrev: null });
      return {
        id: d.id, prob: sc.prob, logit: sc.logit, expectedViews: sc.expectedViews,
        pro: sc.pro.map(c => ({ name: c.name, contribution: c.contribution })),
        contra: sc.contra.map(c => ({ name: c.name, contribution: c.contribution })),
        checklist: TGA4.checklist(d.text).map(c => ({ name: c.name, ok: c.ok })),
      };
    }),
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

const posts = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
  const r = JSON.parse(l);
  return { channel: r.channel || 'x', post_id: r.post_id, text: String(r.text || ''), date: r.date, views: Number(r.views) || 0, reactions: Number(r.reactions) || 0, url: r.url || '' };
});
const name = path.basename(file).replace(/\.[^.]+$/, '');
const model = TGA.analyze(posts, { channel: name });
const deep = TGA2.analyzeDeep(model.posts, model);

const out = {
  channel: model.channel,
  posts: model.overview.n,
  median: TGA.median(model.posts.filter(p => p.views > 0).map(p => p.views)),
  medianCI: deep.medianCI,
  meanCI: deep.meanCI,
  trend: deep.trend,
  changepoints: deep.changepoints,
  forecast: deep.forecast,
  drivers: deep.drivers.map(d => ({ feature: d.feature, nWith: d.nWith, nWithout: d.nWithout, medianWith: d.medianWith, medianWithout: d.medianWithout, lift: d.lift, cliff: d.cliff, p: d.p, significant: d.significant })),
  slots: { channelMedian: deep.slots.channelMedian, channelCI: deep.slots.channelCI, cells: deep.slots.cells, bands: deep.slots.bandStats },
  rubrics: deep.rubrics.map(r => ({ name: r.name, count: r.count, median: r.median, lift: r.lift, er: r.er, p: r.p, lo: r.lo, hi: r.hi, chars: r.chars, emoji: r.emoji })),
  copy: {
    flesch: deep.copy.flesch, asl: deep.copy.asl, asw: deep.copy.asw,
    longShare: deep.copy.sent.longShare, sentMedian: deep.copy.sent.median, sentP90: deep.copy.sent.p90,
    clichePer100: deep.copy.clichePer100, cancelPer100: deep.copy.cancelPer100,
    passiveShare: deep.copy.passiveShare, questionShare: deep.copy.questionShare,
    exclaimShare: deep.copy.exclaimShare, weShare: deep.copy.weShare,
    charsMedian: deep.copy.chars.median, drift: deep.copy.drift, cliches: deep.copy.clicheList,
  },
  neighbourhood: deep.neighbourhood ? {
    gaps: deep.neighbourhood.gaps, spearmanPrev: deep.neighbourhood.spearmanPrev,
    base: deep.neighbourhood.base, daysBusy: deep.neighbourhood.daysBusy, daysCalm: deep.neighbourhood.daysCalm,
    burstTest: deep.neighbourhood.burstTest, medianGapHours: deep.neighbourhood.medianGapHours,
    normalized: deep.neighbourhood.normalized,
  } : null,
  outliers: deep.outliers.map(o => ({ post_id: o.p.post_id, views: o.p.views, z: o.z })),
  findingsCount: deep.findings.length,
};
console.log(JSON.stringify(out, null, mode === '--full' ? 2 : 0));
