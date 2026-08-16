import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QualityManager,
  QUALITY_LEVELS,
  COMPACT_SCALE,
  RESOLUTION_MODES,
  FIDELITY_MODES
} from "../quality.js";

function makeManager(options = {}) {
  return new QualityManager({ warmupMs: 0, ...options });
}

test("desktop starts at the top rung (100%)", () => {
  const manager = makeManager();
  assert.equal(manager.scale, 1);
  assert.equal(manager.label, "100%");
  assert.equal(manager.enabled, true);
});

test("compact devices begin at exactly the 70% rung", () => {
  const manager = makeManager({ compact: true });
  assert.equal(manager.scale, 0.7);
  assert.equal(manager.label, "70%");
});

test("the ladder has a distinct 70% rung and stays strictly ascending", () => {
  assert.ok(QUALITY_LEVELS.includes(COMPACT_SCALE), "ladder must contain the compact rung");
  assert.equal(QUALITY_LEVELS[RESOLUTION_MODES.balanced], COMPACT_SCALE);
  for (let index = 1; index < QUALITY_LEVELS.length; index += 1) {
    assert.ok(QUALITY_LEVELS[index] > QUALITY_LEVELS[index - 1], "ladder must be ascending");
  }
  assert.equal(QUALITY_LEVELS[RESOLUTION_MODES.low], 0.58);
  assert.equal(QUALITY_LEVELS[RESOLUTION_MODES.high], 0.84);
  assert.equal(QUALITY_LEVELS[RESOLUTION_MODES.full], 1);
});

test("warmup window suppresses sampling so startup jank never drops the ladder", () => {
  const changes = [];
  const manager = new QualityManager({ onLevelChange: (scale) => changes.push(scale) });
  for (let index = 0; index < 40; index += 1) manager.sample(60);
  assert.deepEqual(changes, [], "no ladder movement before warmup elapses");
  assert.equal(manager.scale, 1);
});

test("sustained slow frames drop one rung at a time", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  for (let index = 0; index < 12; index += 1) manager.sample(40); // EMA needs ~4 frames to cross 22ms
  assert.deepEqual(changes, [0.84]);
  for (let index = 0; index < 8; index += 1) manager.sample(40);
  assert.deepEqual(changes, [0.84, 0.7]);
});

test("a fast frame breaks the slow streak (hysteresis)", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  for (let index = 0; index < 7; index += 1) manager.sample(40);
  manager.sample(8);
  for (let index = 0; index < 7; index += 1) manager.sample(40);
  assert.deepEqual(changes, [0.84], "streak must not survive an interruption");
});

test("sustained headroom climbs back up", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  manager.setLevel(1);
  assert.deepEqual(changes, [0.58]);
  for (let index = 0; index < 30; index += 1) manager.sample(8);
  assert.deepEqual(changes, [0.58, 0.7]);
  assert.equal(manager.scale, 0.7);
});

test("manual modes pin a rung and disable auto-walking", () => {
  const manager = makeManager();
  manager.setMode("low");
  assert.equal(manager.scale, QUALITY_LEVELS[RESOLUTION_MODES.low]);
  assert.equal(manager.scale, 0.58);
  assert.equal(manager.enabled, false);
  for (let index = 0; index < 30; index += 1) manager.sample(8);
  assert.equal(manager.scale, 0.58, "pinned mode must not climb");
  manager.setMode("balanced");
  assert.equal(manager.scale, 0.7);
  manager.setMode("high");
  assert.equal(manager.scale, 0.84);
  manager.setMode("full");
  assert.equal(manager.scale, 1);
});

test("auto mode returns to the top rung and re-enables", () => {
  const manager = makeManager();
  manager.setMode("high");
  manager.setMode("auto");
  assert.equal(manager.scale, 1);
  assert.equal(manager.enabled, true);
});

test("compact Auto mode returns to the 70% baseline", () => {
  const manager = makeManager({ compact: true });
  manager.setMode("full");
  manager.setMode("auto");
  assert.equal(manager.scale, COMPACT_SCALE);
  assert.equal(manager.enabled, true);
  for (let index = 0; index < 600; index += 1) manager.sample(6);
  assert.equal(manager.scale, COMPACT_SCALE, "compact Auto must stay capped at 70%");
});

test("an active FPS cap caps the auto ladder at the 70% rung", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  assert.equal(manager.scale, 1, "desktop starts at 100%");
  manager.setFpsCeiling(true);
  assert.equal(manager.scale, COMPACT_SCALE, "activating a cap must lower Auto immediately");
  // Sustained headroom would normally climb back to 100%; under a cap the
  // ladder must stop at the 70% rung instead.
  for (let index = 0; index < 40; index += 1) manager.sample(8);
  assert.equal(manager.scale, COMPACT_SCALE, "capped auto headroom must not climb past the 70% rung");
  assert.deepEqual(changes, [0.7], "the climb clamps at the capped ceiling");
});

test("clearing the FPS cap restores the full auto maximum without a forced jump", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  manager.setLevel(2);
  changes.length = 0;
  manager.setFpsCeiling(true);
  manager.setFpsCeiling(false);
  assert.deepEqual(changes, [], "clearing the cap must not move the level immediately");
  for (let index = 0; index < 35; index += 1) manager.sample(8);
  assert.deepEqual(changes, [0.84], "headroom recovers through the normal ladder");
  for (let index = 0; index < 35; index += 1) manager.sample(8);
  assert.deepEqual(changes, [0.84, 1], "the ladder climbs all the way back to 100%");
});

test("manual resolution modes remain authoritative under an active FPS cap", () => {
  const manager = makeManager();
  manager.setFpsCeiling(true);
  manager.setMode("full");
  assert.equal(manager.scale, 1, "manual full resolution must not be clamped by the cap");
  for (let index = 0; index < 40; index += 1) manager.sample(8);
  assert.equal(manager.scale, 1, "a pinned manual rung must not move under a cap");
  manager.setMode("auto");
  assert.equal(manager.scale, COMPACT_SCALE, "returning to auto under a cap lands on the capped ceiling");
});

test("the ladder never leaves its bounds", () => {
  const manager = makeManager();
  for (let index = 0; index < 200; index += 1) manager.sample(60);
  assert.equal(manager.scale, 0.5, "must bottom out at the lowest rung");
  for (let index = 0; index < 600; index += 1) manager.sample(6);
  assert.equal(manager.scale, 1, "must cap at the highest rung");
});

test("fidelity modes are a subset of the original settings", () => {
  assert.deepEqual(FIDELITY_MODES, { lite: 0.58, balanced: 0.8, full: 1 });
  for (const value of Object.values(FIDELITY_MODES)) {
    assert.ok(value > 0 && value <= 1);
  }
});
