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

check('everyone starts at 500', START === 500);

// Every change is a whole number, and they still cancel out exactly.
for (const n of [2, 3, 4]) {
  for (let spread = 0; spread <= 120; spread += 13) {
    const ratings = Array.from({ length: n }, (_, i) => START + i * spread);
    for (let durak = -1; durak < n; durak++) {
      const deltas = ratingChanges(ratings, durak);
      if (!deltas.every(Number.isInteger)) {
        fail(`${n}p: fractional change at spread ${spread}, durak ${durak}: ${deltas}`);
      }
      if (sum(deltas) !== 0) {
        fail(`${n}p: changes sum to ${sum(deltas)} at spread ${spread}, durak ${durak}`);
      }
      for (const d of deltas) {
        if (Math.abs(d) > K) fail(`${n}p: a rating moved ${d}, more than K`);
      }
    }
  }
}

// Two players: one loser, one winner, so it has to be symmetric.
{
  const [w, l] = ratingChanges([START, START], 1);
  check('an even heads-up game moves 20 points', w === 20 && l === -20);
}

// A rating gap should visibly damp the result. This is the whole reason for the
// larger base: at the old scale a 50-point gap only moved 5 points to 4.
{
  const even = ratingChanges([START, START], 1)[0];
  const by50 = ratingChanges([START + 50, START], 1)[0];
  const by100 = ratingChanges([START + 100, START], 1)[0];
  const by200 = ratingChanges([START + 200, START], 1)[0];
  check('a 50-point favourite gains clearly less', by50 <= even - 5);
  check('gains keep shrinking as the gap widens', by100 < by50 && by200 < by100);
  check('a heavy favourite gains almost nothing', by200 <= 5);

  // And the upset is worth more than an expected win.
  const upset = ratingChanges([START + 200, START], 0)[1];
  check('beating a much stronger player pays well', upset >= even + 10);
}

// Three and four players: losing costs much more than winning gains, because
// the durak's loss is split among everyone who got out.
for (const [n, expectedDurak, expectedSurvivor] of [[3, -20, 10], [4, -21, 7]]) {
  const deltas = ratingChanges(Array(n).fill(START), 0);
  check(`${n}p: the durak loses ${-expectedDurak}`, deltas[0] === expectedDurak);
  check(`${n}p: each survivor gains ${expectedSurvivor}`,
    deltas.slice(1).every((d) => d === expectedSurvivor));
  check(`${n}p: losing costs (n-1)x what winning gains`,
    Math.abs(deltas[0]) === expectedSurvivor * (n - 1));
}

// Draws move nothing when everyone is equal.
check('an even draw moves nothing',
  ratingChanges([START, START, START], -1).every((d) => d === 0));

// Being the durak against stronger players is more forgivable.
//
// On the 500 base these separate cleanly. At the old 100 base a loss to equals
// and a loss to much weaker players both rounded to the same figure.
{
  const vsStrong = ratingChanges([500, 580, 580], 0)[0];
  const vsEqual = ratingChanges([500, 500, 500], 0)[0];
  const vsWeak = ratingChanges([500, 420, 420], 0)[0];
  check('losing to stronger players costs least', vsStrong > vsEqual);
  check('losing to much weaker players costs most', vsWeak < vsEqual);
  check('the three cases are clearly separated', vsStrong - vsEqual >= 5 && vsEqual - vsWeak >= 5);
}

// The floor holds.
check('a rating never drops below the floor',
  1 + ratingChanges([1, 550, 550], 0)[0] >= FLOOR);

// Someone who is always the durak sinks a long way. The fall slows as it goes,
// because a rating that low is expected to lose, so the floor is not actually
// reached in any realistic number of games.
{
  let rating = START;
  for (let i = 0; i < 2000; i++) {
    rating = Math.max(FLOOR, rating + ratingChanges([rating, START, START, START], 0)[0]);
  }
  check('a player who always loses ends far below start', rating < 300 && rating >= FLOOR);
}

// Someone who is never the durak climbs to a ceiling and stops, because
// survivors at a four-player table share a single score that no rating can
// outrun.
{
  let rating = START;
  for (let i = 0; i < 2000; i++) {
    rating += ratingChanges([rating, START, START, START], 1)[0];
  }
  check('a player who never loses settles near the ceiling',
    rating > 530 && rating < 590);
}

// Realistic rates land either side of the starting rating.
{
  const settle = (rate) => {
    let rating = START;
    for (let i = 0; i < 6000; i++) {
      const durak = i % 10 < rate ? 0 : 1;
      rating = Math.max(FLOOR, rating + ratingChanges([rating, START, START, START], durak)[0]);
    }
    return rating;
  };
  const bad = settle(4);    // durak 40% of the time
  const good = settle(1);   // durak 10% of the time
  check('a 40% durak rate settles below start', bad > 440 && bad < START);
  check('a 10% durak rate settles above start', good > START && good < 590);
  check('the two are clearly apart', good - bad > 40);
}

// Scores on both sides sum to n/2, which is why the pool balances.
for (const n of [2, 3, 4]) {
  const ratings = Array.from({ length: n }, (_, i) => 460 + i * 30);
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
