import { getLeaderboard } from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatRating } from './rating.js';
import { $, show, clear, toast, playerEl } from './ui.js';
import { setStandings } from './standing.js';

export async function enterLeaderboard() {
  const body = $('#ranks-body');
  clear(body);
  try {
    const rows = await getLeaderboard();
    // The ends of the ladder are in this list already, so hand them over
    // rather than making the rest of the site send for them again.
    setStandings(rows);
    show($('#no-ranks'), rows.length === 0);

    // The view already orders by rating, so a row's position in the list is
    // its place. Equal ratings share a place rather than being separated
    // arbitrarily — which, with everyone starting on the same number, is
    // exactly what the first few games look like.
    let place = 0;
    let previous = null;

    rows.forEach((row, index) => {
      const rating = formatRating(row.rating);
      if (rating !== previous) {
        place = index + 1;
        previous = rating;
      }

      const tr = document.createElement('tr');
      if (session.user && row.id === session.user.id) tr.classList.add('is-me');

      const placeCell = document.createElement('td');
      placeCell.className = 'ranks__place';
      placeCell.textContent = String(place);

      const nameCell = document.createElement('td');
      nameCell.className = 'ranks__player';
      nameCell.append(playerEl(row, { size: 'sm' }));

      const gamesCell = document.createElement('td');
      gamesCell.className = 'ranks__muted';
      gamesCell.textContent = String(row.games);

      const ratingCell = document.createElement('td');
      ratingCell.className = 'ranks__rating';
      ratingCell.textContent = rating;

      tr.append(placeCell, nameCell, gamesCell, ratingCell);
      body.append(tr);
    });
  } catch (error) {
    toast(readableError(error));
  }
}
