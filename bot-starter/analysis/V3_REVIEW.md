# V3 match review and v4 candidate

Reviewed on November 7, 2026. The bot is named **wordgoat** on the live service.

## Why the results changed

There is no learning or warm-up across games. The strategy rebuilds its market history for each match. Reconstructing its own initial rack from public purchases and word plays accounts for all five starting letters in every game. The pinned v3 code also reproduces **all 103 archived winning bid caps**, across both the early losses and later wins.

| Match                                                      |  Place | Points | First payout after auction | Initial rack |
| ---------------------------------------------------------- | -----: | -----: | -------------------------: | ------------ |
| [43006](https://scrabblebot.spacetimedb.com/matches/43006) |      5 |     64 |                         49 | EIINR        |
| [43011](https://scrabblebot.spacetimedb.com/matches/43011) |      2 |     91 |                         40 | EFIRW        |
| [43016](https://scrabblebot.spacetimedb.com/matches/43016) |      4 |     67 |                         47 | AGHNN        |
| [43022](https://scrabblebot.spacetimedb.com/matches/43022) | tied 4 |     63 |                         53 | EINSV        |
| [43028](https://scrabblebot.spacetimedb.com/matches/43028) |      1 |     99 |                         26 | ADEIT        |
| [43034](https://scrabblebot.spacetimedb.com/matches/43034) |      1 |    141 |                         10 | DEQSX        |
| [43040](https://scrabblebot.spacetimedb.com/matches/43040) |      1 |    120 |                         21 | AEEOY        |
| [43046](https://scrabblebot.spacetimedb.com/matches/43046) |      3 |    102 |                         33 | DEORU        |

The first four games averaged **71.25 points**, versus **115.5** in the last four. The first payout moved from auction **47.25** on average to **22.5**. Purchases increased from **10.5** to **15.25** per game. Earlier income funded more opportunities to score.

Three effects explain the swing:

1. **The large-word payout rule amplified differences between racks.** With at least 28 credits and more than five letters left, v3 holds words below 50 points. In 43006, `JOINERS` was worth 42 after auction 6, but the first payout was `REJOINED` for 48 after auction 49. `HAYWIRE` (48) was ready after 19 in 43011; the first payout came after 40. `GINGHAM` (42) was ready after 15 in 43016; the payout came after 47. `VANISHED` (45) was ready after 15 in 43022; the payout came after 53. These waits were real, not missing dictionary entries.
2. **The later batch had favorable tiles and timing.** In 43034 the initial rack included both Q and X for free. `EQUINOX` paid 69 after just ten auctions, followed by `ZESTING` for 51 after auction 30. In contrast, 43006 paid 37 for J and did not turn it into income until auction 49. The other later first payouts were `EQUATING` (54), `BEGAZED` (60), and `UNFROZE` (57), which cleared v3's payout threshold.
3. **The opponent fields changed.** In 43028, Nhat bought no tiles and scored zero. In 43040, both Nhat and Afterword bought no tiles and scored zero. The best rival averaged 112.75 points in the first four games and 101.75 in the last four. This is evidence of different competition, not proof that all later opponents were weaker.

## What the experiments supported

Lowering the early payout target looked attractive from these replays, but it frequently broke useful racks too soon on other deals. A blanket 36-point target reduced average Vickrey scores against five pressure bots from 90.9 to 86.0 on the initial 48-deal screen. Several conditional 42-point targets also lost ground in broader tests. They are **not enabled** in the final candidate.

The retained change is small: **protect a funded rack earlier in the endgame**. V3 waited until seven letters remained and required six credits for every remaining letter before preserving the rack. That sometimes caused an unnecessary payout followed by an expensive, low-scoring rebuild.

| Letters left, excluding the current auction tile | Candidate behavior                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| More than 18                                     | Keep the existing bonus-building and cash-refill rules.                                                  |
| 18 down to 2                                     | Preserve a playable rack if cash covers the estimated purchase reserve. Cash out when funding is needed. |
| 1                                                | Keep the existing all-in bid only for an immediate scoring improvement.                                  |
| 0                                                | Submit the existing disjoint-word cash-out plan and skip bidding.                                        |

The late reserve is `min(6 × letters left, max(12, common tile price))` for Vickrey, and twice the common tile price inside that formula for first-price. This uses the existing recent-price estimate. It adds no learning system, new runtime dependency, or search algorithm.

## Validation

The final candidate passed all **16 strategy tests** and the TypeScript build. New tests cover the endgame boundary, sufficient versus insufficient cash, differences between auction formats, and final liquidation.

Fresh competitive validation used 96 identical deals per strategy per row, seed offset 80000. Opponents spend, play, and respond to their changed racks in the simulator. The bottom-decile column is the average of each strategy's lowest ten scores.

| Field              | Format      | Average, v3 → v4 | Bottom decile, v3 → v4 | Wins, v3 → v4 |
| ------------------ | ----------- | ---------------: | ---------------------: | ------------: |
| Five pressure bots | Vickrey     |      88.9 → 90.7 |            61.0 → 64.5 |       67 → 70 |
| Five pressure bots | First-price |      78.8 → 80.8 |            55.7 → 59.0 |       23 → 24 |
| Mixed opponents    | Vickrey     |    128.8 → 129.8 |            89.6 → 89.6 |       77 → 77 |
| Mixed opponents    | First-price |     99.3 → 101.2 |            73.4 → 75.5 |       36 → 41 |

Direct comparison against v3 used 96 games per row, swapping seats on each deal:

| Room     | Format      | v4 beat v3 | v3 beat v4 | Ties | Table wins, v4 / v3 |
| -------- | ----------- | ---------: | ---------: | ---: | ------------------: |
| Duel     | Vickrey     |         50 |         46 |    0 |             50 / 46 |
| Duel     | First-price |         49 |         47 |    0 |             49 / 47 |
| Six bots | Vickrey     |         50 |         45 |    1 |             45 / 39 |
| Six bots | First-price |         49 |         43 |    4 |             34 / 29 |

The margins are small; this is a favorable local signal, not a decisive strength estimate. Recorded head-to-head turn time was 7.02 ms at the 95th percentile and 114.02 ms maximum, including word selection and bidding.

Additional fresh validation used 48 deals per strategy per row, also at seed offset 80000:

| Field                   | Format      | Average, v3 → v4 | Bottom decile, v3 → v4 | Wins, v3 → v4 |
| ----------------------- | ----------- | ---------------: | ---------------------: | ------------: |
| Built-in opponents      | Vickrey     |    378.6 → 378.5 |          333.4 → 329.0 |       48 → 48 |
| Built-in opponents      | First-price |    267.2 → 273.2 |          199.8 → 199.8 |       48 → 48 |
| Stock starters          | Vickrey     |    389.5 → 386.8 |          334.8 → 335.4 |       48 → 48 |
| Stock starters          | First-price |    337.1 → 352.0 |          285.4 → 288.6 |       48 → 48 |
| Bonus-seeking opponents | Vickrey     |    200.5 → 200.7 |          140.6 → 140.6 |       47 → 47 |
| Bonus-seeking opponents | First-price |    127.7 → 131.0 |            95.6 → 96.0 |       48 → 48 |
| Pressure duel           | Vickrey     |    319.7 → 318.8 |          168.4 → 168.8 |       41 → 39 |
| Pressure duel           | First-price |    287.0 → 288.5 |          211.2 → 211.2 |       48 → 48 |

This covers 768 games per version across 12 field/format combinations, plus the 384 direct head-to-head games above. Average scores improved in nine combinations; lower-tail averages improved or held in eleven. There are tradeoffs: small average-score losses in three Vickrey fields, a lower bottom-decile score against built-in opponents, and two fewer wins in the pressure duel. The broad suite's slowest recorded turn was 255.19 ms, still within the game's one-second auction window; network time is not simulated.

These are modest improvements, not evidence that v4 will eliminate the 44-point early/late gap or win every type of live game. The fixed-opponent-bid replay sensitivity check did not establish a gain on these eight specific replays. It cannot model how changed purchases affect hidden rival racks and bids; neither its scores nor the simulator are claimed as live results. V4 still needs a fresh live batch.

## Reproduce

Run from `bot-starter`:

```powershell
npm test
npm run build
npm run analyze:replays
npm run analyze:replays -- --fixed-market
npm run benchmark -- --against v3
$env:BENCH_GAMES = '96'
$env:BENCH_SEED_OFFSET = '80000'
$env:BENCH_FIELDS = 'Five pressure,Mixed pressure'
$env:BENCH_REPORT = 'analysis/v4-competitive-validation.json'
npm run benchmark -- --robust v3
```

`--robust` without `BENCH_FIELDS` compares six fields in both formats. `BENCH_GAMES` must be even; `BENCH_SEED_OFFSET` selects fresh deals. Reports include per-game scores, lower-tail scores, wins, and approximate paired confidence intervals.

The public SQL snapshot is [v3-replays.json](v3-replays.json). The analyzer writes `v3-decisions.json` with reconstructed racks, balances, ready words, and bid comparisons. The saved v3 implementation is commit `0f58d7ded41a270e0108ba6119fe2d567c5eb28d`; the working tree is the v4 candidate, not a deployed release.

Saved validation: [competitive fields](v4-competitive-validation.json), [other fields](v4-validation.json), and [head-to-head output](v4-head-to-head.txt).
