import { getLeaderboard } from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatScore, formatRate } from './score.js';
import { $, show, clear, toast } from './ui.js';

export async function enterLeaderboard() {
  const body = $('#ranks-body');
  clear(body);
  try {
    const rows = await getLeaderboard();
    show($('#no-ranks'), rows.length === 0);

    // The view already orders by score, so position in the list is the rank.
    // Equal scores share a place rather than being separated arbitrarily.
    let place = 0;
    let previousScore = null;

    rows.forEach((row, index) => {
      if (row.score !== previousScore) {
        place = index + 1;
        previousScore = row.score;
      }

      const tr = document.createElement('tr');
      if (session.user && row.id === session.user.id) tr.classList.add('is-me');

      for (const [value, cls] of [
        [String(place), 'ranks__place'],
        [row.username, ''],
        [String(row.games), 'ranks__muted'],
        [formatRate(row.durak_rate), ''],
        [formatRate(row.expected_rate), 'ranks__muted'],
        [formatScore(row.score), scoreClass(row.score)],
      ]) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = value;
        tr.append(td);
      }
      body.append(tr);
    });
  } catch (error) {
    toast(readableError(error));
  }
}

function scoreClass(score) {
  const n = Number(score);
  if (!n) return 'ranks__score';
  return `ranks__score ${n > 0 ? 'delta--up' : 'delta--down'}`;
}
