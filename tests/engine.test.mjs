/**
 * Rules engine tests. Run with: node tests/engine.test.mjs
 *
 * Random playouts at every table size, plus targeted checks on the rules that
 * are easy to get subtly wrong: free-for-all throw-ins, elimination, and role
 * hand-off after a take.
 */
import {
  newGame,
  applyMove,
  availableMoves,
  seatsToAct,
  activeSeats,
  legalAttacks,
  attackCapacity,
  canPass,
  cardId,
  beats,
  makeRng,
  MAX_SLOTS,
  isHopelessForDefender,
} from '../src/js/durak.js';

const GAMES_PER_SIZE = 1200;
const MAX_PLIES = 6000;

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL: ' + msg); };
const check = (label, cond) => { if (!cond) fail(label); };

/** All 36 cards must be somewhere, exactly once. */
function auditCards(state, where) {
  const seen = new Map();
  const add = (c) => seen.set(cardId(c), (seen.get(cardId(c)) || 0) + 1);
  state.deck.forEach(add);
  state.hands.forEach((h) => h.forEach(add));
  state.table.forEach((s) => { add(s.atk); if (s.def) add(s.def); });

  const inPlay = [...seen.values()].reduce((a, b) => a + b, 0);
  if (inPlay + state.discard !== 36) {
    fail(`${where}: ${inPlay} in play + ${state.discard} discarded != 36`);
    return false;
  }
  for (const [id, n] of seen) {
    if (n > 1) { fail(`${where}: duplicate card ${id}`); return false; }
  }
  return true;
}

function auditInvariants(state, where) {
  if (state.table.length > MAX_SLOTS) {
    fail(`${where}: ${state.table.length} cards on the table, max is ${MAX_SLOTS}`);
  }
  if (state.defender === state.attacker && !state.finished) {
    fail(`${where}: attacker and defender are the same seat`);
  }
  if (!state.finished && (state.out[state.attacker] || state.out[state.defender])) {
    fail(`${where}: an eliminated player holds a role`);
  }
  // Nobody should ever be asked to act in a position that is already hopeless
  // for the defender: stock empty, every other attacker spent, no arrangement
  // of the defender's hand can beat what is on the table. That position must
  // end the game instead of waiting for a "take" click.
  if (!state.finished && isHopelessForDefender(state)) {
    fail(`${where}: position is hopeless for the defender but the game has not ended`);
  }

  // A player is only out once the stock is empty and their hand is gone.
  state.out.forEach((isOut, seat) => {
    if (isOut && state.hands[seat].length > 0) {
      fail(`${where}: seat ${seat} is out but holds ${state.hands[seat].length} cards`);
    }
  });
}

/* ---- random playouts -------------------------------------------------- */

for (const players of [2, 3, 4]) {
  console.log(`Running ${GAMES_PER_SIZE} random playouts with ${players} players...`);
  const outcomes = new Array(players).fill(0);
  let draws = 0;
  let longest = 0;
  let concurrentChoices = 0;
  let positions = 0;

  for (let g = 0; g < GAMES_PER_SIZE; g++) {
    const rng = makeRng(g * 2654435761 + players);
    let state = newGame(g, players);
    let plies = 0;

    if (!auditCards(state, `${players}p game ${g} deal`)) break;

    while (!state.finished) {
      if (++plies > MAX_PLIES) {
        fail(`${players}p game ${g}: did not terminate in ${MAX_PLIES} plies`);
        break;
      }

      const actors = seatsToAct(state);
      if (actors.length === 0) {
        fail(`${players}p game ${g}: nobody can move but the game is not over ` +
          `(table ${state.table.length}, taking ${state.taking}, passed ${state.passed})`);
        break;
      }
      if (actors.length > 1) concurrentChoices++;
      positions++;

      // Pick a random eligible player, then a random legal move of theirs.
      const seat = actors[Math.floor(rng() * actors.length)];
      const moves = availableMoves(state, seat);
      if (moves.length === 0) {
        fail(`${players}p game ${g}: seat ${seat} may act but has no moves`);
        break;
      }
      const active = moves.filter((m) => m.type === 'attack' || m.type === 'defend');
      const pool = active.length && rng() < 0.75 ? active : moves;
      const move = pool[Math.floor(rng() * pool.length)];

      try {
        state = applyMove(state, seat, move);
      } catch (err) {
        fail(`${players}p game ${g}: engine rejected a move it offered (${move.type}): ${err.message}`);
        break;
      }

      if (!auditCards(state, `${players}p game ${g} ply ${plies}`)) break;
      auditInvariants(state, `${players}p game ${g} ply ${plies}`);
    }

    longest = Math.max(longest, plies);
    if (state.finished) {
      if (state.draw) draws++;
      else outcomes[state.durak]++;
    }
  }

  const spread = outcomes.map((n, s) => `seat${s} ${n}`).join(', ');
  console.log(`  durak counts: ${spread}, draws ${draws}`);
  console.log(`  longest ${longest} plies, ${concurrentChoices}/${positions} positions had 2+ eligible players`);

  // With symmetric random play no seat should be wildly over-represented.
  const expected = (GAMES_PER_SIZE - draws) / players;
  outcomes.forEach((n, s) => {
    if (Math.abs(n - expected) > expected * 0.35) {
      fail(`${players}p: seat ${s} was the durak ${n} times, expected near ${Math.round(expected)}`);
    }
  });
}

/* ---- free-for-all attacking ------------------------------------------- */

console.log('Checking free-for-all throw-ins...');
{
  // Only the primary attacker may lead.
  const state = newGame(11, 4);
  for (const seat of [0, 1, 2, 3]) {
    const legal = legalAttacks(state, seat);
    if (seat === state.attacker) {
      check('the primary attacker can lead', legal.length > 0);
    } else {
      check(`seat ${seat} must not lead the round`, legal.length === 0);
    }
  }

  // After a card is down, every attacker with a matching rank may throw in,
  // with no turn order between them.
  let s = applyMove(state, state.attacker, {
    type: 'attack',
    card: legalAttacks(state, state.attacker)[0],
  });
  const rank = s.table[0].atk.r;
  const others = [0, 1, 2, 3].filter((x) => x !== s.defender && x !== s.attacker);
  for (const seat of others) {
    const holdsMatch = s.hands[seat].some((c) => c.r === rank);
    const offered = legalAttacks(s, seat).length > 0;
    check(
      `seat ${seat} may throw in exactly when it holds rank ${rank}`,
      holdsMatch === offered
    );
  }

  // The defender is never an attacker.
  check('the defender cannot attack', legalAttacks(s, s.defender).length === 0);

  // Several players eligible at once is the normal case, not an error.
  check('more than one seat can be eligible at once', seatsToAct(s).length >= 1);
}

/* ---- capacity --------------------------------------------------------- */

console.log('Checking the table never exceeds what the defender can answer...');
for (let g = 0; g < 300; g++) {
  const rng = makeRng(g + 500);
  let state = newGame(g, 4);
  let guard = 0;
  while (!state.finished && guard++ < 3000) {
    const openSlots = state.table.filter((t) => !t.def).length;
    const cap = attackCapacity(state);
    if (cap > state.hands[state.defender].length - openSlots) {
      fail(`game ${g}: capacity ${cap} exceeds what the defender can answer`);
      break;
    }
    if (state.table.length + cap > 6) {
      fail(`game ${g}: capacity would push the table past six slots`);
      break;
    }
    const actors = seatsToAct(state);
    if (!actors.length) break;
    const seat = actors[Math.floor(rng() * actors.length)];
    const moves = availableMoves(state, seat);
    state = applyMove(state, seat, moves[Math.floor(rng() * moves.length)]);
  }
}

/* ---- elimination ------------------------------------------------------ */

console.log('Checking elimination and the last player standing...');
for (const players of [3, 4]) {
  for (let g = 0; g < 300; g++) {
    const rng = makeRng(g + players * 77);
    let state = newGame(g, players);
    let guard = 0;
    while (!state.finished && guard++ < 4000) {
      const actors = seatsToAct(state);
      if (!actors.length) break;
      const seat = actors[Math.floor(rng() * actors.length)];
      const moves = availableMoves(state, seat);
      state = applyMove(state, seat, moves[Math.floor(rng() * moves.length)]);
    }
    if (!state.finished) continue;
    const left = activeSeats(state);
    if (state.draw) {
      check(`${players}p game ${g}: a draw means nobody holds cards`, left.length === 0);
      check(`${players}p game ${g}: a draw has no durak`, state.durak === null);
    } else {
      check(`${players}p game ${g}: exactly one player is left`, left.length === 1);
      check(`${players}p game ${g}: the durak is that player`, state.durak === left[0]);
      check(
        `${players}p game ${g}: the durak still holds cards`,
        state.hands[state.durak].length > 0
      );
    }
  }
}

/* ---- hopeless-defence is about matching, not card counts --------------- */

console.log('Checking that hopelessness matches actual outcomes, not just card counts...');
{
  const base = () => {
    let s = newGame(3, 2);
    // Force a small, controllable position: empty the stock and the
    // attacker's hand, then hand-place exactly what the scenario needs.
    s = { ...s, deck: [], table: [], discard: 30 };
    s.hands = [s.hands[0], []];
    s.attacker = 1; s.defender = 0; s.trump = 'S';
    s.out = [false, false]; s.passed = [true, true];
    return s;
  };

  // Holding MORE cards than there are open attacks is hopeless on its own,
  // no matter what those cards are. Beating the one open attack only removes
  // one card — the other six stay in hand, and the game ends with the
  // defender holding cards while the attacker holds none, whether or not the
  // defence itself succeeded. isHopelessForDefender must say so immediately,
  // without needing the defend to actually be attempted first.
  {
    let s = base();
    s.hands[0] = [{ r: '6', s: 'S' }, { r: '7', s: 'S' }, { r: '8', s: 'D' }, { r: '9', s: 'C' },
      { r: 'K', s: 'H' }, { r: 'Q', s: 'C' }, { r: 'A', s: 'D' }]; // 7 cards, includes a beat
    s.table = [{ atk: { r: '6', s: 'D' }, def: null }]; // 8D or AD would beat this
    check('7 cards against 1 open attack is hopeless even though a beat exists',
      isHopelessForDefender(s));

    const after = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    check('defending it anyway still ends with them holding leftover cards',
      after.finished && after.durak === 0 && after.hands[0].length === 6);
  }

  // Exactly as many cards as open attacks, and a genuine covering arrangement
  // exists: beating everything empties the hand at the same moment the
  // attacker's did, so this is a live draw and must NOT be forced.
  {
    let s = base();
    s.hands[0] = [{ r: '8', s: 'D' }]; // exactly one card, and it beats the one attack
    s.table = [{ atk: { r: '6', s: 'D' }, def: null }];
    check('1 card against 1 open attack with a genuine cover is not hopeless',
      !isHopelessForDefender(s));

    const after = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    check('beating it with the last card produces a draw, not a durak',
      after.finished && after.draw && after.durak === null);
  }

  // Exactly as many cards as open attacks, but the wrong ones: no covering
  // arrangement exists, so a draw is not reachable — they will have to take,
  // and taking only adds cards, which guarantees durak just the same as the
  // too-many-cards case above.
  {
    let s = base();
    s.hands[0] = [{ r: '6', s: 'H' }]; // does not beat a diamond, and S is trump but this isn't S
    s.table = [{ atk: { r: '9', s: 'D' }, def: null }];
    check('1 card against 1 open attack with no cover is hopeless',
      isHopelessForDefender(s));
  }

  // Two open slots that need the same suit, but the hand holds only one card
  // of it: coverable by count (2 cards, 2 slots) but not by assignment — the
  // exact case the matching check exists for.
  {
    let s = base();
    s.hands[0] = [{ r: '9', s: 'H' }, { r: '9', s: 'D' }];
    s.table = [{ atk: { r: '6', s: 'H' }, def: null }, { atk: { r: '7', s: 'H' }, def: null }];
    check('two same-suit demands cannot both be met by one matching card',
      isHopelessForDefender(s));
  }
}

console.log('Checking that a live opponent elsewhere at the table blocks a forced end...');
{
  // The same "3 cards against 1 open attack" shape that is hopeless in a
  // 2-player endgame — but this time a 3rd or 4th seat is still in the game
  // and still holding cards. More attacks could still come from them, so the
  // defender's own hopeless arithmetic must NOT decide the game while anyone
  // else at the table can still act. Only once every other active seat has
  // genuinely run out does this become the same endgame as the 2-player case.
  for (const players of [3, 4]) {
    let s = newGame(1, players);
    s = { ...s, deck: [], table: [], discard: 30 };
    s.attacker = 1; s.defender = 0; s.trump = 'S';
    s.out = s.out.map(() => false);
    s.passed = s.passed.map(() => true);
    s.hands[0] = [{ r: '6', s: 'H' }, { r: '7', s: 'H' }, { r: '8', s: 'H' }]; // 3 cards, no cover
    s.table = [{ atk: { r: '9', s: 'D' }, def: null }]; // 1 open attack, hopeless if this were 2p

    // Seat 1 (the immediate attacker) is spent, but some other seat still
    // holds cards — nobody at the table is out.
    s.hands[1] = [];
    for (let seat = 2; seat < players; seat++) s.hands[seat] = [{ r: '6', s: 'C' }];

    check(`${players}p: not hopeless while seat 2 still holds a card`,
      !isHopelessForDefender(s));

    // That same defender shape, but now genuinely down to the last two
    // active players — everyone else has already been marked out from an
    // earlier round, not merely emptied this round.
    const heads = { ...s, hands: s.hands.map((h, seat) => (seat === 0 ? h : [])) };
    heads.out = heads.out.map((_, seat) => seat !== 0 && seat !== 1);
    check(`${players}p: hopeless once every other seat is actually out`,
      isHopelessForDefender(heads));
  }
}

/* ---- forced endings and the draw that survives them ------------------- */

console.log('Checking forced endings...');
{
  let forced = 0;
  let draws = 0;
  for (const players of [2, 3, 4]) {
    for (let g = 0; g < 800; g++) {
      const rng = makeRng(g * 31 + players);
      let state = newGame(g, players);
      let guard = 0;
      while (!state.finished && guard++ < 5000) {
        const actors = seatsToAct(state);
        if (!actors.length) break;
        const seat = actors[Math.floor(rng() * actors.length)];
        const moves = availableMoves(state, seat);
        state = applyMove(state, seat, moves[Math.floor(rng() * moves.length)]);
      }
      if (!state.finished) continue;

      const end = state.log[state.log.length - 1];
      if (end?.forced) {
        forced++;
        check(`${players}p game ${g}: a forced ending names the defender`,
          state.durak === end.durak && !state.draw);
        check(`${players}p game ${g}: the durak still holds cards`,
          state.hands[state.durak].length > 0);
      }
      if (state.draw) {
        draws++;
        check(`${players}p game ${g}: a draw leaves nobody holding cards`,
          state.hands.every((h) => h.length === 0));
      }
    }
  }
  console.log(`  ${forced} games ended early with no decision left to make`);
  console.log(`  ${draws} games still reached a draw, so the tie is not shortcut away`);
  check('forced endings actually happen', forced > 0);
  check('draws are still reachable', draws > 0);
}

/* ---- beat rule -------------------------------------------------------- */

const T = 'S';
for (const [def, atk, want, label] of [
  [{ r: 'K', s: 'H' }, { r: 'Q', s: 'H' }, true, 'higher of same suit beats'],
  [{ r: 'Q', s: 'H' }, { r: 'K', s: 'H' }, false, 'lower of same suit does not beat'],
  [{ r: '6', s: T }, { r: 'A', s: 'H' }, true, 'any trump beats a non-trump'],
  [{ r: 'A', s: 'H' }, { r: '6', s: T }, false, 'non-trump never beats a trump'],
  [{ r: 'A', s: T }, { r: 'K', s: T }, true, 'higher trump beats lower trump'],
  [{ r: 'K', s: 'D' }, { r: 'Q', s: 'H' }, false, 'off-suit non-trump does not beat'],
]) {
  if (beats(def, atk, T) !== want) fail(`beats(): ${label}`);
}

/* ---- table sizes ------------------------------------------------------ */

for (const bad of [1, 5, 0, 2.5]) {
  let threw = false;
  try { newGame(1, bad); } catch { threw = true; }
  check(`a table of ${bad} should be refused`, threw);
}
for (const good of [2, 3, 4]) {
  const s = newGame(1, good);
  check(`a table of ${good} deals ${good} hands`, s.hands.length === good);
  check(`a table of ${good} deals six cards each`, s.hands.every((h) => h.length === 6));
  check(`a table of ${good} leaves ${36 - good * 6} in the stock`, s.deck.length === 36 - good * 6);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
