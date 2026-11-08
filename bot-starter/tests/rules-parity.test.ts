import { auctionOutcome, current } from "../src/benchmark";
import { ALPHABET, BAG_COUNTS, VALUES, rackCounts } from "../src/lexicon";
import { tableSizes } from "../src/tournament-benchmark";
import { DEFAULT_BAG, letterValue } from "../../spacetimedb/src/letters";
import { submitBid, submitWord } from "../../spacetimedb/src/index";
import { tableSizes as moduleTableSizes } from "../../spacetimedb/src/tournament";
import {
  call,
  currentAuction,
  emptyDb,
  getMatch,
  participant,
  setRack,
  startMatch,
  teamWithBot,
  tick,
} from "../../spacetimedb/src/tests/harness";

test("bag and table sizing agree with the module", () => {
  expect(DEFAULT_BAG).toEqual(
    Array.from(ALPHABET, (letter, i) => [letter, BAG_COUNTS[i]]),
  );
  expect(Array.from(ALPHABET, letterValue)).toEqual(VALUES);
  for (let entrants = 2; entrants < 24; entrants++) {
    for (let size = 2; size < 10; size++)
      expect(tableSizes(entrants, size)).toEqual(
        moduleTableSizes(entrants, size),
      );
  }
});

for (const tag of ["Vickrey", "FirstPrice"] as const) {
  test(`simulated payment and indexed rewards agree with ${tag} reducers`, () => {
    const db = emptyDb();
    const ids = [
      teamWithBot(db, "owner0", "bidder0"),
      teamWithBot(db, "owner1", "bidder1"),
    ];
    const id = startMatch(db, { tag }, ids);
    expect(getMatch(db, id).bagTotal).toBe(87);
    const auctionId = currentAuction(db, id).id;
    setRack(db, id, ids[0], "QIUZEHOSSTCAH");
    for (const word of ["QUIZ", "SHOES", "CHAT"]) {
      let indexed: number | undefined;
      const counts = rackCounts(
        new Map(
          Array.from(word, (tile) => [
            tile,
            [...word].filter((copy) => copy === tile).length,
          ]),
        ),
      );
      current.strategy.lexicon.visit(counts, (play) => {
        if (play.word.length === word.length) indexed = play.score;
      });
      const prior = participant(db, id, ids[0]);
      call(db, "bidder0", (tx) => submitWord(tx, { matchId: id, word }));
      const after = participant(db, id, ids[0]);
      expect(Number(after.score - prior.score)).toBe(indexed);
      expect(Number(after.balance - prior.balance)).toBe(indexed);
    }
    const bids = [
      { id: 0, amount: 11, tie: 0.1 },
      { id: 1, amount: 8, tie: 0.2 },
    ];
    call(db, "bidder0", (tx) => submitBid(tx, { auctionId, amount: 9n }));
    for (const bid of bids) {
      call(db, `bidder${bid.id}`, (tx) =>
        submitBid(tx, { auctionId, amount: BigInt(bid.amount) }),
      );
    }
    tick(db, id);
    const expected = auctionOutcome(bids, tag);
    const result = db.db.auctionResult.auctionId.find(auctionId);
    expect(result?.winnerBotId).toBe(ids[expected.winner!]);
    expect(result?.paid).toBe(BigInt(expected.paid));
  });
}
