import { getLeaderboard } from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatRating } from './elo.js';
import { $, show, clear, toast } from './ui.js';

export async function enterLeaderboard() {
  const body = $('#ranks-body');
  clear(body);
  try {
    const rows = await getLeaderboard();
    show($('#no-ranks'), rows.length === 0);

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (session.user && row.id === session.user.id) tr.classList.add('is-me');

      const played = row.wins + row.losses;
      const rate = played ? `${Math.round((100 * row.wins) / played)}%` : '—';

      for (const [value, cls] of [
        [row.username, ''],
        [formatRating(row.rating), 'rating'],
        [row.wins, ''],
        [row.losses, ''],
        [rate, ''],
      ]) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = String(value);
        tr.append(td);
      }
      body.append(tr);
    });
  } catch (error) {
    toast(readableError(error));
  }
}
