import { getLeaderboard } from './db.js';
import { readableError } from './supabase.js';
import { session } from './auth.js';
import { formatRating } from './rating.js';
import { $, show, clear, toast, playerEl } from './ui.js';
import { setStandings, rankRows, rankTied } from './standing.js';

export async function enterLeaderboard() {
  const body = $('#ranks-body');
  clear(body);
  try {
    // Re-sorted here rather than taken as the view returns it: the view
    // orders on the exact rating, and the ladder is read on the rating as it
    // is printed, with games played settling the ties that makes common.
    const rows = rankRows(await getLeaderboard());
    // The lead is in this list already, so hand it over rather than making
    // the rest of the site send for it again.
    setStandings(rows);
    show($('#no-ranks'), rows.length === 0);

    // A row's position in the sorted list is its place. Players the ladder
    // cannot separate at all — same printed rating, same games — share one
    // rather than being split arbitrarily, which with everyone starting on
    // the same number is exactly what the first few games look like.
    let place = 0;
    let previous = null;

    rows.forEach((row, index) => {
      if (previous === null || !rankTied(row, previous)) {
        place = index + 1;
        previous = row;
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
      ratingCell.textContent = formatRating(row.rating);

      tr.append(placeCell, nameCell, gamesCell, ratingCell);
      body.append(tr);
    });
  } catch (error) {
    toast(readableError(error));
  }
}
