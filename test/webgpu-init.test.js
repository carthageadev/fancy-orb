import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../webgpu-engine.js";

// withTimeout is the bounded-settle helper used by initWebGPU so a wedged or
// unsupported navigator.gpu.requestAdapter()/requestDevice() falls back to
// WebGL instead of hanging the page. These tests run without browser globals.

test("withTimeout resolves with the promise value when it settles in time", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000);
  assert.equal(result, 42);
});

test("withTimeout resolves null when the promise rejects", async () => {
  const result = await withTimeout(Promise.reject(new Error("boom")), 1000);
  assert.equal(result, null);
});

test("withTimeout resolves null when the promise never settles (bounded wait)", async () => {
  const started = Date.now();
  const result = await withTimeout(new Promise(() => {}), 50);
  assert.equal(result, null);
  assert.ok(Date.now() - started < 1000, "timeout must bound the wait");
});

test("a value arriving after the timeout does not override the null result", async () => {
  const neverSettles = new Promise((resolve) => {
    setTimeout(() => resolve("late"), 80);
  });
  const result = await withTimeout(neverSettles, 20);
  assert.equal(result, null, "late settlement must be ignored after timeout");
});
