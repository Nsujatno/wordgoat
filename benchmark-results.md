# Wordgoat tournament evaluation

## Completed live batches

The cohorts use the match IDs supplied by the operator. The replay rows contain actual participant scores, words and public auction payments. Both cohorts used six seats, five starting tiles, and one-second Vickrey auctions. The replays establish what happened in those matches. Opponent strength, code effects, starting deals, and client failures are confounded across the cohorts.

| Cohort | Games | Wordgoat score | Average place | Shared firsts | Shared lasts | Mean rival score | Credits paid per auction | Tiles won |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Listed v3, first 55 | 55 | 90.3 | 2.49 | 18 | 1 | 70.9 | 13.05 | 13.47 |
| Listed v3, all | 81 | 86.5 | 2.73 | 22 | 3 | 71.6 | 13.07 | 13.22 |
| Listed v3, last 26 | 26 | 78.4 | 3.23 | 4 | 2 | 73.1 | 13.12 | 12.69 |
| Listed v5, all | 26 | 76.0 | 3.46 | 5 | 4 | 75.6 | 13.74 | 11.08 |

The later cohort cost 6% more on one-point tiles (11.24 versus 10.61 credits compared with the last 26 v3 games). Wordgoat's first payout came after auction 38.0 versus 31.8, counting a match with zero words as auction 68. The batches share some opponents but no exact five-opponent lineup. These observations support a tougher auction market and leave the version effect unresolved. [End of the v3 batch](https://scrabblebot.spacetimedb.com/matches/46006) · [Start of the v5 batch](https://scrabblebot.spacetimedb.com/matches/46507)

Match 46879 ended at zero with 34 credits. The seven publicly won tiles alone spelled `ONAGERS` for 24 points by auction 35. No word was recorded, and the replay does not show the reason. The remaining 25 v5 games averaged 79.0. [Match 46879](https://scrabblebot.spacetimedb.com/matches/46879)

## Controlled version comparison

Three Vickrey fields used 160 paired deals each at seed offset 136000. The competitive room includes pinned v4, two pressure bots, a bonus-seeking bot and one built-in-style opponent. The intervals are paired score deltas against v5.

| Field | v3 score (shared firsts) | v4 score (shared firsts) | v5 score (shared firsts) | v3 − v5, 95% CI | v4 − v5, 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: |
| Competitive | 103.19 (77) | 103.86 (80) | 103.69 (79) | −2.15 to +1.16 | −1.39 to +1.74 |
| Five pressure bots | 90.26 (120) | 91.20 (122) | 91.41 (115) | −2.89 to +0.59 | −1.96 to +1.53 |
| Mixed pressure | 125.79 (128) | 126.58 (128) | 125.28 (126) | −2.68 to +3.72 | −2.05 to +4.66 |

The controlled data show no clear score advantage for rolling back. The much larger early-v3 versus v5 live gap is consistent with a changing field and a missed cash-out. The local fields do not reproduce the full diversity of the live competition.

## Strategy screens

- Highest current reward improved the historical longest-word control by 0.60 to 0.80 points across four 160-deal field/format comparisons. For five Vickrey pressure bots the gain was +0.80 (95% CI +0.53 to +1.07), with all matches still ending in last place. Earlier liquidity payouts reduced the development Vickrey score by 1.6 points versus v5 against five pressure bots and 2.5 in the mixed field, each on 64 paired deals.
- Replacing the incumbent bid formula with the stand-alone marginal value estimate underbid the competitive field. With 120 fresh first-price deals, both marginal-only and combined variants scored 47.27 against 92.69 for v5, a paired loss of 45.42 points (95% CI −48.38 to −42.45). The same idea scored well against a single pressure bot, where both it and v5 won every development game.
- Tightening remaining supply using public opponent tile deficits was neutral in the Vickrey screens. On the 120 competitive first-price deals it changed average score by −0.21 (95% CI −1.05 to +0.63). Boosting late bids for immediately packable rewards changed it by +0.04 (95% CI −0.43 to +0.51).
- On 160 competitive Vickrey deals, the penultimate cash-out ablation had identical scores to v5 with every window available. With only the final client turn suppressed, it scored 101.88 versus 101.74, a paired change of +0.13 (95% CI −0.07 to +0.33), and won 76 versus 75 shared firsts. This models an isolated missed final window. It does not estimate the frequency or severity of production disconnects.

## Tournament objective

The live policy uses the v5 core. During the penultimate auction, it bids up to its confirmed balance so a rival cannot use a scoring tile that our bot can buy instead. It banks the rack early when winning that tile cannot improve its own payout, and skips the unplayable final tile to concentrate on word submissions. This targets placement and series margin directly. Any credits spent in the penultimate auction would have expired without a later useful purchase.

In 80 paired tournament seeds with twelve entrants, three Swiss rounds, a cut to four, two bracket matches, and a three-game final, v5 qualified 80 times, reached 71 finals and won 50. V4 qualified 79 times, reached 66 finals and won 49. A one-title difference at this sample size offers little evidence of a ranking between them.

The tournament policy and v5 had identical outcomes on a fresh 48-seed Vickrey tournament comparison, covering 1,056 simulated matches across both runs. Each qualified 48 times, reached 38 finals and won 22 titles. The paired 95% interval on the championship change was −9.5 to +9.5 percentage points. In a controlled final-turn test, spending idle cash denied a rival's only playable word while leaving our score unchanged. The evidence supports keeping the faster, deadline-aware implementation, with the championship lift still uncertain.

The phase-specific cash-out ablation produced the same outcomes as v5 on 48 competitive Vickrey tournament seeds. Each qualified 44 times, reached 30 finals and won 20 titles. The experiment only changed decisions in late bracket rounds and the third final game. It remains a benchmark policy.

## Timing and deployment

The bid hot path now accumulates the rack leave cost during trie traversal and caches recent terminal packs. The network event loop processes subscriptions and bid deadlines while the worker searches. The penultimate bid goes out using confirmed balance without waiting for search. The client checks auction identity and elapsed time since receipt before dispatch, raises its bid after confirmed payouts, retries an eligible failed bid once, and rebuilds its match feed after reconnecting. The server enforces the authoritative close time. The reducer parity suite exercises the unchanged game module in memory.

In the 128-deal competitive Vickrey run, the updated policy matched v5 at 100.05 points and 51 shared firsts. Bid p99 fell from 17.10 ms to 9.91 ms. First-price also matched v5 at 91.07 points and 42 shared firsts, with bid p99 of 7.61 ms versus 8.12 ms. In Vickrey duels against pinned v5, each focal policy won 60 of 128 deals, and bid p99 dropped from 37.86 ms to 20.70 ms. The full tournament's bid p99 dropped from 31.74 ms to 17.90 ms and its maximum from 205 ms to 138 ms.

A separate stress probe using 5-, 10-, 19-, and 28-tile racks measured 16–174 ms per bid and about 500 ms of aggregate CPU over the four searches. The process peaked at 268 MiB RSS with one dictionary. The 19- and 28-tile cases exceeded the 100 ms target while remaining well within a nominal one-second auction. The deadline fallback runs independently of worker search.

## Reproduce

Run from `bot-starter` with Node and installed dependencies. The rules check uses the existing module test harness with the LF dictionary stored in Git, including on CRLF checkouts.

```powershell
npm run build
npm test
npm run test:rules
$env:EVAL_FIELDS = 'competitive,pressure,mixed'
$env:EVAL_FORMATS = 'Vickrey'
$env:EVAL_REPORT = 'version-comparison.json'
npm run evaluate -- matches 160 136000 v5 v3 v4
$env:EVAL_FIELDS = 'competitive'
$env:EVAL_FORMATS = 'FirstPrice'
$env:EVAL_REPORT = 'first-price.json'
npm run evaluate -- matches 120 171000 v5 safeClose marginal combined opponent closing
$env:EVAL_FORMATS = 'Vickrey'
$env:EVAL_MISS_FINAL = '1'
$env:EVAL_REPORT = 'missed-final.json'
npm run evaluate -- matches 160 136000 v5 safeClose
Remove-Item Env:EVAL_MISS_FINAL
$env:EVAL_FIELDS = 'competitive,peerDuel'
$env:EVAL_FORMATS = 'Vickrey,FirstPrice'
$env:EVAL_REPORT = 'tournament-policy-matches.json'
npm run evaluate -- matches 128 188000 v5 working
$env:EVAL_FIELDS = 'mixed'
$env:EVAL_FORMATS = 'Vickrey'
$env:EVAL_REPORT = 'tournament-policy.json'
npm run evaluate -- tournaments 48 237000 v5 working
$env:EVAL_FIELDS = 'competitive'
npm run evaluate -- tournaments 48 220000 v5 safeClose phase
```

`EVAL_REPORT` includes individual paired samples, score variance, placement, shared and outright firsts, last-place rate, expected Swiss points, auction wins per opportunity and per bid, points per credit, mean word length, and bid, word and turn latency. Tournament reports also include qualification, final appearances, and championship results. `EVAL_MATCH_SIZE`, `EVAL_SWISS_ROUNDS`, and `EVAL_TOP_CUT` control tournament configuration. Rates use conservative intervals on paired discordant outcomes. Score differences use approximate paired 95% intervals. Local latency excludes transport and the scheduler.
