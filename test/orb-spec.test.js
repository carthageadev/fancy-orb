import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOrbSpec,
  specFromSeed,
  setSeedOffset,
  getSeedOffset,
  hexToRgb,
  mixRgb
} from "../orb-spec.js";

test("buildOrbSpec is deterministic for the same inputs", () => {
  const data = { name: "Aster", a: "#8a5cff", b: "#4c9fff", starDensity: 0.25 };
  const first = buildOrbSpec(data, 0);
  const second = buildOrbSpec(data, 0);
  assert.deepEqual(first, second);
});

test("buildOrbSpec matches the original renderer math (seed 4.7, phase 4.081)", () => {
  setSeedOffset(0);
  const spec = buildOrbSpec({ name: "Aster", a: "#8a5cff", b: "#4c9fff" }, 0);
  assert.equal(spec.seed, 4.7);
  assert.equal(spec.phase, 4.7 * 0.73 + "Aster".length * 0.13);
  assert.equal(spec.spin, 4.7 * 0.19);
  assert.ok(Math.abs(spec.phase - 4.081) < 1e-9);
});

test("seed offset shifts the seed but keeps per-orb stride", () => {
  setSeedOffset(0);
  const before = buildOrbSpec({ name: "A", a: "#fff", b: "#000" }, 1);
  setSeedOffset(5);
  const after = buildOrbSpec({ name: "A", a: "#fff", b: "#000" }, 1);
  assert.equal(after.seed, before.seed + 5);
  assert.equal(getSeedOffset(), 5);
  setSeedOffset(0);
});

test("specFromSeed recomputes motion only, leaving palette untouched", () => {
  const data = { name: "Vesper", a: "#123456", b: "#654321" };
  const motion = specFromSeed(data, 21.83);
  assert.equal(motion.seed, 21.83);
  assert.equal(motion.phase, 21.83 * 0.73 + "Vesper".length * 0.13);
  assert.equal(motion.spin, 21.83 * 0.19);
  assert.deepEqual(Object.keys(motion).sort(), ["phase", "seed", "spin"]);
});

test("hexToRgb normalizes channels to 0..1", () => {
  assert.deepEqual(hexToRgb("#ff0000"), [1, 0, 0]);
  assert.deepEqual(hexToRgb("00ff00"), [0, 1, 0]);
  assert.deepEqual(hexToRgb("#ffffff"), [1, 1, 1]);
});

test("mixRgb lerps per channel", () => {
  assert.deepEqual(mixRgb([0, 0, 0], [1, 1, 1], 0.5), [0.5, 0.5, 0.5]);
  assert.deepEqual(mixRgb([1, 0, 0], [0, 0, 1], 0), [1, 0, 0]);
  assert.deepEqual(mixRgb([1, 0, 0], [0, 0, 1], 1), [0, 0, 1]);
});

test("anchor blends accent A and B at 0.28", () => {
  const spec = buildOrbSpec({ name: "X", a: "#000000", b: "#ffffff" }, 0);
  assert.deepEqual(spec.anchor.map((v) => +v.toFixed(6)), [0.28, 0.28, 0.28]);
});