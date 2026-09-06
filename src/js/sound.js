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
 * The first gesture is the only moment we are allowed to touch audio, so use it
 * to load every clip. Playing and immediately pausing at zero volume is the
 * usual way to get them primed without anyone hearing it.
 */
function unlock() {
  if (unlocked) return;
  unlocked = true;
  for (const { voices } of pools.values()) {
    for (const audio of voices) {
      const volume = audio.volume;
      audio.volume = 0;
      const settle = () => {
        // Pause on BOTH paths. A rejected play() does not reliably mean
        // nothing started — some browsers begin playback and reject
        // afterwards, and restoring the volume without pausing first turns
        // that silent priming clip into an audible one.
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          /* nothing to stop */
        }
        audio.volume = volume;
      };
      audio.play().then(settle).catch(settle);
    }
  }
}

export function initSound() {
  build();
  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, unlock, { once: true, passive: true });
  }
}

/**
 * Sound belongs to the table and nowhere else.
 *
 * The clips are primed on the first interaction anywhere in the app, which
 * includes signing in, so priming alone must never be audible — but relying
 * on that being perfectly silent is thin. This gate is the actual guarantee:
 * outside a game nothing plays at all, whatever else goes wrong.
 */
export function setSoundActive(value) {
  active = Boolean(value);
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
