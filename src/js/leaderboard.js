import { getLeaderboard } from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatRating, formatDurakRate } from './elo.js';
import { $, show, clear, toast } from './ui.js';

export async function enterLeaderboard() {
  const body = $('#ranks-body');
  clear(body);
  try {
    const rows = await getLeaderboard();
    show($('#no-ranks'), rows.length === 0);

    for (const row of rows) {
      const tr = document.createElement('tr');
      if (session.user && row.id === session.user.id) tr.classList.add('is-me');

      for (const [value, cls] of [
        [row.username, ''],
        [formatRating(row.rating), 'rating'],
        [formatDurakRate(row.durak_rate), 'durak-rate'],
      ]) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = String(value);
        tr.append(td);
      }
      body.append(tr);
    }
  } catch (error) {
    toast(readableError(error));
  }
}
