# FortuneJack Plinko and Keno: advertised 99% RTP, configured about 97%

**FortuneJack says its Plinko and Keno have 99% RTP. The payout tables we read from the live games on 24 November 2026 return about 97%.**

- Plinko: 27 tables, theoretical RTP from 96.901245% to 97.109375%. None reaches 99%.
- Keno: 40 tables, theoretical RTP from 96.919531% to 97.095994%. None reaches 99%.

That is a house edge of 2.89% to 3.10% on every setting, against the 1% FortuneJack states.

The 97% figures are the exact theoretical returns of the captured tables under the game's disclosed outcome model. They are not the result of our paid rounds. Our 364 paid rounds check that the live games used these tables and settled by them: every outcome replays from the revealed seeds and every multiplier equals the table.

## Check it yourself

No account, network access or dependencies needed. From this folder:

    node scripts/check.js                  # Node 18+: rebuilds every generated file and checks every hash
    python3 scripts/independent_check.py   # Python 3.8+: a separate implementation that replays every round from raw/
    sha256sum -c SHA256SUMS.txt            # every file except the list itself

Both scripts exit 0 only if every check passes. That includes the one payout exception in section 5: both scripts report it and fail if it is not exactly as listed. Every figure below cites the file it comes from. All times are UTC.

## 1. What FortuneJack says

- **Blog, 15 Oct 2026**, "FortuneJack Originals: Explore 99% RTP Games You Can Verify": "Dice, Mines, Plinko, Crash, Keno, Limbo, Hi-Lo, and Baccarat run on a 99% theoretical RTP." The same post says "A 99% RTP corresponds to a 1% theoretical house edge" and gives its own example: across $10,000 in stakes, the model keeps about $100. (`claims/blog_fortunejack-originals-explore-99-rtp-games-you-can-verify.html`, fetched logged out 24 Nov 2026 08:53; extracted text in the `.txt` beside it.)
- **Plinko game rules:** "House edge: 1%." (`claims/plinko-rules-2026-11-24.txt`, `claims/plinko-rules-house-edge-1pct-2026-11-24.jpg`). The same rules text is in the public Plinko game client, fetched logged out (`raw/client/plinko/assets/index-BvX_ma61.js`).
- **Keno game rules** give no RTP or house-edge figure (`claims/keno-rules-2026-11-24.txt`; the rules text in the public Keno client has none either). Keno's 99% rests on the blog.
- Both games are listed as "FortuneJack Originals" in the Originals lobby, open at fortunejack.com/game/origin.plinko and origin.keno, and are served from prod02.orbitalgaming.com/fj/ (`claims/lobby-path-2026-11-25.txt` and the three lobby screenshots).
- Each game's own configuration in its client links a public verifier: Plinko to codepen.io/Orbital-Maintenance/full/WbpZpZE, Keno to codepen.io/Orbital-Maintenance/full/vExexeO. We saved both on 27 Nov 2026 (`raw/verifier/`). The Plinko verifier holds the same 27 tables we read from the live game, all 351 entries. The Keno verifier holds no payout table. CodePen lists both as created and last updated on 2 October 2026.

`analysis/claims.json` locates each of these in the captured files, and `scripts/check.js` fails if any is missing.

**Before this capture.** Independent copies on web.archive.org, linked in `archives/web-archive-sources.md`:

- FortuneJack's blog introduced Orbital in August 2020 as "our very own development team".
- FortuneJack advertised its earlier Orbital Plinko and Keno at 99% in 2021: "House Edge – 1%" and "RTP – 99%" for Plinko, "max RTP up to 99%" for Keno. The Plinko post was still up in September 2025.
- Orbital's own game pages showed Plinko and Keno at "RTP 99%" from 2021 to January 2023. The game data behind Orbital's homepage lists Keno at rtp 97 in September 2025, and Plinko and Keno at rtp 97 in January and March 2026.
- FortuneJack's homepage had no origin.plinko or origin.keno games on 1 May or 31 August 2026. By 15 November 2026 it linked both under Originals.

## 2. What the tables return

Every table was read from the live game while logged in on 24 November (`raw/configurations/`). The return of each table is computed exactly, as a fraction, in `analysis/theoretical-rtp.json`.

**Keno, Classic, 1 number picked.** 10 of 40 numbers are drawn, so the pick hits with probability 10/40 = 0.25. A miss pays 0, a hit pays 3.88x:

    0.75 x 0 + 0.25 x 3.88 = 0.97  ->  97%

With zero on a miss, 99% would need 3.96x on a hit. Keno Low, 1 pick: 0.75 x 0.7 + 0.25 x 1.78 = 0.97, also 97%. All four 1-pick settings return exactly 97%.

**Plinko, Low, 8 rows.** Each row sends the ball left or right with probability 1/2; the slot is the number of right steps. Table: 5.5, 1.8, 1.1, 1, 0.5, 1, 1.1, 1.8, 5.5.

    (1x5.5 + 8x1.8 + 28x1.1 + 56x1 + 70x0.5 + 56x1 + 28x1.1 + 8x1.8 + 1x5.5) / 256 = 0.9703125  ->  97.03125%

Plinko Medium, 8 rows (14, 3.2, 1.2, 0.6, 0.5, 0.6, 1.2, 3.2, 14) returns 97.109375%, the highest of the 27 Plinko tables (Medium, 9 rows returns the same). Even that is a 2.890625% house edge.

In money terms: at 99%, $10,000 of wagering is expected to cost $100. On these tables it is expected to cost $289 to $310.

## 3. Did the live games use these tables? Paid rounds

364 paid rounds at 0.1 USDT each, one account, 24 Nov 2026 22:13 to 23:53 (`normalized/rounds.ndjson`, `sessions/sessions.json`):

| | Plinko | Keno |
|---|---:|---:|
| Paid rounds recorded | 182 | 182 |
| Settings with a captured table | 27 of 27 | 40 of 40 |
| Settings with recorded rounds | 27 of 27 | 40 of 40 |
| Seed pairs used, server seed revealed | 2 | 3 |
| Outcome replayed from the revealed seed, matched | 182 of 182 | 182 of 182 |
| Multiplier = table value at the replayed outcome | 182 of 182 | 182 of 182 |
| Gross payout = stake x multiplier | 182 of 182 | 181 of 182 (1 unresolved, section 5) |
| Balance moved by -stake + payout from the previous round | 181 of 181 checkable | 182 of 182 |
| Server-seed hash recorded before the round | 182 of 182 | 22 of 182 |

Sources: `analysis/replay-results.ndjson`, `analysis/settlement-results.ndjson`, `analysis/coverage.json` (`totals`). The first recorded round has no earlier balance, so its balance move is counted as unverifiable, not as a match.

- **Seeds.** For all 5 seed pairs, SHA-256 of the revealed server seed equals the committed hash, and the counters used by the recorded rounds end exactly at the count in the reveal reply (`normalized/seeds.json`). For Plinko, the counter shown by the game at six observations during the main run equals the start counter plus the rows played up to that point.
- **Construction.** HMAC-SHA512 with the server seed as key and `clientSeed-counter` as message; first 16 hex digits divided by 0xffffffffffffffff. Plinko uses one counter per row (value of 0.5 or more = right). Keno uses 40 counters per round for a Fisher-Yates shuffle of 1..40 (j = i + floor((40 - i) x value)); the first ten are the draw, in order. Counters start at the nonce shown before the round plus one.
- **Wallet.** FortuneJack's own transaction list gives a total won and total bet per game session. For all 6 sessions that hold recorded rounds, both totals equal the sum of the recorded rounds (`sessions/sessions.json`, `wallet_sessions`).
- **How the bets were placed.** 360 rounds were sent by a script in the game tab that sends the same bet message the game's Bet button sends; 4 rounds (2 per game) were placed with the Bet button and their bet message was identical (`raw/history/`).

## 4. Configuration coverage and observed payout coverage

These are different things. Every setting had a captured table and at least one paid round. That does not mean every payout in every table was paid and tested.

- **Plinko:** the 27 tables hold 351 slot positions in total; our rounds landed on 93 of them (2 to 7 distinct slots per setting). The extra rounds went to Low / 8 rows (42 rounds) and Medium / 8 rows (40 rounds); each landed on slots 1 to 7, never the two edge slots.
- **Keno:** the 40 tables hold 260 hit-count classes in total; our rounds observed 86. In 11 settings every recorded round paid zero, so those rounds corroborate the draw and the losing settlement only. Classic / 1 pick: 35 rounds, 9 paid hits at 3.88x and 26 misses at 0. Low / 1 pick: 33 rounds, 7 hits at 1.78x and 26 misses paid 0.7x.

Per-setting counts are in `analysis/coverage.json`. The RTP figures do not depend on this sample; they come from the complete tables.

## 5. Exceptions

All in `analysis/exceptions.ndjson`.

1. **Keno round 1795559705745017** (main run, round 86 of 160, Medium, 9 picks, 4 hits, multiplier 2.51): credited 0.25099999 USDT; stake x multiplier is 0.251 exactly. 0.00000001 short. The cause is not established. The draw, hit count and multiplier match, and the FortuneJack wallet total for that session includes the same amount.
2. Plinko server message `90` is the game's error message. The Plinko client names error code 1 `CONCURRENT_CONNECTION` and code 7 `PF_NOT_SET` (`raw/client/plinko/assets/index-BvX_ma61.js`). `90,1` was followed by the connection closing; `90,7` followed a client-seed change, which the next message repeated with a different seed. No paid round is affected.
3. Keno server message code 103 ("Another connection") closed the second-set connection after its last bet reply. Every bet on that connection has a reply.
4. 10 rounds (5 Plinko, 5 Keno) were placed before recording started. They appear in the FortuneJack wallet as totals only and cannot be replayed. They are counted as unverifiable, not as matches.

## 6. Limits

- **Keno commitment timing.** The server-seed hash of the Keno main run (160 rounds) was obtained only after the rounds. Those draws replay exactly from the revealed seed, but the hash was not recorded before play. The 22 later Keno rounds and all 182 Plinko rounds had their hash recorded first.
- **Configuration source.** The tables are transcriptions of the live game's own state (Plinko) and multiplier display (Keno). The inbound configuration messages were not preserved. Every recorded multiplier matches these tables, and two screenshots show the same rows on screen.
- **Transcribed records.** The 4 Bet-button rounds, the Plinko second-pair reveal and the three Keno reveal replies are transcriptions from the game tab, not raw message logs.
- **Wallet granularity.** The wallet list gives per-session totals, not per-round transaction ids.
- **Scope.** One account, one evening, one currency (USDT). The tables are shown to be in effect for that period only, not before or after it, and not for other accounts or currencies.
- **Verifier.** The game clients contain no verifier code; they link the CodePen verifiers saved in `raw/verifier/`. These use the replay's seeds, message and counters but round with `parseInt()` where the replay uses `Math.floor()`. The two differ only for a scaled value below 0.000001, which JavaScript writes in exponent form (`parseInt` reads 7e-7 as 7); the saved Plinko verifier can then show an impossible slot, such as 11 on 8 rows. No recorded round is affected: both verifiers give the replayed outcome for all 364 (`analysis/claims.json`). Whether the live server shares this defect is not established. The construction itself is established by replaying every recorded round. CodePen's created and updated dates are CodePen's own records (`raw/verifier/codepen-metadata-2026-11-27.json`).
- **Model.** The theoretical returns assume the disclosed outcome model. A matched seed commitment does not by itself show how server seeds are chosen.

## Reproduce

    node scripts/check.js
    python3 scripts/independent_check.py

`scripts/check.js` (Node 18 or later, no dependencies) rebuilds `sessions/`, `normalized/` and `analysis/` from `raw/` and `claims/`, replays every round, recomputes every table, locates FortuneJack's claims in the captured files, compares the Plinko verifier's tables with the live ones, checks that both verifiers give the replayed outcome for every round, and exits 0 only if the result equals the committed files byte for byte and every hash in both hash lists matches.

`scripts/independent_check.py` (Python 3.8 or later, standard library only) is a separate implementation. It reads `raw/` only, replays every round, recomputes every table, checks the balance moves, wallet totals, hashes, the Plinko verifier's tables and the verifiers' `parseInt()` rounding, and confirms its 67 RTP fractions equal those in `analysis/theoretical-rtp.json`. It exits 0 only if all of that holds and the only payout exception is the one in section 5.

## Files

| Path | What it holds |
|---|---|
| `claims/` | FortuneJack's blog post (saved html and extracted text), the in-game rules, the lobby path and screenshots |
| `archives/` | links to independent web.archive.org copies of earlier FortuneJack and Orbital pages, with what each shows |
| `raw/events/` | the games' websocket messages as recorded in the game tab: Plinko and Keno, main runs and second sets |
| `raw/configurations/` | the 27 Plinko and 40 Keno payout tables, read from the live games |
| `raw/seeds/` | the seed reveal replies |
| `raw/history/` | the 4 rounds placed with the Bet button |
| `raw/wallet-transactions-2026-11-24.txt` | FortuneJack's wallet totals per game session |
| `raw/client/` | the public Plinko and Keno game clients, fetched logged out, with their hash list |
| `raw/verifier/` | the Plinko and Keno verifiers the games link to, as CodePen served them on 27 Nov 2026, with CodePen's dates and the code's licence |
| `normalized/`, `sessions/`, `analysis/` | generated by `scripts/check.js` |
| `manifest.json` | collection times, provenance and the treatment of every file |
| `SHA256SUMS.txt` | SHA-256 of every file except itself |
