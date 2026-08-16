// Focused regression tests for the core performance work:
//   * WebGL2 capability-first context creation, family marking, and badges
//   * side-orb display-scale wiring (backing resolution below hero on side cards)
//   * the explicit Lens on/off toggle on both renderer interfaces
//   * the opt-in debug overlay (?debug=1, #debug-setting, no hot-path footprint)
//   * resize gating so normal frames never read layout (WebGL and WebGPU)
// These are source-level assertions (same style as webgl-hotpath.test.js), so
// they run in Node without a browser or emulation launch.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../webgpu-engine.js", import.meta.url), "utf8");

// Extract the body of `name(` at the given indentation (class methods use 2
// spaces, top-level functions use 0 with an optional `function ` prefix).
// Braces are balanced so object literals and nested callbacks inside the body
// do not confuse the scan.
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

// Extract the arrow-function body stored on `this.<property>` in a constructor.
function extractStoredHandler(source, property) {
  const pattern = new RegExp(`this\\.${property} = \\(\\) => \\{`, "m");
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

// ─── WebGL2 capability-first context ───

test("createWebGLContext requests webgl2 before webgl before experimental-webgl", () => {
  const body = extractMethod(mainSource, "createWebGLContext", 0);
  assert.ok(body, "createWebGLContext() body not found");
  const webgl2 = body.indexOf('"webgl2"');
  const webgl = body.indexOf('"webgl"');
  const experimental = body.indexOf('"experimental-webgl"');
  assert.ok(webgl2 > -1, "webgl2 request missing");
  assert.ok(webgl > -1, "webgl1 fallback request missing");
  assert.ok(experimental > -1, "experimental-webgl fallback missing");
  assert.ok(webgl2 < webgl && webgl < experimental, "context requests must fall back in order");
});

test("the existing context attributes are preserved on every request", () => {
  const body = extractMethod(mainSource, "createWebGLContext", 0);
  assert.ok(body, "createWebGLContext() body not found");
  assert.match(body, /antialias: false/);
  assert.doesNotMatch(body, /antialias: true/);
  assert.match(body, /powerPreference: "high-performance"/);
  assert.match(body, /depth: false/);
});

test("each renderer is marked with the actual context family via a robust feature check", () => {
  const detect = extractMethod(mainSource, "detectWebGLFamily", 0);
  assert.ok(detect, "detectWebGLFamily() body not found");
  assert.match(detect, /instanceof WebGL2RenderingContext/, "family must use the WebGL2 constructor");
  assert.match(detect, /gl\.createVertexArray/, "family must probe a WebGL2-only API for cross-realm contexts");
  const constructor = extractMethod(mainSource, "constructor");
  assert.ok(constructor, "OrbRenderer constructor body not found");
  assert.match(constructor, /this\.contextFamily = detectWebGLFamily\(this\.gl\)/, "family must be recorded on each renderer");
});

test("context restore re-detects and retains the same context family", () => {
  const restored = extractStoredHandler(mainSource, "handleContextRestored");
  assert.ok(restored, "handleContextRestored body not found");
  assert.match(restored, /this\.contextFamily = detectWebGLFamily\(this\.gl\)/, "restore must re-report the live family");
  assert.doesNotMatch(restored, /contextFamily = "webgl"/, "the family must be detected, never hardcoded");
});

test("final WebGL badges and the debug stack report the actual family", () => {
  assert.match(mainSource, /const familyLabel = webglFamilyLabel\(\)/, "badges must derive the family from the live pool");
  assert.match(mainSource, /`\$\{familyLabel\} \/ hero glsl online`/, "final badge must carry the family label");
  assert.match(mainSource, /`\$\{familyLabel\} \/ partial renderer`/, "partial badge must carry the family label");
  assert.match(mainSource, /\$\{webglFamilyLabel\(\)\} \/ loading shader/, "loading badge must carry the family label");
  assert.match(mainSource, /stack: gpuEngine \? "webgpu" : webglFamilyLabel\(\)/, "debug stack must report webgl2/webgl");
});

// ─── side-orb display scale (backing resolution) ───

test("assignVisibleRenderers derives the display scale from layoutByDistance with a safe floor", () => {
  const body = extractMethod(mainSource, "assignVisibleRenderers", 0);
  assert.ok(body, "assignVisibleRenderers() body not found");
  assert.match(body, /renderer\.setDisplayScale\(/, "assigned renderers must receive a display scale");
  assert.match(body, /layoutByDistance\[/, "the display scale must derive from the carousel layout");
  assert.match(body, /setDisplayScale\(Math\.max\(layoutScale, DISPLAY_SCALE_FLOOR\)\)/, "low layout scales must be floored");
  assert.match(mainSource, /const DISPLAY_SCALE_FLOOR = 0\.5/, "the safe floor must be around 0.5");
});

test("WebGL resize multiplies the backing pixel ratio by the display scale", () => {
  const resize = extractMethod(mainSource, "resize");
  assert.ok(resize, "resize() body not found");
  assert.match(resize, /this\.qualityScale \* this\.displayScale/, "the backing store must include the display scale");
  const setDisplayScale = extractMethod(mainSource, "setDisplayScale");
  assert.ok(setDisplayScale, "setDisplayScale() body not found");
  assert.match(setDisplayScale, /this\.displayScale = scale/);
  assert.match(setDisplayScale, /this\.needsResize = true/, "a display-scale change must re-measure");
});

test("WebGPU renderers share the display-scale interface", () => {
  const setDisplayScale = extractMethod(engineSource, "setDisplayScale");
  assert.ok(setDisplayScale, "WebGPU setDisplayScale() missing");
  assert.match(setDisplayScale, /this\.displayScale = scale/);
  const resize = extractMethod(engineSource, "resize");
  assert.ok(resize, "WebGPU resize() missing");
  assert.match(resize, /this\.qualityScale \* this\.displayScale/, "WebGPU backing store must include the display scale");
});

test("debug state exposes per-renderer display scales and actual canvas sizes", () => {
  assert.match(mainSource, /displayScale: renderer\.displayScale/, "per-renderer display scale must be reported");
  assert.match(mainSource, /canvas: \[renderer\.canvas\?\.width, renderer\.canvas\?\.height\]/, "actual canvas sizes must be reported");
  assert.match(mainSource, /contextFamily: renderer\.contextFamily/, "per-renderer family must be reported");
});

// ─── explicit Lens performance toggle ───

test("applyLensSetting maps on/off to uLens 0.4/0 across both renderer pools", () => {
  const apply = extractMethod(mainSource, "applyLensSetting", 0);
  assert.ok(apply, "applyLensSetting() body not found");
  assert.match(apply, /value !== "off"/, "off must disable the lens; anything else restores it");
  assert.match(apply, /renderer\.setLens\(getLensValue\(\)\)/, "the current lens value must reach every renderer");
  assert.match(mainSource, /const LENS_ON_VALUE = 0\.4/, "the on value must be 0.4");
  assert.match(mainSource, /const LENS_OFF_VALUE = 0/, "the off value must be 0");
  assert.match(mainSource, /let lensEnabled = true/, "the lens must default to on");
});

test("setLens exists on both renderer interfaces and re-applies the uniform", () => {
  const webgl = extractMethod(mainSource, "setLens");
  assert.ok(webgl, "WebGL setLens() missing");
  assert.match(webgl, /this\.lens = value/);
  assert.match(webgl, /uploadStaticUniforms\(\)/, "WebGL setLens must re-upload the lens uniform");
  const webgpu = extractMethod(engineSource, "setLens");
  assert.ok(webgpu, "WebGPU setLens() missing");
  assert.match(webgpu, /this\.lens = value/);
});

test("newly created renderers adopt the current lens setting on both backends", () => {
  const webglInit = extractMethod(mainSource, "initializeRendererPool", 0);
  assert.ok(webglInit, "initializeRendererPool() body not found");
  assert.match(webglInit, /renderer\.setLens\(getLensValue\(\)\)/, "new WebGL renderers must adopt the lens state");
  const webgpuInit = extractMethod(mainSource, "initializeWebGPU", 0);
  assert.ok(webgpuInit, "initializeWebGPU() body not found");
  assert.match(webgpuInit, /renderer\.setLens\(getLensValue\(\)\)/, "new WebGPU renderers must adopt the lens state");
});

test("context restore re-applies the retained lens state, never a hardcoded value", () => {
  const upload = extractMethod(mainSource, "uploadStaticUniforms");
  assert.ok(upload, "uploadStaticUniforms() body not found");
  assert.match(upload, /this\.locations\.lens, this\.lens/, "restore re-uploads this.lens, so the toggle survives");
  assert.doesNotMatch(upload, /this\.locations\.lens, 0\.4/, "uploadStaticUniforms must not hardcode the lens value");
});

test("the lens select is wired in the settings setup with an on default", () => {
  const body = extractMethod(mainSource, "setupRenderSettings", 0);
  assert.ok(body, "setupRenderSettings() body not found");
  assert.match(body, /lensSettingControl\?\.addEventListener\("change"/);
  assert.match(body, /applyLensSetting\(event\.target\.value\)/);
  assert.match(body, /applyLensSetting\(lensSettingControl\?\.value \?\? "on"\)/, "a missing control must default to on");
});

test("FPS caps never touch the lens setting", () => {
  const apply = extractMethod(mainSource, "applyFpsSetting", 0);
  assert.ok(apply, "applyFpsSetting() body not found");
  assert.doesNotMatch(apply, /lens/i, "applyFpsSetting must not alter the lens");
  const debug = mainSource.match(/window\.__orbDebug = \(\) => \(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(debug, "window.__orbDebug() body not found");
  assert.match(debug, /lens: \{\s*\n\s*enabled: lensEnabled,/, "debug must report whether the lens is enabled");
  assert.match(debug, /value: getLensValue\(\)/, "debug must report the current lens value");
});

// ─── opt-in debug overlay ───

test("the debug overlay opt-in reads ?debug=1 and defaults off", () => {
  assert.match(mainSource, /get\("debug"\) === "1"/, "only ?debug=1 must opt in");
  assert.match(mainSource, /let debugOverlayEnabled = false/, "the overlay must default off");
});

test("the overlay targets the expected panel and output ids", () => {
  assert.match(mainSource, /document\.querySelector\("#debug-setting"\)/);
  assert.match(mainSource, /document\.querySelector\("#perfDebugPanel"\)/);
  assert.match(mainSource, /document\.querySelector\("#perfDebugOutput"\)/);
  assert.match(mainSource, /perfDebugOutput\.textContent = formatDebugOverlay\(state\)/, "output must flow into the <pre>");
});

test("the debug interval only runs while enabled, and no faster than 4/s", () => {
  const apply = extractMethod(mainSource, "applyDebugSetting", 0);
  assert.ok(apply, "applyDebugSetting() body not found");
  assert.match(apply, /setInterval\(updateDebugOverlay, DEBUG_UPDATE_INTERVAL_MS\)/, "polling must use the shared interval");
  assert.match(apply, /clearInterval\(debugIntervalId\)/, "disabling must stop the interval");
  assert.match(apply, /debugIntervalId = null/, "the interval handle must be reset when stopped");
  assert.match(mainSource, /const DEBUG_UPDATE_INTERVAL_MS = 250/, "at most 4 refreshes per second");
});

test("the debug checkbox is wired in the settings setup and synced at load", () => {
  const body = extractMethod(mainSource, "setupRenderSettings", 0);
  assert.ok(body, "setupRenderSettings() body not found");
  assert.match(body, /debugSettingControl\?\.addEventListener\("change"/, "checkbox changes must toggle the overlay");
  assert.match(body, /applyDebugSetting\(event\.target\.checked\)/);
  assert.match(body, /applyDebugSetting\(debugOptIn\)/, "load must opt in only via ?debug=1");
});

test("frame() and render() stay free of debug/DOM work", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  assert.doesNotMatch(frame, /debug|perfDebug|__orbDebug|setInterval/, "frame() must not do debug work");
  const webglRender = extractMethod(mainSource, "render");
  assert.ok(webglRender, "render() body not found");
  assert.doesNotMatch(webglRender, /debug|perfDebug|__orbDebug/, "WebGL render() must not do debug work");
  const webgpuRender = extractMethod(engineSource, "render");
  assert.ok(webgpuRender, "WebGPU render() body not found");
  assert.doesNotMatch(webgpuRender, /debug|perfDebug|__orbDebug/, "WebGPU render() must not do debug work");
});

// ─── resize gating (no layout reads on steady frames) ───

test("WebGL and WebGPU resize both gate behind a needsResize flag", () => {
  const webglResize = extractMethod(mainSource, "resize");
  assert.ok(webglResize, "WebGL resize() body not found");
  assert.match(webglResize, /if \(!this\.needsResize\) return/, "WebGL steady frames must skip layout reads");
  const webgpuResize = extractMethod(engineSource, "resize");
  assert.ok(webgpuResize, "WebGPU resize() body not found");
  assert.match(webgpuResize, /if \(!this\.needsResize\) return/, "WebGPU steady frames must skip layout reads");
});

test("WebGPU invalidations mark a re-measure instead of resizing eagerly", () => {
  const requestResize = extractMethod(engineSource, "requestResize");
  assert.ok(requestResize, "WebGPU requestResize() missing");
  assert.match(requestResize, /this\.needsResize = true/);
  const setOrb = extractMethod(engineSource, "setOrb");
  assert.ok(setOrb, "WebGPU setOrb() missing");
  assert.match(setOrb, /this\.needsResize = true/, "a renderer moved to another card must re-measure");
  const setQualityScale = extractMethod(engineSource, "setQualityScale");
  assert.ok(setQualityScale, "WebGPU setQualityScale() missing");
  assert.match(setQualityScale, /this\.needsResize = true/);
  const render = extractMethod(engineSource, "render");
  assert.ok(render, "WebGPU render() body not found");
  assert.doesNotMatch(render, /clientWidth|clientHeight/, "render() must never read layout");
  // The shared window-resize handler now flags every renderer via requestResize.
  assert.match(mainSource, /renderer\.requestResize\(\)/, "window resize must flag a re-measure for both families");
});
