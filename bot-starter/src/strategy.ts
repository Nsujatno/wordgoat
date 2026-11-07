import {
  ALPHABET,
  BAG_COUNTS,
  Lexicon,
  VALUES,
  cashOut,
  rackCounts,
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
}

export interface BidObservation {
  letter: string;
  paid: number;
  result: "won" | "lost" | "unbid";
}

export interface BidContext extends Position {
  letter: string;
  auctionType: "Vickrey" | "FirstPrice";
  market?: readonly BidObservation[];
}

const FLEXIBILITY = [
  1.3, 0.6, 1.0, 1.1, 1.6, 0.4, 0.9, 0.8, 1.1, 0.0, 0.5, 1.4, 0.8, 1.5, 1.0,
  1.0, -1.1, 1.5, 2.0, 1.5, 0.0, 0.1, 0.2, -0.4, 0.6, -0.2,
];
const VOWELS = "AEIOU";

function tileCredit(letter: number, count: number): number {
  // Duplicates compete for the same hooks. High-face tiles still have value
  // in a good word, which rackEquity accounts for separately below.
  const credit = Math.max(0.7, 0.85 * VALUES[letter] + FLEXIBILITY[letter]);
  return credit * (Math.min(count, 1) + 0.65 * Math.max(0, count - 1));
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
    (play, missing) => {
      // During a visit the counts are the leave, since the trie has already
      // used the word's tiles. Credit only the copies still on the rack.
      let leave = credit;
      for (let i = 0; i < play.letters.length;) {
        const letter = play.letters[i];
        let used = 0;
        while (play.letters[i] === letter) {
          used++;
          i++;
        }
        if (letter === missing) used--;
        leave +=
          tileCredit(letter, counts[letter]) -
          tileCredit(letter, counts[letter] + used);
      }
      const gain = play.score + leave - credit;
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
  const immediate = improvement * (ctx.bagTotal < 8 ? 1.65 : 1.1);
  const urgency = Math.max(0, 1 - ctx.bagTotal / 22);
  // Second-price bids usually cost less than their cap, so the same bank
  // balance can support more aggressive bidding than in first-price play.
  const desiredBalance =
    ctx.auctionType === "Vickrey"
      ? 18 + 0.9 * ctx.bagTotal
      : 20 + 1.15 * ctx.bagTotal;
  const budgetPressure = Math.min(
    1.8,
    Math.max(0.7, desiredBalance / (ctx.myBalance + 16)),
  );
  const value =
    ((immediate + usefulFuture * flexibility) * (1 + 1.25 * urgency)) /
    budgetPressure;
  const limit = Math.min(ctx.myBalance, Math.max(1, Math.floor(value)));
  return ctx.auctionType === "FirstPrice"
    ? firstPriceBid(ctx, letter, limit)
    : limit;
}

export function choosePlays(ctx: Position): Play[] {
  const counts = rackCounts(ctx.myRack);
  const tiles = counts.reduce((sum, count) => sum + count, 0);
  if (tiles < 2) return [];
  if (ctx.bagTotal === 0) return cashOut(ctx.lexicon, counts).plays;

  // Keep hooks for late acquisitions when we already have enough to bid.
  if (ctx.bagTotal <= 7 && ctx.myBalance >= 6 * ctx.bagTotal) return [];
  const minimumLength =
    ctx.myBalance < 7
      ? 2
      : ctx.myBalance < 12
        ? 4
        : tiles >= 15
          ? 5
          : ctx.myBalance < 23 || tiles >= 13
            ? 6
            : 7;

  let best: Play | undefined;
  let bestValue = -Infinity;
  ctx.lexicon.visit(counts, (play) => {
    const length = play.letters.length;
    if (length < minimumLength) return;
    // With a small rack and plenty of cash, keep high-value tiles available
    // for a more lucrative bingo unless this one already pays well.
    if (length >= 7 && tiles < 10 && ctx.myBalance >= 45 && play.score < 36)
      return;
    const leave = counts.reduce(
      (sum, count, letter) => sum + tileCredit(letter, count),
      0,
    );
    const value = play.score + 0.95 * leave + 0.15 * length;
    if (value > bestValue) {
      best = play;
      bestValue = value;
    }
  });
  return best ? [best] : [];
}
