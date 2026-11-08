import { current, type MatchPosition, type Strategy } from "./benchmark.js";
import { ALPHABET, VALUES, cashOut, rackCounts, type Play } from "./lexicon.js";
import { type BidContext } from "./strategy.js";

const incumbent = current.strategy;
type BidPosition = MatchPosition & BidContext;

function bestPlay(
  ctx: MatchPosition,
  value: (play: Play, leave: number[]) => number,
) {
  let best: Play | undefined;
  let bestValue = -Infinity;
  const counts = rackCounts(ctx.myRack);
  ctx.lexicon.visit(counts, (play) => {
    const score = value(play, counts);
    if (score > bestValue) {
      bestValue = score;
      best = play;
    }
  });
  return best ? [best] : [];
}

function faceBid(ctx: BidPosition): number {
  return Math.min(
    ctx.myBalance,
    VALUES[ALPHABET.indexOf(ctx.letter)] + (ctx.myRack.get(ctx.letter) ? 0 : 2),
  );
}

function recentCommonPrice(ctx: MatchPosition): number {
  const prices = (ctx.market ?? [])
    .slice(-12)
    .map(({ letter, paid }) =>
      Math.max(1, paid - 2.4 * (VALUES[ALPHABET.indexOf(letter)] - 1)),
    )
    .sort((a, b) => a - b);
  return prices.length < 3 ? 8 : prices[Math.floor(prices.length / 2)];
}

function liquidityPlays(ctx: MatchPosition): Play[] {
  const planned = incumbent.choosePlays(ctx);
  if (planned.length || ctx.bagTotal < 14 || ctx.myBalance < 12) return planned;
  const price = recentCommonPrice(ctx);
  if (ctx.myBalance >= Math.max(18, 2.4 * price)) return planned;
  const slot = ALPHABET.indexOf(ctx.letter ?? "");
  const counts = rackCounts(ctx.myRack);
  let revealedUpgrade = 0;
  if (slot >= 0 && ctx.letter) {
    counts[slot]++;
    ctx.lexicon.visit(counts, (play) => {
      revealedUpgrade = Math.max(revealedUpgrade, play.score);
    });
  }
  return bestPlay(ctx, (play, leave) => {
    const reserve = leave.reduce((sum, copies) => sum + Math.min(1, copies), 0);
    const minimum = ctx.bagTotal > 35 ? 29 : 25;
    if (play.score < minimum || revealedUpgrade > play.score + 13)
      return -Infinity;
    return play.score + 2 * Math.min(4, reserve);
  });
}

function projectedReward(
  ctx: BidPosition,
  counts: number[],
  available: readonly number[],
  price: number,
): number {
  let best = 0;
  const tileValue = (slot: number, copies: number) =>
    (Math.min(copies, 1) + 0.45 * Math.max(0, copies - 1)) *
    (1 + 0.65 * VALUES[slot]);
  const equity = counts.reduce(
    (sum, copies, slot) => sum + tileValue(slot, copies),
    0,
  );
  ctx.lexicon.visit(
    counts,
    (play, missing) => {
      let gain = play.score;
      for (let i = 0; i < play.letters.length; ) {
        const slot = play.letters[i];
        let used = 0;
        while (play.letters[i] === slot) {
          used++;
          i++;
        }
        if (missing === slot) used--;
        gain -=
          tileValue(slot, counts[slot] + used) - tileValue(slot, counts[slot]);
      }
      if (missing >= 0) {
        const cost = price + 2 * (VALUES[missing] - 1);
        const capture = Math.min(0.38, 0.07 + (0.09 * ctx.myBalance) / cost);
        gain =
          (gain - cost * 0.6) *
          (1 - (1 - capture) ** Math.min(available[missing], 4)) *
          Math.min(1, ctx.bagTotal / 10);
      }
      best = Math.max(best, gain);
    },
    available,
  );
  return equity + best;
}

function shadedBid(ctx: BidPosition, cap: number, price: number): number {
  if (!cap) return 0;
  const normalize = (letter: string) =>
    2 * (VALUES[ALPHABET.indexOf(letter)] - 1);
  const counts = Array<number>(cap + 2).fill(0);
  const add = (amount: number, weight: number) => {
    counts[Math.min(cap + 1, Math.max(0, Math.round(amount)))] += weight;
  };
  const premium = normalize(ctx.letter);
  for (const adjustment of [-4, -2, 0, 2, 4])
    add(price + premium + adjustment, 1);
  for (const observation of (ctx.market ?? []).slice(-24)) {
    const estimate = observation.paid + premium - normalize(observation.letter);
    if (observation.result === "unbid") add(0, 1);
    else if (observation.result === "lost") add(estimate, 1);
    else {
      // An observed win is censored; use a low-weight distribution below it.
      add(0.5 * estimate, 0.2);
      add(0.8 * estimate, 0.2);
    }
  }
  let bestBid = 0;
  let bestUtility = 0;
  let below = counts[0];
  for (let bid = 1; bid <= cap; bid++) {
    const utility = (below + 0.5 * counts[bid]) * (cap - bid + 0.5);
    if (utility > bestUtility) {
      bestBid = bid;
      bestUtility = utility;
    }
    below += counts[bid];
  }
  return bestBid;
}

function marginalBid(ctx: BidPosition): number {
  if (ctx.bagTotal <= 1 || ctx.myBalance === 0) return incumbent.decideBid(ctx);
  const slot = ALPHABET.indexOf(ctx.letter);
  const counts = rackCounts(ctx.myRack);
  const price = recentCommonPrice(ctx);
  const available = ctx.available ?? Array<number>(26).fill(1);
  const before = projectedReward(ctx, counts, available, price);
  const copies = counts[slot]++;
  const gain = projectedReward(ctx, counts, available, price) - before;
  const horizon = Math.min(1, ctx.bagTotal / 16);
  const speculative = horizon * Math.max(0, 4 - copies * 2);
  const liquidity = Math.max(
    0.56,
    Math.min(
      1.6,
      0.78 + (2 * price) / (ctx.myBalance + 12) - 0.3 * (1 - horizon),
    ),
  );
  const cap = Math.min(
    ctx.myBalance,
    Math.max(0, Math.floor((gain + speculative) / liquidity)),
  );
  return ctx.auctionType === "Vickrey" ? cap : shadedBid(ctx, cap, price);
}

function opponentSupply<T extends MatchPosition>(ctx: T): T {
  const { opponents } = ctx;
  if (!ctx.available || !opponents?.length) return ctx;
  return {
    ...ctx,
    available: ctx.available.map((count, letter) =>
      Math.max(
        0,
        count -
          opponents.reduce(
            (sum, opponent) => sum + Math.max(0, -opponent.netTiles[letter]),
            0,
          ),
      ),
    ),
  };
}

function phasePlays(ctx: MatchPosition): Play[] {
  const planned = incumbent.choosePlays(ctx);
  const { myScore, opponents } = ctx;
  if (
    myScore === undefined ||
    !opponents?.length ||
    !ctx.tournament ||
    planned.length ||
    ctx.bagTotal < 2 ||
    ctx.bagTotal > 8
  )
    return planned;
  const { phase, round, finalMargin } = ctx.tournament;
  const threshold =
    phase === "Bracket"
      ? Math.min(...opponents.map(({ score }) => score)) - myScore
      : phase === "Final" && round === 3
        ? opponents[0].score - myScore - finalMargin
        : NaN;
  // Bank a narrow survival margin when a further purchase is unlikely.
  if (!(threshold >= 0) || ctx.myBalance >= recentCommonPrice(ctx) * 1.5)
    return planned;
  const pack = cashOut(ctx.lexicon, rackCounts(ctx.myRack));
  return pack.score >= Math.max(24, threshold + 8) ? pack.plays : planned;
}

function closingBid(ctx: BidPosition): number {
  const baseline = incumbent.decideBid(ctx);
  if (ctx.bagTotal < 2 || ctx.bagTotal > 8 || baseline >= ctx.myBalance)
    return baseline;
  const counts = rackCounts(ctx.myRack);
  const before = cashOut(ctx.lexicon, counts).score;
  counts[ALPHABET.indexOf(ctx.letter)]++;
  const gain = cashOut(ctx.lexicon, counts).score - before;
  if (gain < 6) return baseline;
  // Preserve one more likely purchase, then price readily realizable points
  // at a lower cash shadow price than early speculative rack improvements.
  const price = recentCommonPrice(ctx);
  const room = Math.max(0, ctx.myBalance - Math.ceil(price));
  const cap = Math.min(room, Math.floor(2.4 * gain + price));
  return Math.max(
    baseline,
    ctx.auctionType === "Vickrey" ? cap : shadedBid(ctx, cap, price),
  );
}

export const experiments: Readonly<Record<string, Strategy>> = {
  reward: {
    ...incumbent,
    rackEventsOnly: true,
    choosePlays: (ctx) => bestPlay(ctx, (play) => play.score),
    decideBid: faceBid,
  },
  liquidity: { ...incumbent, choosePlays: liquidityPlays },
  marginal: { ...incumbent, decideBid: marginalBid },
  combined: {
    ...incumbent,
    choosePlays: liquidityPlays,
    decideBid: marginalBid,
  },
  opponent: {
    ...incumbent,
    choosePlays: (ctx) => incumbent.choosePlays(opponentSupply(ctx)),
    decideBid: (ctx) => incumbent.decideBid(opponentSupply(ctx)),
  },
  phase: { ...incumbent, choosePlays: phasePlays },
  closing: { ...incumbent, decideBid: closingBid },
};
