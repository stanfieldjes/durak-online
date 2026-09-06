import { supabase, readableError } from './supabase.js';
import { getProfile, createProfile } from './db.js';
import { $, $$, show, setText } from './ui.js';
import { formatRating } from './elo.js';

let mode = 'sign-in';

export const session = {
  user: null,
  profile: null,
};

export async function loadSession() {
  const { data } = await supabase.auth.getSession();
  session.user = data.session?.user ?? null;
  session.profile = session.user ? await getProfile(session.user.id) : null;
  return session;
}

export function onAuthChange(handler) {
  supabase.auth.onAuthStateChange(async (event) => {
    if (event === 'SIGNED_OUT') {
      session.user = null;
      session.profile = null;
    } else {
      await loadSession();
    }
    handler(session);
  });
}

export function renderWhoami() {
  const box = $('#whoami');
  if (!session.profile) {
    show(box, false);
    return;
  }
  setText($('#whoami-name'), session.profile.username);
  setText($('#whoami-elo'), formatRating(session.profile.rating));
  show(box, true);
}

function setMode(next) {
  mode = next;
  $$('[data-auth-tab]').forEach((tab) => {
    const on = tab.dataset.authTab === next;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
  });
  $$('[data-only="sign-up"]').forEach((el) => show(el, next === 'sign-up'));
  const username = $('#auth-form [name="username"]');
  if (username) username.required = next === 'sign-up';
  const password = $('#auth-form [name="password"]');
  if (password) password.autocomplete = next === 'sign-up' ? 'new-password' : 'current-password';
  setText($('#auth-submit'), next === 'sign-up' ? 'Create account' : 'Sign in');
  showError(null);
}

function showError(message) {
  const el = $('#auth-error');
  if (!el) return;
  el.textContent = message ?? '';
  show(el, Boolean(message));
}

export function initAuthView(onSignedIn) {
  $$('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.authTab));
  });

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('#auth-submit');
    const email = form.email.value.trim();
    const password = form.password.value;
    const username = form.username.value.trim();

    if (mode === 'sign-up' && (username.length < 3 || username.length > 20)) {
      showError('Pick a name between 3 and 20 characters.');
      return;
    }
    if (password.length < 8) {
      showError('Password must be at least 8 characters.');
      return;
    }

    submit.disabled = true;
    setText(submit, 'Working…');
    showError(null);

    try {
      if (mode === 'sign-up') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          showError('Check your email to confirm the account, then sign in.');
          return;
        }
        await createProfile(data.user.id, username);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      await loadSession();

      // An account can exist without a profile if sign-up was interrupted.
      if (session.user && !session.profile) {
        const fallback = (session.user.email || 'player').split('@')[0].slice(0, 20);
        session.profile = await createProfile(session.user.id, fallback);
      }

      renderWhoami();
      onSignedIn(session);
    } catch (error) {
      showError(readableError(error));
    } finally {
      submit.disabled = false;
      setText(submit, mode === 'sign-up' ? 'Create account' : 'Sign in');
    }
  });

  $('#sign-out').addEventListener('click', async () => {
    await supabase.auth.signOut();
    location.hash = '#/';
    location.reload();
  });

  setMode('sign-in');
}
