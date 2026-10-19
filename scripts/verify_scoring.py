#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Независимая проверка скоринга черновика: та же модель на Python против движка в браузере.

    python3 scripts/verify_scoring.py corpus.jsonl

Сверяет: цель по локальной медиане (±45 дней), матрицу признаков, стандартизацию, градиентный спуск,
разбиение на 5 временных блоков, AUC/точность, вероятность для эталонных черновиков и чек-лист стиля.
"""
import argparse, json, math, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from verify_deep import features, median, EMO, MARKER_ONLY, rubric_of  # noqa: E402

BIN = ['эмодзи-маркер в первой строке', 'цифра в заголовке', 'вопрос в первой строке', 'восклицание в первой строке',
       'заголовок с двоеточием', 'цитата эксперта «…»', 'должность + компания', 'ссылка на источник',
       'список 🔴', 'тире-список', 'нумерованный список', 'заканчивается вопросом', 'финал-эмодзи',
       'хэштег', 'внешняя ссылка', 'длинный пост (>800 знаков)', 'короткий пост (<250 знаков)',
       'много эмодзи (>5)', 'без эмодзи', 'абзацев ≥ 4', 'цифра/процент в теле']
WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
RUBRIC_TOP = 6


def clen(s):
    return len(s)


def load(path):
    out = []
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        out.append({'post_id': r['post_id'], 'text': str(r.get('text') or ''), 'date': r['date'],
                    'views': int(r.get('views') or 0), 'reactions': int(r.get('reactions') or 0)})
    return out


def slot_of(post):
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(post['date']).astimezone(timezone.utc)
    return {'dow': dt.weekday(), 'hour': dt.hour}      # понедельник = 0, как в JS


def band_of(hour):
    return 0 if hour < 6 else 1 if hour < 12 else 2 if hour < 18 else 3


def top_rubrics(posts):
    cnt = {}
    for p in posts:
        r = rubric_of(p['text'])
        cnt[r] = cnt.get(r, 0) + 1
    return [k for k, _ in sorted(cnt.items(), key=lambda kv: -kv[1])[:RUBRIC_TOP]]


def local_medians(sorted_posts, half_days):
    from datetime import datetime, timezone
    t = [datetime.fromisoformat(p['date']).timestamp() for p in sorted_posts]
    half = half_days * 86400
    out = []
    for i in range(len(sorted_posts)):
        lo = i
        while lo > 0 and t[i] - t[lo - 1] <= half:
            lo -= 1
        hi = i
        while hi + 1 < len(sorted_posts) and t[hi + 1] - t[i] <= half:
            hi += 1
        vals = [sorted_posts[j]['views'] for j in range(lo, hi + 1)]
        out.append({'median': median(vals), 'n': len(vals)})
    return out


def vector(text, post, slot, ctx, rubrics):
    f = features(text)
    lines = [s.strip() for s in text.split('\n') if s.strip()]
    emoji = len(EMO.findall(text))
    x = [1 if f[k] else 0 for k in BIN]
    x.append(math.log(clen(text) + 1))
    x.append(math.log(emoji + 1))
    x.append(min(30, len(lines)))
    pid = ctx.get('postsInDay')
    hsp = ctx.get('hoursSincePrev')
    x.append(float('nan') if pid is None else min(10, pid))
    x.append(float('nan') if hsp is None else math.log1p(min(240, hsp)))
    hour, dow = slot['hour'], slot['dow']
    b = band_of(hour)
    x += [1 if b == 1 else 0, 1 if b == 2 else 0, 1 if b == 3 else 0]
    d = dow % 7
    x += [1 if d == k else 0 for k in range(1, 7)]
    if rubrics:
        r = rubric_of(text)
        x += [1 if r == name else 0 for name in rubrics[1:]]
    return x


def feature_names(rubrics):
    out = BIN + ['длина (лог знаков)', 'эмодзи (лог)', 'абзацев', 'постов в тот же день', 'пауза с прошлого поста',
                 'утро 06–11', 'день 12–17', 'вечер 18–23'] + WEEKDAYS[1:]
    if rubrics:
        out += ['рубрика: ' + r for r in rubrics[1:]]
    return out


def standardize(X):
    n, p = len(X), len(X[0])
    mean = [sum(row[j] for row in X) / n for j in range(p)]
    sd = []
    for j in range(p):
        v = sum((row[j] - mean[j]) ** 2 for row in X) / n
        sd.append(math.sqrt(v) or 1)
    return mean, sd, [[(row[j] - mean[j]) / sd[j] for j in range(p)] for row in X]


def sigmoid(z):
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def fit(Z, y, iters=400, lr=0.5, l2=0.01):
    n, p = len(Z), len(Z[0])
    w = [0.0] * p
    b = 0.0
    for _ in range(iters):
        gw = [0.0] * p
        gb = 0.0
        for i in range(n):
            z = b + sum(w[j] * Z[i][j] for j in range(p))
            e = sigmoid(z) - y[i]
            for j in range(p):
                gw[j] += e * Z[i][j]
            gb += e
        for j in range(p):
            w[j] -= lr * (gw[j] / n + l2 * w[j])
        b -= lr * (gb / n)
    return w, b


def auc(scores, labels):
    pairs = sorted(zip(scores, labels), key=lambda x: x[0])
    n = len(pairs)
    rank_sum = pos = neg = 0
    i = 0
    while i < n:
        j = i
        while j + 1 < n and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            if pairs[k][1] == 1:
                rank_sum += r
                pos += 1
            else:
                neg += 1
        i = j + 1
    if not pos or not neg:
        return None
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


def folds_by_time(n, k=5):
    size = n // k
    return [(i * size, n if i == k - 1 else (i + 1) * size) for i in range(k)]


def train(posts, half_days=45, min_window=20):
    with_v = sorted([p for p in posts if p['views'] > 0], key=lambda p: p['date'])
    if len(with_v) < 60:
        return None
    lm = local_medians(with_v, half_days)
    day_count = {}
    for p in with_v:
        day_count[p['date'][:10]] = day_count.get(p['date'][:10], 0) + 1
    times = [__import__('datetime').datetime.fromisoformat(p['date']).timestamp() for p in with_v]
    rubrics = top_rubrics(with_v)
    keep, y = [], []
    for i, p in enumerate(with_v):
        if lm[i]['n'] < min_window:
            continue
        keep.append(i)
        y.append(1 if p['views'] > lm[i]['median'] else 0)
    X = []
    for i in keep:
        p = with_v[i]
        ctx = {'postsInDay': day_count[p['date'][:10]],
               'hoursSincePrev': (times[i] - times[i - 1]) / 3600 if i > 0 else None}
        slot = slot_of(p)          # фактическое время публикации: признаки расписания не должны быть константой
        X.append(vector(p['text'], p, slot, ctx, rubrics))
    p0 = len(X[0])
    for j in range(p0):
        vals = [row[j] for row in X if not math.isnan(row[j])]
        fill = (sum(vals) / len(vals)) if vals else 0.0
        for row in X:
            if math.isnan(row[j]):
                row[j] = fill
    mean, sd, Z = standardize(X)
    w, b = fit(Z, y)
    folds = []
    for idx, (frm, to) in enumerate(folds_by_time(len(Z))):
        tr = [i for i in range(len(Z)) if not (frm <= i < to)]
        te = list(range(frm, to))
        if len(tr) < 40 or len(te) < 10:
            continue
        mw, mb = fit([Z[i] for i in tr], [y[i] for i in tr])
        scores = [mb + sum(mw[j] * Z[i][j] for j in range(len(mw))) for i in te]
        labels = [y[i] for i in te]
        acc = sum(1 for s, l in zip(scores, labels) if (1 if s > 0 else 0) == l) / len(scores)
        folds.append({'fold': idx + 1, 'n': len(te), 'auc': auc(scores, labels), 'accuracy': acc})
    base = sum(y) / len(y)
    return {'n': len(y), 'positives': sum(y), 'baseRate': base, 'thr': median([p['views'] for p in with_v]),
            'names': feature_names(rubrics), 'w': w, 'b': b, 'mean': mean, 'sd': sd, 'rubrics': rubrics,
            'aucMean': sum(f['auc'] for f in folds) / len(folds),
            'aucMin': min(f['auc'] for f in folds), 'aucMax': max(f['auc'] for f in folds),
            'accMean': sum(f['accuracy'] for f in folds) / len(folds),
            'accBaseline': sum(max(f['accuracy'], 1 - f['accuracy']) for f in folds) / len(folds),
            'folds': folds}


# ---------- чек-лист: те же 14 правил, что в движке ----------
def checklist(text):
    L = [s.strip() for s in text.split('\n') if s.strip()]
    first = L[0] if L else ''
    marker_only = MARKER_ONLY.match(EMO.sub('', first)) is not None
    head = L[1] if (marker_only and len(L) > 1) else first
    return [
        ('эмодзи-маркер отдельной строкой', bool(EMO.search(first)) and marker_only),
        ('заголовок-факт без точки', len(head) > 0 and not head.endswith('.')),
        ('цифра в заголовке', bool(re.search(r'\d', head))),
        ('«Этажи» в ёлочках', (not re.search(r'этаж', text, re.I)) or bool(re.search(r'«этаж', text, re.I))),
        ('кавычки без прямых "', '"' not in text),
        ('«риелтор» через «и»', not re.search(r'риэлтор', text, re.I)),
        ('проценты слитно', not re.search(r'\d\s+%', text)),
        ('нет двойных пробелов', not re.search(r'\S  +\S', text)),
        ('фраза короче 32 слов', all(not any(len(re.findall(r'[а-яА-ЯёЁa-zA-Z]{2,}', s)) > 32
                                      for s in re.split(r'[.!?…]+', l)) for l in L)),
        ('есть ссылка на источник', bool(re.search(r'по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|Домклик|Росреестр|ЦБ|ДОМ\.РФ|URA|72\.RU', text, re.I))),
        ('есть финал: призыв или эмодзи', bool(re.search(r'подписывайт|по ссылк|оставляйт|листайт|приходите|читайте', text, re.I))
         or bool(re.fullmatch(r'[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\s]+', L[-1] if L else ''))),
        ('нет хайпа', not re.search(r'шок|сенсаци|уникальный шанс|вы не поверите', text, re.I)),
        ('нет канцелярита', not re.search(r'осуществля|в рамках реализац|производится оформлен|данный объект', text, re.I)),
        ('нет гарантий', not re.search(r'гарантированн\w* доход|100% одобрен|гарантируем одобрен', text, re.I)),
    ]


def score_text(model, text, slot, ctx):
    x = vector(text, None, slot, ctx, model['rubrics'])
    x = [model['mean'][j] if math.isnan(v) else v for j, v in enumerate(x)]
    z = [(v - model['mean'][j]) / model['sd'][j] for j, v in enumerate(x)]
    contrib = [(model['names'][j], model['w'][j] * z[j]) for j in range(len(z))]
    logit = model['b'] + sum(c for _, c in contrib)
    contrib.sort(key=lambda c: -c[1])
    return {'prob': sigmoid(logit), 'logit': logit,
            'pro': [(n, c) for n, c in contrib[:5] if c > 0.01],
            'contra': [(n, c) for n, c in list(reversed(contrib))[:5] if c < -0.01]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('corpus')
    args = ap.parse_args()

    r = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'node_harness.js'), args.corpus, '--score'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1200:])
        return 1
    js = json.loads(r.stdout)
    posts = load(args.corpus)
    py = train(posts)
    fx = json.load(open(os.path.join(ROOT, 'tests', 'score-fixtures.json'), encoding='utf-8'))

    errs = []
    for key in ('n', 'positives', 'thr', 'aucMean', 'aucMin', 'aucMax', 'accMean', 'accBaseline', 'baseRate'):
        if abs(js[key] - py[key]) > 1e-9:
            errs.append(f'{key}: JS {js[key]!r} != Python {py[key]!r}')
    if js['names'] != py['names']:
        errs.append(f"признаки: JS {len(js['names'])} != Python {len(py['names'])}")
    else:
        dmax = max(abs(a - b) for a, b in zip(js['w'], py['w']))
        bmax = abs(js['b'] - py['b'])
        if dmax > 1e-9 or bmax > 1e-9:
            errs.append(f'веса: максимальное расхождение {dmax:.3e}, свободный член {bmax:.3e}')
    if len(js['folds']) != len(py['folds']):
        errs.append('число блоков не совпало')
    else:
        for a, b in zip(js['folds'], py['folds']):
            if abs(a['auc'] - b['auc']) > 1e-9 or abs(a['accuracy'] - b['accuracy']) > 1e-9 or a['n'] != b['n']:
                errs.append(f"блок {a['fold']}: JS {a} != Python {b}")

    max_dp = 0.0
    for draft in fx['drafts']:
        jd = next(d for d in js['drafts'] if d['id'] == draft['id'])
        pyd = score_text(py, draft['text'], {'dow': 3, 'hour': 15}, {'postsInDay': 1, 'hoursSincePrev': None})
        max_dp = max(max_dp, abs(jd['prob'] - pyd['prob']))
        if abs(jd['prob'] - pyd['prob']) > 1e-9:
            errs.append(f"черновик {draft['id']}: вероятность JS {jd['prob']:.12f} != Python {pyd['prob']:.12f}")
        jcl = {c['name']: c['ok'] for c in jd['checklist']}
        for name, ok in checklist(draft['text']):
            if jcl.get(name) != ok:
                errs.append(f"чек-лист {draft['id']}: «{name}» JS {jcl.get(name)} != Python {ok}")
        if 'expect_hard_fails' in draft:
            for name in draft['expect_hard_fails']:
                if jcl.get(name):
                    errs.append(f"чек-лист {draft['id']}: ожидался провал «{name}», а он зачтён")

    if errs:
        print(f'РАСХОЖДЕНИЙ: {len(errs)}')
        for e in errs[:25]:
            print('  ', e)
        return 2
    print(f'скоринг проверен: {py["n"]} постов, {len(py["names"])} признаков, AUC {py["aucMean"]:.4f} '
          f'({py["aucMin"]:.4f}…{py["aucMax"]:.4f}), точность {py["accMean"]:.4f}')
    print(f'совпали: цель по локальной медиане, матрица признаков, стандартизация, спуск, временные блоки, '
          f'AUC, точность, вероятности черновиков (макс. расхождение {max_dp:.2e}), чек-лист стиля')
    return 0


if __name__ == '__main__':
    sys.exit(main())
