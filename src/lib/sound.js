/**
 * Tactile Web Audio API synthesizer for Tangent.
 * Organic wood, paper, and gentle pentatonic percussion (~0 KB of audio files).
 */
import { getPrefs, updatePrefs } from './storage.js';

let ctx = null;
let enabled = getPrefs().sound !== false;
const MASTER_GAIN = 0.24;

// Major pentatonic scale: C5, D5, E5, G5, A5, C6, D6, E6
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];

function ensureCtx() {
  if (!enabled) return null;
  if (!ctx && typeof window !== 'undefined') {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) ctx = new AudioCtx();
  }
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

export function isSoundEnabled() {
  return enabled;
}

export function toggleSound() {
  enabled = !enabled;
  updatePrefs({ sound: enabled });
  if (enabled) playTap();
  return enabled;
}

export function haptic(ms = 8) {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  } catch {
    // Ignore on unsupported browsers
  }
}

/** Soft tactile wood/tile tap with ±3% organic pitch variation */
export function playTap() {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const jitter = 1 + (Math.random() * 0.06 - 0.03);

  // Subtle pitched triangle blip
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(680 * jitter, now);
  osc.frequency.exponentialRampToValueAtTime(340 * jitter, now + 0.028);

  g.gain.setValueAtTime(MASTER_GAIN * 0.65, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.035);
  haptic(6);
}

/** Gentle downward tap for Back / Undo */
export function playBack() {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(420, now);
  osc.frequency.exponentialRampToValueAtTime(250, now + 0.055);
  g.gain.setValueAtTime(MASTER_GAIN * 0.55, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.065);
  haptic(6);
}

/** Soft damped wooden knock for errors / banned hubs (never a harsh buzzer) */
export function playThud() {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(155, now);
  osc.frequency.exponentialRampToValueAtTime(68, now + 0.085);
  g.gain.setValueAtTime(MASTER_GAIN * 0.9, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.1);
  haptic(14);
}

/** Pitch-escalating pentatonic note for reveals & pause-challenge pops */
export function playStep(index = 0) {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const freq = PENTATONIC[Math.min(index, PENTATONIC.length - 1)];

  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, now);

  g.gain.setValueAtTime(0.001, now);
  g.gain.linearRampToValueAtTime(MASTER_GAIN * 0.65, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.2);
  haptic(5);
}

/** Subtle cardstock shuffle rustle */
export function playShuffle() {
  const c = ensureCtx();
  if (!c) return;
  for (let i = 0; i < 4; i++) {
    setTimeout(() => playTap(), i * 28);
  }
}

/** Clean countdown beep for 10-player live race starts */
export function playCountdown(isGo = false) {
  const c = ensureCtx();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(isGo ? 880 : 440, now);
  g.gain.setValueAtTime(MASTER_GAIN * 0.6, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + (isGo ? 0.24 : 0.1));
  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + (isGo ? 0.26 : 0.12));
}

/** Warm softly arpeggiated Cmaj9 chord on victory */
export function playWin() {
  const c = ensureCtx();
  if (!c) return;
  const notes = [523.25, 659.25, 783.99, 987.77, 1174.66]; // C5 E5 G5 B5 D6
  const base = c.currentTime;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2400, base);
  filter.connect(c.destination);

  notes.forEach((freq, i) => {
    const start = base + i * 0.065;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);

    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(MASTER_GAIN * 0.52, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);

    osc.connect(g);
    g.connect(filter);
    osc.start(start);
    osc.stop(start + 0.6);
  });
  haptic(18);
}
