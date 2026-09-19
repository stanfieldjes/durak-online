/**
 * The templates, the stylesheet and the scripts have to agree with each other.
 *
 * All three failure modes here are silent. A dropped CSS rule throws nothing
 * and logs nothing; the page just quietly looks wrong until a player mentions
 * it. An id renamed in a template but not in the script leaves $('#x') null,
 * and the error surfaces somewhere else entirely. A missing partial only
 * fails at build time, which is a slow way to find out.
 *
 * Classes that are deliberately unstyled are listed in UNSTYLED with the
 * reason, so adding one is a decision rather than an oversight.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const listFiles = (dir, ext) =>
  readdirSync(join(ROOT, dir), { recursive: true })
    .filter((name) => String(name).endsWith(ext))
    .map((name) => join(dir, String(name)));

const css = listFiles('src/styles', '.css').map(read).join('\n');
const templates = listFiles('src/templates', '.html');
const scripts = listFiles('src/js', '.js');

/** Class names the stylesheet defines, from every selector in it. */
const defined = new Set(
  [...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);

/**
 * Names that are used but deliberately have no rule of their own. Each one is
 * either a hook for JavaScript or a class whose styling comes from elsewhere.
 */
const UNSTYLED = new Map([
  ['panel', 'a view container; every panel--* variant carries the styling'],
  ['panel--ranks', 'no styling of its own beyond the table inside it'],
  ['panel--game', 'selected by .view:has() rather than styled directly'],
  ['history__delta', 'placement comes from .history .delta'],
  ['auth__pitch', 'a grid child of .panel--auth, which spaces it'],
  ['lobby__active', 'a grid child of .panel--lobby, which spaces it'],
  ['lobby__act', 'a grid child of .panel--lobby, which spaces it'],
  ['lobby__tables', 'a grid child of .panel--lobby, which spaces it'],
  ['lobby__history', 'a grid child of .panel--lobby, which spaces it'],
]);

test('every class used in a template has a rule', () => {
  const missing = new Set();
  for (const path of templates) {
    const html = read(path);
    for (const match of html.matchAll(/class="([^"]+)"/g)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) {
        if (!defined.has(name) && !UNSTYLED.has(name)) missing.add(`${name} (${path})`);
      }
    }
  }
  assert.deepEqual([...missing], [], 'template classes with no CSS rule');
});

test('every class added from JavaScript has a rule', () => {
  const missing = new Set();
  for (const path of scripts) {
    const js = read(path);

    // el.className = 'a b c'  and  el.className = `a ${x}`
    for (const match of js.matchAll(/\.className\s*=\s*['"]([^'"]+)['"]/g)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) {
        if (!defined.has(name) && !UNSTYLED.has(name)) missing.add(`${name} (${path})`);
      }
    }
    // classList.add('a', 'b') / .remove('a') take class names all the way
    // along; classList.toggle('a', cond) takes one, and whatever string
    // appears in the condition after it is a value, not a class.
    for (const match of js.matchAll(/classList\.(add|toggle|remove)\(([^)]*)\)/g)) {
      const literals = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const names = match[1] === 'toggle' ? literals.slice(0, 1) : literals;
      for (const name of names) {
        if (!defined.has(name) && !UNSTYLED.has(name)) missing.add(`${name} (${path})`);
      }
    }
  }
  assert.deepEqual([...missing], [], 'JavaScript classes with no CSS rule');
});

test('the stylesheet still restates [hidden], which build.py requires', () => {
  // Views are toggled with the hidden attribute, and any author rule setting
  // `display` overrides the browser's own display:none for it.
  assert.match(css, /\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/);
});

test('braces balance', () => {
  const opens = (css.match(/\{/g) ?? []).length;
  const closes = (css.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, 'unbalanced braces in the stylesheet');
});

test('every partial a template includes exists', () => {
  const missing = new Set();
  for (const path of templates) {
    for (const match of read(path).matchAll(/\{\{\s*include\s+"([^"]+)"\s*\}\}/g)) {
      const target = join('src/templates', match[1]);
      if (!templates.includes(target)) missing.add(`${match[1]} (from ${path})`);
    }
  }
  assert.deepEqual([...missing], [], 'includes pointing at templates that are not there');
});

test('every id the JavaScript looks up exists in a template', () => {
  const html = templates.map(read).join('\n');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const missing = new Set();
  for (const path of scripts) {
    for (const match of read(path).matchAll(/\$\('#([\w-]+)'\)/g)) {
      if (!ids.has(match[1])) missing.add(`#${match[1]} (${path})`);
    }
  }
  assert.deepEqual([...missing], [], 'ids looked up in JS but absent from the templates');
});
