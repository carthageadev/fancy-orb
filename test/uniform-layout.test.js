import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNIFORM_SLOT_ALIGN,
  UNIFORM_BYTES,
  UNIFORM_OFFSETS,
  writeUniforms
} from "../webgpu-engine.js";

const EXPECTED_FIELDS = [
  "res",
  "bg",
  "anchor",
  "c0",
  "c1",
  "c2",
  "time",
  "phase",
  "audio",
  "spin",
  "arch",
  "lens",
  "starDensity",
  "fidelity"
];

test("uniform offsets cover exactly the WGSL struct fields", () => {
  assert.deepEqual(Object.keys(UNIFORM_OFFSETS), EXPECTED_FIELDS);
});

test("offsets are strictly ascending and stay inside the 128-byte struct", () => {
  const offsets = Object.values(UNIFORM_OFFSETS);
  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(offsets[index] > offsets[index - 1], `offset ${index} not ascending`);
  }
  for (const offset of offsets) {
    assert.ok(offset >= 0 && offset < UNIFORM_BYTES, `offset ${offset} out of bounds`);
  }
  assert.ok(offsets.at(-1) + 4 <= UNIFORM_BYTES, "last field must fit");
});

test("vec3 fields align to 16 bytes (std140)", () => {
  for (const field of ["bg", "anchor", "c0", "c1", "c2"]) {
    assert.equal(UNIFORM_OFFSETS[field] % 16, 0, `${field} misaligned`);
  }
});

test("scalar fields are 4-byte aligned and sequential", () => {
  const scalars = ["time", "phase", "audio", "spin", "arch", "lens", "starDensity", "fidelity"];
  const offsets = scalars.map((field) => UNIFORM_OFFSETS[field]);
  assert.deepEqual(offsets, [96, 100, 104, 108, 112, 116, 120, 124]);
});

test("dynamic offsets align to the device-required slot size", () => {
  assert.ok(UNIFORM_SLOT_ALIGN >= 256, "dynamic offsets need 256-byte alignment");
  assert.equal(UNIFORM_SLOT_ALIGN % 256, 0);
});

test("writeUniforms places values at the declared offsets", () => {
  const view = new Float32Array(UNIFORM_BYTES / 4);
  writeUniforms(view, UNIFORM_OFFSETS, {
    res: [1280, 720],
    bg: [0.1, 0.2, 0.3],
    anchor: [1, 0, 0],
    c0: [0, 1, 0],
    c1: [0, 0, 1],
    c2: [0.5, 0.5, 0.5],
    time: 12.5,
    phase: 4.081,
    audio: 0.035,
    spin: 0.893,
    arch: 1,
    lens: 1,
    starDensity: 0.25,
    fidelity: 1
  });
  assert.equal(view[0], 1280);
  assert.ok(Math.abs(view[4] - 0.1) < 1e-6, "float32 rounding allowed");
  assert.equal(view[24], 12.5);
  assert.ok(Math.abs(view[25] - 4.081) < 1e-6);
  assert.ok(Math.abs(view[26] - 0.035) < 1e-6);
  assert.ok(Math.abs(view[27] - 0.893) < 1e-6);
  assert.equal(view[31], 1);
});

test("slots never overlap: two orbs at consecutive slots stay disjoint", () => {
  const view = new Float32Array((UNIFORM_BYTES / 4) * 2);
  const slotBytes = UNIFORM_BYTES / 4; // floats per slot
  writeUniforms(view.subarray(slotBytes), UNIFORM_OFFSETS, {
    res: [1, 1],
    bg: [0, 0, 0],
    anchor: [0, 0, 0],
    c0: [0, 0, 0],
    c1: [0, 0, 0],
    c2: [0, 0, 0],
    time: 99,
    phase: 0,
    audio: 0,
    spin: 0,
    arch: 1,
    lens: 1,
    starDensity: 1,
    fidelity: 1
  });
  assert.equal(view[slotBytes + UNIFORM_OFFSETS.time / 4], 99, "slot 1 time written");
  for (let index = 0; index < slotBytes; index += 1) {
    assert.equal(view[index], 0, `slot 0 region must stay untouched at float ${index}`);
  }
});