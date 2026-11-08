import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Lexicon, cashOut, rackCounts } from "./lexicon.js";
import { choosePlays, decideBid } from "./strategy.js";

function rack(letters: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of letters)
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
}

test("word search scores the length bonus and respects repeated tiles", () => {
  const lexicon = new Lexicon(["QUIZ", "QUARTZ", "JAZZ"]);
  const counts = rackCounts(rack("QUARTZJIZ"));
  const scores = new Map<string, number>();
  lexicon.visit(counts, (play) => scores.set(play.word, play.score));
  assert.deepEqual(
    scores,
    new Map([
      ["QUIZ", 33],
      ["QUARTZ", 60],
      ["JAZZ", 43],
    ]),
  );
  const withoutSecondZ = cashOut(lexicon, rackCounts(rack("JAZ")));
  assert.equal(withoutSecondZ.score, 0);
});

test("final cash-out picks disjoint words with a higher total than the best single word", () => {
  const lexicon = new Lexicon(["ABCDEFGHI", "ABCDEFG", "HIJKLMN"]);
  const plays = choosePlays({
    myRack: rack("ABCDEFGHIJKLMN"),
    myBalance: 100,
    bagTotal: 0,
    lexicon,
  });
  assert.deepEqual(
    new Set(plays.map((play) => play.word)),
    new Set(["ABCDEFG", "HIJKLMN"]),
  );
});

test("holds short words for a bonus while cash is available and liquidates under pressure", () => {
  const position = {
    myRack: rack("QUARTS"),
    myBalance: 100,
    bagTotal: 40,
    lexicon: new Lexicon(["QUARTS"]),
  };
  assert.deepEqual(choosePlays(position), []);
  assert.equal(choosePlays({ ...position, myBalance: 12 })[0]?.word, "QUARTS");
});

test("penultimate bid goes to a scoring upgrade and final bid is skipped", () => {
  const ctx = {
    myRack: rack("QUART"),
    myBalance: 37,
    bagTotal: 1,
    letter: "Z",
    lexicon: new Lexicon(["QUART", "QUARTZ"]),
    auctionType: "Vickrey" as const,
  };
  assert.equal(decideBid(ctx), 37);
  assert.equal(decideBid({ ...ctx, letter: "X" }), 0);
  assert.equal(decideBid({ ...ctx, bagTotal: 0 }), 0);
});

test("second-price play keeps a modest seven-letter word while there is cash to improve it", () => {
  const position = {
    myRack: rack("RETAINS"),
    myBalance: 40,
    bagTotal: 35,
    lexicon: new Lexicon(["RETAINS"]),
    auctionType: "Vickrey" as const,
  };
  assert.deepEqual(choosePlays(position), []);
  assert.equal(choosePlays({ ...position, myBalance: 20 })[0]?.word, "RETAINS");
});

test("second-price bidding pays a premium for a high-face scoring hook", () => {
  const position = {
    myRack: rack("EALOUS"),
    myBalance: 100,
    bagTotal: 45,
    lexicon: new Lexicon(["JEALOUS", "ZEALOUS", "AEROSOL"]),
    auctionType: "Vickrey" as const,
  };
  assert.ok(
    decideBid({ ...position, letter: "J" }) >
      decideBid({ ...position, letter: "R" }) + 10,
  );
});

test("banks PIQUETS when the available upgrades cost more than their extra payout", () => {
  const position = {
    myRack: rack("EIPQSTU"),
    myBalance: 32,
    bagTotal: 60,
    lexicon: new Lexicon(["PIQUETS", "PICQUETS", "POSTIQUE"]),
    auctionType: "Vickrey" as const,
  };
  assert.equal(choosePlays(position)[0]?.word, "PIQUETS");

  const market = ["A", "E", "R"].map((letter) => ({
    letter,
    paid: 3,
    result: "lost" as const,
  }));
  assert.deepEqual(choosePlays({ ...position, market }), []);
  const available = Array<number>(26).fill(1);
  available[2] = 0; // C has already been dealt or auctioned.
  assert.equal(
    choosePlays({ ...position, market, available })[0]?.word,
    "PIQUETS",
  );
});

test("banks a higher payout even when it uses fewer letters", () => {
  const position = {
    myRack: rack("ABEEHRTYZ"),
    myBalance: 27,
    bagTotal: 37,
    lexicon: new Lexicon(["BREEZY", "BREATHY"]),
    auctionType: "Vickrey" as const,
  };
  assert.equal(choosePlays(position)[0]?.word, "BREEZY");
});

test("keeps a word intact when the revealed tile is an affordable upgrade", () => {
  const position = {
    myRack: rack("JESTER"),
    myBalance: 10,
    bagTotal: 13,
    letter: "S",
    lexicon: new Lexicon(["JESTER", "JESTERS"]),
    auctionType: "Vickrey" as const,
  };
  assert.deepEqual(choosePlays(position), []);
  assert.equal(choosePlays({ ...position, myBalance: 7 })[0]?.word, "JESTER");
});

test("late Vickrey bids cap a stranded Q while paying for a reachable X word", () => {
  const position = {
    myBalance: 35,
    bagTotal: 16,
    lexicon: new Lexicon(["QAT", "QUA", "EXIT", "TEXT"]),
    auctionType: "Vickrey" as const,
  };
  assert.ok(decideBid({ ...position, myRack: rack("A"), letter: "Q" }) <= 8);
  assert.ok(decideBid({ ...position, myRack: rack("ET"), letter: "X" }) >= 20);
});

test("first-price bidding shades a bid for a valuable completion and respects the balance", () => {
  const ctx = {
    myRack: rack("QUART"),
    myBalance: 100,
    bagTotal: 15,
    letter: "Z",
    lexicon: new Lexicon(["QUART", "QUARTZ"]),
    auctionType: "Vickrey" as const,
  };
  const firstPrice = decideBid({ ...ctx, auctionType: "FirstPrice" });
  assert.ok(firstPrice > 0 && firstPrice < decideBid(ctx));
  assert.equal(decideBid({ ...ctx, myBalance: 0 }), 0);
  assert.equal(decideBid({ ...ctx, myBalance: 1 }), 1);
});

test("early and middle-game bonus targets stay intact while cash is available", () => {
  const lexicon = new Lexicon([
    "JOINERS",
    "HAYWIRE",
    "GINGHAM",
    "VANISHED",
    "REJOINED",
    "FISHWAY",
    "HOMAGING",
    "HARVESTING",
  ]);
  const losses = Array.from({ length: 12 }, () => ({
    letter: "E",
    paid: 12,
    result: "lost" as const,
  }));
  for (const [letters, balance, word] of [
    ["EIIJNORS", 40, "JOINERS"],
    ["AEFHIRWY", 39, "HAYWIRE"],
    ["AEGGHIMNN", 42, "GINGHAM"],
    ["ADEHINSV", 44, "VANISHED"],
  ] as const) {
    const ctx = {
      myRack: rack(letters),
      myBalance: balance,
      bagTotal: 40,
      lexicon,
      auctionType: "Vickrey" as const,
      market: losses,
    };
    assert.deepEqual(choosePlays(ctx), []);
    assert.equal(choosePlays({ ...ctx, myBalance: 20 })[0]?.word, word);
    assert.deepEqual(
      choosePlays({ ...ctx, bagTotal: 46 }),
      [],
      "build for the larger bonus early",
    );
    assert.deepEqual(
      choosePlays({ ...ctx, bagTotal: 18 }),
      [],
      "avoid restarting a funded rack late",
    );
    assert.deepEqual(
      choosePlays({ ...ctx, myBalance: 50 }),
      [],
      "retain the larger payout target while funded",
    );
  }
});

test("a dry spell alone does not force a low-value seven-letter payout", () => {
  assert.deepEqual(
    choosePlays({
      myRack: rack("RETAINS"),
      myBalance: 40,
      bagTotal: 40,
      lexicon: new Lexicon(["RETAINS"]),
      market: Array.from({ length: 20 }, () => ({
        letter: "E",
        paid: 12,
        result: "lost" as const,
      })),
    }),
    [],
  );
});

test("first-price endgame preserves funded combinations, liquidates when needed, and always cashes out at the end", () => {
  const ctx = {
    myRack: rack("QUARTS"),
    myBalance: 20,
    bagTotal: 15,
    lexicon: new Lexicon(["QUARTS"]),
    auctionType: "FirstPrice" as const,
    market: Array.from({ length: 3 }, () => ({
      letter: "E",
      paid: 3,
      result: "lost" as const,
    })),
  };
  assert.deepEqual(choosePlays(ctx), []);
  assert.equal(choosePlays({ ...ctx, bagTotal: 19 })[0]?.word, "QUARTS");
  assert.equal(choosePlays({ ...ctx, myBalance: 10 })[0]?.word, "QUARTS");
  assert.deepEqual(choosePlays({ ...ctx, auctionType: "Vickrey" }), []);
  assert.equal(choosePlays({ ...ctx, bagTotal: 0 })[0]?.word, "QUARTS");
});

test("Vickrey preserves a funded late rack while first-price reserves two purchases", () => {
  const ctx = {
    myRack: rack("FISHWAY"),
    myBalance: 20,
    bagTotal: 18,
    lexicon: new Lexicon(["FISHWAY"]),
    auctionType: "Vickrey" as const,
    market: Array.from({ length: 3 }, () => ({
      letter: "E",
      paid: 12,
      result: "lost" as const,
    })),
  };
  assert.deepEqual(choosePlays(ctx), []);
  assert.equal(choosePlays({ ...ctx, bagTotal: 19 })[0]?.word, "FISHWAY");
  assert.equal(choosePlays({ ...ctx, myBalance: 11 })[0]?.word, "FISHWAY");
  assert.equal(
    choosePlays({ ...ctx, auctionType: "FirstPrice" })[0]?.word,
    "FISHWAY",
  );
  assert.deepEqual(
    choosePlays({ ...ctx, auctionType: "FirstPrice", myBalance: 24 }),
    [],
  );
  assert.equal(choosePlays({ ...ctx, bagTotal: 0 })[0]?.word, "FISHWAY");
});

test("indexed bidding and final cash-out fit comfortably in an auction window", () => {
  const dictionary = readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/);
  const lexicon = new Lexicon(dictionary);
  const ctx = {
    myRack: rack("AEINRSTLGCBDUOWPXQZ"),
    myBalance: 100,
    bagTotal: 7,
    lexicon,
  };
  const start = performance.now();
  decideBid({ ...ctx, auctionType: "Vickrey", letter: "E" });
  choosePlays({ ...ctx, bagTotal: 0 });
  assert.ok(performance.now() - start < 150, "search took 150 ms or more");
});
