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
  // Dealing fires this every 55ms, faster than the clip itself finishes, so it
  // needs enough voices to overlap without cutting itself off.
  draw: { file: 'draw_card.mp3', volume: 0.5, pool: 8 },
  gather: { file: 'pickup_or_discard.mp3', volume: 0.6 },
  start: { file: 'game_start.mp3', volume: 0.7 },
  win: { file: 'win.mp3', volume: 0.8 },
  loss: { file: 'loss.mp3', volume: 0.8 },
};

const pools = new Map();
let unlocked = false;
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
      audio.play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.volume = volume;
        })
        .catch(() => {
          audio.volume = volume; // still fine; it will load on first real play
        });
    }
  }
}

export function initSound() {
  build();
  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(event, unlock, { once: true, passive: true });
  }
}

export function play(name) {
  if (muted || !pools.has(name)) return;
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

/** Fire the same clip a few times, spaced out, for a run of drawn cards. */
export function playRepeat(name, times, gapMs = 90) {
  const count = Math.min(times, 6); // a whole table refilling should not rattle
  for (let i = 0; i < count; i++) setTimeout(() => play(name), i * gapMs);
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
