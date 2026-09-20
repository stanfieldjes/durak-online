/**
 * The pieces that only exist on screen: the crop square, the rating line and
 * the panel shown while the pointer rests on a player.
 *
 * None of these throw when they are wrong. A crop that lets the square run off
 * the edge of a photograph draws blank canvas into somebody's avatar; a chart
 * whose scale collapses draws a flat line through the middle and looks
 * plausible; a panel that never hides follows the pointer around the site.
 * So each is checked here rather than by looking at it once and moving on.
 *
 * The browser is jsdom, and the two modules that reach outside it — the canvas
 * in the cropper and Supabase under ui.js — are kept out: cropBounds is the
 * cropper's arithmetic on its own, and the stubs below stand in for the
 * modules ui.js imports for reasons of its own.
 */

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The only part of the suite that wants anything installed.
 *
 * Everything else here runs on a bare Node, and the build has never needed a
 * dependency to test itself — so a machine without jsdom skips the parts that
 * need a document and still checks the arithmetic, rather than failing in a
 * way that looks like the code is broken.
 */
let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // Reported once, below, rather than per test.
}
const NO_DOM = JSDOM ? false : 'needs jsdom: run `npm install` first';

let ratingChart;
let ui;
let cropBounds;
let window;

/** Enough of a browser for the three modules under test. */
function openWindow() {
  window = new JSDOM('<!doctype html><body></body>').window;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.innerWidth = window.innerWidth;
  globalThis.innerHeight = window.innerHeight;
  globalThis.addEventListener = window.addEventListener.bind(window);
  globalThis.setTimeout = window.setTimeout.bind(window);
  globalThis.clearTimeout = window.clearTimeout.bind(window);
}

/**
 * ui.js pulls in durak.js for the suit glyphs and, further down the chain,
 * the Supabase client, which is fetched over the network at import time. A
 * copy of the scripts with those two stubbed lets the parts under test run
 * without either.
 */
before(async () => {
  if (JSDOM) openWindow();

  const dir = mkdtempSync(join(tmpdir(), 'durak-view-'));
  cpSync(join(ROOT, 'src/js'), dir, { recursive: true });

  writeFileSync(join(dir, 'durak.js'),
    'export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };\n'
    + 'export const SUIT_NAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };\n'
    + 'export const MAX_PLAYERS = 8;\n');
  writeFileSync(join(dir, 'supabase.js'),
    'export const supabase = {};\nexport const readableError = (e) => String(e?.message ?? e);\n');

  ({ cropBounds } = await import(pathToFileURL(join(dir, 'cropper.js')).href));
  if (!JSDOM) return;
  ({ ratingChart } = await import(pathToFileURL(join(dir, 'chart.js')).href));
  ui = await import(pathToFileURL(join(dir, 'ui.js')).href);
});

/* ---------------- the crop square ---------------- */

test('the square starts as the whole of the picture’s short side', () => {
  const wide = cropBounds({ w: 4000, h: 3000, zoom: 1, cx: 2000, cy: 1500 });
  assert.equal(wide.side, 3000);

  const tall = cropBounds({ w: 1080, h: 1920, zoom: 1, cx: 540, cy: 960 });
  assert.equal(tall.side, 1080);
});

test('the square never runs off the edge, however far it is dragged', () => {
  const cases = [
    { w: 4000, h: 3000 },
    { w: 640, h: 4000 },
    { w: 1, h: 1 },
    { w: 1200, h: 1200 },
  ];
  for (const { w, h } of cases) {
    for (const zoom of [1, 1.7, 3, 6]) {
      for (const [cx, cy] of [[-9e9, -9e9], [9e9, 9e9], [0, h], [w, 0]]) {
        const box = cropBounds({ w, h, zoom, cx, cy });
        const half = box.side / 2;
        assert.ok(box.cx - half >= -1e-9, `left edge off ${w}x${h} @${zoom}`);
        assert.ok(box.cy - half >= -1e-9, `top edge off ${w}x${h} @${zoom}`);
        assert.ok(box.cx + half <= w + 1e-9, `right edge off ${w}x${h} @${zoom}`);
        assert.ok(box.cy + half <= h + 1e-9, `bottom edge off ${w}x${h} @${zoom}`);
      }
    }
  }
});

test('zoom is held between the whole square and a sixth of it', () => {
  assert.equal(cropBounds({ w: 900, h: 900, zoom: 0.01, cx: 450, cy: 450 }).zoom, 1);
  assert.equal(cropBounds({ w: 900, h: 900, zoom: 500, cx: 450, cy: 450 }).zoom, 6);
  // Zooming right in still leaves a square with area in it.
  assert.equal(cropBounds({ w: 900, h: 900, zoom: 500, cx: 450, cy: 450 }).side, 150);
});

test('a picture already square is left alone at zoom 1', () => {
  const box = cropBounds({ w: 512, h: 512, zoom: 1, cx: 256, cy: 256 });
  assert.deepEqual(
    { side: box.side, cx: box.cx, cy: box.cy },
    { side: 512, cx: 256, cy: 256 },
  );
});

/* ---------------- the chart ---------------- */

beforeEach(() => {
  // One window for the run, not one per test: ui.js keeps a single panel and
  // puts it on the document it first saw, exactly as a browser would. What is
  // reset between tests is the panel's state, not the page.
  ui?.hideProfileCard();
});

const run = (deltas, from = 1000) => {
  const points = [{ at: '2026-01-01T00:00:00Z', rating: from, delta: null, players: null, durak: false }];
  let rating = from;
  deltas.forEach((delta, i) => {
    rating += delta;
    points.push({
      at: new Date(Date.UTC(2026, 0, 2 + i)).toISOString(),
      rating,
      delta,
      players: 4,
      durak: delta < 0,
    });
  });
  return points;
};

test('with nothing to draw it says so rather than drawing an empty box', { skip: NO_DOM }, () => {
  for (const points of [[], run([])]) {
    const el = ratingChart(points);
    assert.equal(el.querySelector('svg'), null);
    assert.match(el.textContent, /no finished games|one game so far/i);
  }
});

test('the line has a point per game, plus the rating held before them', { skip: NO_DOM }, () => {
  const el = ratingChart(run([12, -18, 6, 6, -16]));
  const d = el.querySelector('.chart__line').getAttribute('d');
  assert.equal((d.match(/[ML]/g) ?? []).length, 6);
});

test('every point is inside the box it is drawn in', { skip: NO_DOM }, () => {
  // A scale worked out from the data can put a point outside the plot if the
  // padding is wrong, and the overflow is visible rather than clipped, so it
  // would land on top of the panel instead of being obviously broken.
  for (const deltas of [[12], [12, 12, 12], [-21, -21, -21, -21], [3, -0.5, 0.25]]) {
    const el = ratingChart(run(deltas));
    const svg = el.querySelector('svg');
    const [, , boxW, boxH] = svg.getAttribute('viewBox').split(' ').map(Number);
    for (const point of svg.querySelector('.chart__line').getAttribute('d').matchAll(/([\d.]+) ([\d.]+)/g)) {
      const x = Number(point[1]);
      const y = Number(point[2]);
      assert.ok(x >= 0 && x <= boxW, `x ${x} outside 0..${boxW}`);
      assert.ok(y >= 0 && y <= boxH, `y ${y} outside 0..${boxH} for ${deltas}`);
    }
  }
});

test('a flat run still gets a scale rather than dividing by nothing', { skip: NO_DOM }, () => {
  const el = ratingChart(run([0, 0, 0]));
  const d = el.querySelector('.chart__line').getAttribute('d');
  assert.ok(!/NaN|Infinity/.test(d), d);
  assert.ok(el.querySelectorAll('.chart__grid text').length >= 2);
});

test('a rating far from the start still shows where the start was', { skip: NO_DOM }, () => {
  const climbed = ratingChart(run(Array(20).fill(12)));
  const labels = [...climbed.querySelectorAll('.chart__grid text')].map((t) => t.textContent);
  assert.ok(labels.some((l) => Number(l) <= 1000), `no label at or below 1000: ${labels}`);
});

test('every game keeps a dot, however long the run', { skip: NO_DOM }, () => {
  // Each dot carries a result in its colour, so none of them can be dropped
  // the way an ordinary line chart drops them once they get crowded.
  assert.equal(ratingChart(run(Array(8).fill(6))).querySelectorAll('.chart__dot').length, 9);
  assert.equal(ratingChart(run(Array(80).fill(6))).querySelectorAll('.chart__dot').length, 81);
});

test('dots shrink as the run gets long, but stay dots', { skip: NO_DOM }, () => {
  const radius = (el) => Number(el.querySelector('.chart__dot').getAttribute('r'));
  const few = radius(ratingChart(run(Array(8).fill(6))));
  const many = radius(ratingChart(run(Array(90).fill(6))));
  assert.ok(few > many, `expected ${few} > ${many}`);
  assert.ok(many >= 2, `dots shrank to ${many}, too small to see`);
  assert.ok(few <= 4, `dots grew to ${few}, larger than the spec allows`);
});

test('a dot is green for a game got out of and red for one lost', { skip: NO_DOM }, () => {
  const el = ratingChart(run([12, -18, 6]));
  const dots = [...el.querySelectorAll('.chart__dot')];
  assert.deepEqual(
    dots.map((d) => d.getAttribute('class').replace('chart__dot ', '')),
    ['chart__dot--none', 'chart__dot--out', 'chart__dot--durak', 'chart__dot--out'],
  );
});

test('the value written at the end is the rating the player now holds', { skip: NO_DOM }, () => {
  const el = ratingChart(run([12, -18, 6]));
  assert.equal(el.querySelector('.chart__end-label').textContent, '1000');
});

test('every game is reachable by the pointer', { skip: NO_DOM }, () => {
  const el = ratingChart(run(Array(12).fill(-3)));
  assert.equal(el.querySelectorAll('.chart__hit rect').length, 13);
});

test('the time axis carries no labels at all', { skip: NO_DOM }, () => {
  // Dates meant nothing spread evenly across games played in bursts, so the
  // only place a date appears is the tooltip for the game under the pointer.
  const el = ratingChart(run([6, -6, 6, 6]));
  assert.equal(el.querySelectorAll('.chart__axis').length, 0);
  assert.equal(el.querySelector('.chart__start text'), null, 'the start line is labelled again');

  const labels = [...el.querySelectorAll('text')].map((t) => t.textContent);
  // What is left is the value axis and the figure at the end of the line.
  assert.ok(labels.every((l) => /^\d+$/.test(l)), `non-numeric label: ${labels.join(',')}`);
});

/* ---------------- the panel ---------------- */

const player = (over = {}) => ({
  id: 'p1', username: 'Дурак', rating: 1013.375479, wins: 6, losses: 3, draws: 1, ...over,
});

test('it carries the name and the rating, rounded the way everything else is', { skip: NO_DOM }, () => {
  const trigger = document.createElement('span');
  document.body.append(trigger);
  ui.attachProfileCard(trigger, player());
  trigger.dispatchEvent(new window.FocusEvent('focus'));

  const card = document.querySelector('.pcard');
  assert.equal(card.hidden, false);
  assert.equal(card.querySelector('.pcard__name').textContent, 'Дурак');
  assert.equal(card.querySelector('.pcard__rating').textContent, '1013');
  // The number needs no caption saying what it is.
  assert.doesNotMatch(card.textContent, /rating/i);
});

test('the text beside the picture stays within three lines', { skip: NO_DOM }, () => {
  // Not a style quibble: the panel's even margin comes from the picture being
  // the tallest thing on it, and a fourth line would push past it and open a
  // gap above and below the picture that is not there at the sides. jsdom
  // does no layout, so the count is what can be checked here — the height it
  // has to stay under is written down in main.css, on .pcard__body.
  const trigger = document.createElement('span');
  document.body.append(trigger);
  ui.attachProfileCard(trigger, player());
  trigger.dispatchEvent(new window.FocusEvent('focus'));

  const body = document.querySelector('.pcard__body');
  assert.ok(body.children.length <= 3, `${body.children.length} lines beside the picture`);
});

test('it counts games from either shape of row, and says nothing else', { skip: NO_DOM }, () => {
  const fromProfile = document.createElement('span');
  document.body.append(fromProfile);
  ui.attachProfileCard(fromProfile, player());   // wins 6, losses 3, draws 1
  fromProfile.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(document.querySelector('.pcard__record').textContent, '10 games');

  ui.hideProfileCard();

  const fromLeaderboard = document.createElement('span');
  document.body.append(fromLeaderboard);
  ui.attachProfileCard(fromLeaderboard, { username: 'bo', rating: 988, games: 4, duraks: 1 });
  fromLeaderboard.dispatchEvent(new window.FocusEvent('focus'));

  const card = document.querySelector('.pcard');
  assert.equal(card.querySelector('.pcard__record').textContent, '4 games');
  // How often somebody has been the fool is their business, not a caption.
  assert.doesNotMatch(card.textContent, /durak/i);
});

test('an empty seat gets no panel at all', { skip: NO_DOM }, () => {
  const trigger = document.createElement('span');
  document.body.append(trigger);
  ui.attachProfileCard(trigger, null);
  trigger.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(trigger.classList.contains('has-card'), false);
  assert.equal(trigger.hasAttribute('aria-describedby'), false);
  assert.notEqual(document.querySelector('.pcard')?.hidden, false, 'a panel for nobody');
});

test('it closes again, and lets go of the player it was describing', { skip: NO_DOM }, () => {
  const trigger = document.createElement('span');
  document.body.append(trigger);
  ui.attachProfileCard(trigger, player());

  trigger.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(trigger.getAttribute('aria-describedby'), 'player-card');

  trigger.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(document.querySelector('.pcard').hidden, true);
  assert.equal(trigger.hasAttribute('aria-describedby'), false);
});

test('the trigger is reachable by keyboard', { skip: NO_DOM }, () => {
  const trigger = document.createElement('span');
  document.body.append(trigger);
  ui.attachProfileCard(trigger, player());
  assert.equal(trigger.tabIndex, 0);
});

test('a name in another script keeps its first character whole', { skip: NO_DOM }, () => {
  // The fallback is the first letter of the name, and slicing a string by
  // code unit cuts anything outside the basic plane in half.
  const el = ui.avatarEl({ username: '🀄 mahjong' });
  assert.equal(el.textContent, '🀄');
  assert.equal(ui.avatarEl({ username: 'Дурак' }).textContent, 'Д');
});
