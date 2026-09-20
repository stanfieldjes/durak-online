/**
 * The one property build.py exists to guarantee: every module a deploy ships
 * is versioned together, so a browser can never run part of one deploy
 * against part of another.
 *
 * This is a regression test for a real incident — a player hovered over the
 * leaderboard, saw nothing new, and the account page showed no picture, no
 * chart, no rating, even though the deploy that added all three had gone out
 * cleanly. The build was fine; the browser's disk cache had kept the old
 * ui.js and account.js, because only the entry script's own URL carried a
 * cache-busting query. Every *import inside* a module pointed at a bare,
 * unversioned path, so the browser was free to keep serving those from
 * yesterday even after fetching today's app.js. Run entirely through Python
 * (build.py has no JS-side counterpart), so the check calls it as a
 * subprocess rather than importing it.
 */

import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'durak-build-'));
  for (const name of ['src', 'build.py', 'config.example.json']) {
    cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    site: { title: 'Test', tagline: 't', basePath: '/durak-online/' },
    supabase: { url: 'https://YOUR-PROJECT.supabase.co', anonKey: 'YOUR-ANON-KEY' },
    game: { defaultPlayers: 4, turnSeconds: 0 },
  }));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = () => execFileSync('python3', ['build.py'], { cwd: dir, encoding: 'utf8' });

/** Every ./foo.js or ../foo.js specifier a module's source imports. */
const localImports = (text) => [...text.matchAll(/(['"])(\.\.?\/[^'"]+?\.js)(?:\?[^'"]*)?\1/g)]
  .map((m) => m[2]);

test('the build runs cleanly', () => {
  const output = run();
  assert.match(output, /Built dist/);
});

test('every local import in every shipped module carries the same ?v=', () => {
  const jsDir = join(dir, 'dist', 'js');
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 5, 'the build should have shipped more than a handful of modules');

  const versions = new Set();
  const unversioned = [];

  for (const file of files) {
    const text = readFileSync(join(jsDir, file), 'utf8');
    for (const match of text.matchAll(/(['"])(\.\.?\/[^'"]+?\.js)(\?[^'"]*)?\1/g)) {
      const [, , specifier, query] = match;
      if (!query || !/^\?v=[a-f0-9]+$/.test(query)) unversioned.push(`${file} -> ${specifier}`);
      else versions.add(query);
    }
  }

  assert.deepEqual(unversioned, [], 'local imports with no cache-busting query');
  // One hash for the whole graph: a change anywhere invalidates every module
  // that could be loaded alongside it, not just the one file that changed.
  assert.equal(versions.size, 1, `expected one shared version, saw ${[...versions]}`);
});

test('a change to one file changes the URL of every file that imports it', () => {
  run();
  const before_ = readFileSync(join(dir, 'dist', 'js', 'app.js'), 'utf8');
  const beforeUiUrl = before_.match(/ui\.js\?v=[a-f0-9]+/)[0];

  writeFileSync(join(dir, 'src/js/ui.js'), readFileSync(join(dir, 'src/js/ui.js'), 'utf8') + '\n// touched\n');
  run();

  const after_ = readFileSync(join(dir, 'dist', 'js', 'app.js'), 'utf8');
  const afterUiUrl = after_.match(/ui\.js\?v=[a-f0-9]+/)[0];

  assert.notEqual(beforeUiUrl, afterUiUrl, 'editing ui.js should change the URL every importer uses for it');

  // Every module that imports ui.js — not just the one that was edited —
  // has to move to the new URL together, or a browser could still mix them.
  const escaped = afterUiUrl.replace(/[.?]/g, '\\$&');
  for (const file of readdirSync(join(dir, 'dist', 'js'))) {
    const text = readFileSync(join(dir, 'dist', 'js', file), 'utf8');
    if (localImports(text).some((spec) => spec.endsWith('ui.js'))) {
      assert.match(text, new RegExp(escaped), `${file} still points at the old ui.js`);
    }
  }
});

test('the one import that must not be touched — the CDN import in supabase.js — is untouched', () => {
  run();
  const text = readFileSync(join(dir, 'dist', 'js', 'supabase.js'), 'utf8');
  assert.match(text, /from 'https:\/\/esm\.sh\/@supabase\/supabase-js@[\d.]+'/);
});

test('the entry script tag itself still carries the same version', () => {
  run();
  const html = readFileSync(join(dir, 'dist', 'index.html'), 'utf8');
  const scriptV = html.match(/js\/app\.js\?v=([a-f0-9]+)/)?.[1];
  const importV = readFileSync(join(dir, 'dist', 'js', 'app.js'), 'utf8').match(/ui\.js\?v=([a-f0-9]+)/)?.[1];
  assert.ok(scriptV, 'index.html should reference a versioned app.js');
  assert.equal(scriptV, importV, 'the page and the module graph must agree on one version');
});

test('does nothing to a specifier that is not a local .js import', () => {
  run();
  // The regex has to stop at the first closing quote, or a comment or string
  // containing an unrelated later quote could swallow past the real import.
  const account = readFileSync(join(dir, 'dist', 'js', 'account.js'), 'utf8');
  assert.doesNotMatch(account, /\?v=[a-f0-9]+\?v=/, 'a specifier was versioned twice');
});

test('fails loudly rather than shipping a stylesheet that breaks [hidden]', () => {
  const real = readFileSync(join(dir, 'src/styles/main.css'), 'utf8');
  writeFileSync(join(dir, 'src/styles/main.css'), real.replace(/\[hidden\][^}]*\}/, ''));
  assert.throws(() => run(), /\[hidden\]/);
  writeFileSync(join(dir, 'src/styles/main.css'), real);
});
