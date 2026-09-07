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
  computeScore,
  expectedDurakChance,
  durakRate,
  expectedRate,
} from '../src/js/score.js';

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

console.log('Checking score behaviour...');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Mirror of public.score() in supabase/schema.sql. */
const sqlScore = (games, duraks, expected) =>
  games <= 0 ? 0 : Math.sign(100 * (expected - duraks) / games)
    * Math.round(Math.abs(100 * (expected - duraks) / games));

// Each seat carries 1/n of the blame, because every game has exactly one durak.
for (const n of [2, 3, 4]) {
  check(`${n}p: a seat's expected share is 1/${n}`,
    Math.abs(expectedDurakChance(n) - 1 / n) < 1e-12);
}
check('a table\'s shares add up to exactly one durak',
  [2, 3, 4].every((n) => Math.abs(n * expectedDurakChance(n) - 1) < 1e-12));

// The worked example from the spec: seven games, two at 2p, one at 3p, four at
// 4p, which expects a 33% durak rate.
{
  const expected = 2 * (1 / 2) + 1 * (1 / 3) + 4 * (1 / 4);
  const games = 7;
  check('seven mixed games expect a 33% durak rate',
    Math.round(expectedRate({ games, expectedDuraks: expected })) === 33);
  check('a 30% actual durak rate scores +3',
    computeScore({ games, duraks: 0.30 * games, expectedDuraks: expected }) === 3);
  check('a 48% actual durak rate scores -15',
    computeScore({ games, duraks: 0.48 * games, expectedDuraks: expected }) === -15);
}

// Matching expectation exactly scores zero, at every table size.
for (const n of [2, 3, 4]) {
  const games = 100;
  const expected = games / n;
  check(`${n}p: losing exactly as often as expected scores zero`,
    computeScore({ games, duraks: expected, expectedDuraks: expected }) === 0);
}

// Direction and bounds.
{
  const games = 40;
  const expected = games / 4; // all four-player tables
  const better = computeScore({ games, duraks: 5, expectedDuraks: expected });
  const worse = computeScore({ games, duraks: 15, expectedDuraks: expected });
  check('losing less often than expected scores positive', better > 0);
  check('losing more often than expected scores negative', worse < 0);
  check('never the durak at 4p tables caps near +25',
    computeScore({ games, duraks: 0, expectedDuraks: expected }) === 25);
  check('always the durak at 4p tables bottoms near -75',
    computeScore({ games, duraks: games, expectedDuraks: expected }) === -75);
}

// Bigger tables raise the bar: the same actual durak rate scores worse when
// the tables were larger, because less was expected of you.
{
  const games = 60;
  const duraks = 15; // a 25% actual rate throughout
  const atTwo = computeScore({ games, duraks, expectedDuraks: games / 2 });
  const atThree = computeScore({ games, duraks, expectedDuraks: games / 3 });
  const atFour = computeScore({ games, duraks, expectedDuraks: games / 4 });
  check('a 25% rate is excellent at two-player tables', atTwo === 25);
  check('the same rate is worth less at three players', atThree < atTwo);
  check('and is merely par at four players', atFour === 0);
}

// Score is a rate, so playing more of the same does not inflate it.
{
  const once = computeScore({ games: 10, duraks: 2, expectedDuraks: 10 / 4 });
  const tenfold = computeScore({ games: 100, duraks: 20, expectedDuraks: 100 / 4 });
  check('ten times the games at the same rate gives the same score',
    once === tenfold);
}

// No games played is not a score of zero; it is no score at all.
check('a player with no games has no score',
  computeScore({ games: 0, duraks: 0, expectedDuraks: 0 }) === null);

// The JS and the SQL must agree, since the database is what actually stores it.
{
  let mismatches = 0;
  let checked = 0;
  for (let games = 1; games <= 40; games++) {
    for (let duraks = 0; duraks <= games; duraks++) {
      for (const n of [2, 3, 4]) {
        const expected = games / n;
        const js = computeScore({ games, duraks, expectedDuraks: expected });
        const sql = sqlScore(games, duraks, expected);
        checked++;
        if (js !== sql) mismatches++;
      }
    }
  }
  check(`the score formula matches the SQL across ${checked} combinations`,
    mismatches === 0);
}

// Rates report what they say they do.
{
  check('durak rate is duraks over games',
    Math.round(durakRate({ games: 8, duraks: 2 })) === 25);
  check('expected rate is expected duraks over games',
    Math.round(expectedRate({ games: 8, expectedDuraks: 2 })) === 25);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
