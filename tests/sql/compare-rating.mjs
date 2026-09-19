// tests/sql/compare-rating.mjs
/**
 * Hold ratingChanges() in src/js/rating.js against public.rating_changes() in
 * supabase/schema.sql, case by case.
 *
 * The two have to agree exactly, not approximately. The browser shows a player
 * their rating change the moment a game ends, and the database works the same
 * change out independently a fraction of a second earlier — if the two ever
 * disagreed, the number on screen would be a lie, and the one that sticks is
 * the database's.
 *
 * Reads the file that tests/sql/run.sh dumped out of Postgres. Each line is
 *
 *     <ratings, comma separated>|<durak index from one, or empty>|<deltas>
 */

import { readFileSync } from 'node:fs';
import { ratingChanges } from '../../src/js/rating.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: compare-rating.mjs <dump from rating.cases.sql>');
  process.exit(2);
}

const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
if (lines.length === 0) {
  console.error('  FAIL: the SQL produced no cases');
  process.exit(1);
}

let mismatches = 0;
let worst = 0;

for (const line of lines) {
  const [ratingText, durakText, deltaText] = line.split('|');
  const ratings = ratingText.split(',').map(Number);
  // SQL arrays count from one and use NULL for a draw; the JS counts seats
  // from zero and uses -1.
  const durakSeat = durakText === '' ? -1 : Number(durakText) - 1;
  const fromSql = deltaText.split(',').map(Number);
  const fromJs = ratingChanges(ratings, durakSeat);

  if (fromJs.length !== fromSql.length) {
    mismatches++;
    console.error(`  FAIL: ${ratingText} durak ${durakText}: ${fromJs.length} deltas vs ${fromSql.length}`);
    continue;
  }

  for (let i = 0; i < fromJs.length; i++) {
    const gap = Math.abs(fromJs[i] - fromSql[i]);
    worst = Math.max(worst, gap);
    if (gap > 0) {
      mismatches++;
      console.error(
        `  FAIL: ${ratingText} durak ${durakText} seat ${i}: js ${fromJs[i]} vs sql ${fromSql[i]}`,
      );
      break;
    }
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} case(s) disagree. Worst gap ${worst}.`);
  process.exit(1);
}

console.log(`  ${lines.length} rating cases agree exactly between the JavaScript and the SQL`);
