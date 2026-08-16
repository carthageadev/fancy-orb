import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withTimeout, createRenderPipeline, initWebGPU } from "../webgpu-engine.js";

// withTimeout is the bounded-settle helper used by initWebGPU so a wedged or
// unsupported navigator.gpu.requestAdapter()/requestDevice() reports WebGPU
// unavailable instead of hanging the page. These tests run without browser globals.

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

// initWebGPU is the entry point main.js calls for an explicit WebGPU request.
// Stock Firefox for Android never exposes navigator.gpu (and some runtimes
// lack a global navigator entirely), so it must return null without throwing
// instead of tearing down the working WebGL renderers.

const engineSource = readFileSync(new URL("../webgpu-engine.js", import.meta.url), "utf8");

test("initWebGPU() source guards an absent global navigator before touching navigator.gpu", () => {
  const pattern = /if \(typeof navigator === "undefined" \|\| !navigator\.gpu\) return null;/;
  assert.match(engineSource, pattern);
});

test("initWebGPU returns null when navigator.gpu is unavailable", async () => {
  // Node 21+ exposes a global navigator without .gpu; older Node exposes no
  // navigator at all. Either way initWebGPU() must keep its null-return
  // contract instead of throwing a ReferenceError.
  const result = await initWebGPU();
  assert.equal(result, null);
});

// createRenderPipeline is the pipeline-factory selector used by
// WebGPUEngine.initialize(). It prefers the async factory (compiles off the
// main thread, the startup-hitch fix) and falls back to the synchronous one
// for older implementations. The stubs below are plain objects exposing only
// the two factory methods — no real WebGPU implementation is faked.

test("createRenderPipeline prefers createRenderPipelineAsync when available", async () => {
  const pipeline = { label: "async pipeline" };
  const descriptor = { label: "hero" };
  const asyncDevice = {
    createRenderPipelineAsync(input) {
      return Promise.resolve({ input, pipeline });
    }
  };
  const result = await createRenderPipeline(asyncDevice, descriptor);
  assert.equal(result.pipeline, pipeline);
  assert.equal(result.input, descriptor, "descriptor must be forwarded untouched");
});

test("createRenderPipeline never touches the sync factory when async exists", async () => {
  let syncCalls = 0;
  const device = {
    createRenderPipeline() {
      syncCalls += 1;
      throw new Error("sync factory must not be called");
    },
    createRenderPipelineAsync() {
      return Promise.resolve("async result");
    }
  };
  const result = await createRenderPipeline(device, {});
  assert.equal(result, "async result");
  assert.equal(syncCalls, 0);
});

test("createRenderPipeline falls back to the synchronous factory on older devices", async () => {
  const pipeline = { label: "sync pipeline" };
  const descriptor = { label: "hero" };
  const syncCalls = [];
  const syncDevice = {
    createRenderPipeline(input) {
      syncCalls.push(input);
      return pipeline;
    }
  };
  const result = await createRenderPipeline(syncDevice, descriptor);
  assert.equal(result, pipeline);
  assert.deepEqual(syncCalls, [descriptor], "descriptor must be forwarded untouched");
});

test("createRenderPipeline surfaces a sync fallback failure as a rejection", async () => {
  const syncDevice = {
    createRenderPipeline() {
      throw new Error("sync creation failed");
    }
  };
  await assert.rejects(createRenderPipeline(syncDevice, {}), /sync creation failed/);
});
