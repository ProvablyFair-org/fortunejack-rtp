#!/usr/bin/env python3
"""Independent check of the FortuneJack Plinko and Keno evidence package, in Python.

A second implementation, written separately from scripts/check.js and sharing no code with it.
It reads raw/ only. It recomputes the RTP of every payout table with exact fractions, checks each
revealed server seed against its committed hash, replays every recorded round from the revealed
seeds, checks each multiplier and gross payout against the captured tables, checks every balance
move and the wallet session totals, compares the Plinko verifier's tables with the live tables, and
verifies SHA256SUMS.txt and raw/client/SHA256SUMS.txt.
It then compares its RTP fractions with analysis/theoretical-rtp.json, written by scripts/check.js.

    python3 scripts/independent_check.py

Python 3.8 or later, standard library only. Exit code 0 when every hash and commitment matches,
every outcome and multiplier replays, every balance move matches, and both implementations agree.
"""
import hashlib
import hmac
import json
import math
import os
import re
import sys
from datetime import datetime
from decimal import ROUND_DOWN, Decimal
from fractions import Fraction

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAY = '2026-11-24'


def text(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as f:
        return f.read()


def data_lines(*parts):
    return [l for l in text(*parts).split('\n') if l and not l.startswith('#')]


def when(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00'))


problems = []


def expect(ok, what):
    if not ok:
        problems.append(what)
    return ok


# ---------------------------------------------------------------- payout tables and exact RTP
PLINKO = {}  # (risk as sent by the game: low / medium / high, rows) -> multipliers by slot
for line in data_lines('raw', 'configurations', 'plinko-coeffs-2026-11-24.txt'):
    rows, rest = line.split(' ', 1)
    for part in rest.split(' | '):
        risk, values = part.split('=')
        PLINKO[(risk, int(rows))] = [Decimal(v) for v in values.split(':')]

KENO = {}  # (risk as labelled in the game: Classic / Low / Medium / High, picks) -> multipliers by hits
for line in data_lines('raw', 'configurations', 'keno-paytables-2026-11-24.txt'):
    left, values = line.split('=')
    risk, picks = left.split()
    KENO[(risk, int(picks))] = [Decimal(v) for v in values.split(':')]
KENO_RISK = {'default': 'Classic', 'low': 'Low', 'mid': 'Medium', 'high': 'High'}

rtp = {}
for (risk, rows), m in PLINKO.items():
    expect(len(m) == rows + 1, 'plinko table length %s/%d' % (risk, rows))
    rtp['plinko/%s/%d' % (risk.capitalize(), rows)] = sum(
        Fraction(math.comb(rows, k), 2 ** rows) * Fraction(m[k]) for k in range(rows + 1))
for (risk, picks), m in KENO.items():
    expect(len(m) == picks + 1, 'keno table length %s/%d' % (risk, picks))
    # hypergeometric: picks numbers chosen, 10 of 40 drawn
    probs = [Fraction(math.comb(picks, h) * math.comb(40 - picks, 10 - h), math.comb(40, 10)) for h in range(picks + 1)]
    expect(sum(probs) == 1, 'keno probabilities sum %s/%d' % (risk, picks))
    rtp['keno/%s/%d' % (risk, picks)] = sum(p * Fraction(x) for p, x in zip(probs, m))


def pct(f, dp=6):
    return '%.*f' % (dp, f * 100)


def summary(game):
    v = [x for k, x in rtp.items() if k.startswith(game + '/')]
    return len(v), min(v), max(v), sum(1 for x in v if x >= Fraction(99, 100))


# ---------------------------------------------------------------- seed pairs
def unit(server, client, counter):
    digest = hmac.new(server.encode('utf-8'), ('%s-%d' % (client, counter)).encode('utf-8'), hashlib.sha512).hexdigest()
    u = float(int(digest[:16], 16)) / float(0xffffffffffffffff)
    if u >= 1.0:
        raise ValueError('unit value of 1.0 at counter %d' % counter)
    return u


plinko_reveals = [l.split(',') for l in data_lines('raw', 'seeds', 'plinko-seed-reveals-2026-11-24.txt')]
keno_reveals = [json.loads(l)['data'] for l in data_lines('raw', 'seeds', 'keno-seed-reveals-2026-11-24.txt')]
# message 119 fields: new hash, new client seed, new nonce, revealed server seed, its hash, its client seed, its total counters, next hash
PAIRS = {}
for name, f in zip(('plinko-A', 'plinko-B'), plinko_reveals):
    PAIRS[name] = dict(server=f[4], hash=f[5], client=f[6], total=int(f[7]))
for name, d in zip(('keno-A', 'keno-B', 'keno-C'), keno_reveals):
    PAIRS[name] = dict(server=d['previous_server_seed'], hash=d['previous_server_seed_hash'],
                       client=d['previous_client_seed'], total=int(d['previous_nonce']))
commitments_ok = 0
for name, p in PAIRS.items():
    if expect(hashlib.sha256(p['server'].encode('utf-8')).hexdigest() == p['hash'], 'commitment ' + name):
        commitments_ok += 1


# ---------------------------------------------------------------- recorded rounds, read from raw/
def events(name):
    return [json.loads(l) for l in text('raw', 'events', name).split('\n') if l.strip()]


rounds = []
bases = {}


def plinko_log(name, pair):
    last_nonce = None
    for e in events(name):
        s = e['s'].strip()
        if e['dir'] == 'recv' and s.startswith('119,'):
            f = s.split(',')
            if f[1] == PAIRS[pair]['hash']:
                last_nonce = int(f[3])  # nonce shown for this pair
        elif e['dir'] == 'recv' and s.startswith('65,'):
            if pair not in bases:
                bases[pair] = (last_nonce, 'nonce shown before the first round')
            f = s.split(',')
            rounds.append(dict(game='plinko', pair=pair, time=when(e['t']), id=f[6], risk=f[7], rows=int(f[8]),
                               path=''.join(f[1].split(';')), balance=Decimal(f[2]), payout=Decimal(f[3]),
                               mult=Decimal(f[4]), stake=Decimal(f[5])))


def keno_log(name, pair):
    for e in events(name):
        s = e['s'].strip()
        if e['dir'] == 'prebet-panel':
            d = json.loads(s)
            if d['active_server_seed_hash'] == PAIRS[pair]['hash']:
                bases[pair] = (int(d['nonce']), 'nonce shown in the fairness panel before the first bet')
            continue
        if e['dir'] != 'recv' or not s.startswith('{'):
            continue
        j = json.loads(s, parse_float=Decimal, parse_int=Decimal)
        if j.get('service') != 'bet':
            continue
        d = j['data']
        rounds.append(dict(game='keno', pair=pair, time=when(e['t']), id=d['round_id'], risk=KENO_RISK[d['risk']],
                           selected=[int(x) for x in d['selected']], drawn=[int(x) for x in d['numbers']],
                           balance=d['balance'], payout=d['win_amount'], mult=d['win_mult'], stake=d['bet_amount']))


plinko_log('plinko-main-run-2026-11-24.ndjson', 'plinko-A')
plinko_log('plinko-second-set-2026-11-24.ndjson', 'plinko-B')
for l in data_lines('raw', 'history', 'plinko-button-rounds-2026-11-24.csv'):
    t, path, bal, pay, mult, stake, bet_id, risk, rows = l.split(',')
    rounds.append(dict(game='plinko', pair='plinko-B', time=when(DAY + 'T' + t + 'Z'), id=bet_id, risk=risk, rows=int(rows),
                       path=path, balance=Decimal(bal), payout=Decimal(pay), mult=Decimal(mult), stake=Decimal(stake)))
keno_log('keno-main-run-2026-11-24.ndjson', 'keno-A')
keno_log('keno-second-set-2026-11-24.ndjson', 'keno-B')
DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDE'  # one character per drawn number, 0..40
for l in data_lines('raw', 'history', 'keno-button-rounds-2026-11-24.csv'):
    idx, t, risk, picks, drawn, hits, mult, pay, stake, bal, rid = l.split(',')
    rounds.append(dict(game='keno', pair='keno-C', time=when(DAY + 'T' + t + 'Z'), id=rid,
                       risk=KENO_RISK[{'d': 'default', 'l': 'low', 'm': 'mid', 'h': 'high'}[risk]],
                       selected=list(range(1, int(picks) + 1)), drawn=[DIGITS.index(c) for c in drawn],
                       balance=Decimal(bal), payout=Decimal(pay), mult=Decimal(mult), stake=Decimal(stake)))
# Keno pair C starts at the nonce given for it in the reveal reply that handed it over (pair B's reveal)
bases['keno-C'] = (int(keno_reveals[1]['nonce']), 'nonce of the new pair in the reveal reply that handed it over')
# Keno pair A: no nonce was recorded before its rounds, so the base is the reveal total less 40 per recorded round
keno_a_rounds = sum(1 for r in rounds if r['pair'] == 'keno-A')
bases['keno-A'] = (PAIRS['keno-A']['total'] - 40 * keno_a_rounds,
                   'reveal total less 40 per recorded round (equals 5 unrecorded earlier rounds x 40)')


# ---------------------------------------------------------------- replay and settlement
def plinko_path(p, first, rows):
    return ''.join('1' if unit(p['server'], p['client'], first + i) >= 0.5 else '0' for i in range(rows))


def keno_draw(p, first):
    a = list(range(1, 41))
    for i in range(40):
        j = i + math.floor((40 - i) * unit(p['server'], p['client'], first + i))
        a[i], a[j] = a[j], a[i]
    return a[:10]


counter = {pair: base for pair, (base, _) in bases.items()}
stats = {g: dict(rounds=0, outcome=0, multiplier=0, payout=0) for g in ('plinko', 'keno')}
payout_exceptions = []
observed = set()
for r in rounds:  # logs are in time order within each pair
    p, st = PAIRS[r['pair']], stats[r['game']]
    st['rounds'] += 1
    if r['game'] == 'plinko':
        mine = plinko_path(p, counter[r['pair']] + 1, r['rows'])
        counter[r['pair']] += r['rows']
        table_mult = PLINKO[(r['risk'], r['rows'])][r['path'].count('1')]
        observed.add(('plinko', r['risk'], r['rows'], r['path'].count('1')))
        ok_outcome = mine == r['path']
    else:
        mine = keno_draw(p, counter[r['pair']] + 1)
        counter[r['pair']] += 40
        hits = len(set(r['selected']) & set(mine))
        table_mult = KENO[(r['risk'], len(r['selected']))][hits]
        observed.add(('keno', r['risk'], len(r['selected']), hits))
        ok_outcome = mine == r['drawn']
    st['outcome'] += expect(ok_outcome, 'outcome %s %s' % (r['game'], r['id']))
    st['multiplier'] += expect(table_mult == r['mult'], 'multiplier %s %s' % (r['game'], r['id']))
    expected_payout = (r['stake'] * table_mult).quantize(Decimal('0.00000001'), rounding=ROUND_DOWN)
    if expected_payout == r['payout']:
        st['payout'] += 1
    else:
        payout_exceptions.append('%s round %s: stake x multiplier = %s, credited %s' % (r['game'], r['id'], expected_payout, r['payout']))

counters_ok = 0
for pair, p in PAIRS.items():
    if expect(counter[pair] == p['total'], 'counter total ' + pair):
        counters_ok += 1

# balance moves across both games, in time order (one wallet)
timeline = sorted(rounds, key=lambda r: r['time'])
balance_ok = balance_checked = 0
for prev, r in zip(timeline, timeline[1:]):
    balance_checked += 1
    balance_ok += expect(prev['balance'] - r['stake'] + r['payout'] == r['balance'], 'balance move ' + str(r['id']))

# wallet session totals (session times are UTC)
wallet_ok = wallet_none = 0
for l in data_lines('raw', 'wallet-transactions-2026-11-24.txt'):
    m = re.match(r'^(\w+)\s+(\d\d:\d\d)-(\d\d:\d\d)\s+won ([0-9.]+) USDT\s+bet -([0-9.]+) USDT\s+= (.*)$', l)
    game, start, end = m.group(1).lower(), when(DAY + 'T' + m.group(2) + ':00Z'), when(DAY + 'T' + m.group(3) + ':59.999Z')
    inside = [r for r in rounds if r['game'] == game and start <= r['time'] <= end]
    if not inside:
        wallet_none += 1
        continue
    wallet_ok += expect(sum(r['payout'] for r in inside) == Decimal(m.group(4)) and sum(r['stake'] for r in inside) == Decimal(m.group(5)),
                        'wallet session ' + l[:30])


# ---------------------------------------------------------------- hashes
def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


sums = [l.split('  ', 1) for l in text('SHA256SUMS.txt').split('\n') if l]
hash_bad = [p for h, p in sums if not os.path.isfile(os.path.join(ROOT, p)) or sha256_file(os.path.join(ROOT, p)) != h]
listed = {p for _, p in sums}
present = []
for d, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules', '__pycache__')]
    present += [os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, '/') for f in files]
unlisted = sorted(p for p in present if p != 'SHA256SUMS.txt' and p not in listed)
client_sums = [l.split('  ', 1) for l in text('raw', 'client', 'SHA256SUMS.txt').split('\n') if l]
client_bad = [p for h, p in client_sums if sha256_file(os.path.join(ROOT, 'raw', 'client', p)) != h]
for p in hash_bad + ['raw/client/' + p for p in client_bad]:
    problems.append('hash ' + p)
for p in unlisted:
    problems.append('not in SHA256SUMS.txt: ' + p)

# ---------------------------------------------------------------- the Plinko verifier FortuneJack links (saved from CodePen)
ver_tables = ver_match = ver_entries = ver_entries_match = 0
block = re.search(r'const COEFFS = \{(.*?)\n\};', text('raw', 'verifier', 'plinko-WbpZpZE.js'), re.S)
if block:
    for m in re.finditer(r'(\d+): \{ low: \[([^\]]*)\], medium: \[([^\]]*)\], high: \[([^\]]*)\] \}', block.group(1)):
        for risk, values in (('low', m.group(2)), ('medium', m.group(3)), ('high', m.group(4))):
            vals = [Decimal(x.strip()) for x in values.split(',')]
            live = PLINKO.get((risk, int(m.group(1))))
            ok = live is not None and len(live) == len(vals)
            for i, x in enumerate(vals):
                ver_entries += 1
                if live is not None and i < len(live) and live[i] == x:
                    ver_entries_match += 1
                else:
                    ok = False
            ver_tables += 1
            ver_match += ok
expect(ver_tables == 27 and ver_match == 27 and ver_entries == 351 and ver_entries_match == 351,
       'the Plinko verifier tables differ from the live tables')

# ---------------------------------------------------------------- agreement with scripts/check.js
agree = compared = 0
theo_path = os.path.join(ROOT, 'analysis', 'theoretical-rtp.json')
if os.path.isfile(theo_path):
    theo = json.loads(text('analysis', 'theoretical-rtp.json'))
    for entry in theo['plinko'] + theo['keno']:
        compared += 1
        num, den = entry['rtp_fraction'].split('/')
        agree += expect(rtp.get(entry['setting']) == Fraction(int(num), int(den)), 'RTP disagrees with check.js: ' + entry['setting'])
else:
    problems.append('analysis/theoretical-rtp.json missing')

# ---------------------------------------------------------------- report
out = print
for game in ('plinko', 'keno'):
    n, lo, hi, at99 = summary(game)
    out('%s: %d tables, RTP %s%% to %s%%, house edge %s%% to %s%%, tables at or above 99%%: %d'
        % (game, n, pct(lo), pct(hi), pct(1 - hi), pct(1 - lo), at99))
out('seed commitments: %d/%d match' % (commitments_ok, len(PAIRS)))
out('counter totals: %d/%d end exactly at the reveal total' % (counters_ok, len(PAIRS)))
for pair, (base, how) in sorted(bases.items()):
    out('  %s starts after counter %d (%s)' % (pair, base, how))
for game in ('plinko', 'keno'):
    st = stats[game]
    out('%s: %d rounds, outcome replayed %d/%d, multiplier %d/%d, gross payout %d/%d'
        % (game, st['rounds'], st['outcome'], st['rounds'], st['multiplier'], st['rounds'], st['payout'], st['rounds']))
for x in payout_exceptions:
    out('  payout exception: ' + x)
out('balance moves: %d/%d match (the first recorded round has no earlier balance)' % (balance_ok, balance_checked))
out('wallet sessions: %d match the recorded rounds, %d hold no recorded rounds' % (wallet_ok, wallet_none))
out('payout positions observed: plinko %d of %d, keno %d of %d'
    % (sum(1 for o in observed if o[0] == 'plinko'), sum(len(v) for v in PLINKO.values()),
       sum(1 for o in observed if o[0] == 'keno'), sum(len(v) for v in KENO.values())))
out('SHA256SUMS.txt: %d/%d files match, %d files not listed; raw/client/SHA256SUMS.txt: %d/%d match'
    % (len(sums) - len(hash_bad), len(sums), len(unlisted), len(client_sums) - len(client_bad), len(client_sums)))
out('plinko verifier saved from CodePen: %d/%d tables and %d/%d entries equal the live tables'
    % (ver_match, ver_tables, ver_entries_match, ver_entries))
out('agreement with scripts/check.js: %d/%d table RTPs identical as exact fractions' % (agree, compared))
for p in problems:
    out('PROBLEM ' + p)
out('RESULT: OK' if not problems else 'RESULT: FAIL (%d problems)' % len(problems))
sys.exit(0 if not problems else 1)
