/**
 * Your own name, picture and rating.
 *
 * The picture goes into the `avatars` storage bucket under a folder named
 * with your user id, which is the only place the storage policy lets you
 * write. Where it landed is then recorded on the profile through set_avatar(),
 * so the browser never writes to the profiles table itself.
 *
 * What is uploaded is the square chosen in the cropper, not the file that was
 * picked — see cropper.js.
 */
import { setUsername, setAvatar, uploadAvatar, getProfile, listMyRatingHistory } from './db.js';
import { readableError } from './supabase.js';
import { session, renderWhoami, nameProblem } from './auth.js';
import { $, show, setText, clear, toast, avatarEl, paintRating } from './ui.js';
import { cropToSquare } from './cropper.js';
import { ratingChart } from './chart.js';

/** Bigger than this and the bucket refuses it, so say so before uploading. */
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** How many games back the line goes. Nobody here has played more. */
const HISTORY = 100;

/**
 * Bumped on every visit to the page, so a history that arrives after the
 * player has left and come back is dropped rather than drawn on top of the
 * one they are already looking at.
 */
let visit = 0;

export function initAccount() {
  $('#account-name-form').addEventListener('submit', onRename);
  $('#avatar-file').addEventListener('change', onPick);
  $('#avatar-remove').addEventListener('click', onRemove);
}

export async function enterAccount() {
  if (!session.user) return;
  note(null);

  // Another tab, or another device, may have changed the name or the picture
  // since this page loaded.
  try {
    const fresh = await getProfile(session.user.id);
    if (fresh) session.profile = fresh;
  } catch (error) {
    toast(readableError(error));
  }
  if (!session.profile) return;

  $('#account-name-form').name.value = session.profile.username;
  paint();
  paintHistory();
}

function paint() {
  const box = $('#account-avatar');
  clear(box);
  box.append(avatarEl(session.profile, { size: 'lg' }));
  show($('#avatar-remove'), Boolean(session.profile?.avatar_url));
  paintRating($('#account-rating'), session.profile?.rating);
  renderWhoami();
}

/**
 * The line of the rating over time.
 *
 * Walked backwards from the rating on the profile rather than forwards from
 * the starting one: the profile holds the true current figure, and anchoring
 * the chart to it means the last point always agrees with the number printed
 * above it — even for a player with more games than the limit here shows.
 */
async function paintHistory() {
  const mine = ++visit;
  const box = $('#account-chart');
  clear(box);
  setText($('#account-games'), '');

  let games;
  try {
    games = await listMyRatingHistory(session.user.id, HISTORY);
  } catch (error) {
    if (mine !== visit) return;
    const failed = document.createElement('p');
    failed.className = 'chart__empty';
    failed.textContent = readableError(error);
    box.append(failed);
    return;
  }

  // Somebody else's turn now: they left the page and came back while this was
  // in the air, and a second chart is already on its way.
  if (mine !== visit) return;

  const now = Number(session.profile?.rating ?? 0);
  const points = [];
  let rating = now;

  for (let i = games.length - 1; i >= 0; i--) {
    points.unshift({ ...games[i], rating });
    rating -= games[i].delta;
  }
  // Where the line begins: the rating held before the first game shown.
  points.unshift({
    at: games[0]?.at ?? null,
    rating,
    delta: null,
    players: null,
    durak: false,
  });

  box.append(ratingChart(games.length ? points : []));
  setText($('#account-games'), games.length === 1 ? '1 game' : `${games.length} games`);
}

function note(message, kind = 'info') {
  const el = $('#account-note');
  if (!el) return;
  el.textContent = message ?? '';
  el.classList.toggle('is-bad', kind === 'bad');
  show(el, Boolean(message));
}

async function onRename(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#account-name-save');
  const name = form.name.value.trim();

  if (name === session.profile?.username) {
    note('That is already your name.');
    return;
  }
  const problem = nameProblem(name);
  if (problem) {
    note(problem, 'bad');
    return;
  }

  submit.disabled = true;
  setText(submit, 'Saving…');
  try {
    session.profile = await setUsername(name);
    form.name.value = session.profile.username;
    paint();
    note('Name changed.');
  } catch (error) {
    note(readableError(error), 'bad');
  } finally {
    submit.disabled = false;
    setText(submit, 'Save');
  }
}

async function onPick(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';   // so picking the same file again still fires a change
  if (!file) return;

  if (!TYPES.includes(file.type)) {
    note('Pictures must be PNG, JPEG, WebP or GIF.', 'bad');
    return;
  }
  if (file.size > MAX_BYTES) {
    note('That picture is over 2MB. Try a smaller one.', 'bad');
    return;
  }

  let square;
  try {
    square = await cropToSquare(file);
  } catch {
    note('That file could not be opened as a picture.', 'bad');
    return;
  }
  if (!square) {
    note(null);   // they backed out of the cropper
    return;
  }

  input.disabled = true;
  note('Uploading…');
  try {
    const url = await uploadAvatar(session.user.id, square);
    session.profile = await setAvatar(url);
    paint();
    note('Picture updated.');
  } catch (error) {
    note(uploadProblem(error), 'bad');
  } finally {
    input.disabled = false;
  }
}

async function onRemove() {
  const btn = $('#avatar-remove');
  btn.disabled = true;
  try {
    session.profile = await setAvatar(null);
    paint();
    note('Picture removed.');
  } catch (error) {
    note(readableError(error), 'bad');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Storage errors arrive as HTTP-flavoured messages that mean nothing to the
 * person who just picked a photo. The one worth translating is a missing
 * bucket, which means the setup step was skipped rather than that they did
 * anything wrong.
 */
function uploadProblem(error) {
  const message = error?.message ?? '';
  if (/bucket not found/i.test(message)) {
    return 'Pictures are not set up on this site yet — the avatars bucket is missing.';
  }
  if (/exceeded the maximum|payload too large/i.test(message)) {
    return 'That picture is too large. Try one under 2MB.';
  }
  if (/mime type|not supported/i.test(message)) {
    return 'Pictures must be PNG, JPEG, WebP or GIF.';
  }
  if (/row-level security|unauthorized|403/i.test(message)) {
    return 'You are not allowed to write there. Check the avatars bucket policies.';
  }
  return readableError(error);
}
