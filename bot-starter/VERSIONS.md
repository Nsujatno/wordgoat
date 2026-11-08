# Wordgoat versions

Each released version is pinned to a Git commit in [the version registry](src/versions.ts). The pin preserves the strategy, game client, and dictionary together. Match groups are assigned using the reported version for each live test batch.

## Live results

| Version | Commit | Wins | Average place | Average points |
| --- | --- | ---: | ---: | ---: |
| v1 | `0827890` | 0/5 | 2.60 | 85.8 |
| v2 | `96462d6` | 3/6 | 1.83 | 101.0 |
| v3 | `0f58d7d` | 3/8 | 2.63 | 93.4 |

| Version | Place | Wordgoat points | Highest-scoring rival | Replay |
| --- | ---: | ---: | --- | --- |
| v1 | 3rd | 69 | GodOfThudner (126) | [42798](https://scrabblebot.spacetimedb.com/matches/42798) |
| v1 | 3rd | 108 | StickBot (150) | [42801](https://scrabblebot.spacetimedb.com/matches/42801) |
| v1 | 2nd | 73 | GodOfThudner (111) | [42804](https://scrabblebot.spacetimedb.com/matches/42804) |
| v1 | 3rd | 87 | GodOfThudner (118) | [42807](https://scrabblebot.spacetimedb.com/matches/42807) |
| v1 | 2nd | 92 | GodOfThudner (114) | [42810](https://scrabblebot.spacetimedb.com/matches/42810) |
| v2 | 1st | 118 | LUCENT (109) | [42871](https://scrabblebot.spacetimedb.com/matches/42871) |
| v2 | 2nd | 86 | LexiconWarrior (100) | [42874](https://scrabblebot.spacetimedb.com/matches/42874) |
| v2 | 1st | 146 | Bron (93) | [42877](https://scrabblebot.spacetimedb.com/matches/42877) |
| v2 | 3rd | 85 | Binter and GodOfThudner (93) | [42880](https://scrabblebot.spacetimedb.com/matches/42880) |
| v2 | 1st | 94 | GodOfThudner (91) | [42884](https://scrabblebot.spacetimedb.com/matches/42884) |
| v2 | 3rd | 77 | RackMaw (142) | [42887](https://scrabblebot.spacetimedb.com/matches/42887) |

The two live batches had different opponents. Use the same-seed local results for a controlled comparison.

## Local benchmark on 2026-11-07

| Against the same five pressure bots | v1 wins / 96 | v2 wins / 96 | v1 average | v2 average |
| --- | ---: | ---: | ---: | ---: |
| Vickrey | 35 | 63 | 73.3 | 88.8 |
| First-price | 14 | 14 | 75.7 | 75.7 |

| Head-to-head room | Format | v1 beat v2 | v2 beat v1 | Tied | Outright table wins, v1 / v2 |
| --- | --- | ---: | ---: | ---: | ---: |
| Duel | Vickrey | 39 | 57 | 0 | 39 / 57 |
| Six-bot pressure table | Vickrey | 25 | 71 | 0 | 20 / 57 |
| Duel | First-price | 48 | 48 | 0 | 48 / 48 |
| Six-bot pressure table | First-price | 46 | 46 | 4 | 30 / 30 |

The local results favor v2 for Vickrey. First-price performance was identical in the common field.

## v3 candidate review

Wordgoat's initial tiles can be reconstructed in these six games by matching its tile wins to the letters it spent on words. The archived winning bid caps agree with v2 on the reconstructed racks.

| Result | What the replay showed | Replay |
| --- | --- | --- |
| Won 118–109 | `SKYDIVED` paid 60 after auction 29. `MONARCH` paid another 42 and funded the late `X` purchase. | [42871](https://scrabblebot.spacetimedb.com/matches/42871) |
| Lost 86–100 | The `Q` cost 23 credits with only an `A` in the rack. It stayed unused, and Wordgoat had five credits left for the last 11 auctions whose tiles could be played. | [42874](https://scrabblebot.spacetimedb.com/matches/42874) |
| Won 146–93 | Waiting for `P` paid off. It completed `QUADPLEX` for 81 and funded two more scoring cycles. | [42877](https://scrabblebot.spacetimedb.com/matches/42877) |
| Lost 85–93 | `ADMIXES` was ready after auction 11 for 51. Wordgoat held it through auction 43, including 24 straight auctions without a tile win. | [42880](https://scrabblebot.spacetimedb.com/matches/42880) |
| Won 94–91 | Wordgoat played `BREATHY` for 45 just before winning `C`. With that `C`, the original rack could score 63 with `BREEZY` and `CHAT`. | [42884](https://scrabblebot.spacetimedb.com/matches/42884) |
| Lost 77–142 | `PIQUETS` was ready for 54 after auction 7. Wordgoat waited 21 auctions and paid 6 for an `O` to score 57 with `POSTIQUE`. It spent its final credits in auction 56. | [42887](https://scrabblebot.spacetimedb.com/matches/42887) |

The candidate compares the extra points from a one-tile upgrade with the estimated purchase price. It also considers a lucrative five- or six-letter play, checks whether the revealed auction tile is worth keeping a rack intact for, and caps expensive late purchases when a thin rack has little scoring potential.

In counterfactual replay tests, the simulator sampled hidden opponent racks and bids and allowed rivals to spend and play as their racks changed. The candidate won 34 of 48 runs of this batch versus v2's 22. It won 38 of 96 runs on 12 nearby comparison replays versus v2's 33, and 27 of 40 on the earlier five replays versus v2's 31. With opponents' scores held fixed, it cleared the recorded winning score in 23 of 48 runs of this batch versus v2's 11.

The all-version Vickrey benchmark used 96 games per matchup. Outright wins in the common field were 35 for v1, 63 for v2, and 64 for the candidate. The candidate tied for first twice.

| Candidate opponent | Duel record | Six-bot head-to-head record | Six-bot table wins, candidate / opponent |
| --- | ---: | ---: | ---: |
| v1 | 58–38 | 73–22, 1 tie | 60 / 15 |
| v2 | 53–43 | 49–47 | 44 / 42 |

First-price results stayed even across the three strategies. The candidate is the working strategy for the next live test batch.

## V3 live review and v4 candidate

The eight v3 games (43006, 43011, 43016, 43022, 43028, 43034, 43040, 43046) averaged 71.25 points in the first four and 115.5 in the last four. All 103 winning bid caps match the pinned v3 code. Large-word timing, starting tiles, and different opponent fields explain the change; there is no cross-match learning.

The working v4 candidate makes a small endgame change: with 18 or fewer letters left, it preserves a playable rack when cash covers the estimated purchase reserve, then liquidates on the final auction. Broader early-payout changes were rejected after they hurt other deals. Fresh competitive tests improved average scores in both formats and improved or preserved the bottom-decile averages. These are local improvements; no v4 live results are recorded yet.

See the [full analysis and validation](analysis/V3_REVIEW.md) for the match evidence, exact phase rules, limitations, and reproducible commands. `npm run analyze:replays` rechecks the archived batch; `npm run benchmark -- --robust v3` compares scoring and consistency across six fields in both formats.

## Run the comparison

From `bot-starter`, run the full version suite with `npm run benchmark -- --versions`. It loads each version's committed strategy and dictionary, tests each against five fixed pressure bots on 96 common deals, and runs every version pair in both auction formats. Each pair plays a duel and a six-bot table with four pressure bots, swapping seats on each of 48 deals per room and format.

| Command | What it runs |
| --- | --- |
| `npm run benchmark -- --versions` | Compare all saved versions. |
| `npm run benchmark -- --versions --candidate` | Include the working strategy against every saved version. |
| `npm run benchmark -- --against v1` | Compare the working strategy directly with v1. A commit SHA also works. |

The simulator tests bidding and word choice. Live match records also reflect different opponent lineups and network timing.

## Save the next version

1. Run the version suite with `--candidate` and compare six-bot Vickrey table wins first. Check direct results and first-price results for tradeoffs.
2. Commit the candidate and append its next version ID and full commit SHA to the registry. Keep the earlier pins fixed.
3. Record its live match IDs and scores when available. Append the new benchmark results here using the same comparison conditions.

To run a saved version live, use a separate checkout of its pinned commit and configure it as you would the current bot. Use one live process per bot identity so the match results have a clear version assignment.
