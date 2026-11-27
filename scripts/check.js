#!/usr/bin/env node
// FortuneJack Plinko + Keno evidence package: offline rebuild and check.
//
// Reads raw/ and claims/. Rebuilds sessions/, normalized/ and analysis/ (README.md is written by
// hand), replays every recorded round from the revealed seeds, checks multiplier, gross payout and
// balance movement against the captured tables, recomputes the exact RTP of every table, locates
// FortuneJack's claims in the captured sources, and verifies both hash lists and the manifest
// inventory.
//
//   node scripts/check.js            rebuild in memory; exit 0 only if every rebuilt file equals
//                                    the committed file byte for byte and every hash matches
//   node scripts/check.js --write    write the rebuilt files (used once, when the package is built)
//
// No dependencies: node:fs, node:path, node:crypto. Node 18 or later.
// scripts/independent_check.py is a separate implementation of the replay and RTP checks.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const readText = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------------------------
// Exact decimal arithmetic (BigInt, 18 decimal places). Money and multipliers never touch floats.
// ---------------------------------------------------------------------------------------------
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);
function D(s) {
  s = String(s).trim();
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('not a plain decimal: ' + s);
  const [i, f = ''] = s.split('.');
  if (f.length > SCALE) throw new Error('too many decimals: ' + s);
  const v = BigInt(i) * ONE + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE));
  return neg ? -v : v;
}
function S(v) {
  const neg = v < 0n;
  if (neg) v = -v;
  const i = v / ONE;
  let f = (v % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '');
}
function mul(a, b) {
  const p = a * b;
  if (p % ONE !== 0n) throw new Error('product exceeds precision');
  return p / ONE;
}
const Q8 = 10n ** BigInt(SCALE - 8);
const trunc8 = (v) => v - (v % Q8); // v >= 0: keep 8 decimal places, ignore further digits

// ---------------------------------------------------------------------------------------------
// Provably fair construction (HMAC-SHA512, key = server seed as UTF-8 text,
// message = client seed + "-" + counter; first 16 hex digits / 0xffffffffffffffff, in IEEE
// double arithmetic as the published construction does).
// ---------------------------------------------------------------------------------------------
function unit(server, client, counter) {
  const h = crypto.createHmac('sha512', Buffer.from(server, 'utf8')).update(client + '-' + counter, 'utf8').digest('hex');
  return Number('0x' + h.slice(0, 16)) / Number('0xffffffffffffffff');
}
// Plinko: one counter per row; floor(2u) = 1 means right. Slot = number of rights.
function plinkoPath(server, client, firstCounter, rows) {
  let p = '';
  for (let r = 0; r < rows; r++) p += String(Math.floor(2 * unit(server, client, firstCounter + r)));
  return p;
}
// Keno: 40 counters per round; Fisher-Yates over 1..40 with j = i + floor((40 - i) u);
// the first ten positions are the draw, in order. (The 40th step has a range of one.)
function kenoDraw(server, client, firstCounter) {
  const a = [];
  for (let n = 1; n <= 40; n++) a.push(n);
  for (let i = 0; i < 40; i++) {
    const j = i + Math.floor((40 - i) * unit(server, client, firstCounter + i));
    const t = a[j]; a[j] = a[i]; a[i] = t;
  }
  return a.slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------
const EV = 'raw/events/';
const F = {
  plinkoMain: EV + 'plinko-main-run-2026-11-24.ndjson',
  plinkoSet2: EV + 'plinko-second-set-2026-11-24.ndjson',
  kenoMain: EV + 'keno-main-run-2026-11-24.ndjson',
  kenoSet2: EV + 'keno-second-set-2026-11-24.ndjson',
  plinkoButton: 'raw/history/plinko-button-rounds-2026-11-24.csv',
  kenoButton: 'raw/history/keno-button-rounds-2026-11-24.csv',
  plinkoTables: 'raw/configurations/plinko-coeffs-2026-11-24.txt',
  kenoTables: 'raw/configurations/keno-paytables-2026-11-24.txt',
  plinkoReveals: 'raw/seeds/plinko-seed-reveals-2026-11-24.txt',
  kenoReveals: 'raw/seeds/keno-seed-reveals-2026-11-24.txt',
  wallet: 'raw/wallet-transactions-2026-11-24.txt',
};
const DATE = '2026-11-24';

function ndjson(file) {
  return readText(file).split('\n').map((l, i) => ({ l, line: i + 1 })).filter((x) => x.l.trim())
    .map((x) => Object.assign(JSON.parse(x.l), { _ref: file + ':' + x.line }));
}
function dataLines(file) {
  return readText(file).split('\n').map((l, i) => ({ l, line: i + 1 })).filter((x) => x.l && !x.l.startsWith('#'));
}
const strip = (s) => s.replace(/\r\n$/, '');

// ---------------------------------------------------------------------------------------------
// Configurations (tables)
// ---------------------------------------------------------------------------------------------
const RISK_P = { low: 'Low', medium: 'Medium', high: 'High' };
const RISK_K = { default: 'Classic', low: 'Low', mid: 'Medium', high: 'High' };

const plinkoTables = {};
for (const { l, line } of dataLines(F.plinkoTables)) {
  const m = l.match(/^(\d+) (.*)$/);
  const rows = Number(m[1]);
  for (const part of m[2].split(' | ')) {
    const [risk, list] = part.split('=');
    plinkoTables[risk + '/' + rows] = { risk, rows, coefficients: list.split(':'), ref: F.plinkoTables + ':' + line };
  }
}
const kenoTables = {};
for (const { l, line } of dataLines(F.kenoTables)) {
  const m = l.match(/^(\w+) (\d+)=(.*)$/);
  kenoTables[m[1] + '/' + m[2]] = { risk: m[1], picks: Number(m[2]), multipliers: m[3].split(':'), ref: F.kenoTables + ':' + line };
}

// ---------------------------------------------------------------------------------------------
// Exact theoretical RTP
// ---------------------------------------------------------------------------------------------
function C(n, k) {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) r = (r * BigInt(n - i)) / BigInt(i + 1);
  return r;
}
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
// value as exact fraction num/den of the multiplier unit (RTP as a ratio, not percent)
function percent(num, den, dp) {
  const s = 10n ** BigInt(dp);
  const x = num * 100n * s;
  let q = x / den;
  if ((x % den) * 2n >= den) q += 1n; // round half up
  const str = q.toString().padStart(dp + 1, '0');
  return str.slice(0, -dp) + '.' + str.slice(-dp);
}
function exactPercent(num, den) { // only for terminating fractions
  let d = den, k = 0;
  while (d % 2n === 0n) { d /= 2n; k++; }
  while (d % 5n === 0n) { d /= 5n; k++; }
  if (d !== 1n) return null;
  return percent(num, den, k + 2).replace(/0+$/, '').replace(/\.$/, '');
}
const theo = { method: {}, plinko: [], keno: [], summary: {} };
theo.method.plinko = 'RTP = sum over k of C(n,k) x m[k] / 2^n, n = rows, m = coefficient array (index = number of right steps), each step right with probability 1/2. Exact rational arithmetic.';
theo.method.keno = 'RTP = sum over h of C(s,h) x C(40-s,10-h) / C(40,10) x m[h], s = numbers picked, h = hits, 10 of 40 drawn uniformly. Exact rational arithmetic.';
theo.method.assumptions = 'Disclosed outcome model only. No payout cap, fee, bonus or promotion applied (none was evidenced; max win per bet displayed no figure). Rounding to 8 decimal places is a per-bet settlement rule and is not applied to the theoretical value.';
for (const risk of ['low', 'medium', 'high']) {
  for (let rows = 8; rows <= 16; rows++) {
    const t = plinkoTables[risk + '/' + rows];
    let num = 0n;
    t.coefficients.forEach((m, k) => { num += C(rows, k) * D(m); });
    let den = (2n ** BigInt(rows)) * ONE;
    const g = gcd(num, den); num /= g; den /= g;
    theo.plinko.push({ setting: 'plinko/' + RISK_P[risk] + '/' + rows, risk: RISK_P[risk], rows, coefficients: t.coefficients,
      table_ref: t.ref, rtp_fraction: num + '/' + den, rtp_percent_exact: exactPercent(num, den), rtp_percent_6dp: percent(num, den, 6),
      house_edge_percent_6dp: percent(den - num, den, 6) });
  }
}
const C4010 = C(40, 10);
for (const risk of ['Classic', 'Low', 'Medium', 'High']) {
  for (let s = 1; s <= 10; s++) {
    const t = kenoTables[risk + '/' + s];
    if (t.multipliers.length !== s + 1) throw new Error('keno table length ' + risk + s);
    let num = 0n;
    t.multipliers.forEach((m, h) => { num += C(s, h) * C(40 - s, 10 - h) * D(m); });
    let den = C4010 * ONE;
    const g = gcd(num, den); num /= g; den /= g;
    theo.keno.push({ setting: 'keno/' + risk + '/' + s, risk, picks: s, multipliers: t.multipliers, table_ref: t.ref,
      rtp_fraction: num + '/' + den, rtp_percent_6dp: percent(num, den, 6), house_edge_percent_6dp: percent(den - num, den, 6) });
  }
}
function range(list) {
  const v = list.map((x) => x.rtp_percent_6dp).sort((a, b) => Number(a) - Number(b));
  return { tables: list.length, min_percent_6dp: v[0], max_percent_6dp: v[v.length - 1],
    tables_at_or_above_99_percent: list.filter((x) => Number(x.rtp_percent_6dp) >= 99).length };
}
theo.summary.plinko = range(theo.plinko);
theo.summary.keno = range(theo.keno);
// Worked examples
const kc1 = kenoTables['Classic/1'].multipliers, kl1 = kenoTables['Low/1'].multipliers;
theo.summary.examples = {
  keno_classic_1_pick: { probabilities: { miss: '30/40', hit: '10/40' }, multipliers: { miss: kc1[0], hit: kc1[1] },
    rtp_percent: theo.keno.find((x) => x.setting === 'keno/Classic/1').rtp_percent_6dp,
    hit_multiplier_for_99_percent_with_zero_on_miss: S((D('0.99') * 4n)) },
  keno_low_1_pick: { multipliers: { miss: kl1[0], hit: kl1[1] }, rtp_percent: theo.keno.find((x) => x.setting === 'keno/Low/1').rtp_percent_6dp },
  plinko_low_8_rows: { coefficients: plinkoTables['low/8'].coefficients, rtp_percent_exact: theo.plinko.find((x) => x.setting === 'plinko/Low/8').rtp_percent_exact },
  plinko_medium_8_rows: { coefficients: plinkoTables['medium/8'].coefficients, rtp_percent_exact: theo.plinko.find((x) => x.setting === 'plinko/Medium/8').rtp_percent_exact },
};

// ---------------------------------------------------------------------------------------------
// Rounds from raw events
// ---------------------------------------------------------------------------------------------
const exceptions = [];
const pfObs = []; // seed-state observations

function parsePlinkoEvents(file) {
  const ev = ndjson(file);
  const sent = [];
  const rounds = [];
  for (const e of ev) {
    const s = strip(e.s);
    if (e.dir === 'sent' && s.startsWith('64,')) sent.push(e);
    else if (e.dir === 'recv' && s.startsWith('65,')) {
      const f = s.split(',');
      const bet = sent.shift();
      if (!bet) throw new Error('65 without 64 at ' + e._ref);
      const b = strip(bet.s).split(',');
      rounds.push({ game: 'plinko', round_id: f[6], round_id_kind: 'bet uuid (message 65 field 7)', time_utc: e.t,
        time_source: 'capture arrival time of message 65 in the game tab (browser clock)',
        event_refs: [bet._ref, e._ref], raw_sent: strip(bet.s), raw_result: s,
        risk_raw: f[7], rows: Number(f[8]), stake: f[5], path: f[1].split(';').join(''), balance_after: f[2], gross_payout: f[3],
        reported_multiplier: f[4], sent_risk: b[1], sent_rows: Number(b[2]), sent_amount: b[3] });
    } else if (e.dir === 'recv' && s.startsWith('119,')) {
      pfObs.push({ game: 'plinko', time_utc: e.t, ref: e._ref, raw: s });
    } else if (e.dir === 'recv' && s.startsWith('90,')) {
      const i = ev.indexOf(e);
      const prev = ev.slice(0, i).reverse().find((x) => x.dir === 'sent');
      const next = ev[i + 1];
      exceptions.push({ check: 'unexplained_server_message', game: 'plinko', round_id: null, observed: s,
        context: { previous_sent: prev ? { ref: prev._ref, raw: strip(prev.s) } : null, next_event: next ? { ref: next._ref, dir: next.dir, raw: strip(next.s) } : null },
        status: 'unresolved', reason: 'message type 90 is not documented in any file of this package; no paid round sits between the previous and next recorded round of this message', source_refs: [e._ref] });
    }
  }
  if (sent.length) throw new Error('64 without 65 in ' + file);
  return rounds;
}
function parseKenoEvents(file) {
  const ev = ndjson(file);
  const sent = [];
  const rounds = [];
  for (const e of ev) {
    const s = strip(e.s);
    if (e.dir === 'prebet-panel') { pfObs.push({ game: 'keno', time_utc: e.t, ref: e._ref, raw: s, kind: 'panel' }); continue; }
    if (!s.startsWith('{')) continue;
    const j = JSON.parse(s);
    if (e.dir === 'sent' && j.service === 'bet') sent.push(e);
    else if (e.dir === 'recv' && j.service === 'bet') {
      const bet = sent.shift();
      if (!bet) throw new Error('reply without bet at ' + e._ref);
      const bj = JSON.parse(strip(bet.s)).data;
      const d = j.data;
      const num = (k) => { const m = s.match(new RegExp('"' + k + '":([-0-9.eE+]+)')); return m[1]; };
      rounds.push({ game: 'keno', round_id: d.round_id, round_id_kind: 'round_id (bet reply)', time_utc: e.t,
        time_source: 'capture arrival time of the bet reply in the game tab (browser clock)',
        event_refs: [bet._ref, e._ref], raw_sent: strip(bet.s), raw_result: s,
        risk_raw: d.risk, selected: d.selected, drawn: d.numbers, win_numbers: d.win_numbers, currency: d.currency,
        stake: num('bet_amount'), gross_payout: num('win_amount'), reported_multiplier: num('win_mult'), balance_after: num('balance'),
        sent_risk: bj.risk, sent_selected: bj.selected, sent_amount: bj.amount, bet_amount_type: d.bet_amount_type });
    } else if (e.dir === 'recv' && j.code !== undefined) {
      const i = ev.indexOf(e);
      exceptions.push({ check: 'connection_event', game: 'keno', round_id: null, observed: s,
        context: { next_event: ev[i + 1] ? { ref: ev[i + 1]._ref, dir: ev[i + 1].dir } : null, unanswered_bets_at_this_point: sent.length },
        status: 'no round affected', reason: 'server closed the connection (code ' + j.code + ') after the last recorded bet reply; every bet sent on this connection has a reply',
        source_refs: [e._ref] });
    }
  }
  if (sent.length) throw new Error('bet without reply in ' + file);
  return rounds;
}

const pMain = parsePlinkoEvents(F.plinkoMain);
const pSet2 = parsePlinkoEvents(F.plinkoSet2);
const kMain = parseKenoEvents(F.kenoMain);
const kSet2 = parseKenoEvents(F.kenoSet2);

// Bet-button rounds (transcribed)
const pBtn = dataLines(F.plinkoButton).map(({ l, line }) => {
  const f = l.split(',');
  return { game: 'plinko', round_id: f[6], round_id_kind: 'first 8 hex digits of the bet uuid (transcription)', time_utc: DATE + 'T' + f[0] + 'Z',
    time_source: 'capture time in the game tab, transcribed (time of day only; date 24 Nov 2026 UTC)',
    event_refs: [F.plinkoButton + ':' + line], raw_result: l, risk_raw: f[7], rows: Number(f[8]), stake: f[5], path: f[1], balance_after: f[2],
    gross_payout: f[3], reported_multiplier: f[4], placed_with: 'Bet button' };
});
const DIG = '0123456789abcdefghijklmnopqrstuvwxyzABCDE';
const kBtn = dataLines(F.kenoButton).map(({ l, line }) => {
  const f = l.split(',');
  const picks = Number(f[3]);
  return { game: 'keno', round_id: f[10], round_id_kind: 'round_id (transcription)', time_utc: DATE + 'T' + f[1] + 'Z',
    time_source: 'capture time in the game tab, transcribed (time of day only; date 24 Nov 2026 UTC)',
    event_refs: [F.kenoButton + ':' + line], raw_result: l, risk_raw: { d: 'default', l: 'low', m: 'mid', h: 'high' }[f[2]],
    selected: Array.from({ length: picks }, (_, i) => i + 1), drawn: f[4].split('').map((c) => DIG.indexOf(c)), win_numbers_count: Number(f[5]),
    reported_multiplier: f[6], gross_payout: f[7], stake: f[8], balance_after: f[9], currency: null, placed_with: 'Bet button' };
});

// ---------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------
const pRev = dataLines(F.plinkoReveals).map(({ l, line }) => ({ f: l.split(','), ref: F.plinkoReveals + ':' + line }));
const kRev = dataLines(F.kenoReveals).map(({ l, line }) => ({ d: JSON.parse(l).data, ref: F.kenoReveals + ':' + line }));
const pObsParsed = pfObs.filter((o) => o.game === 'plinko').map((o) => {
  const f = o.raw.split(',');
  return { time_utc: o.time_utc, ref: o.ref, hash: f[1], client: f[2], nonce: Number(f[3]), revealed: f[4] || null, next_hash: f[8] };
}).sort((a, b) => a.time_utc.localeCompare(b.time_utc));
function firstObs(hash) { // first raw observation of a hash, as active or as next hash
  const o = pObsParsed.find((x) => x.hash === hash || x.next_hash === hash);
  return o ? { time_utc: o.time_utc, ref: o.ref, as: o.hash === hash ? 'active hash' : 'next hash', nonce_shown: o.hash === hash ? o.nonce : null } : null;
}
const seeds = [];
function seedRec(o) { seeds.push(o); return o; }
// Plinko pair A: revealed in line 1, raw message also in the events log
const pa = pRev[0].f, pb = pRev[1].f;
const rawRevealA = pObsParsed.find((x) => x.revealed === pa[4]);
const seedPA = seedRec({ seed_id: 'plinko-A', game: 'plinko', client_seed: pa[6], server_seed_hash: pa[5], revealed_server_seed: pa[4],
  hash_first_observed: firstObs(pa[5]), revealed: { time_utc: rawRevealA ? rawRevealA.time_utc : null, refs: [pRev[0].ref].concat(rawRevealA ? [rawRevealA.ref] : []) },
  nonce_before_first_recorded_round: null, total_counters_at_reveal: Number(pa[7]), next_hash_at_reveal: pa[1] });
const seedPB = seedRec({ seed_id: 'plinko-B', game: 'plinko', client_seed: pb[6], server_seed_hash: pb[5], revealed_server_seed: pb[4],
  hash_first_observed: firstObs(pb[5]), revealed: { time_utc: null, time_note: 'about 23:51 UTC (transcription)', refs: [pRev[1].ref] },
  nonce_before_first_recorded_round: null, total_counters_at_reveal: Number(pb[7]), next_hash_at_reveal: pb[1] });
{
  // nonce shown just before the first round of each pair (raw 119 observations)
  const a = pObsParsed.filter((x) => x.hash === seedPA.server_seed_hash && x.time_utc < pMain[0].time_utc).pop();
  seedPA.nonce_before_first_recorded_round = { value: a.nonce, ref: a.ref, time_utc: a.time_utc };
  const b = pObsParsed.filter((x) => x.hash === seedPB.server_seed_hash && x.time_utc < pSet2[0].time_utc).pop();
  seedPB.nonce_before_first_recorded_round = { value: b.nonce, ref: b.ref, time_utc: b.time_utc };
}
const panel = pfObs.find((o) => o.kind === 'panel');
const panelD = JSON.parse(panel.raw);
const k0 = kRev[0].d, k1 = kRev[1].d, k2 = kRev[2].d;
const seedK1 = seedRec({ seed_id: 'keno-A', game: 'keno', client_seed: k0.previous_client_seed, server_seed_hash: k0.previous_server_seed_hash,
  revealed_server_seed: k0.previous_server_seed, hash_first_observed: { time_utc: null, ref: kRev[0].ref, as: 'previous_server_seed_hash in the reveal reply, after the rounds',
    note: 'not recorded before the rounds' },
  revealed: { time_utc: null, time_note: 'about 22:50 UTC (transcription)', refs: [kRev[0].ref] },
  nonce_before_first_recorded_round: { value: null, note: 'not recorded; base inferred as total counters at reveal minus 40 per recorded round' },
  total_counters_at_reveal: k0.previous_nonce, next_hash_at_reveal: k0.next_server_seed_hash });
const seedK2 = seedRec({ seed_id: 'keno-B', game: 'keno', client_seed: k1.previous_client_seed, server_seed_hash: k1.previous_server_seed_hash,
  revealed_server_seed: k1.previous_server_seed, hash_first_observed: { time_utc: null, time_note: 'about 22:50 UTC (transcription)', ref: kRev[0].ref, as: 'active hash (server_seed_hash) in the reveal reply of keno-A, nonce ' + k0.nonce },
  hash_observed_before_first_bet: { time_utc: panel.time_utc, ref: panel.ref, hash: panelD.active_server_seed_hash, nonce_shown: Number(panelD.nonce) },
  revealed: { time_utc: null, time_note: 'about 23:47 UTC (transcription)', refs: [kRev[1].ref] },
  nonce_before_first_recorded_round: { value: Number(panelD.nonce), ref: panel.ref, time_utc: panel.time_utc },
  total_counters_at_reveal: k1.previous_nonce, next_hash_at_reveal: k1.next_server_seed_hash });
const seedK3 = seedRec({ seed_id: 'keno-C', game: 'keno', client_seed: k2.previous_client_seed, server_seed_hash: k2.previous_server_seed_hash,
  revealed_server_seed: k2.previous_server_seed, hash_first_observed: { time_utc: null, time_note: 'about 23:47 UTC (transcription)', ref: kRev[1].ref, as: 'active hash (server_seed_hash) in the reveal reply of keno-B, nonce ' + k1.nonce },
  revealed: { time_utc: null, time_note: 'about 23:54 UTC (transcription)', refs: [kRev[2].ref] },
  nonce_before_first_recorded_round: { value: k1.nonce, ref: kRev[1].ref },
  total_counters_at_reveal: k2.previous_nonce, next_hash_at_reveal: k2.next_server_seed_hash });
// chain: each reveal's new active hash equals the next pair's hash
const chainChecks = [
  ['plinko-A next -> plinko-B', pa[1] === seedPB.server_seed_hash],
  ['keno-A active after reveal -> keno-B', k0.server_seed_hash === seedK2.server_seed_hash],
  ['keno-B active after reveal -> keno-C', k1.server_seed_hash === seedK3.server_seed_hash],
  ['keno-B panel hash before first bet', panelD.active_server_seed_hash === seedK2.server_seed_hash],
];

// ---------------------------------------------------------------------------------------------
// Sessions and round normalisation
// ---------------------------------------------------------------------------------------------
const SESS = [
  { session_id: 'P1', game: 'plinko', label: 'Plinko main run', rounds: pMain, seed: seedPA, events: [F.plinkoMain], placed_with: 'script in the game tab sending the game\'s own bet message' },
  { session_id: 'K1', game: 'keno', label: 'Keno main run', rounds: kMain, seed: seedK1, events: [F.kenoMain], placed_with: 'script in the game tab sending the game\'s own bet message' },
  { session_id: 'K2', game: 'keno', label: 'Keno second set', rounds: kSet2, seed: seedK2, events: [F.kenoSet2], placed_with: 'script in the game tab sending the game\'s own bet message' },
  { session_id: 'P2', game: 'plinko', label: 'Plinko second set', rounds: pSet2, seed: seedPB, events: [F.plinkoSet2], placed_with: 'script in the game tab sending the game\'s own bet message' },
  { session_id: 'P3', game: 'plinko', label: 'Plinko Bet-button rounds', rounds: pBtn, seed: seedPB, events: [F.plinkoButton], placed_with: 'the game\'s Bet button' },
  { session_id: 'K3', game: 'keno', label: 'Keno Bet-button rounds', rounds: kBtn, seed: seedK3, events: [F.kenoButton], placed_with: 'the game\'s Bet button' },
];

// counters per seed pair, in time order of the rounds on that pair
const counterState = new Map();
const kenoK1Rounds = kMain.length;
counterState.set('plinko-A', seedPA.nonce_before_first_recorded_round.value);
counterState.set('plinko-B', seedPB.nonce_before_first_recorded_round.value);
counterState.set('keno-A', seedK1.total_counters_at_reveal - 40 * kenoK1Rounds);
counterState.set('keno-B', seedK2.nonce_before_first_recorded_round.value);
counterState.set('keno-C', seedK3.nonce_before_first_recorded_round.value);
const counterBase = new Map(counterState);

const rounds = [];
for (const s of SESS) {
  s.rounds.sort((a, b) => a.time_utc.localeCompare(b.time_utc));
  s.rounds.forEach((r, i) => {
    const used = r.game === 'plinko' ? r.rows : 40;
    const from = counterState.get(s.seed.seed_id) + 1;
    counterState.set(s.seed.seed_id, from + used - 1);
    const setting = r.game === 'plinko' ? 'plinko/' + RISK_P[r.risk_raw] + '/' + r.rows : 'keno/' + RISK_K[r.risk_raw] + '/' + r.selected.length;
    const n = { round_id: r.round_id, round_id_kind: r.round_id_kind, game: r.game, session_id: s.session_id, index_in_session: i,
      setting, configuration_ref: r.game === 'plinko' ? 'plinko-tables-2026-11-24' : 'keno-tables-2026-11-24',
      seed_ref: s.seed.seed_id, counter_interval: [from, from + used - 1], time_utc: r.time_utc, time_source: r.time_source,
      event_refs: r.event_refs, source_kind: r.event_refs[0].startsWith('raw/events/') ? 'raw server messages' : 'transcription',
      placed_with: r.placed_with || s.placed_with, currency: r.currency || 'USDT',
      currency_source: r.currency ? 'bet reply field currency' : 'FortuneJack wallet session currency (no currency field in this record)',
      stake: r.stake, reported_multiplier: r.reported_multiplier, gross_payout: r.gross_payout, balance_after: r.balance_after,
      terminal_status: 'settled', wallet_ref: null };
    if (r.game === 'plinko') {
      Object.assign(n, { risk_raw: r.risk_raw, risk: RISK_P[r.risk_raw], rows: r.rows, coefficient_array_ref: setting,
        path: r.path, path_convention: 'one character per row from the top, 1 = right; landing slot = number of 1s, coefficient index from the left',
        landing_slot: r.path.split('').filter((c) => c === '1').length });
      if (r.sent_risk !== undefined) n.sent_bet = { risk: r.sent_risk, rows: r.sent_rows, amount: r.sent_amount };
    } else {
      Object.assign(n, { risk_raw: r.risk_raw, risk: RISK_K[r.risk_raw], selected: r.selected, picks: r.selected.length, drawn: r.drawn,
        drawn_order: 'as sent by the server', server_win_numbers: r.win_numbers === undefined ? null : r.win_numbers,
        server_hits: r.win_numbers === undefined ? r.win_numbers_count : r.win_numbers.length, payout_row_ref: setting });
      if (r.sent_risk !== undefined) n.sent_bet = { risk: r.sent_risk, selected: r.sent_selected, amount: r.sent_amount };
    }
    rounds.push(n);
  });
}
rounds.sort((a, b) => a.time_utc.localeCompare(b.time_utc) || a.round_id.localeCompare(b.round_id));

// ---------------------------------------------------------------------------------------------
// Wallet sessions
// ---------------------------------------------------------------------------------------------
const wallet = dataLines(F.wallet).map(({ l, line }) => {
  const m = l.match(/^(\w+)\s+(\d\d:\d\d)-(\d\d:\d\d)\s+won ([0-9.]+) USDT\s+bet -([0-9.]+) USDT\s+= (.*)$/);
  const toUtc = (hm) => DATE + 'T' + hm; // the transcription lists session times in UTC
  return { ref: F.wallet + ':' + line, game: m[1].toLowerCase(), window_utc: m[2] + '-' + m[3], from_utc: toUtc(m[2]) + ':00Z', to_utc: toUtc(m[3]) + ':59.999Z',
    won: m[4], bet: m[5], label: m[6] };
});

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------
const seedById = Object.fromEntries(seeds.map((s) => [s.seed_id, s]));
const replay = [];
const settle = [];
const rec = (arr, o) => { arr.push(o); return o.status; };

// commitment checks per seed pair
for (const s of seeds) {
  const h = sha256(Buffer.from(s.revealed_server_seed, 'utf8'));
  s.commitment_check = { sha256_of_revealed_seed: h, matches_hash: h === s.server_seed_hash };
  const pre = s.seed_id === 'keno-A' ? false : true;
  s.commitment_timing = pre ? 'hash observed before the first recorded round on this pair' : 'hash obtained only after the rounds (no pre-bet record)';
  s.counter_base = counterBase.get(s.seed_id);
  s.counters_consumed_by_recorded_rounds = counterState.get(s.seed_id) - counterBase.get(s.seed_id);
  s.counter_interval = [counterBase.get(s.seed_id) + 1, counterState.get(s.seed_id)];
  s.counter_end_equals_reveal = counterState.get(s.seed_id) === s.total_counters_at_reveal;
  s.mapping_evidence = s.game === 'plinko'
    ? 'one counter per row; counters run from the nonce shown before the first round + 1; the last counter equals the total in the reveal reply; every path replays'
    : '40 counters per round; ' + (s.seed_id === 'keno-A' ? 'base = total in the reveal reply minus 40 x recorded rounds (the 5 earlier test rounds on this pair explain a base of 200)' : 'counters run from the nonce shown before the first round + 1') + '; the last counter equals the total in the reveal reply; every draw replays';
  s.rounds = rounds.filter((r) => r.seed_ref === s.seed_id).length;
  rec(replay, { check: 'seed_commitment', seed_id: s.seed_id, round_id: null, expected: s.server_seed_hash, observed: h,
    status: h === s.server_seed_hash ? 'matched' : 'mismatched', reason: 'sha256(revealed server seed as UTF-8 text) vs committed hash; ' + s.commitment_timing,
    source_refs: [].concat(s.revealed.refs) });
  rec(replay, { check: 'counter_total', seed_id: s.seed_id, round_id: null, expected: String(s.total_counters_at_reveal), observed: String(counterState.get(s.seed_id)),
    status: s.counter_end_equals_reveal ? 'matched' : 'mismatched', reason: 'counter base ' + s.counter_base + ' + counters consumed by ' + s.rounds + ' recorded rounds vs total in the reveal reply',
    source_refs: [].concat(s.revealed.refs) });
}
for (const [name, ok] of chainChecks) rec(replay, { check: 'seed_chain', seed_id: null, round_id: null, expected: name, observed: ok ? 'equal' : 'different', status: ok ? 'matched' : 'mismatched', reason: 'hash handed over at a seed change', source_refs: [F.plinkoReveals, F.kenoReveals, panel.ref] });
// Plinko intermediate nonce observations on pair A
for (const o of pObsParsed.filter((x) => x.hash === seedPA.server_seed_hash && !x.revealed)) {
  const before = rounds.filter((r) => r.seed_ref === 'plinko-A' && r.time_utc < o.time_utc).reduce((a, r) => a + r.rows, 0);
  const exp = seedPA.nonce_before_first_recorded_round.value + before;
  if (o.time_utc < seedPA.nonce_before_first_recorded_round.time_utc) continue;
  rec(replay, { check: 'nonce_progress', seed_id: 'plinko-A', round_id: null, expected: String(exp), observed: String(o.nonce),
    status: exp === o.nonce ? 'matched' : 'mismatched', reason: 'nonce in message 119 vs counter base + rows of the recorded rounds before it', source_refs: [o.ref] });
}

// per round
for (const r of rounds) {
  const s = seedById[r.seed_ref];
  if (r.game === 'plinko') {
    const ok = /^[01]+$/.test(r.path) && r.path.length === r.rows;
    rec(replay, { check: 'plinko_path_shape', seed_id: s.seed_id, round_id: r.round_id, expected: r.rows + ' binary steps', observed: r.path.length + (ok ? ' binary steps' : ' invalid'),
      status: ok ? 'matched' : 'mismatched', reason: 'path length and directions', source_refs: r.event_refs });
    const p = plinkoPath(s.revealed_server_seed, s.client_seed, r.counter_interval[0], r.rows);
    r.replayed_path = p;
    r.replayed_slot = p.split('').filter((c) => c === '1').length;
    rec(replay, { check: 'outcome_replay', seed_id: s.seed_id, round_id: r.round_id, counters: r.counter_interval, expected: p, observed: r.path,
      status: p === r.path ? 'matched' : 'mismatched', reason: 'full path replayed from the revealed seed', source_refs: r.event_refs });
    const coeffs = plinkoTables[r.risk_raw + '/' + r.rows].coefficients;
    const em = coeffs[r.replayed_slot];
    rec(settle, { check: 'multiplier', round_id: r.round_id, setting: r.setting, expected: em, observed: r.reported_multiplier,
      status: D(em) === D(r.reported_multiplier) ? 'matched' : 'mismatched', reason: 'table coefficient at the replayed slot ' + r.replayed_slot, source_refs: r.event_refs.concat([plinkoTables[r.risk_raw + '/' + r.rows].ref]) });
    const eg = trunc8(mul(D(r.stake), D(em)));
    rec(settle, { check: 'gross_payout', round_id: r.round_id, setting: r.setting, expected: S(eg), observed: r.gross_payout,
      status: eg === D(r.gross_payout) ? 'matched' : 'mismatched', reason: 'stake ' + r.stake + ' x ' + em, source_refs: r.event_refs });
    if (r.sent_bet) {
      const ok2 = r.sent_bet.risk === r.risk_raw && r.sent_bet.rows === r.rows && D(r.sent_bet.amount) === D(r.stake);
      rec(settle, { check: 'bet_matches_result', round_id: r.round_id, setting: r.setting, expected: r.sent_bet.risk + ',' + r.sent_bet.rows + ',' + r.sent_bet.amount,
        observed: r.risk_raw + ',' + r.rows + ',' + r.stake, status: ok2 ? 'matched' : 'mismatched', reason: 'settings and amount sent vs settings and stake in the result', source_refs: r.event_refs });
    }
  } else {
    const d = r.drawn;
    const shapeOk = d.length === 10 && new Set(d).size === 10 && d.every((x) => Number.isInteger(x) && x >= 1 && x <= 40)
      && new Set(r.selected).size === r.selected.length && r.selected.length >= 1 && r.selected.length <= 10;
    rec(replay, { check: 'keno_draw_shape', seed_id: s.seed_id, round_id: r.round_id, expected: '10 distinct numbers in 1..40; 1..10 distinct picks',
      observed: d.length + ' drawn, ' + new Set(d).size + ' distinct, ' + r.selected.length + ' picks', status: shapeOk ? 'matched' : 'mismatched', reason: 'bounds, uniqueness, length', source_refs: r.event_refs });
    const draw = kenoDraw(s.revealed_server_seed, s.client_seed, r.counter_interval[0]);
    r.replayed_draw = draw;
    rec(replay, { check: 'outcome_replay', seed_id: s.seed_id, round_id: r.round_id, counters: r.counter_interval, expected: draw.join(','), observed: d.join(','),
      status: draw.join(',') === d.join(',') ? 'matched' : 'mismatched', reason: 'all ten drawn numbers replayed in order from the revealed seed', source_refs: r.event_refs });
    const hits = r.selected.filter((x) => draw.includes(x)).length;
    r.computed_hits = hits;
    rec(settle, { check: 'hit_count', round_id: r.round_id, setting: r.setting, expected: String(hits), observed: String(r.server_hits),
      status: hits === r.server_hits ? 'matched' : 'mismatched', reason: 'size of intersection(selected, replayed draw) vs the server\'s win numbers', source_refs: r.event_refs });
    const t = kenoTables[RISK_K[r.risk_raw] + '/' + r.picks];
    const em = t.multipliers[hits];
    rec(settle, { check: 'multiplier', round_id: r.round_id, setting: r.setting, expected: em, observed: r.reported_multiplier,
      status: D(em) === D(r.reported_multiplier) ? 'matched' : 'mismatched', reason: 'payout row at ' + hits + ' hits', source_refs: r.event_refs.concat([t.ref]) });
    const eg = trunc8(mul(D(r.stake), D(em)));
    const st = eg === D(r.gross_payout) ? 'matched' : 'mismatched';
    rec(settle, { check: 'gross_payout', round_id: r.round_id, setting: r.setting, expected: S(eg), observed: r.gross_payout, status: st,
      reason: 'stake ' + r.stake + ' x ' + em + ', exact decimal, 8 decimal places kept (game rule: further digits ignored)' + (st === 'mismatched' ? '; difference ' + S(D(r.gross_payout) - eg) + '; cause not established' : ''),
      source_refs: r.event_refs });
    if (st === 'mismatched') exceptions.push({ check: 'gross_payout', game: 'keno', round_id: r.round_id, session_id: r.session_id, index_in_session: r.index_in_session,
      expected: S(eg), observed: r.gross_payout, difference: S(D(r.gross_payout) - eg), status: 'unresolved',
      reason: 'credited amount differs from stake x table multiplier under exact decimal arithmetic; the cause is not established from the files in this package',
      source_refs: r.event_refs });
    if (r.sent_bet) {
      const ok2 = r.sent_bet.risk === r.risk_raw && r.sent_bet.selected.join(',') === r.selected.join(',') && D(r.sent_bet.amount) === D(r.stake);
      rec(settle, { check: 'bet_matches_result', round_id: r.round_id, setting: r.setting, expected: r.sent_bet.risk + ' [' + r.sent_bet.selected.join(',') + '] ' + r.sent_bet.amount,
        observed: r.risk_raw + ' [' + r.selected.join(',') + '] ' + r.stake, status: ok2 ? 'matched' : 'mismatched', reason: 'settings and amount sent vs the reply', source_refs: r.event_refs });
    }
  }
}
// balance chain across all recorded rounds of both games, in time order
let prev = null;
for (const r of rounds) {
  if (!prev) {
    rec(settle, { check: 'balance_move', round_id: r.round_id, setting: r.setting, expected: null, observed: r.balance_after, status: 'unverifiable',
      reason: 'first recorded round: no earlier balance recorded; opening balance derived as ' + S(D(r.balance_after) + D(r.stake) - D(r.gross_payout)), source_refs: r.event_refs });
  } else {
    const exp = D(prev.balance_after) - D(r.stake) + D(r.gross_payout);
    rec(settle, { check: 'balance_move', round_id: r.round_id, setting: r.setting, expected: S(exp), observed: r.balance_after,
      status: exp === D(r.balance_after) ? 'matched' : 'mismatched', reason: 'previous recorded balance (' + prev.game + ' ' + prev.round_id + ') - stake + reported gross payout', source_refs: r.event_refs });
  }
  prev = r;
}
// wallet session totals
const walletSessions = [];
for (const w of wallet) {
  const rs = rounds.filter((r) => r.game === w.game && r.time_utc >= w.from_utc && r.time_utc <= w.to_utc);
  const sid = [...new Set(rs.map((r) => r.session_id))];
  if (!rs.length) {
    const ws = { wallet_ref: w.ref, game: w.game, window_utc: w.window_utc, won: w.won, bet: w.bet, label: w.label, session_ids: [], recorded_rounds: 0, status: 'unverifiable' };
    walletSessions.push(ws);
    rec(settle, { check: 'wallet_session_totals', round_id: null, session_id: null, expected: null, observed: 'won ' + w.won + ' / bet ' + w.bet, status: 'unverifiable',
      reason: 'no recorded rounds in this wallet session (test rounds placed before recording started); totals only', source_refs: [w.ref] });
    exceptions.push({ check: 'unrecorded_rounds', game: w.game, round_id: null, observed: 'wallet session ' + w.window_utc + ' UTC: won ' + w.won + ' / bet ' + w.bet,
      status: 'unverifiable', reason: 'test rounds placed before recording started; outcomes not recorded, so they cannot be replayed; wallet totals only', source_refs: [w.ref] });
    continue;
  }
  const won = rs.reduce((a, r) => a + D(r.gross_payout), 0n), bet = rs.reduce((a, r) => a + D(r.stake), 0n);
  const ok = won === D(w.won) && bet === D(w.bet);
  for (const r of rs) r.wallet_ref = w.ref;
  walletSessions.push({ wallet_ref: w.ref, game: w.game, window_utc: w.window_utc, won: w.won, bet: w.bet, label: w.label, session_ids: sid, recorded_rounds: rs.length,
    recorded_won: S(won), recorded_bet: S(bet), status: ok ? 'matched' : 'mismatched' });
  rec(settle, { check: 'wallet_session_totals', round_id: null, session_id: sid.join(','), expected: 'won ' + S(won) + ' / bet ' + S(bet) + ' (' + rs.length + ' recorded rounds)',
    observed: 'won ' + w.won + ' / bet ' + w.bet, status: ok ? 'matched' : 'mismatched', reason: 'FortuneJack wallet per-session totals vs the sum of the recorded rounds in that session window', source_refs: [w.ref] });
}

// ---------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------
const st = (arr, check, id) => arr.filter((x) => x.check === check && x.round_id === id).map((x) => x.status);
const walletOk = new Set(walletSessions.filter((w) => w.status === 'matched').map((w) => w.wallet_ref));
function cov(setting, game, slotsN) {
  const rs = rounds.filter((r) => r.setting === setting);
  const seen = [...new Set(rs.map((r) => (game === 'plinko' ? r.replayed_slot : r.computed_hits)))].sort((a, b) => a - b);
  const o = { setting, configuration_available: true, recorded_rounds: rs.length,
    replayable_rounds: rs.filter((r) => seedById[r.seed_ref].commitment_check.matches_hash).length,
    replay_matched: rs.filter((r) => st(replay, 'outcome_replay', r.round_id).every((x) => x === 'matched')).length,
    commitment_recorded_before_round: rs.filter((r) => seedById[r.seed_ref].commitment_timing.startsWith('hash observed before')).length,
    commitment_after_rounds_only: rs.filter((r) => !seedById[r.seed_ref].commitment_timing.startsWith('hash observed before')).length,
    settlement_matched: rs.filter((r) => ['multiplier', 'gross_payout'].every((c) => st(settle, c, r.round_id).every((x) => x === 'matched'))).length,
    balance_move_matched: rs.filter((r) => st(settle, 'balance_move', r.round_id)[0] === 'matched').length,
    in_wallet_session_with_matching_totals: rs.filter((r) => walletOk.has(r.wallet_ref)).length,
    mismatches: rs.filter((r) => replay.concat(settle).some((x) => x.round_id === r.round_id && x.status === 'mismatched')).length,
    unverifiable: rs.filter((r) => replay.concat(settle).some((x) => x.round_id === r.round_id && x.status === 'unverifiable')).length };
  if (game === 'plinko') {
    o.slots_in_table = slotsN; o.observed_slots = seen; o.observed_slot_count = seen.length;
  } else {
    o.payout_classes_in_table = slotsN; o.observed_hit_counts = seen;
    o.observed_paid_classes = seen.filter((h) => D(kenoTables[setting.split('/')[1] + '/' + setting.split('/')[2]].multipliers[h]) > 0n);
  }
  return o;
}
const coverage = {
  note: 'Configuration coverage (a table was captured for the setting) is separate from observed payout coverage (which slots or hit counts actually occurred in recorded rounds). All settings sampled does not mean every payout was tested.',
  plinko: theo.plinko.map((t) => cov(t.setting, 'plinko', t.coefficients.length)),
  keno: theo.keno.map((t) => cov(t.setting, 'keno', t.multipliers.length)),
};
function totals(list) {
  const keys = ['recorded_rounds', 'replayable_rounds', 'replay_matched', 'commitment_recorded_before_round', 'commitment_after_rounds_only', 'settlement_matched',
    'balance_move_matched', 'in_wallet_session_with_matching_totals', 'mismatches', 'unverifiable'];
  const o = { settings_with_configuration: list.filter((x) => x.configuration_available).length, settings_with_recorded_rounds: list.filter((x) => x.recorded_rounds > 0).length };
  for (const k of keys) o[k] = list.reduce((a, x) => a + x[k], 0);
  return o;
}
coverage.totals = { plinko: totals(coverage.plinko), keno: totals(coverage.keno) };
coverage.totals.plinko.slots_in_all_tables = coverage.plinko.reduce((a, x) => a + x.slots_in_table, 0);
coverage.totals.plinko.slots_observed = coverage.plinko.reduce((a, x) => a + x.observed_slot_count, 0);
coverage.totals.keno.payout_classes_in_all_tables = coverage.keno.reduce((a, x) => a + x.payout_classes_in_table, 0);
coverage.totals.keno.hit_counts_observed = coverage.keno.reduce((a, x) => a + x.observed_hit_counts.length, 0);
coverage.totals.unrecorded_test_rounds = { wallet_sessions: walletSessions.filter((w) => w.status === 'unverifiable').map((w) => ({ game: w.game, wallet_ref: w.wallet_ref, bet: w.bet, won: w.won })),
  note: 'stakes of 0.1 per round: 5 Plinko and 5 Keno rounds, outcomes not recorded' };
coverage.focused = {
  'keno/Classic/1': (() => { const rs = rounds.filter((r) => r.setting === 'keno/Classic/1'); return { rounds: rs.length, paid_hits: rs.filter((r) => r.computed_hits === 1).length, misses: rs.filter((r) => r.computed_hits === 0).length }; })(),
  'keno/Low/1': (() => { const rs = rounds.filter((r) => r.setting === 'keno/Low/1'); return { rounds: rs.length, hits: rs.filter((r) => r.computed_hits === 1).length, misses_paid_0_7: rs.filter((r) => r.computed_hits === 0).length }; })(),
};

// ---------------------------------------------------------------------------------------------
// Claims, located as exact text in the captured sources
// ---------------------------------------------------------------------------------------------
const BLOG_TXT = 'claims/blog_fortunejack-originals-explore-99-rtp-games-you-can-verify.txt';
const PLINKO_JS = 'raw/client/plinko/assets/index-BvX_ma61.js';
const KENO_JS = 'raw/client/keno/assets/index-CbS1RIor.js';
function locate(claim, file, quote) {
  const text = readText(file);
  const i = text.indexOf(quote);
  return i < 0 ? { claim, source: file, quote, found: false } : { claim, source: file, line: text.slice(0, i).split('\n').length, quote, found: true };
}
function verifierLink(claim, file, gameId) {
  const m = readText(file).match(new RegExp('gameId:"' + gameId.replace('.', '\\.') + '"[\\s\\S]{0,400}?verify:\\{url:"([^"]+)",penId:"([^"]+)"\\}'));
  return m ? { claim, source: file, game_id: gameId, verifier_url: m[1] + '/' + m[2], found: true,
    note: 'set by the game\'s own configuration (gameId ' + gameId + '), which replaces the default verifier link in the shared client code at startup' }
    : { claim, source: file, game_id: gameId, found: false };
}
const PLINKO_VERIFIER = 'raw/verifier/plinko-WbpZpZE.js';
const KENO_VERIFIER = 'raw/verifier/keno-vExexeO.js';
const PEN_META = 'raw/verifier/codepen-metadata-2026-11-27.json';
function verifierTables(claim) {
  const block = readText(PLINKO_VERIFIER).match(/const COEFFS = \{([\s\S]*?)\n\};/);
  let tables = 0, tablesMatched = 0, entries = 0, entriesMatched = 0;
  const mismatched = [];
  if (block) {
    for (const m of block[1].matchAll(/(\d+): \{ low: \[([^\]]*)\], medium: \[([^\]]*)\], high: \[([^\]]*)\] \}/g)) {
      for (const [risk, list] of [['low', m[2]], ['medium', m[3]], ['high', m[4]]]) {
        tables++;
        const v = list.split(',').map((x) => x.trim());
        const t = plinkoTables[risk + '/' + m[1]];
        let ok = !!t && t.coefficients.length === v.length;
        v.forEach((x, i) => { entries++; if (t && t.coefficients[i] !== undefined && D(x) === D(t.coefficients[i])) entriesMatched++; else ok = false; });
        if (ok) tablesMatched++; else mismatched.push(risk + '/' + m[1]);
      }
    }
  }
  return { claim, source: PLINKO_VERIFIER, compared_with: F.plinkoTables, tables_in_verifier: tables, tables_matched: tablesMatched,
    entries_in_verifier: entries, entries_matched: entriesMatched, mismatched, found: tables === 27 && tablesMatched === 27 && entries === 351 && entriesMatched === 351 };
}
function noPayoutTable(claim, file) {
  const js = readText(file);
  const arrays = [...js.matchAll(/\[\s*-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?){3,}\s*\]/g)].length;
  return { claim, source: file, numeric_arrays_of_four_or_more: arrays, found: arrays === 0 && !/COEFF|PAYTABLE|PAYOUT|MULTIPLIER/i.test(js) };
}
function sameConstruction(claim) {
  const both = ['crypto.subtle.importKey("raw", enc.encode(seeds.serverSeed), { name: "HMAC", hash: "SHA-512" }', 'enc.encode(seeds.clientSeed + "-" + n)',
    'Number("0x" + hash.substring(0, 16)) / Number("0xffffffffffffffff")'];
  const plinko = ['slot += nextInt(2, serverSeed, clientSeed, startNonce + i)'];
  const keno = ['const NONCES_PER_ROUND = 40;', 'const j = i + nextInt(balls.length - i, serverSeed, clientSeed, nonce);', 'return balls.slice(0, 10)'];
  const p = readText(PLINKO_VERIFIER), k = readText(KENO_VERIFIER);
  const missing = [];
  for (const s of both) { if (!p.includes(s)) missing.push('plinko: ' + s); if (!k.includes(s)) missing.push('keno: ' + s); }
  for (const s of plinko) if (!p.includes(s)) missing.push('plinko: ' + s);
  for (const s of keno) if (!k.includes(s)) missing.push('keno: ' + s);
  return { claim, sources: [PLINKO_VERIFIER, KENO_VERIFIER], code_checked: { both, plinko, keno }, missing, found: missing.length === 0 };
}
function penDates(claim) {
  const p = JSON.parse(readText(PEN_META)).pens.find((x) => x.id === 'WbpZpZE');
  return { claim, source: PEN_META, created: p ? p.createdAt : null, updated: p ? p.updatedAt : null,
    found: !!p && p.createdAt.startsWith('2026-10-02') && p.updatedAt.startsWith('2026-10-02') };
}
function rulesWithoutReturnFigure(claim, file) {
  const rules = [...readText(file).matchAll(/ruleLine(\d+):"([^"]*)"/g)].map((m) => ({ key: 'ruleLine' + m[1], text: m[2] }));
  const hits = rules.filter((r) => /RTP|return to player|house edge|\d%/i.test(r.text));
  return { claim, source: file, rule_lines: rules.length, rule_lines_with_a_return_figure: hits.map((r) => r.key), found: rules.length > 0 && hits.length === 0 };
}
const claims = {
  note: 'Each entry is located in a captured file of this package: the blog page fetched logged out (text extracted from the saved html), the public game clients fetched logged out, and the verifiers the games link to, saved from CodePen. found = true means the exact text is present or the comparison holds.',
  entries: [
    locate('The FortuneJack blog lists Plinko and Keno among the titles on a 99% theoretical RTP', BLOG_TXT, 'Dice, Mines, Plinko, Crash, Keno, Limbo, Hi-Lo, and Baccarat run on a 99% theoretical RTP.'),
    locate('The blog equates 99% RTP with a 1% house edge', BLOG_TXT, 'A 99% RTP corresponds to a 1% theoretical house edge.'),
    locate('The blog\'s own example: $10,000 in stakes, about $100 kept', BLOG_TXT, '$10,000 in total stakes, the mathematical model retains approximately $100'),
    locate('The Plinko game rules state a 1% house edge (rules text in the public client)', PLINKO_JS, 'Every drop is provably fair and can be verified. House edge: 1%.'),
    rulesWithoutReturnFigure('The Keno game rules state no RTP or house-edge figure (rules text in the public client)', KENO_JS),
    verifierLink('The FortuneJack Plinko game links this public verifier', PLINKO_JS, 'fj.plinko'),
    verifierLink('The FortuneJack Keno game links this public verifier', KENO_JS, 'fj.keno'),
    verifierTables('The Plinko verifier the game links holds the same 27 payout tables as the live game'),
    noPayoutTable('The Keno verifier the game links holds no payout table', KENO_VERIFIER),
    sameConstruction('Both verifiers compute outcomes the way the replay in this package does'),
    penDates('CodePen lists the Plinko verifier as created and last updated on 2 October 2026'),
  ],
};

// ---------------------------------------------------------------------------------------------
// Normalised outputs
// ---------------------------------------------------------------------------------------------
const tableHash =(o) => sha256(Buffer.from(JSON.stringify(o)));
const pTabObj = Object.fromEntries(theo.plinko.map((t) => [t.setting, t.coefficients]));
const kTabObj = Object.fromEntries(theo.keno.map((t) => [t.setting, t.multipliers]));
const configurations = [
  { configuration_id: 'plinko-tables-2026-11-24', game: 'plinko', table_hash_sha256: tableHash(pTabObj), raw_ref: F.plinkoTables,
    raw_kind: 'transcription of the coefficient tables held by the live game state; the inbound configuration message was not preserved',
    read_time_utc: 'about 2026-11-24T21:20Z (from the file header)', sessions: ['P1', 'P2', 'P3'],
    settings_mapping: { risk: 'low/medium/high (server) = Low/Medium/High (interface)', rows: '8..16', index: 'coefficient index = number of right steps' },
    tables: pTabObj, limits: { minimum_stake: 'unknown', maximum_stake: 'unknown', max_win_per_bet: 'rules panel shows no figure' },
    precision: 'unknown (no rounding rule stated in the Plinko rules panel)', promotion_state: 'unknown',
    effective_interval: 'observed from the read time through the last recorded round (23:50:33 UTC); every recorded multiplier equals this table at the replayed slot. Not established before or after that interval.',
    interface_match: 'claims/lobby-plinko-in-fortunejack-2026-11-25.jpg shows the Low / 8 row as 5.5 1.8 1.1 1 0.5 1 1.1 1.8 5.5; claims/plinko-rules-house-edge-1pct-2026-11-24.jpg shows Medium / 8 as 14 3.2 1.2 0.6 0.5 0.6 1.2 3.2 14' },
  { configuration_id: 'keno-tables-2026-11-24', game: 'keno', table_hash_sha256: tableHash(kTabObj), raw_ref: F.kenoTables,
    raw_kind: 'transcription of the multiplier list the live game displays per picked count; the inbound configuration message was not preserved',
    read_time_utc: 'about 2026-11-24T21:35Z (from the file header)', sessions: ['K1', 'K2', 'K3'],
    settings_mapping: { risk: 'default/low/mid/high (server) = Classic/Low/Medium/High (interface); the mapping is corroborated by every recorded multiplier matching the table', picks: '1..10', index: 'multiplier index = hits' },
    tables: kTabObj, limits: { minimum_stake: 'unknown', maximum_stake: 'unknown', max_win_per_bet: 'rules panel shows no figure' },
    precision: 'rules panel: "Amounts are rounded to 8 decimal places. Any further digits are ignored."', promotion_state: 'unknown',
    effective_interval: 'observed from the read time through the last recorded round (23:53:07 UTC). Not established before or after that interval.' },
];
const sessions = SESS.map((s) => {
  const rs = rounds.filter((r) => r.session_id === s.session_id);
  return { session_id: s.session_id, label: s.label, game: s.game, account: 'one FortuneJack account (pseudonym: account-A); identity withheld',
    lobby_url: 'https://fortunejack.com/game/origin.' + s.game, game_frame_url: 'https://prod02.orbitalgaming.com/fj/' + s.game + '/',
    provider_game_id: 'fj.' + s.game + ' (websocket path wss://prod02.orbitalgaming.com/wsbridge/v1/game/fj.' + s.game + ')',
    first_round_utc: rs[0].time_utc, last_round_utc: rs[rs.length - 1].time_utc, rounds: rs.length, currency: 'USDT', money: 'real money (cash wallet debits and credits in the FortuneJack wallet)',
    funding_status: 'unknown beyond the wallet totals', mode_and_reward_status: 'unknown (no bonus, rakeback or promotion field observed; absence of a field is not evidence it is inactive)',
    bets_placed_with: s.placed_with, seed_ref: s.seed.seed_id, source_files: s.events,
    rules_refs: s.game === 'plinko' ? ['claims/plinko-rules-2026-11-24.txt', 'claims/plinko-rules-house-edge-1pct-2026-11-24.jpg'] : ['claims/keno-rules-2026-11-24.txt', 'claims/keno-rules-2026-11-24.jpg'],
    claim_refs: ['claims/blog_fortunejack-originals-explore-99-rtp-games-you-can-verify.html', 'claims/lobby-path-2026-11-25.txt'],
    wallet_ref: rs[0].wallet_ref, client_version: s.game === 'plinko' ? 'raw/client/plinko/assets/index-BvX_ma61.js (fetched 23:54:51 UTC, game version shown: 1.0)' : 'raw/client/keno/assets/index-CbS1RIor.js (fetched 23:54:51 UTC, game version shown: 1.0)' };
});
const normRounds = rounds.map((r) => { const o = Object.assign({}, r); delete o.replayed_path; delete o.replayed_slot; delete o.replayed_draw; delete o.computed_hits; return o; });
const seedsOut = seeds.map((s) => Object.assign({}, s));

// ---------------------------------------------------------------------------------------------
// Emit / compare
// ---------------------------------------------------------------------------------------------
const J = (o) => JSON.stringify(o, null, 2) + '\n';
const NJ = (a) => a.map((o) => JSON.stringify(o)).join('\n') + '\n';
const outputs = {
  'sessions/sessions.json': J({ sessions, wallet_sessions: walletSessions }),
  'normalized/rounds.ndjson': NJ(normRounds),
  'normalized/configurations.json': J(configurations),
  'normalized/seeds.json': J(seedsOut),
  'analysis/replay-results.ndjson': NJ(replay),
  'analysis/settlement-results.ndjson': NJ(settle),
  'analysis/theoretical-rtp.json': J(theo),
  'analysis/coverage.json': J(coverage),
  'analysis/exceptions.ndjson': NJ(exceptions),
  'analysis/claims.json': J(claims),
};

let fail = 0;
const say = (s) => process.stdout.write(s + '\n');
if (WRITE) {
  for (const [p, c] of Object.entries(outputs)) {
    fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, p), c);
  }
  say('wrote ' + Object.keys(outputs).length + ' files');
} else {
  for (const [p, c] of Object.entries(outputs)) {
    const f = path.join(ROOT, p);
    const same = fs.existsSync(f) && Buffer.compare(fs.readFileSync(f), Buffer.from(c)) === 0;
    if (!same) fail++;
    say((same ? 'same    ' : 'DIFFERS ') + p);
  }
  // SHA256SUMS.txt covers every file in the package except itself
  const sums = readText('SHA256SUMS.txt').split('\n').filter(Boolean).map((l) => { const m = l.match(/^([0-9a-f]{64})  (.+)$/); return { h: m[1], p: m[2] }; });
  const listed = new Set(sums.map((x) => x.p));
  let bad = 0;
  for (const x of sums) {
    const f = path.join(ROOT, x.p);
    if (!fs.existsSync(f) || sha256(fs.readFileSync(f)) !== x.h) { bad++; say('HASH    ' + x.p); }
  }
  const all = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else all.push(rel(p));
    }
  })(ROOT);
  const unlisted = all.filter((p) => p !== 'SHA256SUMS.txt' && !listed.has(p));
  for (const p of unlisted) say('UNLISTED ' + p);
  say('SHA256SUMS.txt: ' + (sums.length - bad) + '/' + sums.length + ' files match; ' + unlisted.length + ' files not listed');
  // raw/client/SHA256SUMS.txt (hash list of the client files, as fetched)
  const csums = readText('raw/client/SHA256SUMS.txt').split('\n').filter(Boolean).map((l) => l.split(/\s+/));
  let cbad = 0, cn = 0;
  for (const [h, p] of csums) {
    cn++;
    if (sha256(fs.readFileSync(path.join(ROOT, 'raw/client', p))) !== h) { cbad++; say('HASH    raw/client/' + p); }
  }
  say('raw/client/SHA256SUMS.txt: ' + (cn - cbad) + '/' + cn + ' client files match');
  // manifest inventory: byte-identical files must hash to the private original
  const man = JSON.parse(readText('manifest.json'));
  let mbad = 0, mn = 0;
  for (const it of man.file_inventory) {
    if (!fs.existsSync(path.join(ROOT, it.path))) { mbad++; say('MISSING ' + it.path); continue; }
    const h = sha256(fs.readFileSync(path.join(ROOT, it.path)));
    if (it.treatment.startsWith('byte-identical')) { mn++; if (h !== it.private_original_sha256) { mbad++; say('ORIGINAL ' + it.path); } }
  }
  say('manifest inventory: ' + (mn - (mbad)) + '/' + mn + ' byte-identical files equal their private originals');
  fail += bad + unlisted.length + cbad + mbad;
}
const count = (arr, check, status) => arr.filter((x) => x.check === check && (!status || x.status === status)).length;
const g = (game, a, check, status) => a.filter((x) => x.check === check && rounds.some((r) => r.round_id === x.round_id && r.game === game) && (!status || x.status === status)).length;
say('');
say('rounds: plinko ' + rounds.filter((r) => r.game === 'plinko').length + ', keno ' + rounds.filter((r) => r.game === 'keno').length);
say('seed commitments matched: ' + count(replay, 'seed_commitment', 'matched') + '/' + count(replay, 'seed_commitment') + '; counter totals matched: ' + count(replay, 'counter_total', 'matched') + '/' + count(replay, 'counter_total'));
for (const game of ['plinko', 'keno']) {
  say(game + ': replay ' + g(game, replay, 'outcome_replay', 'matched') + '/' + g(game, replay, 'outcome_replay') +
    ', multiplier ' + g(game, settle, 'multiplier', 'matched') + '/' + g(game, settle, 'multiplier') +
    ', gross payout ' + g(game, settle, 'gross_payout', 'matched') + '/' + g(game, settle, 'gross_payout') +
    ', balance move ' + g(game, settle, 'balance_move', 'matched') + '/' + g(game, settle, 'balance_move'));
}
say('wallet sessions: ' + walletSessions.filter((w) => w.status === 'matched').length + ' matched, ' + walletSessions.filter((w) => w.status === 'mismatched').length + ' mismatched, ' + walletSessions.filter((w) => w.status === 'unverifiable').length + ' unverifiable');
say('theoretical RTP: plinko ' + theo.summary.plinko.tables + ' tables ' + theo.summary.plinko.min_percent_6dp + '-' + theo.summary.plinko.max_percent_6dp + '%, keno ' + theo.summary.keno.tables + ' tables ' + theo.summary.keno.min_percent_6dp + '-' + theo.summary.keno.max_percent_6dp + '%');
say('exceptions: ' + exceptions.length);
const claimsFound = claims.entries.filter((c) => c.found).length;
say('claims located in the captured sources: ' + claimsFound + '/' + claims.entries.length);
for (const c of claims.entries) if (!c.found) { fail++; say('CLAIM NOT FOUND ' + c.claim); }
if (!WRITE) {
  say(fail === 0 ? 'RESULT: OK, rebuilt outputs equal the committed files byte for byte' : 'RESULT: FAIL (' + fail + ' problems)');
  process.exit(fail === 0 ? 0 : 1);
}
