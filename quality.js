// quality.js — adaptive resolution ladder.
//
// Samples per-frame time (rAF deltas), smooths with an EMA, and walks a
// resolution scale ladder: sustained lag drops a rung (down to 0.5 on very
// weak devices), sustained headroom climbs back up. Manual modes pin a fixed
// rung; auto mode (default) walks freely.
//
// Compact/coarse-pointer devices begin at exactly 70% backing resolution —
// the 0.7 rung, two below the desktop start — so weak mobile GPUs pay for
// fewer pixels up front. Auto mode still adapts from there after the warmup
// window.
//
// Both renderers (WebGL and WebGPU) implement setQualityScale(scale) and
// setFidelity(value), so the manager drives both stacks identically.

export const QUALITY_LEVELS = [0.5, 0.58, 0.7, 0.84, 1];

// Compact/coarse-pointer devices start on exactly this rung (70%). It is a
// real ladder rung, so auto mode can walk either direction from it.
export const COMPACT_SCALE = 0.7;

// Manual-mode rungs (labels preserved from the original settings UI).
export const RESOLUTION_MODES = {
  low: 1,      // 58%
  balanced: 2, // 70%
  high: 3,     // 84%
  full: 4      // 100%
};

export const FIDELITY_MODES = {
  lite: 0.58,
  balanced: 0.8,
  full: 1
};

const SLOW_EMA_MS = 22;     // above this sustained -> drop a rung
const FAST_EMA_MS = 17.2;   // below this sustained -> climb a rung
const SLOW_STREAK = 8;      // frames of lag before dropping
const FAST_STREAK = 30;     // frames of headroom before climbing
const EMA_ALPHA = 0.1;      // frame-time smoothing

export class QualityManager {
  constructor({ onLevelChange, compact = false, warmupMs = 1500 } = {}) {
    this.levels = QUALITY_LEVELS;
    // compact/coarse-pointer devices begin at the exact 70% rung (two below
    // the desktop start); full-size devices begin at the top rung.
    this.index = compact ? this.levels.indexOf(COMPACT_SCALE) : this.levels.length - 1;
    this.enabled = true;
    this.emaMs = 16.7;
    this.slowStreak = 0;
    this.fastStreak = 0;
    this.onLevelChange = onLevelChange ?? (() => {});
    this.warmupMs = warmupMs;
    this.armedAt = performance.now() + warmupMs;
  }

  get scale() {
    return this.levels[this.index];
  }

  get label() {
    return `${Math.round(this.scale * 100)}%`;
  }

  setLevel(nextIndex) {
    const clamped = Math.max(0, Math.min(this.levels.length - 1, nextIndex));
    if (clamped === this.index) return;
    this.index = clamped;
    this.onLevelChange(this.scale);
  }

  setMode(mode) {
    if (mode === "auto") {
      this.enabled = true;
      this.setLevel(this.levels.length - 1);
    } else {
      this.enabled = false;
      this.setLevel(RESOLUTION_MODES[mode] ?? RESOLUTION_MODES.balanced);
    }
    this.reset();
  }

  // frameMs: time between the last two animation frames. Ignored during the
  // warmup window so startup jank (shader compile, GPU warmup) can never
  // drop the ladder before the app is actually running.
  sample(frameMs) {
    if (!this.enabled || performance.now() < this.armedAt) return;
    this.emaMs = this.emaMs * (1 - EMA_ALPHA) + frameMs * EMA_ALPHA;

    if (this.emaMs > SLOW_EMA_MS) {
      this.slowStreak += 1;
      this.fastStreak = 0;
      if (this.slowStreak >= SLOW_STREAK) {
        this.slowStreak = 0;
        this.setLevel(this.index - 1);
      }
      return;
    }

    this.slowStreak = 0;
    if (this.emaMs < FAST_EMA_MS) {
      this.fastStreak += 1;
      if (this.fastStreak >= FAST_STREAK) {
        this.fastStreak = 0;
        this.setLevel(this.index + 1);
      }
    } else {
      this.fastStreak = 0;
    }
  }

  reset() {
    this.emaMs = 16.7;
    this.slowStreak = 0;
    this.fastStreak = 0;
    this.armedAt = performance.now() + this.warmupMs;
  }
}