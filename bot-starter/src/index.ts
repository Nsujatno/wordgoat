// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
import {
  DbConnection,
  tables,
  type EventContext,
  type ErrorContext,
  type SubscriptionHandle,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALPHABET, BAG_COUNTS, LETTER_VALUE, rackCounts } from "./lexicon.js";
import { type BidObservation } from "./strategy.js";
import { TurnPlanner } from "./turn-planner.js";
import "dotenv/config";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

const planner = new TurnPlanner();
const BID_MARGIN_MS = 160;

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let connection: DbConnection | undefined;
let token = BOT_TOKEN ?? loadToken();
let reconnectDelay = 500;
let ready = false;
let turnQueued = false;
let lifecycleQueued = false;
let lobbyPoll: ReturnType<typeof setInterval> | undefined;
let joinRequestedAt: number | undefined;
let nextJoinAttempt = 0;
let queuedLobby: bigint | undefined;
let warnedOverdue = false;
const matchFeeds = new Map<
  bigint,
  { handle: SubscriptionHandle; applied: boolean }
>();
interface Turn {
  auctionId: bigint;
  participantId: bigint;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  searching: boolean;
  bid?: bigint;
}
const turns = new Map<bigint, Turn>();
const pendingWords = new Set<bigint>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function marketForMatch(
  conn: DbConnection,
  matchId: bigint,
  rack: Map<string, number>,
  letter: string,
) {
  const drawn = Array<number>(26).fill(0);
  const starting = rackCounts(rack);
  const market: BidObservation[] = [];
  const results = Array.from(
    conn.db.auctionResult.resultByMatch.filter(matchId),
  ).sort((a, b) => Number(a.auctionId - b.auctionId));
  for (const result of results) {
    const index = ALPHABET.indexOf(result.letter);
    const won = result.winnerBotId === myBotId;
    if (index >= 0) {
      drawn[index]++;
      if (won) starting[index]--;
    }
    market.push({
      letter: result.letter,
      paid: Number(result.paid),
      result: won ? "won" : result.winnerBotId === undefined ? "unbid" : "lost",
    });
  }
  // Reconstruct only our own initial deal. Other starting racks are hidden,
  // so the remaining counts are upper bounds, not a claim about the bag.
  for (const play of conn.db.wordPlay.playByMatch.filter(matchId)) {
    if (play.botId !== myBotId) continue;
    for (const tile of play.word) starting[ALPHABET.indexOf(tile)]++;
  }
  const available = BAG_COUNTS.map((count, index) =>
    Math.max(
      0,
      count -
        drawn[index] -
        Math.max(0, starting[index]) -
        Number(ALPHABET[index] === letter),
    ),
  );
  return { market, available };
}

function queueTurn(conn: DbConnection) {
  if (conn !== connection || !ready || turnQueued) return;
  turnQueued = true;
  queueMicrotask(() => {
    turnQueued = false;
    playTurn(conn);
  });
}

function playTurn(conn: DbConnection) {
  if (conn !== connection || !ready) return;
  for (const participant of conn.db.matchParticipant.iter()) {
    const { matchId } = participant;
    if (!matchFeeds.get(matchId)?.applied) continue;
    const match = conn.db.matchState.id.find(matchId);
    if (match?.status.tag !== "Running" || match.currentAuctionId === undefined)
      continue;
    const auction = conn.db.auction.id.find(match.currentAuctionId);
    if (auction?.status.tag !== "Open") continue;
    const previous = turns.get(matchId);
    if (previous?.auctionId !== auction.id) {
      clearTimeout(previous?.timer);
      // Server timestamps determine the window length. Start a monotonic
      // local budget on receipt so clock skew cannot suppress every bid.
      const windowMs = Number(
        auction.closesAt.microsSinceUnixEpoch - auction.opensAt.microsSinceUnixEpoch,
      ) / 1000;
      const deadline = performance.now() + windowMs;
      const timer = setTimeout(
        () => {
          // Keep a small legal bid in flight if search or word confirmation
          // runs long. The penultimate bid is already handled at open, and
          // only word plays matter in the final window.
          if (match.bagTotal <= 1) return;
          const turn = turns.get(matchId);
          if (turn?.auctionId === auction.id && turn.bid === undefined) {
            console.warn(
              `[${BOT_NAME}] using deadline bid for auction ${auction.id}`,
            );
            submitTurnBid(
              conn,
              matchId,
              turn,
              Math.min(3, LETTER_VALUE[auction.letter]),
            );
          }
        },
        Math.max(0, windowMs - BID_MARGIN_MS),
      );
      const turn = {
        auctionId: auction.id,
        participantId: participant.id,
        deadline,
        timer,
        searching: false,
      };
      turns.set(matchId, turn);
      if (match.bagTotal === 1)
        submitTurnBid(conn, matchId, turn, Number(participant.balance));
    }
    const turn = turns.get(matchId)!;
    if (turn.searching || pendingWords.has(matchId) || planner.busy) continue;
    turn.searching = true;

    const myRack = rackForMatch(conn, matchId);
    const { market, available } = marketForMatch(
      conn,
      matchId,
      myRack,
      auction.letter,
    );
    const position = {
      myRack,
      myBalance: Number(participant.balance),
      bagTotal: match.bagTotal,
      auctionType: match.auctionType.tag,
      letter: auction.letter,
      market,
      available,
    };
    void planner
      .plan({ position, playWords: true })
      .then(async ({ plays, bid }) => {
        const live = activeParticipant(conn, matchId, turn);
        if (!live) return;
        if (
          live.score !== participant.score ||
          live.balance !== participant.balance
        ) {
          turn.searching = false;
          queueTurn(conn);
          return;
        }
        clearTimeout(turn.timer);
        submitTurnBid(conn, matchId, turn, bid);
        if (!plays.length) return;
        pendingWords.add(matchId);
        const results = await Promise.allSettled(
          plays.map(({ word, score }) => {
            console.log(
              `[${BOT_NAME}] match ${matchId}: playing '${word}' for ${score}`,
            );
            return conn.reducers.submitWord({ matchId, word });
          }),
        );
        if (connection !== conn) return;
        pendingWords.delete(matchId);
        if (results.some((result) => result.status === "rejected")) {
          for (const result of results) {
            if (result.status === "rejected")
              logFailure(
                `playing word in match ${matchId}, auction ${auction.id}`,
              )(result.reason);
          }
          const refreshed = activeParticipant(conn, matchId, turn);
          if (refreshed) {
            const refreshedPosition = {
              ...position,
              myRack: rackForMatch(conn, matchId),
              myBalance: Number(refreshed.balance),
            };
            void planner
              .plan({ position: refreshedPosition, playWords: false })
              .then(({ bid }) => submitTurnBid(conn, matchId, turn, bid))
              .catch(logFailure("recomputing bid"))
              .finally(() => queueTurn(conn));
          }
        } else {
          submitTurnBid(conn, matchId, turn, bid);
        }
        queueTurn(conn);
      })
      .catch(logFailure("planning turn"))
      .finally(() => queueTurn(conn));
  }
}

function activeParticipant(conn: DbConnection, matchId: bigint, turn: Turn) {
  if (
    conn !== connection ||
    !ready ||
    turns.get(matchId) !== turn ||
    performance.now() >= turn.deadline
  )
    return;
  const match = conn.db.matchState.id.find(matchId);
  if (
    match?.status.tag !== "Running" ||
    match.currentAuctionId !== turn.auctionId
  )
    return;
  return conn.db.matchParticipant.id.find(turn.participantId);
}

function submitTurnBid(
  conn: DbConnection,
  matchId: bigint,
  turn: Turn,
  target: number,
  retry = true,
) {
  const participant = activeParticipant(conn, matchId, turn);
  if (!participant) return;
  const amount = BigInt(Math.min(target, Number(participant.balance)));
  if (retry && amount === (turn.bid ?? 0n)) return;
  turn.bid = amount;
  console.log(
    `[${BOT_NAME}] bid ${amount} (match ${matchId}, auction ${turn.auctionId})`,
  );
  void conn.reducers
    .submitBid({ auctionId: turn.auctionId, amount })
    .catch((error: unknown) => {
      logFailure(`bid on auction ${turn.auctionId}`)(error);
      if (
        retry &&
        turn.bid === amount &&
        turn.deadline - performance.now() > BID_MARGIN_MS
      ) {
        submitTurnBid(conn, matchId, turn, target, false);
      }
    });
}

function onConnect(
  conn: DbConnection,
  identity: Identity,
  connectedToken: string,
) {
  connection = conn;
  reconnectDelay = 500;
  myIdentity = identity;
  token = connectedToken;
  saveToken(connectedToken);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onError((ctx) => logFailure("subscribing to game state")(ctx.event))
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            if (conn !== connection) return;
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribe([tables.bot, tables.botCredential]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open" && matchFeeds.get(a.matchId)?.applied)
      queueTurn(conn);
  });
  conn.db.myRack.onInsert(() => queueTurn(conn));
  conn.db.myRack.onUpdate(() => queueTurn(conn));
  conn.db.myRack.onDelete(() => queueTurn(conn));
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (!matchFeeds.get(r.matchId)?.applied || r.winnerBotId !== myBotId)
      return;
    console.log(
      `[${BOT_NAME}] match ${r.matchId}: won '${r.letter}' for ${r.paid}`,
    );
  });

  conn.db.openLobbies.onInsert(() => queueLifecycle(conn));
  conn.db.openLobbies.onUpdate(() => queueLifecycle(conn));
  conn.db.openLobbies.onDelete(() => queueLifecycle(conn));
  conn.db.openLobbyMembers.onInsert(() => queueLifecycle(conn));
  conn.db.openLobbyMembers.onDelete(() => queueLifecycle(conn));
  conn.db.matchParticipant.onInsert(() => queueLifecycle(conn));
  conn.db.matchState.onInsert(() => queueLifecycle(conn));
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (old.status.tag !== neu.status.tag) queueLifecycle(conn);
    if (old.currentAuctionId !== neu.currentAuctionId) queueTurn(conn);
  });
}

function queueLifecycle(conn: DbConnection) {
  if (conn !== connection || !ready || lifecycleQueued) return;
  lifecycleQueued = true;
  queueMicrotask(() => {
    lifecycleQueued = false;
    if (conn === connection && ready && !syncMatchFeeds(conn) && !TOURNAMENT_ID)
      joinLobby(conn);
  });
}

function syncMatchFeeds(conn: DbConnection): boolean {
  let inMatch = false;
  for (const { matchId, score } of conn.db.matchParticipant.iter()) {
    const match = conn.db.matchState.id.find(matchId);
    const feed = matchFeeds.get(matchId);
    if (match?.status.tag !== "Running") {
      if (feed) {
        matchFeeds.delete(matchId);
        clearTimeout(turns.get(matchId)?.timer);
        turns.delete(matchId);
        feed.handle.unsubscribe();
        console.log(
          `[${BOT_NAME}] match ${matchId} ended with ${score} points`,
        );
      }
      continue;
    }
    inMatch = true;
    if (feed) continue;
    console.log(
      `[${BOT_NAME}] seated in match ${matchId} (round ${match.currentRound})`,
    );
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        const current = matchFeeds.get(matchId);
        if (current?.handle !== handle) return;
        current.applied = true;
        queueTurn(conn);
      })
      .onError((ctx) => {
        if (matchFeeds.get(matchId)?.handle === handle)
          matchFeeds.delete(matchId);
        logFailure(`loading match ${matchId}`)(ctx.event);
      })
      .subscribe([
        tables.auction.where((row) => row.matchId.eq(matchId)),
        tables.auctionResult.where((row) => row.matchId.eq(matchId)),
        tables.wordPlay.where((row) => row.matchId.eq(matchId)),
        tables.myRack.where((row) => row.matchId.eq(matchId)),
      ]);
    matchFeeds.set(matchId, { handle, applied: false });
  }
  return inMatch;
}

function joinLobby(conn: DbConnection) {
  const lobby = conn.db.openLobbies.iter().next().value;
  const membership =
    lobby &&
    Array.from(conn.db.openLobbyMembers.iter()).find(
      (member) => member.lobbyId === lobby.id && member.botId === myBotId,
    );
  if (lobby && membership) {
    const seconds = Math.ceil(
      (Number(lobby.closesAt.microsSinceUnixEpoch) / 1000 - Date.now()) / 1000,
    );
    if (queuedLobby !== lobby.id) {
      queuedLobby = lobby.id;
      warnedOverdue = false;
      const players = conn.db.openLobbyMembers.count();
      console.log(
        `[${BOT_NAME}] queued in lobby ${lobby.id} (${players}/${lobby.maxSize}). Starts when full or at the ${Math.max(0, seconds)}s deadline.`,
      );
    }
    if (!warnedOverdue && seconds < -5) {
      warnedOverdue = true;
      console.warn(
        `[${BOT_NAME}] lobby ${lobby.id} is past its deadline. Waiting for the server to start the match.`,
      );
    }
    return;
  }
  queuedLobby = undefined;
  const now = Date.now();
  if (now < nextJoinAttempt) return;
  if (joinRequestedAt !== undefined) {
    if (now - joinRequestedAt < 15_000) return;
    console.warn(
      `[${BOT_NAME}] no lobby join confirmation after 15s. Retrying.`,
    );
  }
  joinRequestedAt = now;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers
    .joinLobby({})
    .catch((error: unknown) => {
      if (joinRequestedAt !== now) return;
      nextJoinAttempt = Date.now() + 15_000;
      logFailure("joining the lobby")(error);
    })
    .finally(() => {
      if (joinRequestedAt === now) joinRequestedAt = undefined;
    });
}

function bootstrapActivity(conn: DbConnection) {
  if (myBotId === null) return;
  const botId = myBotId;
  // The public auction tables contain millions of rows. Discover our matches
  // first, then subscribe to auction and rack data one active match at a time.
  conn
    .subscriptionBuilder()
    .onError((ctx) => logFailure("tracking lobbies and matches")(ctx.event))
    .onApplied(() => {
      ready = true;
      if (TOURNAMENT_ID) {
        conn.reducers
          .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
          .then(() =>
            console.log(
              `[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`,
            ),
          )
          .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
      }
      queueLifecycle(conn);
      lobbyPoll = setInterval(() => queueLifecycle(conn), 5000);
    })
    .subscribe([
      tables.openLobbies,
      tables.openLobbyMembers,
      tables.matchParticipant.where((row) => row.botId.eq(botId)),
      `SELECT match_state.* FROM match_state JOIN match_participant ON match_state.id = match_participant.match_id WHERE match_participant.bot_id = ${botId}`,
    ]);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  const next = DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(token)
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      scheduleReconnect();
    })
    .onDisconnect(() => {
      if (connection !== next) return;
      connection = undefined;
      ready = false;
      clearInterval(lobbyPoll);
      for (const turn of turns.values()) clearTimeout(turn.timer);
      turns.clear();
      matchFeeds.clear();
      pendingWords.clear();
      myIdentity = null;
      myBotId = null;
      joinRequestedAt = undefined;
      nextJoinAttempt = 0;
      queuedLobby = undefined;
      console.log(`[${BOT_NAME}] disconnected`);
      scheduleReconnect();
    })
    .build();
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    main();
  }, reconnectDelay);
  reconnectDelay = Math.min(15_000, reconnectDelay * 2);
}

main();
