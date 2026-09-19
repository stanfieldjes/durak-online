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
  canClear,
  isQuickClear,
  cardId,
  beats,
  makeRng,
  MAX_SLOTS,
  isHopelessForDefender,
  describe,
  deckSize,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_SUIT_IN_DEAL,
} from '../src/js/durak.js';

const GAMES_PER_SIZE = 1200;
const MAX_PLIES = 6000;

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL: ' + msg); };
const check = (label, cond) => { if (!cond) fail(label); };

/** Every card in that table's deck must be somewhere, exactly once. */
function auditCards(state, where) {
  const seen = new Map();
  const add = (c) => seen.set(cardId(c), (seen.get(cardId(c)) || 0) + 1);
  state.deck.forEach(add);
  state.hands.forEach((h) => h.forEach(add));
  state.table.forEach((s) => { add(s.atk); if (s.def) add(s.def); });

  const total = deckSize(state.playerCount);
  const inPlay = [...seen.values()].reduce((a, b) => a + b, 0);
  if (inPlay + state.discard !== total) {
    fail(`${where}: ${inPlay} in play + ${state.discard} discarded != ${total}`);
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

for (const players of [2, 3, 4, 6, 8]) {
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
let takesPastHand = 0;
for (let g = 0; g < 300; g++) {
  const rng = makeRng(g + 500);
  let state = newGame(g, 4);
  let guard = 0;
  while (!state.finished && guard++ < 3000) {
    const openSlots = state.table.filter((t) => !t.def).length;
    const cap = attackCapacity(state);
    if (!state.taking && cap > state.hands[state.defender].length - openSlots) {
      fail(`game ${g}: capacity ${cap} exceeds what the defender can answer`);
      break;
    }
    if (state.taking && cap !== Math.max(0, 6 - state.table.length)) {
      fail(`game ${g}: during a take, capacity ${cap} is not simply the room left on the table`);
      break;
    }
    if (state.taking && openSlots > state.hands[state.defender].length) takesPastHand++;
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

check('random play reaches takes with more open cards than the defender holds', takesPastHand > 0);

console.log('Checking throw-ins during a take ignore the defender\'s hand size...');
{
  let s = newGame(3, 2);
  s = { ...s, trump: 'S', attacker: 0, defender: 1, taking: false, out: [false, false], passed: [false, true] };
  s.hands[0] = [{ r: '6', s: 'D' }, { r: '6', s: 'H' }, { r: '6', s: 'S' }, { r: '7', s: 'H' }, { r: '7', s: 'S' }];
  s.hands[1] = [{ r: 'A', s: 'H' }]; // one card left, one open attack
  s.table = [
    { atk: { r: '6', s: 'C' }, def: { r: '7', s: 'C' } },
    { atk: { r: '7', s: 'D' }, def: null },
  ];
  check('while defending: no room past the defender\'s hand', attackCapacity(s) === 0 && legalAttacks(s, 0).length === 0);

  let t = applyMove(s, 1, { type: 'take' });
  check('once taking: room up to six on the table', attackCapacity(t) === 4);
  check('once taking: every matching card may be thrown in', legalAttacks(t, 0).length === 5);
  for (const card of [{ r: '6', s: 'D' }, { r: '6', s: 'H' }, { r: '7', s: 'H' }, { r: '6', s: 'S' }]) {
    t = applyMove(t, 0, { type: 'attack', card });
  }
  check('four throw-ins land on a one-card defender', t.table.length === 6 && t.taking && !t.finished);
  check('the six-card limit still holds', attackCapacity(t) === 0 && legalAttacks(t, 0).length === 0);
  check('a full take is a quick clear with no Done', isQuickClear(t) && !canPass(t, 0));
  const done = applyMove(t, 0, { type: 'clear' });
  check('the defender picks up all twelve cards', done.hands[1].length === 1 + 6 + 1 && done.table.length === 0);
}

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

    const beaten = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    const after = applyMove(beaten, 1, { type: 'clear' });
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

    const beaten = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    const after = applyMove(beaten, 0, { type: 'clear' });
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

console.log('Checking that defending the last card ends the game without a pass click...');
{
  // Defender plays their last card, it beats the only open attack, the deck
  // is empty, and the OTHER player still holds cards. Nobody has to click
  // anything: the table waits for the automatic clear. The attacker may press
  // Done to skip the pause, and either way ends the game the same.
  for (const players of [2, 3, 4, 6, 8]) {
    let s = newGame(2, players);
    s = { ...s, deck: [], table: [], discard: 30 };
    s.attacker = 1; s.defender = 0; s.trump = 'S';
    s.out = s.out.map(() => false);
    s.passed = s.passed.map(() => false);
    s.hands[0] = [{ r: '8', s: 'D' }]; // exactly the defender's last card
    s.table = [{ atk: { r: '6', s: 'D' }, def: null }];
    s.hands[1] = [{ r: '6', s: 'C' }, { r: '7', s: 'C' }]; // the attacker still holds cards
    for (let seat = 2; seat < players; seat++) s.hands[seat] = [];

    const beaten = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    check(`${players}p: the defended card stays on the table to be seen`,
      !beaten.finished && beaten.table.length === 1 && beaten.table[0].def);
    check(`${players}p: the defender is never offered Done`, !canPass(beaten, 0));
    check(`${players}p: the table is ready to clear`, canClear(beaten, 1));
    // The defender has no cards left, so nothing more can be thrown in: a
    // short look at the table, and no Done button to wait on.
    check(`${players}p: an empty defender makes it a quick clear`, isQuickClear(beaten));
    check(`${players}p: no Done during a quick clear`, !canPass(beaten, 1));

    const after = applyMove(beaten, 1, { type: 'clear' });
    check(`${players}p: clearing ends the game`, after.finished);
    check(`${players}p: the defender wins, the still-loaded opponent is the durak`,
      after.durak === 1);

  }

  // The same shape, but the OTHER player has also emptied their hand: still
  // a draw, reached without anyone pressing anything.
  {
    let s = newGame(2, 2);
    s = { ...s, deck: [], table: [], discard: 30 };
    s.attacker = 1; s.defender = 0; s.trump = 'S';
    s.out = [false, false]; s.passed = [false, false];
    s.hands[0] = [{ r: '8', s: 'D' }];
    s.table = [{ atk: { r: '6', s: 'D' }, def: null }];
    s.hands[1] = [];
    const beaten = applyMove(s, 0, { type: 'defend', card: { r: '8', s: 'D' }, slot: 0 });
    const after = applyMove(beaten, 0, { type: 'clear' });
    check('a simultaneous empty-hand finish is still a draw', after.finished && after.draw);
  }
}

console.log('Checking when Done is offered...');
{
  const rng = makeRng(4242);
  let pauses = 0, takesWithRoom = 0, fullTakes = 0, skips = 0;
  for (let g = 0; g < 400; g++) {
    let state = newGame(g + 900, 2 + (g % 3));
    let guard = 0;
    while (!state.finished && guard++ < 3000) {
      const owesAnswer = !state.taking && state.table.some((t) => !t.def);
      for (const seat of activeSeats(state)) {
        const offered = canPass(state, seat);
        if (seat === state.defender && offered) fail(`game ${g}: Done offered to the defender`);
        if (owesAnswer && offered) fail(`game ${g}: Done offered while the defender still owes an answer`);
        if (state.taking && attackCapacity(state) > 0 && offered && state.hands[seat].length === 0) {
          fail(`game ${g}: Done offered to an empty hand during a take with room`);
        }
      }
      if (canClear(state)) pauses++;
      if (state.taking && attackCapacity(state) > 0) takesWithRoom++;
      if (state.taking && attackCapacity(state) <= 0) fullTakes++;

      const actors = seatsToAct(state);
      if (!actors.length) { fail(`game ${g}: stalled`); break; }
      const seat = actors[Math.floor(rng() * actors.length)];
      const moves = availableMoves(state, seat);
      const move = moves[Math.floor(rng() * moves.length)];
      const next = applyMove(state, seat, move);
      if (move.type === 'pass' && canClear(state) && next.table.length === 0) skips++;
      state = next;
    }
  }
  check('pauses before a clear occur', pauses > 0);
  check('takes with room occur', takesWithRoom > 0);
  check('full takes occur', fullTakes > 0);
  check('Done actually skips pauses in play', skips > 0);

  // Six on the table and the defender takes: the attacker is not needed, but
  // Done skips the pause and hands the cards over.
  let s = newGame(5, 2);
  s = { ...s, deck: [], discard: 12, trump: 'S', attacker: 0, defender: 1, taking: false };
  s.hands[0] = [{ r: '9', s: 'C' }];
  s.hands[1] = [{ r: '7', s: 'H' }, { r: '8', s: 'H' }, { r: '9', s: 'H' }, { r: '10', s: 'H' },
    { r: 'J', s: 'H' }, { r: 'Q', s: 'H' }, { r: 'K', s: 'H' }];
  s.table = [
    { atk: { r: '6', s: 'C' }, def: { r: '7', s: 'C' } },
    { atk: { r: '6', s: 'D' }, def: { r: '7', s: 'D' } },
    { atk: { r: '8', s: 'C' }, def: { r: '10', s: 'C' } },
    { atk: { r: '8', s: 'D' }, def: { r: '9', s: 'D' } },
    { atk: { r: '10', s: 'D' }, def: { r: 'J', s: 'D' } },
    { atk: { r: 'J', s: 'C' }, def: null },
  ];
  s.passed = [false, true]; s.out = [false, false];
  const took = applyMove(s, 1, { type: 'take' });
  check('six on the table: the take waits rather than resolving on its own', took.table.length === 6);
  check('six on the table: the table is ready to clear', canClear(took, 0));
  check('six on the table: it is a quick clear', isQuickClear(took));
  check('six on the table: no Done to wait on', !canPass(took, 0));
  const cleared = applyMove(took, 0, { type: 'clear' });
  check('six on the table: clearing hands the cards to the defender',
    cleared.table.length === 0 && cleared.log.some((e) => e.t === 'taken'));

  // The reported case: all six attacks beaten, defender still holding cards.
  let six = newGame(5, 2);
  six = { ...six, deck: six.deck, trump: 'S', attacker: 0, defender: 1, taking: false, out: [false, false] };
  six.hands[0] = [{ r: '6', s: 'H' }, { r: '7', s: 'H' }]; // the attacker even holds matching ranks
  six.hands[1] = [{ r: 'A', s: 'C' }, { r: 'K', s: 'H' }, { r: 'Q', s: 'D' }];
  six.table = [
    { atk: { r: '6', s: 'C' }, def: { r: '7', s: 'C' } },
    { atk: { r: '6', s: 'D' }, def: { r: '7', s: 'D' } },
    { atk: { r: '8', s: 'C' }, def: { r: '10', s: 'C' } },
    { atk: { r: '8', s: 'D' }, def: { r: '9', s: 'D' } },
    { atk: { r: '10', s: 'D' }, def: { r: 'J', s: 'D' } },
    { atk: { r: 'J', s: 'C' }, def: null },
  ];
  six.passed = [false, true];
  const sixBeaten = applyMove(six, 1, { type: 'defend', card: { r: 'A', s: 'C' }, slot: 5 });
  check('six beaten: waiting to clear', canClear(sixBeaten) && sixBeaten.table.length === 6);
  check('six beaten: quick clear, even though the attacker holds matching ranks', isQuickClear(sixBeaten));
  check('six beaten: nobody can throw in', legalAttacks(sixBeaten, 0).length === 0);
  check('six beaten: no Done button', !canPass(sixBeaten, 0));

  // Five beaten with room left is still the long pause, with Done.
  const five = { ...six, table: six.table.slice(0, 5), passed: [false, true] };
  check('five beaten with room: long pause', canClear(five) && !isQuickClear(five));
  check('five beaten with room: Done is offered', canPass(five, 0));

  // A take with room left still waits for Done.
  let t = newGame(8, 2);
  const lead = legalAttacks(t, t.attacker)[0];
  t = applyMove(t, t.attacker, { type: 'attack', card: lead });
  t = applyMove(t, t.defender, { type: 'take' });
  check('a take with room left offers Done to the attacker', canPass(t, t.attacker));
  check('a take with room left does not clear on its own', !canClear(t, t.attacker));

  // Three attackers on a beaten table: the pause is skipped only once all of
  // them press Done, and a throw-in in between wipes the earlier presses.
  let m = newGame(21, 4);
  m = { ...m, deck: m.deck, taking: false, attacker: 0, defender: 1, out: [false, false, false, false] };
  m.trump = 'S';
  m.hands[0] = [{ r: '6', s: 'H' }, { r: 'A', s: 'C' }];
  m.hands[1] = [{ r: 'K', s: 'D' }, { r: 'K', s: 'C' }];
  m.hands[2] = [{ r: '6', s: 'C' }];
  m.hands[3] = [{ r: 'Q', s: 'H' }];
  m.table = [{ atk: { r: '6', s: 'D' }, def: null }];
  m.passed = [false, true, false, false];
  const beaten = applyMove(m, 1, { type: 'defend', card: { r: 'K', s: 'D' }, slot: 0 });
  const one = applyMove(beaten, 0, { type: 'pass' });
  const two = applyMove(one, 3, { type: 'pass' });
  check('beaten table, 2 of 3 attackers done: still waiting', two.table.length === 1 && canClear(two));
  check('an attacker who pressed Done is not offered it again', !canPass(two, 0));
  const all = applyMove(two, 2, { type: 'pass' });
  check('beaten table, all 3 attackers done: cleared at once', all.table.length === 0 && all.log.some((e) => e.t === 'beaten'));

  const thrown = applyMove(one, 2, { type: 'attack', card: { r: '6', s: 'C' } });
  check('a throw-in wipes earlier Done presses', !thrown.passed[0]);
  check('no Done while the new card is unanswered', [0, 2, 3].every((x) => !canPass(thrown, x)));

  // Every attacker already out of cards: the defence still gets its pause.
  let e = newGame(4, 3);
  e = { ...e, taking: false, attacker: 0, defender: 1, out: [false, false, false] };
  e.hands[0] = []; e.hands[2] = [];
  e.hands[1] = [{ r: 'A', s: e.trump }, { r: '7', s: e.trump === 'S' ? 'H' : 'S' }];
  e.table = [{ atk: { r: '6', s: e.trump }, def: null }];
  e.passed = [false, true, false];
  const quiet = applyMove(e, 1, { type: 'defend', card: { r: 'A', s: e.trump }, slot: 0 });
  check('empty-handed attackers alone never skip the pause', quiet.table.length === 1 && canClear(quiet));
  check('but they can still press Done to skip it', canPass(quiet, 0) && applyMove(quiet, 0, { type: 'pass' }).table.length === 0);
}

console.log('Checking prompts never claim a beaten table when nothing was played...');
{
  for (const players of [2, 3, 4, 6, 8]) {
    const s = newGame(7, players);
    const text = describe(s, s.defender);
    check(`${players}p: defender before the attack is told to wait ("${text}")`,
      !/beaten/i.test(text) && /waiting for the attack/i.test(text));
  }
  const rng = makeRng(77);
  for (let g = 0; g < 200; g++) {
    let state = newGame(g + 3000, 2 + (g % 3));
    let guard = 0;
    while (!state.finished && guard++ < 3000) {
      for (const seat of activeSeats(state)) {
        const text = describe(state, seat);
        if (/beaten/i.test(text) && !(state.table.length > 0 && state.table.every((t) => t.def))) {
          fail(`game ${g}: seat ${seat} told "${text}" with ${state.table.length} cards down`);
        }
      }
      const actors = seatsToAct(state);
      if (!actors.length) break;
      const seat = actors[Math.floor(rng() * actors.length)];
      const moves = availableMoves(state, seat);
      state = applyMove(state, seat, moves[Math.floor(rng() * moves.length)]);
    }
  }
}

/* ---- forced endings and the draw that survives them ------------------- */

console.log('Checking forced endings...');
{
  let forced = 0;
  let draws = 0;
  for (const players of [2, 3, 4, 6, 8]) {
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

for (const bad of [1, 9, 0, 2.5]) {
  let threw = false;
  try { newGame(1, bad); } catch { threw = true; }
  check(`a table of ${bad} should be refused`, threw);
}
for (const good of [2, 3, 4, 5, 6, 7, 8]) {
  const s = newGame(1, good);
  const size = deckSize(good);
  check(`a table of ${good} deals ${good} hands`, s.hands.length === good);
  check(`a table of ${good} deals six cards each`, s.hands.every((h) => h.length === 6));
  // Four players play the usual 36; every seat either way moves it by a rank.
  check(`a table of ${good} plays with ${size} cards`, size === 36 + (good - 4) * 4);
  check(`a table of ${good} leaves ${size - good * 6} in the stock`, s.deck.length === size - good * 6);
}

/* ---- nobody is dealt more than four of a suit ------------------------- */
console.log('Checking deals spread the suits...');
{
  let worst = 0;
  for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
    for (let seed = 1; seed <= 600; seed++) {
      for (const hand of newGame(seed, players).hands) {
        const bySuit = {};
        for (const card of hand) bySuit[card.s] = (bySuit[card.s] ?? 0) + 1;
        worst = Math.max(worst, ...Object.values(bySuit));
      }
    }
  }
  check(`no dealt hand holds more than ${MAX_SUIT_IN_DEAL} of a suit (worst was ${worst})`,
    worst <= MAX_SUIT_IN_DEAL);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll checks passed.');
