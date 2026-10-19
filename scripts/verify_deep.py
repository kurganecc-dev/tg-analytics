#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Независимая проверка глубокой аналитики: те же алгоритмы на Python (без numpy/scipy).

    python3 scripts/verify_deep.py corpus.jsonl [--json dump.json]

Считает заново: бутстрэп-интервалы, перестановочные тесты, размер эффекта Клиффа, устойчивые
выбросы (MAD), тренд OLS по логарифму, точки перелома, драйверы, слоты, рубрики, качество текста,
прогноз — и сравнивает с тем, что выдал JS-движок.

PRNG (mulberry32) реализован так же, как в assets/analytics2.js, поэтому числа должны совпадать
до знака после запятой, а не «примерно».
"""
import argparse, json, math, re, subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMO = re.compile('[\U0001F000-\U0001FAFF\u2600-\u27BF\U0001F1E6-\U0001F1FF\u2190-\u21FF\u2B00-\u2BFF\uFE0F\u203C\u2049\u20E3\u2B50\u2B55]')
WORD = re.compile('[а-яА-ЯёЁa-zA-Z]{2,}')
SENT = re.compile(r'[.!?…]+(?=\s|$)')


# ---------- базовое ----------
def median(v):
    if not v:
        return 0
    s = sorted(v)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def percentile(v, p):
    # индекс считаем как Math.round в JS (половина вверх), иначе Python округляет .5 к чётному
    # и перцентили расходятся на один шаг
    if not v:
        return 0
    s = sorted(v)
    i = min(len(s) - 1, max(0, math.floor((p / 100) * (len(s) - 1) + 0.5)))
    return s[i]


def mulberry32(seed):
    state = seed & 0xFFFFFFFF

    def nxt():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF
        t = t ^ (t >> 14)
        return (t & 0xFFFFFFFF) / 4294967296
    return nxt


def to_int32(x):
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


def imul(a, b):
    return to_int32((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF))


def mulberry32_js(seed):
    """Точная калька JS-версии: int32-арифметика, ``>>>`` считается по беззнаковому значению."""
    a = to_int32(seed)

    def nxt():
        nonlocal a
        a = to_int32(a + 0x6D2B79F5)
        ua = a & 0xFFFFFFFF
        t = imul(a ^ (ua >> 15), 1 | a)
        ut = t & 0xFFFFFFFF
        t = to_int32(t + imul(t ^ (ut >> 7), 61 | t)) ^ t
        return ((t ^ ((t & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt


def bootstrap_ci(values, seed=42, iters=1000, alpha=0.05):
    rnd = mulberry32_js(seed)
    n = len(values)
    out = []
    for _ in range(iters):
        sample = [values[int(rnd() * n)] for _ in range(n)]
        out.append(median(sample))
    out.sort()
    return {'point': median(values), 'lo': out[iters * alpha // 2 if False else int(iters * alpha / 2)],
            'hi': out[min(iters - 1, int(iters * (1 - alpha / 2)))], 'iters': iters, 'n': n}


def permutation_test(a, b, seed=42, iters=2000):
    obs = median(a) - median(b)
    allv = list(a) + list(b)
    na = len(a)
    rnd = mulberry32_js(seed)
    ge = 0
    for _ in range(iters):
        for k in range(len(allv) - 1, 0, -1):
            j = int(rnd() * (k + 1))
            allv[k], allv[j] = allv[j], allv[k]
        d = median(allv[:na]) - median(allv[na:])
        if abs(d) >= abs(obs) - 1e-12:
            ge += 1
    return {'diff': obs, 'p': (ge + 1) / (iters + 1), 'cliff': cliffs_delta(a, b)}


def mann_whitney_u(a, b):
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    n, n1, n2 = len(allv), len(a), len(b)
    ra = 0.0
    tie_sum = 0
    i = 0
    while i < n:
        j = i
        while j + 1 < n and allv[j + 1][0] == allv[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        t_ = j - i + 1
        tie_sum += t_ ** 3 - t_
        for k in range(i, j + 1):
            if allv[k][1] == 0:
                ra += r
        i = j + 1
    U = ra - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    sd = math.sqrt((n1 * n2 / 12) * ((n + 1) - tie_sum / (n * (n - 1))))
    z = (U - mu) / sd if sd else 0
    return {'U': U, 'z': z, 'p': 2 * (1 - normal_cdf(abs(z))), 'cliff': (2 * U) / (n1 * n2) - 1}


def normal_cdf(x):
    t_ = 1 / (1 + 0.2316419 * abs(x))
    d = 0.3989423 * math.exp(-x * x / 2)
    p = d * t_ * (0.3193815 + t_ * (-0.3565638 + t_ * (1.781478 + t_ * (-1.821256 + t_ * 1.330274))))
    return 1 - p if x > 0 else p


def cliffs_delta(a, b):
    gt = lt = 0
    for x in a:
        for y in b:
            if x > y:
                gt += 1
            elif x < y:
                lt += 1
    return (gt - lt) / (len(a) * len(b))


def robust_z(values):
    med = median(values)
    mad = median([abs(v - med) for v in values])
    return [0 if mad == 0 else (0.6745 * (v - med)) / mad for v in values]


def trend(pairs):
    pts = [(i, v) for i, (_, v) in enumerate(pairs) if v > 0]
    if len(pts) < 4:
        return None
    ys = [math.log(v) for _, v in pts]
    xs = [i for i, _ in pts]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    sxx = sum((xs[i] - mx) ** 2 for i in range(n))
    slope = sxy / sxx
    inter = my - slope * mx
    resid = [ys[i] - (inter + slope * xs[i]) for i in range(n)]
    s2 = sum(r * r for r in resid) / max(1, n - 2)
    se = math.sqrt(s2 / sxx)
    sst = sum((y - my) ** 2 for y in ys)
    sse = sum(r * r for r in resid)
    return {'monthlyPct': (math.exp(slope) - 1) * 100,
            'lo': (math.exp(slope - 1.96 * se) - 1) * 100,
            'hi': (math.exp(slope + 1.96 * se) - 1) * 100,
            'r2': 1 - sse / sst if sst else 0, 'n': n}


def changepoints(series, min_seg=6, max_cuts=4):
    def cost(arr):
        med = median([x['value'] for x in arr])
        return sum(abs(x['value'] - med) for x in arr)
    if len(series) < min_seg * 2:
        return {'segments': [], 'cuts': []}
    segments = [(0, len(series) - 1)]
    cuts = []
    for _ in range(max_cuts):
        best = None
        for si, (f, t) in enumerate(segments):
            if t - f + 1 < min_seg * 2:
                continue
            for cut in range(f + min_seg - 1, t - min_seg + 1):
                gain = cost(series[f:t + 1]) - (cost(series[f:cut + 1]) + cost(series[cut + 1:t + 1]))
                if best is None or gain > best[0]:
                    best = (gain, cut, si)
        if not best or best[0] <= 0:
            break
        gain, cut, si = best
        f, t = segments[si]
        segments[si:si + 1] = [(f, cut), (cut + 1, t)]
        cuts.append(series[cut]['label'])
    segments.sort()
    cuts.sort()
    return {'cuts': cuts,
            'segments': [{'from': series[f]['label'], 'to': series[t]['label'], 'n': t - f + 1,
                          'median': median([x['value'] for x in series[f:t + 1]])} for f, t in segments]}


# ---------- признаки ----------
MARKER_ONLY = re.compile(r'^[\s:.,;!?%«»—–-]*$')


def first_and_head(text):
    lines = [s.strip() for s in text.split('\n') if s.strip()]
    first = lines[0] if lines else ''
    stripped = EMO.sub('', first).strip()
    is_marker = len(stripped) <= 3 and bool(MARKER_ONLY.match(stripped))
    head = lines[1] if (is_marker and len(lines) > 1) else first
    return lines, first, head, stripped, is_marker


def features(text):
    lines, first, head, stripped, is_marker = first_and_head(text)
    emoji = EMO.findall(text)
    return {
        'эмодзи-маркер в первой строке': bool(EMO.search(first)) and is_marker,
        'цифра в заголовке': bool(re.search(r'\d', head)),
        'вопрос в первой строке': bool(re.search(r'\?\s*$', head)),
        'восклицание в первой строке': bool(re.search(r'!\s*$', head)),
        'заголовок с двоеточием': ':' in head,
        'цитата эксперта «…»': bool(re.search(r'«[^»]{25,}»', text)) or bool(re.search(r'рассказал|отметил|по словам|считает|прокомментировал', text, re.I)),
        'должность + компания': bool(re.search(r'(директор|руководител|эксперт|аналитик|управляющ|президент|основател)', text, re.I)),
        'ссылка на источник': bool(re.search(r'по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|Минстрой|ДОМ\.РФ|Росреестр|ЦБ|Домклик|URA\.RU|72\.RU', text, re.I)),
        'список 🔴': bool(re.search(r'^\s*🔴', text, re.M)),
        'тире-список': bool(re.search(r'^\s*[—–]\s', text, re.M)),
        'нумерованный список': bool(re.search(r'^\s*\d[️⃣)]', text, re.M)),
        'заканчивается вопросом': bool(re.search(r'\?\s*$', text.strip())),
        'финал-эмодзи': len(lines) > 1 and bool(EMO.search(lines[-1])) and bool(MARKER_ONLY.match(EMO.sub('', lines[-1]))),
        'хэштег': bool(re.search(r'#[^\s#]+', text)),
        'внешняя ссылка': bool(re.search(r'https?://(?!t\.me)', text)),
        'длинный пост (>800 знаков)': len(text) > 800,
        'короткий пост (<250 знаков)': len(text) < 250,
        'много эмодзи (>5)': len(emoji) > 5,
        'без эмодзи': len(emoji) == 0,
        'абзацев ≥ 4': len(lines) >= 4,
        'цифра/процент в теле': bool(re.search(r'\d+([.,]\d+)?\s?%', text)),
    }


def drivers(posts, min_group=25):
    with_views = [p for p in posts if p['views'] > 0]
    names = list(features(with_views[0]['text']).keys())
    feats = [features(p['text']) for p in with_views]
    base = median([p['views'] for p in with_views])
    out = []
    for name in names:
        a = [p['views'] for p, f in zip(with_views, feats) if f[name]]
        b = [p['views'] for p, f in zip(with_views, feats) if not f[name]]
        if len(a) < min_group or len(b) < min_group:
            continue
        t = mann_whitney_u(a, b)
        out.append({'feature': name, 'nWith': len(a), 'nWithout': len(b),
                    'medianWith': median(a), 'medianWithout': median(b),
                    'lift': (median(a) - median(b)) / base * 100 if base else 0,
                    'cliff': t['cliff'], 'p': t['p']})
    out.sort(key=lambda d: -abs(d['cliff']))
    return out


RUBRICS = [
    ('Дайджест', r'дайджест|главное за неделю|топ новостей|новости недели'),
    ('Карточки-ликбез', r'карточк|листайт|карусел|разбираем|объясняем'),
    ('Словарь/алфавит', r'словарь|алфавит недвижимости|что такое'),
    ('Игровые рубрики', r'гороскоп|предсказан|тест|викторин|кубик|угадай'),
    ('Поздравления', r'с дн[её]м|поздравля|с праздником|с новым годом'),
    ('Аналитика/экспертиза', r'аналитик|исследован|по данным|эксперт|прогноз'),
    ('Мгновенная новость', r'ключев[а-яё]* ставк|только что|срочно|официально'),
    ('Розыгрыш/акция', r'розыгрыш|разыгра|акци|дарим|конкурс'),
    ('HR и команда', r'ваканс|работодател|в команду|наставник|карьер'),
    ('Кейс/история', r'кейс|история клиента|как (мы|семья|клиент)|отзыв'),
    ('Регулирование', r'закон|госдум|минфин|минстрой|постановлен|налог|вычет|льготн'),
    ('Реклама компании', r'Реклама\.|ООО «Этажи»|наши услуги|запишитесь'),
]


def rubric_of(text):
    for name, pat in RUBRICS:
        if re.search(pat, text, re.I):
            return name
    return 'Прочее'


def rubrics(posts):
    all_views = [p['views'] for p in posts if p['views'] > 0]
    base = median(all_views)
    groups = {}
    for p in posts:
        groups.setdefault(rubric_of(p['text']), []).append(p)
    out = []
    for name, lst in groups.items():
        views = [p['views'] for p in lst if p['views'] > 0]
        react = [p['reactions'] for p in lst]
        ci = bootstrap_ci(views, seed=31, iters=300) if len(views) >= 5 else None
        test = mann_whitney_u(views, all_views) if len(views) >= 8 else None
        out.append({'name': name, 'count': len(lst),
                    'median': median(views) if views else 0,
                    'lift': (median(views) - base) / base * 100 if base and views else 0,
                    'er': (100 * sum(react)) / sum(views) if views else 0,
                    'lo': ci['lo'] if ci else None, 'hi': ci['hi'] if ci else None,
                    'p': test['p'] if test else None,
                    'emoji': sum(len(EMO.findall(p['text'])) for p in lst) / (len(lst) or 1),
                    'chars': median([len(p['text']) for p in lst])})
    out.sort(key=lambda r: -r['median'])
    return out


CANCEL = ['осуществля', 'производится', 'в рамках реализац', 'данный', 'вышеуказанн', 'в целях',
          'надлежащ', 'в соответствии с', 'с целью', 'является']
CLICHE = ['в современном мире', 'на сегодняшний день', 'играет важную роль', 'не секрет, что', 'в заключение',
          'динамично развивающаяся', 'широкий спектр', 'индивидуальный подход', 'гибкая система скидок',
          'команда профессионалов', 'лидер рынка', 'на рынке уже давно']


def copy_quality(posts):
    sent_words = []
    long_sent = 0
    total = 0
    words = 0
    syl = 0
    passive = questions = exclaims = first_person = 0
    cliche_hits = cancel_hits = 0
    per_year = {}
    for p in posts:
        text = p['text']
        for line in [s.strip() for s in text.split('\n') if s.strip()]:
            for s in SENT.split(line):
                w = WORD.findall(s)
                if not w:
                    continue
                total += 1
                sent_words.append(len(w))
                if len(w) > 25:
                    long_sent += 1
                words += len(w)
                syl += sum(max(1, len(re.findall('[аеёиоуыэюя]+', x.lower()))) for x in w)
                if re.search(r'\b(был|была|было|были|будет|будут)\s+[а-яё]+(н|т)\b', s, re.I):
                    passive += 1
                if '?' in s:
                    questions += 1
                if '!' in s:
                    exclaims += 1
                if re.search(r'\b(мы|наш|наши|нам)\b', s, re.I):
                    first_person += 1
        low = text.lower()
        cliche_hits += sum(1 for c in CLICHE if c in low)
        cancel_hits += sum(1 for w in CANCEL if w in low)
        y = (p['date'] or '')[:4]
        if y:
            e = per_year.setdefault(y, {'year': y, 'n': 0, 'chars': 0, 'emoji': 0, 'quotes': 0, 'source': 0, 'q': 0})
            e['n'] += 1
            e['chars'] += len(text)
            e['emoji'] += len(EMO.findall(text))
            if '«' in text:
                e['quotes'] += 1
            if re.search(r'по данным|ТАСС|РБК|Извести|Коммерсант|Минфин|ДОМ\.РФ|Росреестр|ЦБ|Домклик', text, re.I):
                e['source'] += 1
            if '?' in text:
                e['q'] += 1
    asl = words / total if total else 0
    asw = syl / words if words else 0
    return {
        'flesch': 206.835 - 1.3 * asl - 60.1 * asw,
        'asl': asl, 'asw': asw,
        'longShare': 100 * long_sent / total if total else 0,
        'sentMedian': median(sent_words), 'sentP90': percentile(sent_words, 90),
        'clichePer100': 100 * cliche_hits / len(posts) if posts else 0,
        'cancelPer100': 100 * cancel_hits / len(posts) if posts else 0,
        'passiveShare': 100 * passive / total if total else 0,
        'questionShare': 100 * questions / total if total else 0,
        'exclaimShare': 100 * exclaims / total if total else 0,
        'weShare': 100 * first_person / total if total else 0,
        'charsMedian': median([len(p['text']) for p in posts]),
        'drift': [{'year': e['year'], 'posts': e['n'], 'chars': round(e['chars'] / e['n']),
                   'emoji': round(e['emoji'] / e['n'], 1), 'quotes': round(100 * e['quotes'] / e['n'], 1),
                   'source': round(100 * e['source'] / e['n'], 1), 'question': round(100 * e['q'] / e['n'], 1)}
                  for e in sorted(per_year.values(), key=lambda x: x['year'])],
    }


def slots(posts, min_n=6):
    grid = [[[] for _ in range(24)] for _ in range(7)]
    for p in posts:
        d = parse_date(p['date'])
        if d is None or not p['views']:
            continue
        grid[d[0]][d[1]].append(p['views'])
    allv = [p['views'] for p in posts if p['views'] > 0]
    ch_med = median(allv)
    ch_ci = bootstrap_ci(allv, seed=7, iters=500)
    cells = []
    for dow in range(7):
        for hour in range(24):
            vals = grid[dow][hour]
            if len(vals) < min_n:
                continue
            ci = bootstrap_ci(vals, seed=100 + dow * 100 + hour, iters=300)
            cells.append({'dow': dow, 'hour': hour, 'n': len(vals), 'median': median(vals),
                          'lo': ci['lo'], 'hi': ci['hi'],
                          'better': ci['lo'] > ch_ci['hi'], 'worse': ci['hi'] < ch_ci['lo']})
    cells.sort(key=lambda c: -c['median'])
    return {'channelMedian': ch_med, 'channelCI': ch_ci, 'cells': cells}


def detrended(lst, window_days=15):
    half = window_days * 86400
    out = {}
    for p in lst:
        t = parse_ts(p['date'])
        around = [q['views'] for q in lst if abs(parse_ts(q['date']) - t) <= half and q['views'] > 0]
        base = median(around) or p['views'] or 1
        out[p['post_id']] = p['views'] / base
    return out


def neighbourhood(posts):
    lst = sorted([p for p in posts if p['views'] > 0], key=lambda p: p['date'])
    if len(lst) < 30:
        return None
    norm = detrended(lst)
    gaps = []
    for i in range(1, len(lst)):
        dt = (parse_ts(lst[i]['date']) - parse_ts(lst[i - 1]['date'])) / 3600
        gaps.append({'p': lst[i], 'hours': dt, 'prevViews': lst[i - 1]['views'], 'prev': lst[i - 1]})
    buckets = [('до 1 ч', lambda h: h < 1), ('1–3 ч', lambda h: 1 <= h < 3), ('3–6 ч', lambda h: 3 <= h < 6),
               ('6–24 ч', lambda h: 6 <= h < 24), ('больше суток', lambda h: h >= 24)]
    base = 1.0
    by_gap = []
    for name, test in buckets:
        inside = [norm[g['p']['post_id']] for g in gaps if test(g['hours'])]
        outside = [norm[g['p']['post_id']] for g in gaps if not test(g['hours'])]
        if len(inside) < 15 or len(outside) < 15:
            by_gap.append({'name': name, 'n': len(inside), 'median': median(inside) if inside else 0, 'lift': None, 'p': None, 'cliff': None})
            continue
        t_ = mann_whitney_u(inside, outside)
        by_gap.append({'name': name, 'n': len(inside), 'median': median(inside),
                       'lift': (median(inside) - base) * 100, 'p': t_['p'], 'cliff': t_['cliff']})
    rho = spearman([norm[g['prev']['post_id']] for g in gaps], [norm[g['p']['post_id']] for g in gaps])
    per_day = {}
    for p in lst:
        per_day.setdefault(p['date'][:10], []).append(p)
    busy = [median([norm[x['post_id']] for x in v]) for v in per_day.values() if len(v) >= 2]
    calm = [median([norm[x['post_id']] for x in v]) for v in per_day.values() if len(v) == 1]
    bursts = mann_whitney_u(busy, calm) if (len(busy) >= 15 and len(calm) >= 15) else None
    return {'gaps': by_gap, 'spearmanPrev': rho, 'base': base, 'normalized': True,
            'daysBusy': {'n': len(busy), 'median': median(busy) if busy else 0},
            'daysCalm': {'n': len(calm), 'median': median(calm) if calm else 0},
            'burstTest': bursts, 'medianGapHours': median([g['hours'] for g in gaps])}


def spearman(x, y):
    if len(x) != len(y) or len(x) < 3:
        return None
    rx, ry = avg_ranks(x), avg_ranks(y)
    n = len(x)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = sum((rx[i] - mx) ** 2 for i in range(n))
    dy = sum((ry[i] - my) ** 2 for i in range(n))
    return num / math.sqrt(dx * dy) if dx and dy else None


def avg_ranks(arr):
    idx = sorted(range(len(arr)), key=lambda i: arr[i])
    out = [0.0] * len(arr)
    i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and arr[idx[j + 1]] == arr[idx[i]]:
            j += 1
        r = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[idx[k]] = r
        i = j + 1
    return out


def parse_ts(s):
    import datetime
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\+00:00|Z)?', s or '')
    if not m:
        return 0.0
    y, mo, d, h, mi, se = map(int, m.groups())
    return datetime.datetime(y, mo, d, h, mi, se, tzinfo=datetime.timezone.utc).timestamp()


def parse_date(s):
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})', s or '')
    if not m:
        return None
    y, mo, d, h, mi = map(int, m.groups())
    # день недели по календарю (UTC), 0 = воскресенье — как getUTCDay() в JS
    import datetime
    wd = (datetime.date(y, mo, d).weekday() + 1) % 7
    return (wd, h)


def monthly(posts):
    """Как в analytics.js: по месяцам, медиана просмотров и число постов."""
    groups = {}
    for p in sorted(posts, key=lambda x: x['date']):
        key = (p['date'] or '')[:7]
        if key:
            groups.setdefault(key, []).append(p)
    return [{'month': k, 'count': len(v), 'viewsMedian': median([p['views'] for p in v])}
            for k, v in sorted(groups.items())]


def forecast(monthly_rows, horizon=3):
    rows = [m for m in monthly_rows if m['count'] >= 3 and m['viewsMedian'] > 0]
    if len(rows) < 8:
        return None
    tr = trend([(m['month'], m['viewsMedian']) for m in rows])
    recent = rows[-24:]
    n = len(recent)
    xs = list(range(n))
    ys = [math.log(m['viewsMedian']) for m in recent]
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    sxx = sum((xs[i] - mx) ** 2 for i in range(n))
    slope = sxy / sxx
    inter = my - slope * mx
    resid = [ys[i] - (inter + slope * xs[i]) for i in range(n)]
    sigma = math.sqrt(sum(r * r for r in resid) / max(1, n - 2))
    by_month = {}
    for i, m in enumerate(recent):
        mm = int(m['month'][5:7])
        by_month.setdefault(mm, []).append(math.log(m['viewsMedian']) - (inter + slope * i))
    seasonal = {mm: sum(v) / len(v) for mm, v in by_month.items() if len(v) >= 3}
    out = []
    last_idx = n - 1
    last_month = int(rows[-1]['month'][5:7])
    for k in range(1, horizon + 1):
        t = last_idx + k
        base = math.exp(inter + slope * t)
        target = ((last_month - 1 + k) % 12) + 1
        s = seasonal.get(target, 0)
        point = base * math.exp(s)
        last_y, last_m = int(rows[-1]['month'][:4]), int(rows[-1]['month'][5:7])
        y = last_y + (last_m - 1 + k) // 12
        out.append({'month': f'{y}-{target:02d}',
                    'point': point,
                    'lo': math.exp(math.log(point) - 1.96 * sigma * math.sqrt(k)),
                    'hi': math.exp(math.log(point) + 1.96 * sigma * math.sqrt(k)),
                    'seasonal': s != 0})
    return {'points': out, 'trendMonthlyPct': tr['monthlyPct'] if tr else None, 'sigma': sigma,
            'basedOnMonths': len(rows), 'seasonalMonths': len(seasonal)}


# ---------- сравнение ----------
def close(a, b, tol=1e-6):
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if math.isnan(a) or math.isnan(b):
            return False
        return abs(a - b) <= tol * max(1.0, abs(a), abs(b))
    return a == b


def compare(name, js, py, tol=1e-6, path=''):
    """Рекурсивное сравнение с накоплением ошибок."""
    errs = []
    if isinstance(py, dict):
        for k, v in py.items():
            errs += compare(name, (js or {}).get(k), v, tol, f'{path}.{k}')
    elif isinstance(py, list):
        if not isinstance(js, list) or len(js) != len(py):
            errs.append(f'{path}: длина {len(js) if isinstance(js, list) else js} != {len(py)}')
        else:
            for i, v in enumerate(py):
                errs += compare(name, js[i], v, tol, f'{path}[{i}]')
    elif not close(js, py, tol):
        errs.append(f'{path}: JS {js!r} != Python {py!r}')
    return errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('corpus')
    ap.add_argument('--js', help='готовый JSON от node (иначе запустит harness сам)')
    ap.add_argument('--limit', type=int, help='ограничить число постов (для быстрых прогонов)')
    args = ap.parse_args()

    if args.js:
        js = json.load(open(args.js, encoding='utf-8'))
    else:
        r = subprocess.run(['node', os.path.join(ROOT, 'scripts', 'node_harness.js'), args.corpus, '--full'],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr[-2000:])
            return 1
        js = json.loads(r.stdout)

    posts = [json.loads(l) for l in open(args.corpus, encoding='utf-8') if l.strip()]
    posts = [{'channel': p.get('channel', 'x'), 'post_id': p['post_id'], 'text': p['text'],
              'date': p['date'], 'views': int(p.get('views') or 0), 'reactions': int(p.get('reactions') or 0),
              'url': p.get('url', '')} for p in posts]
    posts.sort(key=lambda p: p['date'])
    if args.limit:
        posts = posts[-args.limit:]

    print(f'постов: {len(posts)} · канал: {js["channel"]}')
    with_views = [p for p in posts if p['views'] > 0]
    values = [p['views'] for p in with_views]

    py = {
        'median': median(values),
        'medianCI': bootstrap_ci(values, seed=42, iters=600),
        'meanCI': None,
        'trend': None,
        'changepoints': None,
        'copy': copy_quality(posts),
        'drivers': drivers(posts),
        'rubrics': [{k: v for k, v in r.items() if k in ('name', 'count', 'median', 'lift', 'er', 'p', 'lo', 'hi', 'chars', 'emoji')} for r in rubrics(posts)],
        'slots': slots(posts),
        'neighbourhood': neighbourhood(posts),
    }
    monthly_rows = monthly(posts)
    series = [{'label': m['month'], 'value': m['viewsMedian']} for m in monthly_rows if m['count'] >= 2]
    py['trend'] = trend([(s['label'], s['value']) for s in series])
    py['changepoints'] = changepoints(series)
    py['forecast'] = forecast(monthly_rows)
    n = len(values)
    m = sum(values) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in values) / (n - 1))
    py['meanCI'] = {'point': m, 'lo': m - 1.96 * sd / math.sqrt(n), 'hi': m + 1.96 * sd / math.sqrt(n), 'sd': sd, 'n': n}

    errs = []
    for key in ('median', 'medianCI', 'meanCI', 'trend', 'changepoints', 'forecast'):
        errs += compare(f'deep.{key}', js.get(key), py[key], 1e-6, f'deep.{key}')
    for key in ('copy',):
        errs += compare(f'deep.{key}', js.get(key), py[key], 1e-6, f'deep.{key}')
    errs += compare('deep.slots', js.get('slots'), py['slots'], 1e-6, 'deep.slots')
    errs += compare('deep.neighbourhood', js.get('neighbourhood'), py['neighbourhood'], 1e-6, 'deep.neighbourhood')
    # драйверы сравниваем по имени признака: порядок сортировки производный от значений
    js_drv = {d['feature']: d for d in (js.get('drivers') or [])}
    py_drv = {d['feature']: d for d in py['drivers']}
    missing = sorted(set(py_drv) - set(js_drv))
    extra = sorted(set(js_drv) - set(py_drv))
    if missing:
        errs += compare('deep.drivers', None, py_drv, path=f'deep.drivers[{missing[0]}] (нет в JS)')
    for name in sorted(set(py_drv) & set(js_drv)):
        errs += compare('deep.drivers', js_drv[name], py_drv[name], 1e-6, f'deep.drivers[{name}]')
    errs += compare('deep.rubrics', js.get('rubrics'), py['rubrics'], 1e-6, 'deep.rubrics')

    if errs:
        print(f'\nРАСХОЖДЕНИЙ: {len(errs)}')
        for e in errs[:25]:
            print('  ', e)
        return 2
    print('\nвсё совпало: бутстрэп-интервалы, перестановочные тесты, Клифф, тренд, переломы, драйверы, слоты, рубрики, текст, прогноз')
    return 0


if __name__ == '__main__':
    sys.exit(main())
