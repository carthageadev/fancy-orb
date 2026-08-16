// quality.js — adaptive resolution ladder + frame-rate cap.
//
// Samples per-frame time (rAF deltas), smooths with an EMA, and walks a
// resolution scale ladder: sustained lag drops a rung (down to 0.5 on very
// weak devices), sustained headroom climbs back up. Manual modes pin a fixed
// rung; auto mode (default) walks within the device-class budget.
//
// Compact/coarse-pointer devices begin at exactly 70% backing resolution —
// the 0.7 rung, two below the desktop start — so weak mobile GPUs pay for
// fewer pixels up front. Auto mode still adapts down after the warmup window,
// but compact Auto is capped at 70% so a fast-looking mobile device does not
// immediately climb back into an expensive full-resolution path.
//
// The frame-rate cap (the `fps-setting` select) is a sibling policy: Auto
// renders every rAF as today, while 30/20/15 render on a coarser cadence and
// preserve shader appearance. The ladder keeps sampling under a cap by scaling
// its slow/fast thresholds to the capped per-render budget, so a device that
// holds the cap looks healthy and one that misses it still walks down. While a
// cap is active, the auto ladder's ceiling also drops to the 70% rung, so
// healthy frames under a cap cannot climb back to full resolution and erase
// the pixel savings; manual resolution modes stay authoritative and are never
// clamped. Fidelity remains the explicit visual-quality tradeoff.
//
// Both renderers (WebGL and WebGPU) implement setQualityScale(scale),
// and setFidelity(value), so the manager drives both stacks identically.

export const QUALITY_LEVELS = [0.5, 0.58, 0.7, 0.84, 1];

// Compact/coarse-pointer devices start on exactly this rung (70%). It is a
// real ladder rung, so compact Auto can walk down from it when needed.
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

// --- frame-rate cap ---
// Values of the `fps-setting` select. Auto keeps the current behavior (render
// every rAF); capped modes add a frame target so old phones do less work
// while absolute time still advances on every rAF.

export const FPS_CAPS = {
  auto: null,
  "30": 30,
  "20": 20,
  "15": 15
};

export const FPS_DEFAULT = "auto";

export function isFpsSetting(value) {
  // A <select> change event always delivers a string, and property access on
  // FPS_CAPS would silently coerce e.g. the number 30 into the "30" key.
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FPS_CAPS, value);
}

// Per-render interval in milliseconds for a cap; 0 means no cap (auto).
export function fpsToInterval(fps) {
  const target = isFpsSetting(fps) ? FPS_CAPS[fps] : null;
  return target == null ? 0 : 1000 / target;
}

// Cadence check for the rAF loop. `lastRenderAt` is the rAF timestamp of the
// previous render (0 before the first one); the first render is always
// immediate. Afterwards a render is due once `intervalMs` has elapsed since
// the last one. Auto (intervalMs 0) is due on every rAF.
export function frameDue(now, lastRenderAt, intervalMs) {
  return lastRenderAt <= 0 || now - lastRenderAt >= intervalMs;
}

const SLOW_EMA_MS = 22;     // above this sustained -> drop a rung
const FAST_EMA_MS = 17.2;   // below this sustained -> climb a rung
const SLOW_STREAK = 8;      // frames of lag before dropping
const FAST_STREAK = 30;     // frames of headroom before climbing
const EMA_ALPHA = 0.1;      // frame-time smoothing
export const AUTO_BUDGET_MS = 1000 / 60; // the 22/17.2 ms thresholds assume 60 Hz

export class QualityManager {
  constructor({ onLevelChange, compact = false, warmupMs = 1500 } = {}) {
    this.levels = QUALITY_LEVELS;
    // The auto ladder's ceiling. Desktop Auto may walk up to 100%; compact
    // Auto is capped at the 70% rung. setFpsCeiling() lowers it further while
    // a capped FPS mode is active. baseMaxIndex keeps the uncapped ceiling so
    // clearing the cap restores it exactly.
    this.autoMaxIndex = compact ? this.levels.indexOf(COMPACT_SCALE) : this.levels.length - 1;
    this.baseMaxIndex = this.autoMaxIndex;
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
    const maxIndex = this.enabled ? this.autoMaxIndex : this.levels.length - 1;
    const clamped = Math.max(0, Math.min(maxIndex, nextIndex));
    if (clamped === this.index) return;
    this.index = clamped;
    this.onLevelChange(this.scale);
  }

  setMode(mode) {
    if (mode === "auto") {
      this.enabled = true;
      this.setLevel(this.autoMaxIndex);
    } else {
      this.enabled = false;
      this.setLevel(RESOLUTION_MODES[mode] ?? RESOLUTION_MODES.balanced);
    }
    this.reset();
  }

  // Capped FPS modes lower the auto ladder's ceiling to the 70% COMPACT_SCALE
  // rung so adaptive headroom cannot climb back to full resolution while the
  // cap is buying GPU savings. Manual modes stay authoritative: when `enabled`
  // is false, setLevel() clamps against the full ladder, so no manual rung is
  // ever clamped. Clearing the cap restores the normal auto maximum without
  // moving the level — the ladder's existing fast/slow hysteresis recovers it.
  setFpsCeiling(capped) {
    const compactIndex = this.levels.indexOf(COMPACT_SCALE);
    this.autoMaxIndex = capped
      ? Math.min(this.baseMaxIndex, compactIndex)
      : this.baseMaxIndex;
    if (capped && this.enabled && this.index > this.autoMaxIndex) {
      this.setLevel(this.autoMaxIndex);
    }
  }

  // frameMs: time between the last two animation frames. Ignored during the
  // warmup window so startup jank (shader compile, GPU warmup) can never
  // drop the ladder before the app is actually running.
  //
  // budgetMs: per-render budget in ms. The default is the 60 Hz frame budget
  // (16.7 ms), which reproduces the original slow/fast thresholds exactly.
  // Under a frame-rate cap the caller passes the capped interval instead, and
  // the thresholds scale with it so sampling stays meaningful: hitting the
  // cap reads as healthy, missing it still walks the ladder down.
  sample(frameMs, budgetMs = AUTO_BUDGET_MS) {
    if (!this.enabled || performance.now() < this.armedAt) return;
    this.emaMs = this.emaMs * (1 - EMA_ALPHA) + frameMs * EMA_ALPHA;

    const slowMs = (SLOW_EMA_MS * budgetMs) / AUTO_BUDGET_MS;
    const fastMs = (FAST_EMA_MS * budgetMs) / AUTO_BUDGET_MS;

    if (this.emaMs > slowMs) {
      this.slowStreak += 1;
      this.fastStreak = 0;
      if (this.slowStreak >= SLOW_STREAK) {
        this.slowStreak = 0;
        this.setLevel(this.index - 1);
      }
      return;
    }

    this.slowStreak = 0;
    if (this.emaMs < fastMs) {
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
