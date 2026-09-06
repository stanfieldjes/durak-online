/**
 * Contract tests between the browser engine, the SQL in supabase/schema.sql,
 * and the rating model. Run with: node tests/sync.test.mjs
 *
 * The concurrency section is the important one. Attacking is free-for-all, so
 * two players genuinely can submit moves built on the same position. If the
 * version guard is wrong, one of those cards silently disappears.
 */
import {
  newGame,
  applyMove,
  availableMoves,
  seatsToAct,
  cardId,
  IllegalMove,
} from '../src/js/durak.js';
import {
  ratingChanges,
  expectedScore,
  actualScore,
  START,
  K,
  FLOOR,
} from '../src/js/elo.js';

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL: ' + msg); };
const check = (label, cond) => { if (!cond) fail(label); };

const countCards = (state) => {
  const n = state.deck.length
    + state.hands.reduce((a, h) => a + h.length, 0)
    + state.table.reduce((a, s) => a + (s.def ? 2 : 1), 0);
  return n + state.discard;
};

/* ---- 1. the SQL guard never rejects a legal move ---------------------- */
// Mirror of submit_move():
//   if my_seat <> defender and table_len = 0 and my_seat <> attacker
//     then raise 'the opening card belongs to the attacker'
const sqlWouldReject = (state, seat) =>
  seat !== state.defender && state.table.length === 0 && seat !== state.attacker;

console.log('Checking the SQL guard against the engine...');
let checked = 0;
for (const players of [2, 3, 4]) {
  for (let g = 0; g < 250; g++) {
    let state = newGame(g, players);
    let guard = 0;
    while (!state.finished && guard++ < 3000) {
      for (const seat of seatsToAct(state)) {
        if (sqlWouldReject(state, seat)) {
          fail(`${players}p game ${g}: SQL would reject seat ${seat}, which the engine allows`);
        }
        checked++;
      }
      const actors = seatsToAct(state);
      const seat = actors[guard % actors.length];
      const moves = availableMoves(state, seat);
      state = applyMove(state, seat, moves[guard % moves.length]);
    }
  }
}
console.log(`  ${checked} eligible-seat decisions agreed`);

/* ---- 2. versions advance by exactly one ------------------------------- */
// submit_move() requires p_state.version = stored version + 1.
console.log('Checking version numbering...');
for (const players of [2, 3, 4]) {
  let state = newGame(7, players);
  let expected = 0;
  let guard = 0;
  check(`${players}p: a fresh deal is version 0`, state.version === 0);
  while (!state.finished && guard++ < 2000) {
    const actors = seatsToAct(state);
    const seat = actors[guard % actors.length];
    const moves = availableMoves(state, seat);
    const before = state.version;
    state = applyMove(state, seat, moves[guard % moves.length]);
    expected += 1;
    if (state.version !== before + 1) {
      fail(`${players}p: version went ${before} -> ${state.version}`);
      break;
    }
  }
  check(`${players}p: version tracks the move count`, state.version === expected);
}

/* ---- 3. simultaneous submissions -------------------------------------- */
/**
 * Stand-in for submit_move(). Accepts a write only if it was built on the
 * version currently stored, exactly as the SQL does.
 */
function makeServer(initial) {
  let stored = initial;
  return {
    read: () => JSON.parse(JSON.stringify(stored)),
    submit(next, baseVersion) {
      if (stored.version !== baseVersion) throw new Error('stale position');
      if (next.version !== stored.version + 1) throw new Error('bad version step');
      stored = next;
      return this.read();
    },
  };
}

console.log('Checking that simultaneous moves cannot lose a card...');
{
  let collisions = 0;
  let retriesThatSucceeded = 0;
  let retriesAbandoned = 0;

  for (let g = 0; g < 600; g++) {
    const server = makeServer(newGame(g, 4));
    let guard = 0;

    while (!server.read().finished && guard++ < 2000) {
      const snapshot = server.read();
      const actors = seatsToAct(snapshot);
      if (actors.length === 0) break;

      // Two players read the same position and both decide to move.
      const movers = actors.slice(0, 2);
      const attempts = movers.map((seat) => {
        const moves = availableMoves(snapshot, seat);
        const move = moves[guard % moves.length];
        return { seat, move, base: snapshot.version, next: applyMove(snapshot, seat, move) };
      });

      let accepted = 0;
      for (const attempt of attempts) {
        try {
          server.submit(attempt.next, attempt.base);
          accepted++;
        } catch (err) {
          if (!/stale position/.test(err.message)) {
            fail(`game ${g}: unexpected rejection: ${err.message}`);
            break;
          }
          collisions++;
          // What the client does next: re-read and re-apply if still legal.
          const fresh = server.read();
          if (fresh.finished) { retriesAbandoned++; continue; }
          let replayed;
          try {
            replayed = applyMove(fresh, attempt.seat, attempt.move);
          } catch (e) {
            if (!(e instanceof IllegalMove)) fail(`game ${g}: retry threw ${e.message}`);
            retriesAbandoned++; // the move stopped being legal — correct outcome
            continue;
          }
          server.submit(replayed, fresh.version);
          retriesThatSucceeded++;
        }
      }

      if (attempts.length > 1 && accepted > 1) {
        fail(`game ${g}: the server accepted two writes on the same version`);
      }

      const now = server.read();
      if (countCards(now) !== 36) {
        fail(`game ${g}: ${countCards(now)} cards after concurrent writes, expected 36`);
        break;
      }
    }
  }

  console.log(`  ${collisions} collisions: ${retriesThatSucceeded} retried cleanly, ` +
    `${retriesAbandoned} correctly dropped as no longer legal`);
  check('collisions actually occurred, so the guard was exercised', collisions > 0);
}

/* ---- 4. deals reproduce from the seed --------------------------------- */
// join_game() trusts the last player to deal from the stored seed.
console.log('Checking deals are reproducible from the seed...');
for (const seed of [0, 1, 42, 999, 2147483645]) {
  for (const players of [2, 3, 4]) {
    const a = JSON.stringify(newGame(seed, players));
    const b = JSON.stringify(newGame(seed, players));
    if (a !== b) fail(`seed ${seed} at ${players}p dealt two different games`);
  }
}
check('different seeds deal differently',
  JSON.stringify(newGame(1, 4)) !== JSON.stringify(newGame(2, 4)));
check('the same seed deals differently for different table sizes',
  JSON.stringify(newGame(1, 3)) !== JSON.stringify(newGame(1, 4)));

/* ---- 5. ratings ------------------------------------------------------- */

console.log('Checking rating behaviour...');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

check('everyone starts at 100', START === 100);

// Two players: one loser, one winner, so it must be symmetric.
{
  const [w, l] = ratingChanges([START, START], 1);
  check('an even heads-up game moves 5 points', w === 5 && l === -5);
}

// Three and four players: losing costs much more than winning gains.
for (const n of [3, 4]) {
  const ratings = Array(n).fill(START);
  const deltas = ratingChanges(ratings, 0);
  const durak = deltas[0];
  const survivor = deltas[1];
  check(`${n}p: the durak loses 5`, Math.abs(durak + 5) < 0.01);
  // The durak's loss is split among the n-1 survivors, so it is that much larger.
  check(`${n}p: losing costs (n-1)x what winning gains`,
    Math.abs(durak) >= survivor * (n - 1) - 0.02);
  check(`${n}p: winning is a small bonus`, survivor > 0 && survivor < 3);
  check(`${n}p: the pool is zero sum`, Math.abs(sum(deltas)) < 0.05);
}

// Zero sum across a wide sweep of ratings and table sizes.
for (const n of [2, 3, 4]) {
  for (let spread = 0; spread <= 120; spread += 17) {
    const ratings = Array.from({ length: n }, (_, i) => START + i * spread);
    for (let durak = -1; durak < n; durak++) {
      const deltas = ratingChanges(ratings, durak);
      if (Math.abs(sum(deltas)) > 0.05) {
        fail(`${n}p: not zero sum at spread ${spread}, durak ${durak} (sum ${sum(deltas)})`);
      }
      for (const d of deltas) {
        if (Math.abs(d) > K + 0.01) fail(`${n}p: a rating moved more than K`);
      }
    }
  }
}

// Draws move nothing when everyone is equal.
{
  const deltas = ratingChanges([START, START, START], -1);
  check('an even draw moves nothing', deltas.every((d) => Math.abs(d) < 0.01));
}

// Being the durak against stronger players is more forgivable.
{
  const vsStrong = ratingChanges([100, 180, 180], 0)[0];
  const vsWeak = ratingChanges([100, 40, 40], 0)[0];
  check('losing to stronger players costs less', vsStrong > vsWeak);
  check('losing to much weaker players is punished hard', vsWeak < -6);
}

// The floor holds.
{
  const deltas = ratingChanges([1, 150, 150], 0);
  check('a rating never drops below the floor', 1 + deltas[0] >= FLOOR - 0.001);
}

// Someone who is always the durak sinks to the floor and stays there.
{
  let rating = START;
  for (let i = 0; i < 500; i++) {
    rating = Math.max(FLOOR, rating + ratingChanges([rating, START, START, START], 0)[0]);
  }
  check('a player who always loses ends at the floor', rating < 5);
}

// Someone who is never the durak climbs to a ceiling and stops. Survivors at a
// four-player table share a score of 2/3, so no rating can outrun that.
{
  let rating = START;
  for (let i = 0; i < 500; i++) {
    rating += ratingChanges([rating, START, START, START], 1)[0];
  }
  check('a player who never loses settles near the ceiling',
    rating > 140 && rating < 190);
}

// A realistic bad run costs real ground: being the durak 40% of the time at a
// four-player table should sit well below the starting rating.
{
  let rating = START;
  for (let i = 0; i < 2000; i++) {
    const durak = i % 5 < 2 ? 0 : 1;          // durak 40% of the time
    rating += ratingChanges([rating, START, START, START], durak)[0];
  }
  check('a 40% durak rate settles well below start', rating > 40 && rating < 85);
}

// Scores on both sides sum to n/2, which is why the pool balances.
for (const n of [2, 3, 4]) {
  const ratings = Array.from({ length: n }, (_, i) => 60 + i * 30);
  const expectedTotal = sum(ratings.map((_, s) => expectedScore(ratings, s)));
  const actualTotal = sum(ratings.map((_, s) => actualScore(n, s, 0)));
  check(`${n}p: expected scores sum to n/2`, Math.abs(expectedTotal - n / 2) < 1e-9);
  check(`${n}p: actual scores sum to n/2`, Math.abs(actualTotal - n / 2) < 1e-9);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
