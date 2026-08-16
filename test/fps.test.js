// Regression tests for the frame-rate cap (`fps-setting`): the pure cadence
// helpers, the budget-aware quality sampling, and the main.js / renderer
// wiring (source-level, same style as webgl-hotpath.test.js). FPS caps gate
// render frequency only — the uLens chromatic lens uniform stays 0.4 for
// every setting, and no low-power profile is applied. No browser or
// emulation launch required.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QualityManager,
  AUTO_BUDGET_MS,
  FPS_CAPS,
  FPS_DEFAULT,
  isFpsSetting,
  fpsToInterval,
  frameDue
} from "../quality.js";

function makeManager(options = {}) {
  return new QualityManager({ warmupMs: 0, ...options });
}

// --- pure cadence helpers ---

test("the FPS cap table exposes exactly Auto / 30 / 20 / 15", () => {
  assert.deepEqual(FPS_CAPS, { auto: null, "30": 30, "20": 20, "15": 15 });
  assert.equal(FPS_DEFAULT, "auto");
});

test("isFpsSetting accepts the four option values and rejects everything else", () => {
  for (const value of ["auto", "30", "20", "15"]) {
    assert.equal(isFpsSetting(value), true, `expected ${value} to be valid`);
  }
  for (const value of ["60", "0", "", "Auto", null, undefined, 30]) {
    assert.equal(isFpsSetting(value), false, `expected ${value} to be invalid`);
  }
});

test("fpsToInterval returns 0 for auto and the exact per-render budget otherwise", () => {
  assert.equal(fpsToInterval("auto"), 0);
  assert.ok(Math.abs(fpsToInterval("30") - 1000 / 30) < 1e-9);
  assert.equal(fpsToInterval("20"), 50);
  assert.ok(Math.abs(fpsToInterval("15") - 1000 / 15) < 1e-9);
  assert.equal(fpsToInterval("60"), 0, "unknown values fall back to no cap");
});

test("frameDue renders immediately on the first frame", () => {
  assert.equal(frameDue(100, 0, 1000 / 30), true, "first render must be immediate");
  assert.equal(frameDue(16.7, 0, 0), true);
});

test("frameDue under a cap renders once the interval has elapsed", () => {
  const interval = 1000 / 30;
  assert.equal(frameDue(50, 50, interval), false, "same-tick render must be skipped");
  assert.equal(frameDue(66.7, 50, interval), false, "less than one interval is not due");
  assert.equal(frameDue(84, 50, interval), true, "one full interval makes a render due");
  assert.equal(frameDue(50, 0, interval), true, "the first render ignores the interval");
});

test("frameDue under auto is due on every rAF", () => {
  assert.equal(frameDue(100, 100, 0), true);
  assert.equal(frameDue(110, 105, 0), true);
});

test("AUTO_BUDGET_MS is the exact 60 Hz frame budget", () => {
  assert.equal(AUTO_BUDGET_MS, 1000 / 60);
});

// --- budget-aware quality sampling ---

test("quality sampling scales the slow/fast thresholds to the capped budget", () => {
  const changes = [];
  const manager = makeManager({ onLevelChange: (scale) => changes.push(scale) });
  // A healthy 60 Hz rAF stream under a 30 fps cap must climb, never drop.
  manager.setLevel(1);
  changes.length = 0;
  for (let index = 0; index < 40; index += 1) manager.sample(16.7, 1000 / 30);
  assert.deepEqual(changes, [0.7], "capped but healthy frames must climb a rung");
  // A device that cannot hold the cap (rAF deltas near 50 ms) still drops.
  const slowManager = makeManager();
  for (let index = 0; index < 30; index += 1) slowManager.sample(50, 1000 / 30);
  assert.equal(slowManager.scale, 0.84, "missing the capped budget must drop a rung");
});

test("the default budget keeps the original auto thresholds", () => {
  const manager = makeManager();
  for (let index = 0; index < 12; index += 1) manager.sample(40, AUTO_BUDGET_MS);
  assert.equal(manager.scale, 0.84, "40 ms frames must still drop on auto");
});

// --- main.js wiring (source-level) ---

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../webgpu-engine.js", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// Extract the body of `name(` at the given indentation. Handles class methods
// (2 spaces) and top-level functions, including `async function`. Braces are
// balanced so nested callbacks and object literals do not confuse the scan.
function extractMethod(source, name, indent = 2) {
  const pattern = new RegExp(`^ {${indent}}(?:async function |function )?${name}\\(`, "m");
  const match = pattern.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

test("main wires the #fps-setting select into applyFpsSetting", () => {
  assert.match(mainSource, /fpsSettingControl = document\.querySelector\("#fps-setting"\)/);
  assert.match(mainSource, /fpsSettingControl\?\.addEventListener\("change"/);
  const body = extractMethod(mainSource, "setupRenderSettings", 0);
  assert.ok(body, "setupRenderSettings() body not found");
  assert.match(body, /applyFpsSetting\(event\.target\.value\)/);
});

test("mobile renderer settings wrap the renderer action instead of clipping it", () => {
  assert.match(
    stylesSource,
    /@media \(max-width: 640px\)[\s\S]*\.render-mode-toggle\s*\{\s*flex-wrap:\s*wrap;/
  );
});

test("main imports AUTO_BUDGET_MS from quality.js instead of duplicating 16.7", () => {
  assert.match(mainSource, /import \{[^}]*\bAUTO_BUDGET_MS\b[^}]*\} from "\.\/quality\.js"/);
  assert.match(mainSource, /fpsIntervalMs > 0 \? fpsIntervalMs : AUTO_BUDGET_MS/);
});

test("applyFpsSetting normalizes the cadence and the auto ceiling without a low-power profile", () => {
  const apply = extractMethod(mainSource, "applyFpsSetting", 0);
  assert.ok(apply, "applyFpsSetting() body not found");
  assert.match(apply, /isFpsSetting\(value\)/);
  assert.match(apply, /fpsIntervalMs = fpsToInterval\(normalized\)/);
  assert.match(apply, /quality\.setFpsCeiling\(fpsIntervalMs > 0\)/, "a cap must lower the auto ceiling");
  assert.match(apply, /lastRenderAt = 0/, "the new cadence must apply on the next rAF");
  assert.match(apply, /needsRender = true/);
  assert.doesNotMatch(apply, /fpsLowPower|setLowPower/, "caps must not touch any low-power profile");
});

test("the frame loop gates rendering by the cadence while time keeps advancing", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  assert.match(frame, /frameDue\(now, lastRenderAt, fpsIntervalMs\)/);
  assert.match(frame, /renderDue && stageInView/);
  assert.match(frame, /const frameMs = lastFrameNow \? now - lastFrameNow : AUTO_BUDGET_MS/);
  assert.match(frame, /if \(shouldRender\) \{/, "the render attempt must be gated by shouldRender");
  assert.match(frame, /lastTime = /, "absolute time must keep advancing on skipped ticks");
  assert.match(frame, /window\.requestAnimationFrame\(frame\)/, "rAF scheduling must never stop");
});

test("the cadence anchor advances only after a render succeeds and resets on failure", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  // The anchor must not be advanced before (or when) a render throws: capped
  // mode would otherwise wait out the whole interval after a failed frame.
  assert.doesNotMatch(frame, /if \(shouldRender\) lastRenderAt = now/);
  assert.match(frame, /if \(didRender\) lastRenderAt = now/, "a successful render advances the anchor");
  assert.match(frame, /try \{/, "the render attempt must be guarded");
  assert.match(frame, /lastRenderAt = 0;/, "a failed frame must reset the anchor for a prompt retry");
  assert.match(frame, /console\.error\("Renderer frame failed:", error\)/);
});

test("updateAdaptiveQuality hands the capped budget to the ladder", () => {
  const update = extractMethod(mainSource, "updateAdaptiveQuality", 0);
  assert.ok(update, "updateAdaptiveQuality() body not found");
  assert.match(update, /quality\.sample\(frameMs, fpsIntervalMs > 0 \? fpsIntervalMs : AUTO_BUDGET_MS\)/);
});

test("newly created WebGL renderers are not wired to a low-power profile", () => {
  const init = extractMethod(mainSource, "initializeRendererPool", 0);
  assert.ok(init, "initializeRendererPool() body not found");
  assert.match(init, /new OrbRenderer\(canvas, orbData\[index\], index\)/);
  assert.doesNotMatch(init, /setLowPower/, "renderer creation must not apply an FPS low-power profile");
  assert.doesNotMatch(mainSource, /fpsLowPower/, "module state must not track an FPS low-power flag");
});

test("newly created WebGPU renderers are not wired to a low-power profile", () => {
  const init = extractMethod(mainSource, "initializeWebGPU", 0);
  assert.ok(init, "initializeWebGPU() body not found");
  assert.match(init, /renderer\.setFidelity\(fidelityValue\)/);
  assert.doesNotMatch(init, /setLowPower/, "renderer creation must not apply an FPS low-power profile");
});

// --- FPS caps preserve the lens uniform (source-level) ---

test("WebGL uploadStaticUniforms drives uLens from the lens state for every FPS setting", () => {
  const upload = extractMethod(mainSource, "uploadStaticUniforms");
  assert.ok(upload, "uploadStaticUniforms() body not found");
  assert.match(upload, /this\.locations\.lens, this\.lens/, "uLens must be driven by the renderer lens state");
  assert.doesNotMatch(upload, /0\.4/, "uploadStaticUniforms must not hardcode the lens value");
  assert.doesNotMatch(upload, /lowPower/, "uLens must not depend on any low-power state");
  assert.match(mainSource, /const LENS_ON_VALUE = 0\.4/, "the on value must stay 0.4");
});

test("the WebGL renderer no longer exposes a setLowPower low-power profile", () => {
  assert.doesNotMatch(mainSource, /setLowPower/, "main.js must not define or call setLowPower");
  assert.doesNotMatch(mainSource, /lowPower/, "main.js must not reference any low-power profile");
});

test("WebGPU render drives the lens from the lens state for every FPS setting", () => {
  const render = extractMethod(engineSource, "render");
  assert.ok(render, "render() body not found");
  assert.match(render, /lens: this\.lens/, "uLens must be driven by the renderer lens state");
  assert.doesNotMatch(render, /lowPower/, "uLens must not depend on any low-power state");
  assert.match(engineSource, /this\.lens = 0\.4/, "the default lens value must stay 0.4");
});

test("the WebGPU renderer no longer exposes a setLowPower low-power profile", () => {
  assert.doesNotMatch(engineSource, /setLowPower/, "webgpu-engine.js must not define or call setLowPower");
  assert.doesNotMatch(engineSource, /lowPower/, "webgpu-engine.js must not reference any low-power profile");
});

test("the debug fps report keeps setting and intervalMs without a lowPower flag", () => {
  assert.match(mainSource, /setting: fpsSetting/);
  assert.match(mainSource, /intervalMs: \+fpsIntervalMs\.toFixed\(2\)/);
  assert.doesNotMatch(mainSource, /lowPower: fpsLowPower/);
});
