/**
 * Contract tests between the browser engine, the SQL in supabase/schema.sql,
 * and the rating model. Run with: node tests/sync.test.mjs
 *
 * The concurrency section is the important one. Attacking is free-for-all, so
 * two players genuinely can submit moves built on the same position. If the
 * version guard is wrong, one of those cards silently disappears.
 *
 * The rating section holds src/js/rating.js against a hand-written mirror of
 * public.rating_changes(). tests/sql/run.sh does the same thing against a real
 * Postgres when one is available; this runs everywhere and needs nothing
 * installed.
 */
import {
  newGame,
  applyMove,
  availableMoves,
  seatsToAct,
  IllegalMove,
  deckSize,
} from '../src/js/durak.js';
import {
  ratingChanges,
  quantise,
  START,
  K,
  SCALE,
  FLOOR,
} from '../src/js/rating.js';

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
      if (countCards(now) !== deckSize(now.playerCount)) {
        fail(`game ${g}: ${countCards(now)} cards after concurrent writes, ` +
          `expected ${deckSize(now.playerCount)}`);
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
  for (const players of [2, 3, 4, 5, 6, 7, 8]) {
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
const net = (xs) => quantise(sum(xs));
const level = (n) => Array(n).fill(START);

/**
 * A hand-written mirror of public.rating_changes() in supabase/schema.sql,
 * written from the SQL rather than from rating.js, so that the comparison
 * below is worth making. If the two implementations ever drift apart, the
 * number a player sees when a game ends stops being the number the database
 * actually stored.
 */
function sqlRatingChanges(ratings, durakIndex) {
  const k = 24;
  const scale = 400;
  const floorAt = 100;
  const step = 0.000001;
  const round6 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 1e6) / 1e6 + 0;

  const n = ratings.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const isDurak = durakIndex !== null && durakIndex >= 1 && durakIndex <= n;
  const strongest = Math.max(...ratings);

  const weights = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = Math.pow(10, (strongest - ratings[i]) / scale);
    total += weights[i];
  }

  const raw = [];
  const deltas = [];
  for (let i = 0; i < n; i++) {
    const actual = isDurak ? (i === durakIndex - 1 ? 1 : 0) : 1 / n;
    raw[i] = -k * (actual - weights[i] / total);
    deltas[i] = round6(raw[i]);
  }

  if (isDurak) {
    let survivors = 0;
    for (let i = 0; i < n; i++) if (i !== durakIndex - 1) survivors += deltas[i];
    deltas[durakIndex - 1] = round6(-survivors);
  } else {
    let residual = round6(sum(deltas));
    let guard = 0;
    while (residual !== 0 && guard++ < 100) {
      const dir = residual > 0 ? -step : step;
      let best = 0;
      let bestWant = null;
      for (let i = 0; i < n; i++) {
        const want = Math.sign(dir) * (raw[i] - deltas[i]);
        if (bestWant === null || want > bestWant) {
          bestWant = want;
          best = i;
        }
      }
      deltas[best] = round6(deltas[best] + dir);
      residual = round6(residual + dir);
    }
  }

  for (let i = 0; i < n; i++) {
    deltas[i] = round6(Math.max(floorAt, ratings[i] + deltas[i]) - ratings[i]);
  }
  return deltas;
}

// The constants the SQL hard-codes have to be the ones rating.js exports.
check('K matches the SQL', K === 24);
check('SCALE matches the SQL', SCALE === 400);
check('FLOOR matches the SQL', FLOOR === 100);
check('the opening rating matches the SQL', START === 1000);

// Every game hands out exactly one unit of blame, so nothing is created or
// destroyed: the changes at any table always sum to zero.
for (let n = 2; n <= 8; n++) {
  for (let durak = 0; durak < n; durak++) {
    check(`${n}p: changes sum to zero`, net(ratingChanges(level(n), durak)) === 0);
  }
  check(`${n}p: a draw sums to zero`, net(ratingChanges(level(n), -1)) === 0);
}

// The documented amounts at a table of equal ratings.
{
  const expected = { 2: 12, 3: 16, 4: 18, 5: 19.2, 6: 20, 8: 21 };
  for (const [players, loss] of Object.entries(expected)) {
    const deltas = ratingChanges(level(Number(players)), 0);
    check(`${players}p: the durak loses ${loss}`, Math.abs(-deltas[0] - loss) < 1e-5);
  }
  const seven = ratingChanges(level(7), 0);
  check('7p: the durak loses 24 x 6/7', Math.abs(-seven[0] - (24 * 6) / 7) < 1e-5);
}

// The property the whole decimal design exists to protect: losing at a bigger
// table always costs more, with no exceptions anywhere in the range. Whole
// numbers break this at seven players, where six survivors each round 3.43
// down to 3 and leave the durak absorbing less than they would lose at four.
{
  const losses = [];
  for (let n = 2; n <= 8; n++) losses.push(-ratingChanges(level(n), 0)[0]);
  for (let i = 1; i < losses.length; i++) {
    check(`the durak pays more at ${i + 2} players than at ${i + 1}`,
      losses[i] > losses[i - 1]);
  }
  // What an integer model would produce: the survivors round first, and the
  // durak absorbs whatever they leave. At n = 2..8 that gives
  // 12, 16, 18, 20, 20, 18, 21 — which goes backwards at seven players and
  // is flat between five and six. Neither is a rounding nicety: it means a
  // seven-handed durak gets off lighter than a five-handed one.
  const wholeNumbers = [];
  for (let n = 2; n <= 8; n++) wholeNumbers.push((n - 1) * Math.round(24 / n));
  const risesEveryTime = wholeNumbers.every((x, i) => i === 0 || x > wholeNumbers[i - 1]);
  check('an integer model really would break the order', !risesEveryTime);
  check('specifically, a seven-player durak would pay less than a six-player one',
    wholeNumbers[5] < wholeNumbers[4]);
}

// Who you played counts.
check('losing to weaker players costs more',
  ratingChanges([1200, 900, 900, 900], 0)[0] < ratingChanges([1200, 1500, 1500, 1500], 0)[0]);
check('surviving a strong table pays more',
  ratingChanges([1000, 1400, 1400, 1400], 3)[0] > ratingChanges([1000, 700, 700, 700], 3)[0]);

// A rating is a running total rather than a rate, so playing more games can
// never dilute it. This is the whole reason the old percentage-point score
// was replaced: there, evidence counted against you.
{
  let rating = START;
  for (let game = 0; game < 200; game++) {
    // Never the durak at level four-player tables.
    const deltas = ratingChanges([rating, rating, rating, rating], 3);
    rating = quantise(rating + deltas[0]);
  }
  check('a player who keeps getting out keeps climbing', rating > START + 100);
}

// Nobody falls through the floor.
check('a player at the floor cannot fall further', ratingChanges([FLOOR, 1000], 0)[0] === 0);

// The JS and the SQL must agree exactly, since the database is what actually
// stores the rating while the browser is what shows it.
{
  let mismatches = 0;
  let cases = 0;
  const tables = [];

  for (let n = 2; n <= 8; n++) {
    tables.push(level(n));
    tables.push(Array.from({ length: n }, (_, i) => 1000 + i * 37));
    tables.push(Array.from({ length: n }, (_, i) => 1000 - i * 213));
    tables.push(Array.from({ length: n }, (_, i) => 400 + ((i * 104729) % 2200)));
  }
  tables.push([1000.000001, 1000, 999.999999]);
  tables.push([1003, 999, 1001, 1002, 998, 1000, 997]);
  tables.push([100, 2000]);
  tables.push([FLOOR, FLOOR, FLOOR]);

  for (const ratings of tables) {
    for (let durak = -1; durak < ratings.length; durak++) {
      const js = ratingChanges(ratings, durak);
      // SQL arrays count from one, and use NULL rather than -1 for a draw.
      const sql = sqlRatingChanges(ratings, durak === -1 ? null : durak + 1);
      cases++;
      for (let i = 0; i < js.length; i++) {
        if (js[i] !== sql[i]) {
          mismatches++;
          fail(`[${ratings}] durak ${durak} seat ${i}: js ${js[i]} vs sql ${sql[i]}`);
          break;
        }
      }
    }
  }
  check(`the rating model matches the SQL across ${cases} tables`, mismatches === 0);
  console.log(`  ${cases} rating cases checked against the SQL`);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
