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
    myRack: rack("QUARTZ"),
    myBalance: 100,
    bagTotal: 40,
    lexicon: new Lexicon(["QUARTZ"]),
  };
  assert.deepEqual(choosePlays(position), []);
  assert.equal(choosePlays({ ...position, myBalance: 12 })[0]?.word, "QUARTZ");
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
