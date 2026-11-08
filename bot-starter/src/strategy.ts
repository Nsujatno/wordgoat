import {
  ALPHABET,
  BAG_COUNTS,
  Lexicon,
  VALUES,
  cashOut,
  rackCounts,
  spend,
  type Play,
} from "./lexicon.js";

export { LETTER_VALUE } from "./lexicon.js";

export interface Position {
  myRack: ReadonlyMap<string, number>;
  myBalance: number;
  lexicon: Lexicon;
  // Unrevealed tiles, excluding the one currently up for auction.
  bagTotal: number;
  // Upper bounds after removing public draws and our own starting tiles.
  available?: readonly number[];
  auctionType?: "Vickrey" | "FirstPrice";
  letter?: string;
  market?: readonly BidObservation[];
}

export interface BidObservation {
  letter: string;
  paid: number;
  result: "won" | "lost" | "unbid";
}

export interface BidContext extends Position {
  letter: string;
  auctionType: "Vickrey" | "FirstPrice";
}

const FLEXIBILITY = [
  1.3, 0.6, 1.0, 1.1, 1.6, 0.4, 0.9, 0.8, 1.1, 0.0, 0.5, 1.4, 0.8, 1.5, 1.0,
  1.0, -1.1, 1.5, 2.0, 1.5, 0.0, 0.1, 0.2, -0.4, 0.6, -0.2,
];
const VOWELS = "AEIOU";
const TILE_CREDITS = VALUES.map((face, slot) =>
  Math.max(0.7, 0.85 * face + FLEXIBILITY[slot]),
);
const MAX_RACK_COPIES = Math.max(...BAG_COUNTS) + 1;
const COPY_COSTS = TILE_CREDITS.map((credit) => {
  const costs = Array<number>(MAX_RACK_COPIES + 1).fill(0.65 * credit);
  costs[1] = credit;
  return costs;
});

function tileCredit(letter: number, count: number): number {
  // Duplicates compete for the same hooks. High-face tiles still have value
  // in a good word, which rackEquity accounts for separately below.
  return (
    TILE_CREDITS[letter] * (Math.min(count, 1) + 0.65 * Math.max(0, count - 1))
  );
}

function rackEquity(
  lexicon: Lexicon,
  counts: number[],
  available: readonly number[],
  horizon: number,
): number {
  const credit = counts.reduce(
    (sum, count, letter) => sum + tileCredit(letter, count),
    0,
  );
  let surplus = 0;
  lexicon.visit(
    counts,
    (play, missing, leaveCost) => {
      const gain = play.score - leaveCost;
      if (missing < 0) {
        surplus = Math.max(surplus, gain);
      } else {
        const probability = Math.min(
          0.68,
          0.17 + horizon * 0.009 * Math.min(4, available[missing]),
        );
        surplus = Math.max(
          surplus,
          probability * (gain - 2.1 * VALUES[missing] - 2),
        );
      }
    },
    available,
    COPY_COSTS,
  );
  return credit + surplus;
}

function marketOffset(letter: string): number {
  return VOWELS.includes(letter) ? 2 : 0;
}

function firstPriceBid(ctx: BidContext, letter: number, limit: number): number {
  const center = VALUES[letter] + marketOffset(ctx.letter);
  // Start with a broad prior, then learn from this match's public payments.
  // On our own wins the opposing high bid is censored below what we paid.
  const prices = [-1, 0, 1, 2, 3, 5].map((offset) => ({
    price: Math.max(1, center + offset),
    weight: 1,
  }));
  for (const result of ctx.market ?? []) {
    const index = ALPHABET.indexOf(result.letter);
    if (index < 0) continue;
    const difference = center - VALUES[index] - marketOffset(result.letter);
    const weight =
      result.letter === ctx.letter
        ? 2
        : 0.8 / (1 + Math.abs(difference) * 0.18);
    if (result.result === "unbid") {
      prices.push({ price: 0, weight });
    } else if (result.result === "lost") {
      prices.push({ price: Math.max(1, result.paid + difference), weight });
    } else {
      for (let discount = 0; discount <= 3; discount++) {
        prices.push({
          price: Math.max(0, result.paid + difference - discount),
          weight: weight / 8,
        });
      }
    }
  }

  let bestBid = 1;
  let bestUtility = 0;
  for (let bid = 1; bid <= Math.floor(limit); bid++) {
    let wins = 0;
    for (const { price, weight } of prices) {
      if (price < bid) wins += weight;
      else if (price === bid) wins += 0.45 * weight;
    }
    const utility = wins * (limit + 0.75 - bid);
    if (utility > bestUtility) {
      bestUtility = utility;
      bestBid = bid;
    }
  }
  return bestBid;
}

function facePricePremium(letter: number): number {
  return 2.5 * (VALUES[letter] - 1);
}

function commonTilePrice(market: readonly BidObservation[] = []): number {
  // Normalize recent public payments to a one-point tile. Losing payments
  // are a conservative estimate of the price we'd have to beat.
  const samples = market.slice(-16).flatMap(({ letter, paid }) => {
    const slot = ALPHABET.indexOf(letter);
    return slot < 0 ? [] : [Math.max(1, paid - facePricePremium(slot))];
  });
  if (samples.length < 3) return 8;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function hasProfitableUpgrade(
  ctx: Position,
  counts: number[],
  reward: number,
  commonPrice: number,
): boolean {
  let worthWaiting = false;
  ctx.lexicon.visit(
    counts,
    (play, missing) => {
      if (
        missing >= 0 &&
        play.score - reward > commonPrice + facePricePremium(missing)
      ) {
        worthWaiting = true;
      }
    },
    ctx.available ?? BAG_COUNTS,
  );
  return worthWaiting;
}

function waitForRevealedTile(
  ctx: Position,
  counts: number[],
  play: Play,
  commonPrice: number,
): boolean {
  const letter = ctx.letter;
  if (!letter || letter.length !== 1) return false;
  const slot = ALPHABET.indexOf(letter);
  if (slot < 0) return false;
  const price = Math.max(1, Math.ceil(commonPrice + facePricePremium(slot)));
  if (ctx.myBalance < price) return false;

  // Compare both lines after winning the revealed tile. A payout can break
  // a better combination even when the remaining letters still make a word.
  counts[slot]++;
  const holdScore = cashOut(ctx.lexicon, counts).score;
  spend(counts, play);
  const playScore = play.score + cashOut(ctx.lexicon, counts).score;
  spend(counts, play, 1);
  counts[slot]--;
  return (
    holdScore - playScore >= 7 &&
    decideBid({ ...ctx, letter, auctionType: "Vickrey" }) >= price
  );
}

export function decideBid(ctx: BidContext): number {
  const letter = ALPHABET.indexOf(ctx.letter);
  if (
    ctx.letter.length !== 1 ||
    letter < 0 ||
    ctx.myBalance < 1 ||
    ctx.bagTotal === 0
  )
    return 0;
  const counts = rackCounts(ctx.myRack);

  if (ctx.bagTotal === 1) {
    // A win here leaves one auction window to play the tile. Cash has no
    // further use, so only an improvement in realizable score matters.
    const before = cashOut(ctx.lexicon, counts).score;
    counts[letter]++;
    return cashOut(ctx.lexicon, counts).score > before ? ctx.myBalance : 0;
  }

  const available = ctx.available ?? BAG_COUNTS;
  const before = rackEquity(ctx.lexicon, counts, available, ctx.bagTotal);
  const copies = counts[letter]++;
  const improvement =
    rackEquity(ctx.lexicon, counts, available, ctx.bagTotal) - before;
  const vowelCount = Array.from(VOWELS).reduce(
    (sum, vowel) => sum + counts[ALPHABET.indexOf(vowel)],
    0,
  );
  const tileCount = counts.reduce((sum, count) => sum + count, 0);
  const vowelShare =
    (vowelCount - Number(VOWELS.includes(ctx.letter)) + 2) / (tileCount + 4);
  const balanceBonus = VOWELS.includes(ctx.letter)
    ? 5 * (0.42 - vowelShare)
    : 4 * (vowelShare - 0.42);

  const usefulFuture = Math.min(1, (ctx.bagTotal - 1) / 12);
  const flexibility = Math.max(
    0,
    3.5 + 1.8 * FLEXIBILITY[letter] + balanceBonus - 1.6 * copies,
  );
  const secondPrice = ctx.auctionType === "Vickrey";
  // In a costly field, a face point that makes it into a long word is worth
  // more than another interchangeable tile. An unsupported Q is risky,
  // and a second copy of a pricey letter is harder to score.
  const face = VALUES[letter];
  const unsupportedQ =
    ctx.letter === "Q" && !counts[ALPHABET.indexOf("U")] && improvement < 14;
  const scoringPremium = secondPrice
    ? 2.15 * (face - 1) * (unsupportedQ ? 0.35 : 1) * (copies ? 0.5 : 1)
    : 0;
  const immediate = improvement * (ctx.bagTotal < 8 ? 1.65 : 1.1);
  const urgency = Math.max(0, 1 - ctx.bagTotal / 22);
  // Second-price bids usually cost less than their cap, so the same bank
  // balance can support more aggressive bidding than in first-price play.
  const desiredBalance = secondPrice
    ? 18 + 0.9 * ctx.bagTotal
    : 20 + 1.15 * ctx.bagTotal;
  const budgetPressure = Math.min(
    1.8,
    Math.max(0.7, desiredBalance / (ctx.myBalance + 16)),
  );
  const value =
    ((immediate + usefulFuture * (flexibility + scoringPremium)) *
      ((secondPrice ? 0.85 : 1) + 1.25 * urgency)) /
    budgetPressure;
  let limit = Math.min(ctx.myBalance, Math.max(1, Math.floor(value)));
  if (
    secondPrice &&
    ctx.bagTotal <= 18 &&
    face >= 3 &&
    tileCount <= 4 &&
    limit > 8
  ) {
    // With a thin rack late in the game, a pricey tile should lead to a
    // meaningful payout with at most one more purchase.
    let reachable = 0;
    ctx.lexicon.visit(
      counts,
      (play) => {
        reachable = Math.max(reachable, play.score);
      },
      available,
    );
    if (reachable < 15)
      limit = Math.min(limit, Math.max(1, Math.floor(0.7 * reachable)));
  }
  if (secondPrice && ctx.bagTotal <= 7 && limit < ctx.myBalance) {
    const withTile = cashOut(ctx.lexicon, counts).score;
    counts[letter]--;
    const gain = Math.max(0, withTile - cashOut(ctx.lexicon, counts).score);
    limit = Math.min(ctx.myBalance, Math.floor(limit + 0.55 * gain));
  }
  return ctx.auctionType === "FirstPrice"
    ? firstPriceBid(ctx, letter, limit)
    : limit;
}

export function choosePlays(ctx: Position): Play[] {
  const counts = rackCounts(ctx.myRack);
  const tiles = counts.reduce((sum, count) => sum + count, 0);
  if (tiles < 2) return [];
  if (ctx.bagTotal === 0) return cashOut(ctx.lexicon, counts).plays;

  const secondPrice = ctx.auctionType !== "FirstPrice";
  const price = commonTilePrice(ctx.market);
  // Protect a funded rack in the endgame: there is little time to rebuild,
  // unless a large rack has low cash and already holds a strong payout.
  const holdHorizon = 18;
  const holdBudget = secondPrice
    ? Math.min(6 * ctx.bagTotal, Math.max(12, price))
    : Math.min(6 * ctx.bagTotal, Math.max(12, 2 * price));
  const unlockEndgame =
    secondPrice && ctx.bagTotal >= 5 && tiles >= 9 && ctx.myBalance < 28;
  if (
    ctx.bagTotal <= holdHorizon &&
    ctx.myBalance >= holdBudget &&
    !unlockEndgame
  )
    return [];
  const canWait = ctx.bagTotal > 5 && ctx.myBalance >= 28;
  const minimumLength =
    ctx.myBalance < 7
      ? 2
      : ctx.myBalance < 12
        ? 4
        : tiles >= (secondPrice ? 16 : 15)
          ? 5
          : ctx.myBalance < 23 || tiles >= (secondPrice ? 14 : 13)
            ? 6
            : 7;

  let best: Play | undefined;
  let bestValue = -Infinity;
  const seedBonusPerTile = secondPrice && ctx.bagTotal >= 18 ? 1.0 : 0;
  ctx.lexicon.visit(counts, (play) => {
    const length = play.letters.length;
    const largePayout = secondPrice && length >= 5 && play.score >= 42;
    if (length < minimumLength && !largePayout) return;
    if (unlockEndgame && play.score < 42) return;
    if (secondPrice) {
      const waitFloor =
        length <= 8 &&
        (ctx.bagTotal <= 38 ||
          (tiles >= 9 && ctx.bagTotal <= 44 && ctx.myBalance < 42))
          ? 48
          : 50;
      if (canWait && play.score < waitFloor) return;
    } else if (
      length >= 7 &&
      tiles < 10 &&
      ctx.myBalance >= 45 &&
      play.score < 36
    ) {
      return;
    }
    const leave = counts.reduce(
      (sum, count, letter) => sum + tileCredit(letter, count),
      0,
    );
    const kept = Math.min(4, tiles - length);
    const value =
      play.score +
      0.95 * leave +
      kept * seedBonusPerTile +
      0.15 * Math.min(7, length);
    if (value > bestValue) {
      best = play;
      bestValue = value;
    }
  });
  if (secondPrice && best) {
    // For a strong ready word, wait for a one-tile upgrade only when its
    // extra payout can cover the expected cost of the missing letter.
    const upgradeCap = tiles >= 9 && ctx.myBalance < 38 ? 48 : 57;
    if (
      (canWait || unlockEndgame) &&
      best.score < upgradeCap &&
      hasProfitableUpgrade(ctx, counts, best.score, price)
    )
      return [];
    if (waitForRevealedTile(ctx, counts, best, price)) return [];
  }
  return best ? [best] : [];
}

// Use the extra window when winning the penultimate tile cannot improve
// the rack's terminal payout. A missed final event then costs no points.
export function chooseTournamentPlays(ctx: Position): Play[] {
  const planned = choosePlays(ctx);
  if (planned.length || ctx.bagTotal !== 1 || !ctx.letter) return planned;
  const slot = ALPHABET.indexOf(ctx.letter);
  if (ctx.letter.length !== 1 || slot < 0) return planned;
  const counts = rackCounts(ctx.myRack);
  const pack = cashOut(ctx.lexicon, counts);
  if (!pack.plays.length || ctx.myBalance < 1) return pack.plays;
  counts[slot]++;
  return cashOut(ctx.lexicon, counts).score > pack.score ? [] : pack.plays;
}

export function decideTournamentBid(ctx: BidContext): number {
  // One later window remains to score this tile, but no later tile can be
  // scored by an external bot. Unspent cash has no value after this auction.
  // A win also denies the tile to an opponent who could improve their place.
  if (
    ctx.bagTotal === 1 &&
    ctx.letter.length === 1 &&
    ALPHABET.includes(ctx.letter)
  )
    return Math.max(0, Math.floor(ctx.myBalance));
  return decideBid(ctx);
}
