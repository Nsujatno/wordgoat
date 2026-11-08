import assert from "node:assert/strict";
import test from "node:test";
import {
  auctionOutcome,
  current,
  simulateMatch,
  type MatchPosition,
} from "./benchmark.js";
import { experiments } from "./experiments.js";
import { Lexicon } from "./lexicon.js";
import {
  pairedInterval,
  pairedRateInterval,
  placement,
  tableSizes,
} from "./tournament-benchmark.js";
import { TurnPlanner } from "./turn-planner.js";
import { chooseTournamentPlays, decideTournamentBid } from "./strategy.js";

test("auction settlement skips zero bids, breaks ties, and handles the reserve", () => {
  const bids = [
    { id: 1, amount: 4, tie: 0.8 },
    { id: 0, amount: 4, tie: 0.2 },
  ];
  assert.deepEqual(auctionOutcome(bids, "Vickrey"), { winner: 0, paid: 4 });
  assert.deepEqual(auctionOutcome(bids.slice(0, 1), "FirstPrice"), {
    winner: 1,
    paid: 4,
  });
  assert.deepEqual(auctionOutcome(bids.slice(0, 1), "Vickrey"), {
    winner: 1,
    paid: 1,
  });
  assert.deepEqual(
    auctionOutcome([{ id: 0, amount: 0, tie: 0.1 }], "Vickrey"),
    { winner: undefined, paid: 0 },
  );
});

test("common seeds fix the deal, external bots cannot play the final won tile, and accounting closes", () => {
  const reveals: string[] = [];
  const active = {
    ...current.strategy,
    choosePlays: () => [],
    decideBid: ({ letter, bagTotal }: { letter: string; bagTotal: number }) => {
      reveals.push(letter);
      return bagTotal === 0 ? 1 : 0;
    },
  };
  const idle = { ...active, decideBid: () => 0 };
  const run = () =>
    simulateMatch(123, [active, idle], "Vickrey", current.strategy);
  const first = run();
  const sequence = reveals.splice(0);
  assert.deepEqual(run(), first);
  assert.deepEqual(reveals, sequence);
  assert.equal(sequence.length, 88);
  assert.deepEqual(first[0], {
    score: 0,
    balance: 99,
    wins: 1,
    bids: 1,
    spent: 1,
    words: 0,
    lettersPlayed: 0,
    auctions: 88,
  });
});

test("placements and intervals preserve paired outcomes and competition ties", () => {
  assert.deepEqual(tableSizes(13, 6), [7, 6]);
  assert.deepEqual(placement([40, 40, 22, 22], 2, 3), {
    place: 3,
    swissPoints: 1,
    first: 0,
    outrightFirst: 0,
    last: 1,
  });
  assert.deepEqual(pairedInterval([11, 22, 33], [13, 24, 35]), {
    delta: 2,
    lower: 2,
    upper: 2,
  });
  const sparse = pairedRateInterval([1, 0, 1], [1, 0, 1]);
  assert.equal(sparse.delta, 0);
  assert.ok(sparse.lower < 0 && sparse.upper > 0);
});

test("highest reward and liquidity choices are legal and candidate bids stay affordable", () => {
  const position = {
    lexicon: new Lexicon(["QUIZ", "RAISE"]),
    myRack: new Map(
      Array.from("QUIZRAISE", (tile) => [tile, tile === "I" ? 2 : 1]),
    ),
    myBalance: 15,
    bagTotal: 31,
    auctionType: "Vickrey" as const,
    letter: "T",
  };
  assert.equal(experiments.reward.choosePlays(position)[0]?.word, "QUIZ");
  assert.equal(experiments.liquidity.choosePlays(position)[0]?.word, "QUIZ");
  for (const strategy of Object.values(experiments)) {
    const bid = strategy.decideBid(position);
    assert.ok(
      Number.isSafeInteger(bid) && bid >= 0 && bid <= position.myBalance,
    );
  }
});

test("the local worker can finish a rack while the network event loop stays free", async () => {
  const worker = new TurnPlanner();
  try {
    const pending = worker.plan({
      position: {
        myRack: new Map(Array.from("QUIZ", (tile) => [tile, 1])),
        myBalance: 5,
        bagTotal: 0,
        auctionType: "Vickrey",
        letter: "E",
      },
      playWords: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const plan = await pending;
    assert.equal(plan.plays[0]?.word, "QUIZ");
    assert.equal(plan.bid, 0);
  } finally {
    await worker.close();
  }
});

test("the penultimate window banks ONAGERS when the revealed tile cannot improve it", () => {
  const position = {
    lexicon: new Lexicon(["ONAGERS", "ZONERS"]),
    myRack: new Map(Array.from("ONAGERS", (tile) => [tile, 1])),
    myBalance: 34,
    bagTotal: 1,
    auctionType: "Vickrey" as const,
  };
  assert.equal(
    chooseTournamentPlays({ ...position, letter: "E" })[0]?.word,
    "ONAGERS",
  );
  assert.deepEqual(chooseTournamentPlays({ ...position, letter: "Z" }), []);
  assert.equal(
    chooseTournamentPlays({ ...position, bagTotal: 0, letter: "Z" })[0]?.word,
    "ONAGERS",
  );
});

test("a tournament bid can deny a penultimate tile, but skips the final tile", () => {
  const position = {
    lexicon: new Lexicon(["ONAGERS"]),
    myRack: new Map<string, number>(),
    myBalance: 23,
    bagTotal: 1,
    auctionType: "FirstPrice" as const,
    letter: "Z",
  };
  assert.equal(decideTournamentBid(position), 23);
  assert.equal(decideTournamentBid({ ...position, bagTotal: 0 }), 0);
});

test("a penultimate denial can change opponent score without changing our own", () => {
  const idle = {
    ...current.strategy,
    choosePlays: () => [],
    decideBid: () => 0,
  };
  let rack: string[] = [];
  let tile = "";
  const observe = {
    ...idle,
    decideBid: (ctx: MatchPosition) => {
      if (ctx.bagTotal === 87) {
        rack = Array.from(ctx.myRack).flatMap(([letter, count]) =>
          Array<string>(count).fill(letter),
        );
      }
      if (ctx.bagTotal === 1) tile = ctx.letter!;
      return 0;
    },
  };
  simulateMatch(7201, [idle, observe], "Vickrey", idle);
  const lexicon = new Lexicon([[...rack, tile].join("")]);
  const rival = {
    ...idle,
    lexicon,
    choosePlays: (ctx: Parameters<typeof current.strategy.choosePlays>[0]) =>
      ctx.bagTotal === 0 ? chooseTournamentPlays(ctx) : [],
    decideBid: (ctx: Parameters<typeof current.strategy.decideBid>[0]) =>
      Number(ctx.bagTotal === 1),
  };
  const deny = {
    ...idle,
    decideBid: (ctx: Parameters<typeof current.strategy.decideBid>[0]) =>
      ctx.bagTotal === 1 ? decideTournamentBid(ctx) : 0,
  };
  const before = simulateMatch(7201, [idle, rival], "Vickrey", idle);
  const after = simulateMatch(7201, [deny, rival], "Vickrey", idle);
  assert.ok(before[1].score > 0);
  assert.equal(after[1].score, 0);
  assert.equal(before[0].score, after[0].score);
});
