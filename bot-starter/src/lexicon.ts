export const LETTER_VALUE: Record<string, number> = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10,
};

export const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const VALUES = Array.from(ALPHABET, (letter) => LETTER_VALUE[letter]);
export const BAG_COUNTS = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];

export function rackCounts(rack: ReadonlyMap<string, number>): number[] {
  return Array.from(ALPHABET, (letter) => rack.get(letter) ?? 0);
}

export interface Play {
  word: string;
  letters: number[];
  face: number;
  score: number;
}

interface Node {
  letter: number;
  child?: Node;
  sibling?: Node;
  play?: Play;
}

// Index each letter multiset once. Anagrams consume the same tiles for the
// same reward, so search only needs one legal spelling per terminal node.
export class Lexicon {
  private readonly root: Node = { letter: -1 };

  constructor(dictionary: readonly string[]) {
    for (const word of dictionary) {
      if (!/^[A-Z]{2,}$/.test(word)) continue;
      const letters = Array.from(word, (letter) => letter.charCodeAt(0) - 65);
      letters.sort((a, b) => a - b);
      let node = this.root;
      for (const letter of letters) {
        let child = node.child;
        while (child && child.letter !== letter) child = child.sibling;
        if (!child) {
          child = { letter, sibling: node.child };
          node.child = child;
        }
        node = child;
      }
      if (node.play) continue;
      const face = letters.reduce((sum, letter) => sum + VALUES[letter], 0);
      const multiplier = Math.min(6, Math.max(2, letters.length - 1));
      node.play = {
        word,
        letters,
        face,
        score: Math.floor((face * multiplier) / 2),
      };
    }
  }

  // With `available`, also report words missing exactly one available tile.
  // A single traversal handles both ordinary plays and all one-tile upgrades.
  visit(
    counts: number[],
    report: (play: Play, missing: number) => void,
    available?: readonly number[],
  ): void {
    const search = (node: Node, missing: number) => {
      if (node.play) report(node.play, missing);
      for (let child = node.child; child; child = child.sibling) {
        const letter = child.letter;
        if (counts[letter] > 0) {
          counts[letter]--;
          search(child, missing);
          counts[letter]++;
        } else if (missing < 0 && available && available[letter] > 0) {
          search(child, letter);
        }
      }
    };
    search(this.root, -1);
  }
}

export function spend(
  counts: number[],
  play: Play,
  direction: -1 | 1 = -1,
): void {
  for (const letter of play.letters) counts[letter] += direction;
}

export interface CashOut {
  score: number;
  plays: Play[];
}

// Pack disjoint words rather than consuming a high-scoring word that blocks
// a better combination. The search keeps a legal incumbent under its work cap.
export function cashOut(lexicon: Lexicon, counts: number[]): CashOut {
  const plays: Play[] = [];
  lexicon.visit(counts, (play) => plays.push(play));
  plays.sort(
    (a, b) => b.score - a.score || b.letters.length - a.letters.length,
  );
  const byLetter: Play[][] = Array.from(ALPHABET, () => []);
  for (const play of plays) {
    for (let i = 0; i < play.letters.length; i++) {
      const letter = play.letters[i];
      if (letter !== play.letters[i - 1]) byLetter[letter].push(play);
    }
  }

  let best: CashOut = { score: 0, plays: [] };
  const chosen: Play[] = [];
  const seen = new Map<string, number>();
  let work = 20_000;

  const search = (score: number, face: number) => {
    if (score > best.score) best = { score, plays: [...chosen] };
    if (score + 3 * face <= best.score || work <= 0) return;
    const key = String.fromCharCode(...counts);
    if ((seen.get(key) ?? -1) >= score) return;
    seen.set(key, score);

    // Every solution uses this letter in a word or leaves one copy unused.
    let pivot = -1;
    for (let letter = 0; letter < counts.length; letter++) {
      if (
        counts[letter] &&
        (pivot < 0 || byLetter[letter].length < byLetter[pivot].length)
      )
        pivot = letter;
    }
    for (const play of byLetter[pivot]) {
      if (--work < 0) break;
      if (score + play.score + 3 * (face - play.face) <= best.score) continue;
      spend(counts, play);
      if (play.letters.every((letter) => counts[letter] >= 0)) {
        chosen.push(play);
        search(score + play.score, face - play.face);
        chosen.pop();
      }
      spend(counts, play, 1);
    }
    counts[pivot]--;
    search(score, face - VALUES[pivot]);
    counts[pivot]++;
  };

  search(
    0,
    counts.reduce((sum, count, letter) => sum + count * VALUES[letter], 0),
  );
  return best;
}
