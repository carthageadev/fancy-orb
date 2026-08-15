// orb-spec.js — per-orb derived state, shared by the WebGL and WebGPU
// renderers so both draw the exact same sky from the same inputs.

let seedOffset = 0;

export function setSeedOffset(value) {
  seedOffset = value;
}

export function getSeedOffset() {
  return seedOffset;
}

export function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function mixRgb(first, second, amount) {
  return first.map((channel, index) => channel + (second[index] - channel) * amount);
}

// Derived galaxy state for one orb — identical formulas to the original
// WebGL renderer so the WebGPU port renders the same sky.
export function buildOrbSpec(data, index) {
  const seed = seedOffset + index * 17.13 + 4.7;
  const phase = seed * 0.73 + data.name.length * 0.13;
  const spin = seed * 0.19;
  const starDensity = data.starDensity ?? 1;
  const accentA = hexToRgb(data.a);
  const accentB = hexToRgb(data.b);
  const accentC = hexToRgb(data.c || data.b);
  const anchor = mixRgb(accentA, accentB, 0.28);
  return { seed, phase, spin, starDensity, accentA, accentB, accentC, anchor };
}

// Recompute motion from a fresh seed (shuffle) without touching the palette.
export function specFromSeed(data, seed) {
  const phase = seed * 0.73 + data.name.length * 0.13;
  const spin = seed * 0.19;
  return { seed, phase, spin };
}