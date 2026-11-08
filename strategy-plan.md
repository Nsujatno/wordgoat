# Strategy and evaluation plan

## Evaluation architecture

1. Keep the original longest-word starter as a control and pin the incumbent to v5 (`aeae8b9`). Preserve earlier version comparisons. Extend the existing in-process simulator because the game clock can advance immediately and the same TypeScript policies can run in the simulator and client. Use the existing SpacetimeDB in-memory reducer tests as the rules oracle and add benchmark-side checks for settlement, final-turn ordering, rewards, and ranking. Run locally without credentials.
2. Use seeded, independent random streams for bag draws, tie breaking, and opponent jitter. Candidate and incumbent occupy the same seat with the same starting deal and exogenous auction sequence. The other bots adapt to the resulting racks and balances. Cover built-in opponents, stock starters, bonus-seeking bots, high-price pressure, and rooms including a pinned Wordgoat opponent. Run both formats and two-bot finals. When tournament outcomes change the roster, reuse the seed for each phase, round and table, accepting that the new roster can change the deal and number of draws.
3. Record score, sample variance, competition placement, shared first and last rates, outright first rate, expected Swiss points, auctions won per opportunity, purchases per bid, score per credit spent, average word length, and decision-time quantiles and maxima. Report paired 95% intervals on primary differences, with the match seed or tournament seed as the sampling unit. Use development seeds to compare components and disjoint seeds to evaluate finalists. Report the number of matches, realized stage exposure and uncertainty, including results where the interval spans zero.
4. Run complete Swiss-to-final tournaments with realistic table sizes and different opponent archetypes. Use championship probability as the main deployment outcome. Qualification and bracket elimination are diagnostics. Use late score margins for risk-policy inputs only when they could be derived from public rows. Validate numerical results separately from transport behavior under stale snapshots, reducer failures, deadlines, and reconnects.

## Priorities and ablations

| Order | Candidate | Main question |
| --- | --- | --- |
| 1 | Highest current reward with original bidding | Does immediate reward improve the stock control? Compare it with v5 as well. |
| 2 | Liquidity-aware timing | Can an early payout fund more useful buys when recent prices exceed the remaining runway? Compare with the best observed benchmark policy and v5. |
| 3 | Marginal bid | Value the available tile by changes in playable words and one-tile continuations, with an explicit cash cost and first-price shading. Compare with incumbent and the word-only ablation. |
| 4 | Combined | Run the strongest new bidding and word ideas together to measure interaction. |
| 5 | Public opponent state | Test whether guaranteed opponent holdings and observable cash and results help estimate supply or price. |
| 6 | Phase-sensitive policy | Test if taking a safe payout or preserving upside in late rounds improves survival and championship probability. |

Start with cheap approximations and run bigger simulations for promising candidates. Test both short-horizon and larger payout opportunities through the same candidate interfaces. Use held-out comparisons to decide whether to enable a candidate. Keep experimental configurations available for reproducing the comparisons. Use the pinned incumbent if the evidence is inconclusive.

## Real-time path

The incumbent's anagram trie enumerates valid multisets and one-missing-tile completions. Endgame cash-out bounds a search over disjoint word combinations. Profile the number and duration of bidding and word decisions, plus dictionary build time and memory on the local Node process. Put search outside the network event loop so feed processing and current-auction bids can continue. Tie every action to the auction and input snapshot that produced it, cap bids using confirmed balance, and keep a bounded fallback for time-sensitive decisions. Local simulation timing excludes transport and the server's queue.
