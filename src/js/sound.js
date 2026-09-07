/**
 * Sound effects.
 *
 * Browsers refuse to play audio until the person has interacted with the page,
 * so nothing is played before the first click and the first gesture is used to
 * prime the clips. Each clip keeps a small pool of elements, because several
 * cards can land close together and a single element cannot overlap itself.
 */
import { CONFIG } from './config.js';

const BASE = `${CONFIG.basePath}audio/`;
const POOL = 3;
const STORAGE_KEY = 'durak:muted';

const CLIPS = {
  play: { file: 'play_card.mp3', volume: 0.7 },
  gather: { file: 'pickup_or_discard.mp3', volume: 0.6 },
  takeDeclared: { file: 'take_declared.mp3', volume: 0.7 },
  start: { file: 'game_start.mp3', volume: 0.7 },
  win: { file: 'win.mp3', volume: 0.8 },
  loss: { file: 'loss.mp3', volume: 0.8 },
};

const pools = new Map();
let unlocked = false;
let priming = false;
let active = false; // only true while a table is on screen
let muted = readMuted();

function readMuted() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false; // private mode, or storage blocked
  }
}

function build() {
  for (const [name, { file, volume, pool = POOL }] of Object.entries(CLIPS)) {
    const voices = [];
    for (let i = 0; i < pool; i++) {
      const audio = new Audio(BASE + file);
      audio.preload = 'auto';
      audio.volume = volume;
      voices.push(audio);
    }
    pools.set(name, { voices, next: 0 });
  }
}

/**
 * Prime the clips so the first real play is instant.
 *
 * Two things make this delicate. Browsers refuse to play audio until the
 * person has interacted with the page, so priming has to happen inside a
 * gesture. And iOS treats `volume` as read-only and ignores writes to it
 * entirely — so the usual "play at volume 0" trick is silent everywhere
 * except the one place it matters most, where it plays every clip at full
 * volume instead. `muted` is honoured on iOS, so that is what does the work
 * here; the volume line is only a belt-and-braces fallback.
 */
function unlock() {
  if (unlocked || priming) return;
  priming = true;

  for (const { voices } of pools.values()) {
    for (const audio of voices) {
      const volume = audio.volume;
      audio.muted = true;
      audio.volume = 0;
      const stop = () => {
        // Pause on BOTH paths. A rejected play() does not reliably mean
        // nothing started — some browsers begin playback and reject
        // afterwards, and un-muting without pausing first turns that silent
        // priming clip into an audible one.
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          /* nothing to stop */
        }
        audio.muted = false;
        audio.volume = volume;
      };
      audio.play().then(
        () => {
          stop();
          // Only now is it certain playback is actually permitted. Marking
          // this on the attempt instead would strand the app permanently
          // half-primed if the first try happened before a real gesture.
          unlocked = true;
          priming = false;
          stopWaitingForGesture();
        },
        () => {
          stop();
          priming = false; // blocked; the gesture listeners will try again
        }
      );
    }
  }
}

const GESTURES = ['pointerdown', 'keydown', 'touchstart'];

function startWaitingForGesture() {
  if (unlocked) return;
  for (const event of GESTURES) {
    window.addEventListener(event, unlock, { passive: true });
  }
}

function stopWaitingForGesture() {
  for (const event of GESTURES) {
    window.removeEventListener(event, unlock);
  }
}

/** Build the clips. Loads audio data, but never plays anything. */
export function initSound() {
  build();
}

/**
 * Sound belongs to the table and nowhere else.
 *
 * Nothing is primed and nothing is played until a table is actually on
 * screen. Priming used to happen on the first interaction anywhere in the
 * app, which meant signing in could trigger it — and on any browser where the
 * silencing trick failed, that was audible. Waiting until a game starts
 * removes the possibility rather than relying on the priming being quiet.
 */
export function setSoundActive(value) {
  active = Boolean(value);
  if (active) {
    startWaitingForGesture();
    unlock(); // may be blocked this early; the gesture listeners are the fallback
  } else {
    stopWaitingForGesture();
  }
}

export function play(name) {
  if (!active || muted || !pools.has(name)) return;
  const pool = pools.get(name);
  const audio = pool.voices[pool.next];
  pool.next = (pool.next + 1) % pool.voices.length;
  try {
    audio.currentTime = 0;
    audio.play().catch(() => {}); // blocked before the first gesture; not worth surfacing
  } catch {
    /* ignore */
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = Boolean(value);
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* preference just will not persist */
  }
  return muted;
}

export function toggleMuted() {
  return setMuted(!muted);
}
