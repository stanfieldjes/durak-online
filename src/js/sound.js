/**
 * Sound effects, on the Web Audio API.
 *
 * The obvious implementation is an <audio> element per clip with `volume` set
 * from a slider. That does not work: iOS and Safari treat
 * HTMLMediaElement.volume as read-only and silently ignore writes to it, so
 * the slider would appear to do nothing on exactly the devices most likely to
 * be used here. Routing through a GainNode gives real volume control
 * everywhere, and decoded buffers can overlap freely without needing a pool of
 * elements per clip.
 *
 * Nothing is fetched, decoded, or played until a table is on screen — sound
 * belongs to the game and nowhere else.
 */
import { CONFIG } from './config.js';

const BASE = `${CONFIG.basePath}audio/`;
const STORAGE_KEY = 'durak:volume';
const DEFAULT_VOLUME = 0.7;

/** Per-clip trim, so the mix is balanced before the master slider touches it. */
const CLIPS = {
  play: { file: 'play_card.mp3', gain: 0.9 },
  gather: { file: 'pickup_or_discard.mp3', gain: 0.8 },
  takeDeclared: { file: 'take_declared.mp3', gain: 0.9 },
  start: { file: 'game_start.mp3', gain: 0.9 },
  win: { file: 'win.mp3', gain: 1 },
  loss: { file: 'loss.mp3', gain: 1 },
};

let context = null;
let master = null;      // GainNode: the slider's actual effect
let buffers = new Map(); // name -> AudioBuffer
let loading = false;
let active = false;      // true only while a table is on screen
let volume = readVolume();

function readVolume() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) return DEFAULT_VOLUME;
    const value = Number(saved);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME; // private mode, or storage blocked
  }
}

function ensureContext() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  master = context.createGain();
  master.gain.value = volume;
  master.connect(context.destination);
  return context;
}

/**
 * Fetch and decode every clip. Safe to call repeatedly; it only runs once.
 * Decoding failures are per-clip, so one missing file cannot silence the rest.
 */
async function load() {
  if (loading || buffers.size > 0) return;
  const ctx = ensureContext();
  if (!ctx) return;
  loading = true;

  await Promise.all(
    Object.entries(CLIPS).map(async ([name, { file }]) => {
      try {
        const response = await fetch(BASE + file);
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        // Safari needs the callback form of decodeAudioData in older versions,
        // so wrap it rather than relying on the promise return.
        const buffer = await new Promise((resolve, reject) => {
          const maybe = ctx.decodeAudioData(bytes, resolve, reject);
          if (maybe?.then) maybe.then(resolve, reject);
        });
        buffers.set(name, buffer);
      } catch {
        /* this one clip stays silent */
      }
    })
  );

  loading = false;
}

/**
 * An AudioContext starts suspended until the person interacts with the page.
 * Resuming is cheap and safe to attempt repeatedly, so it is tried both when
 * a game begins and on the next gesture after that.
 */
function resume() {
  const ctx = ensureContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

const GESTURES = ['pointerdown', 'keydown', 'touchstart'];

function startWaitingForGesture() {
  for (const event of GESTURES) window.addEventListener(event, resume, { passive: true });
}

function stopWaitingForGesture() {
  for (const event of GESTURES) window.removeEventListener(event, resume);
}

/** Nothing here touches audio; the context is only built once a game starts. */
export function initSound() {}

export function setSoundActive(value) {
  active = Boolean(value);
  if (active) {
    load();
    resume();
    startWaitingForGesture();
  } else {
    stopWaitingForGesture();
  }
}

export function play(name) {
  if (!active || volume <= 0) return;
  const buffer = buffers.get(name);
  if (!buffer || !context || !master) return;
  if (context.state === 'suspended') resume();

  try {
    const source = context.createBufferSource();
    source.buffer = buffer;

    const trim = context.createGain();
    trim.gain.value = CLIPS[name]?.gain ?? 1;

    source.connect(trim);
    trim.connect(master);
    source.start();
    source.onended = () => {
      source.disconnect();
      trim.disconnect();
    };
  } catch {
    /* a failed effect is never worth interrupting a game for */
  }
}

/* ---------------- volume ---------------- */

export function getVolume() {
  return volume;
}

/** @param {number} value 0 (silent) to 1 (full) */
export function setVolume(value) {
  volume = Math.min(1, Math.max(0, Number(value) || 0));
  if (master && context) {
    // Ramp rather than jump, so dragging the slider does not click and pop.
    const now = context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(volume, now, 0.015);
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(volume));
  } catch {
    /* preference just will not persist */
  }
  return volume;
}
