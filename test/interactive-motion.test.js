// Regression tests for the opt-in interactive motion feature: default-off
// behavior, input listener lifecycle, permission handling, clamping/smoothing,
// renderer spin paths, new renderer state, and debug observability. These are
// source-level assertions so they run in Node without a browser.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../webgpu-engine.js", import.meta.url), "utf8");
const wgslSource = readFileSync(new URL("../webgpu-shaders.js", import.meta.url), "utf8");

// Extract the body of a top-level or class method at the given indentation.
// Handles async functions and balances braces so nested callbacks and object
// literals do not confuse the scan.
function extractMethod(source, name, indent = 0) {
  const pattern = new RegExp(`^ {${indent}}(?:async function |function )?${name}\\(`, "m");
  const match = pattern.exec(source);
  if (!match) return null;
  const paramsOpen = source.indexOf("(", match.index);
  if (paramsOpen === -1) return null;
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let index = paramsOpen; index < source.length; index += 1) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        let cursor = index + 1;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (source[cursor] === "{") bodyOpen = cursor;
        break;
      }
    }
  }
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let index = bodyOpen; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyOpen, index + 1);
    }
  }
  return null;
}

// --- default-off behavior ---

test("interactive motion is off by default", () => {
  assert.match(mainSource, /let interactiveEnabled = false/);
  assert.match(mainSource, /let interactionCurrent = 0/);
  assert.match(mainSource, /let interactionCurrentPitch = 0/);
  assert.match(mainSource, /let interactionCurrentRoll = 0/);
  assert.match(mainSource, /let interactionPermission = "unknown"/);
  assert.match(mainSource, /let interactionSource = "none"/);
});

// --- animation clock and autonomous spin ---

test("interactive mode keeps the shader clock advancing", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  assert.match(frame, /lastTime = typeof window\.__orbFreezeTime === "number" \? window\.__orbFreezeTime : now \* 0\.001/);
  assert.doesNotMatch(frame, /interactionFrozenTime|interactionFrozenAt/);
});

test("interactive mode toggles autonomous spin without freezing uTime", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body, "setInteractiveMotion() body not found");
  assert.match(body, /renderer\.setAutonomousSpin\(false\)/);
  assert.match(body, /renderer\.setAutonomousSpin\(true\)/);
  assert.match(body, /gpuEngine\.interactiveMotion = true/);
  assert.match(body, /gpuEngine\.interactiveMotion = false/);
});

test("default WebGL orientation can disable all autonomous sphere motion", () => {
  assert.match(mainSource, /this\.spin \+ \(this\.autonomousSpin \? time \* 0\.08 : 0\) \+ \(this\.interactionSpin \|\| 0\)/);
  assert.match(mainSource, /gl\.uniform1f\(this\.locations\.motion, this\.autonomousSpin \? 1 : 0\)/);
});

test("default WebGPU orientation can disable all autonomous sphere motion", () => {
  assert.match(engineSource, /this\.spin \+ \(this\.autonomousSpin \? time \* 0\.08 : 0\) \+ \(this\.interactionSpin \|\| 0\)/);
  assert.match(engineSource, /motion: this\.autonomousSpin \? 1 : 0/);
});

test("OrbRenderer inherits the current interaction orientation", () => {
  assert.match(mainSource, /this\.interactionSpin = interactionCurrent/);
  assert.match(mainSource, /this\.interactionPitch = interactionCurrentPitch/);
  assert.match(mainSource, /this\.interactionRoll = interactionCurrentRoll/);
});

test("WebGPUOrbRenderer inherits the engine interaction orientation", () => {
  assert.match(engineSource, /this\.interactionSpin = engine\.interactionSpin \?\? 0/);
  assert.match(engineSource, /this\.interactionPitch = engine\.interactionPitch \?\? 0/);
  assert.match(engineSource, /this\.interactionRoll = engine\.interactionRoll \?\? 0/);
});

// --- input listener lifecycle ---

test("setInteractiveMotion is defined as an async function", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body, "setInteractiveMotion() body not found");
  assert.match(mainSource, /async function setInteractiveMotion\(/);
});

test("setInteractiveMotion guards against redundant calls", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body);
  assert.match(body, /if \(enabled === interactiveEnabled\) return/);
});

test("setInteractiveMotion registers listeners on enable and removes on disable", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body);
  assert.match(body, /addInteractiveListeners\(\)/, "enable path must add listeners");
  assert.match(body, /removeInteractiveListeners\(\)/, "disable path must remove listeners");
});

test("addInteractiveListeners uses a passive viewport pointer listener", () => {
  const body = extractMethod(mainSource, "addInteractiveListeners", 0);
  assert.ok(body, "addInteractiveListeners() body not found");
  assert.match(body, /window\.addEventListener\("pointermove", onInteractivePointerMove, \{ passive: true \}\)/);
  assert.doesNotMatch(body, /pointerleave/);
  assert.match(body, /window\.addEventListener\("deviceorientation", onDeviceOrientation, \{ passive: true \}\)/);
});

test("removeInteractiveListeners removes viewport and orientation listeners", () => {
  const body = extractMethod(mainSource, "removeInteractiveListeners", 0);
  assert.ok(body, "removeInteractiveListeners() body not found");
  assert.match(body, /window\.removeEventListener\("pointermove", onInteractivePointerMove\)/);
  assert.match(body, /window\.removeEventListener\("deviceorientation", onDeviceOrientation\)/);
});

test("pointer handler normalizes against the viewport", () => {
  const body = extractMethod(mainSource, "onInteractivePointerMove", 0);
  assert.ok(body, "onInteractivePointerMove() body not found");
  assert.match(body, /event\.clientX \/ window\.innerWidth/);
  assert.match(body, /event\.clientY \/ window\.innerHeight/);
  assert.doesNotMatch(body, /getBoundingClientRect/);
});

test("setupRenderSettings wires #interactive-motion checkbox change", () => {
  const body = extractMethod(mainSource, "setupRenderSettings", 0);
  assert.ok(body, "setupRenderSettings() body not found");
  assert.match(body, /document\.querySelector\("#interactive-motion"\)/);
  assert.match(body, /addEventListener\("change", async \(event\) =>/);
  assert.match(body, /setInteractiveMotion\(event\.target\.checked\)/);
});

// --- permission handling ---

test("requestOrientationPermission handles iOS requestPermission API", () => {
  const body = extractMethod(mainSource, "requestOrientationPermission", 0);
  assert.ok(body, "requestOrientationPermission() body not found");
  assert.match(body, /typeof DeviceOrientationEvent !== "undefined"/);
  assert.match(body, /typeof DeviceOrientationEvent\.requestPermission === "function"/);
  assert.match(body, /DeviceOrientationEvent\.requestPermission\(\)/);
  assert.match(body, /interactionPermission = result === "granted"/);
});

test("requestOrientationPermission gracefully handles denied permission", () => {
  const body = extractMethod(mainSource, "requestOrientationPermission", 0);
  assert.ok(body);
  assert.match(body, /interactionPermission = "denied"/);
  // Falls back to pointer-only
  assert.match(body, /if \(interactionPermission !== "granted"\) interactionSource = "pointer"/);
});

test("requestOrientationPermission marks orientation as unavailable when API is missing", () => {
  const body = extractMethod(mainSource, "requestOrientationPermission", 0);
  assert.ok(body);
  assert.match(body, /interactionPermission = "unavailable"/);
  assert.match(body, /interactionSource = "pointer"/);
});

test("requestOrientationPermission rejects insecure contexts before attempting permission", () => {
  const body = extractMethod(mainSource, "requestOrientationPermission", 0);
  assert.ok(body);
  const secureCtxCheck = body.indexOf('window.isSecureContext === false');
  assert.ok(secureCtxCheck > -1, "isSecureContext guard not found");
  const iOSBranch = body.indexOf('typeof DeviceOrientationEvent !== "undefined"');
  assert.ok(secureCtxCheck < iOSBranch, "insecure-context guard must run before the iOS permission branch");
  assert.match(body, /interactionPermission = "unavailable"/);
  assert.match(body, /interactionSource = "pointer"/);
});

test("updateInteractiveHint sets appropriate text for each permission state", () => {
  const body = extractMethod(mainSource, "updateInteractiveHint", 0);
  assert.ok(body, "updateInteractiveHint() body not found");
  assert.match(body, /Sensor permission denied/);
  assert.match(body, /Gyroscope unavailable/);
  assert.match(body, /Pointer or phone tilt guides the orb/);
});

test("setInteractiveMotion resets state on disable", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body);
  assert.match(body, /interactionTarget = 0/);
  assert.match(body, /interactionTargetRoll = 0/);
  assert.match(body, /interactionSource = "none"/);
  assert.match(body, /gyroNeutralAlpha = null/);
  assert.match(body, /gyroNeutralGamma = null/);
  assert.match(body, /gyroNeutralBeta = null/);
});

test("setInteractiveMotion checks enabled state after async permission request", () => {
  const body = extractMethod(mainSource, "setInteractiveMotion", 0);
  assert.ok(body);
  assert.match(body, /await requestOrientationPermission\(\)/);
  assert.match(body, /if \(!interactiveEnabled\) return/, "must bail if disabled during async permission");
});

// --- clamping/smoothing ---

test("clamp function bounds values between min and max", () => {
  const body = extractMethod(mainSource, "clamp", 0);
  assert.ok(body, "clamp() body not found");
  assert.match(body, /value < min \? min : value > max \? max : value/);
});

test("pointer handler maps horizontal yaw and vertical pitch independently", () => {
  const body = extractMethod(mainSource, "onInteractivePointerMove", 0);
  assert.ok(body, "onInteractivePointerMove() body not found");
  assert.match(body, /\(normX - 0\.5\) \* 1\.2/, "x mapping to [-0.6, 0.6]");
  assert.match(body, /interactionTarget = clamp\(\(normX - 0\.5\) \* 1\.2, -0\.6, 0\.6\)/);
  assert.doesNotMatch(body, /targetY/);
  assert.match(body, /interactionTargetPitch = clamp\(\(normY - 0\.5\) \* 1\.0, -0\.5, 0\.5\)/);
});

test("orientation handler maps alpha, beta, and gamma to yaw, pitch, and roll", () => {
  const body = extractMethod(mainSource, "onDeviceOrientation", 0);
  assert.ok(body, "onDeviceOrientation() body not found");
  assert.match(body, /const \{ alpha, beta, gamma \} = event/);
  assert.match(body, /const alphaDelta = hasAlpha && gyroNeutralAlpha !== null \? angleDelta\(alpha, gyroNeutralAlpha\) : 0/);
  assert.match(body, /let pitchDelta = betaDelta/);
  assert.match(body, /let rollDelta = gammaDelta/);
  assert.match(body, /interactionTarget = clamp\(alphaDelta \* 0\.015, -0\.6, 0\.6\)/);
  assert.match(body, /interactionTargetPitch = clamp\(-pitchDelta \* 0\.015, -0\.6, 0\.6\)/);
  assert.match(body, /interactionTargetRoll = clamp\(rollDelta \* 0\.015, -0\.6, 0\.6\)/);
  assert.match(body, /screenAngle === 90/);
  assert.match(body, /screenAngle === 270/);
});

test("orientation handler captures neutral baselines on first event", () => {
  const body = extractMethod(mainSource, "onDeviceOrientation", 0);
  assert.ok(body);
  assert.match(body, /gyroNeutralAlpha = alpha/);
  assert.match(body, /if \(gyroNeutralGamma === null\)/);
  assert.match(body, /gyroNeutralGamma = gamma/);
  assert.match(body, /gyroNeutralBeta = beta/);
});

test("orientation handler rejects non-finite beta and gamma values", () => {
  const body = extractMethod(mainSource, "onDeviceOrientation", 0);
  assert.ok(body);
  assert.match(body, /typeof gamma !== "number" \|\| typeof beta !== "number"/);
  assert.match(body, /!Number\.isFinite\(gamma\) \|\| !Number\.isFinite\(beta\)/);
  // The non-finite guard must run before the neutral baseline capture
  const nonFiniteGuard = body.indexOf('!Number.isFinite(gamma)');
  const baselineCapture = body.indexOf('gyroNeutralGamma === null');
  assert.ok(nonFiniteGuard > -1, "Number.isFinite guard not found");
  assert.ok(baselineCapture > -1, "neutral baseline capture not found");
  assert.ok(nonFiniteGuard < baselineCapture, "non-finite guard must precede baseline capture");
});

test("frame loop smooths shader-space yaw, pitch, and roll", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  assert.match(frame, /interactionCurrent \+= \(target - interactionCurrent\) \* 0\.08/);
  assert.match(frame, /Math\.abs\(interactionCurrent\) < 0\.0001/);
  assert.match(frame, /interactionCurrent = 0/);
  assert.match(frame, /interactionCurrentPitch \+= \(targetPitch - interactionCurrentPitch\) \* 0\.08/);
  assert.match(frame, /interactionCurrentRoll \+= \(targetRoll - interactionCurrentRoll\) \* 0\.08/);
  assert.match(frame, /rendererPool\[index\]\.setInteractionPitch\(interactionCurrentPitch\)/);
  assert.match(frame, /rendererPool\[index\]\.setInteractionRoll\(interactionCurrentRoll\)/);
});

test("frame loop decays interactionCurrent to zero after disable", () => {
  const frame = extractMethod(mainSource, "frame", 0);
  assert.ok(frame, "frame() body not found");
  // The decay guard: continue smoothing when current is non-zero even if disabled
  assert.match(frame, /interactiveEnabled[\s\S]*interactionCurrent !== 0[\s\S]*interactionCurrentPitch !== 0[\s\S]*interactionCurrentRoll !== 0/);
  assert.match(frame, /interactionCurrentPitch !== 0/);
  assert.match(frame, /interactionCurrentRoll !== 0/);
});

test("both shaders apply interactive pitch inside sphere sampling", () => {
  assert.match(mainSource, /uniform float uPitch/);
  assert.match(mainSource, /float cp = cos\(uPitch\)/);
  assert.match(wgslSource, /let cp = cos\(u\.pitch\)/);
  assert.match(wgslSource, /n = vec3f\(n\.x, cp \* n\.y - sp \* n\.z, sp \* n\.y \+ cp \* n\.z\)/);
});

test("both shaders apply interactive roll around the view axis", () => {
  assert.match(mainSource, /uniform float uRoll/);
  assert.match(mainSource, /t \* 0\.13 \* uMotion \+ uRoll/);
  assert.match(wgslSource, /t \* 0\.13 \* u\.motion \+ u\.roll/);
});

// --- both renderer spin paths ---

test("WebGL render adds interactionSpin to the uSpin uniform", () => {
  const render = extractMethod(mainSource, "render", 2);
  assert.ok(render, "WebGL render() body not found");
  assert.match(render, /gl\.uniform1f\(this\.locations\.spin, this\.spin \+ \(this\.autonomousSpin \? time \* 0\.08 : 0\) \+ \(this\.interactionSpin \|\| 0\)\)/);
  assert.match(render, /gl\.uniform1f\(this\.locations\.pitch, this\.interactionPitch\)/);
  assert.match(render, /gl\.uniform1f\(this\.locations\.roll, this\.interactionRoll\)/);
  assert.match(render, /gl\.uniform1f\(this\.locations\.motion, this\.autonomousSpin \? 1 : 0\)/);
});

test("WebGPU render adds interactionSpin to the spin uniform", () => {
  const render = extractMethod(engineSource, "render", 2);
  assert.ok(render, "WebGPU render() body not found");
  assert.match(render, /spin: this\.spin \+ \(this\.autonomousSpin \? time \* 0\.08 : 0\) \+ \(this\.interactionSpin \|\| 0\)/);
  assert.match(render, /pitch: this\.interactionPitch/);
  assert.match(render, /roll: this\.interactionRoll/);
  assert.match(render, /motion: this\.autonomousSpin \? 1 : 0/);
});

test("OrbRenderer exposes a setInteractionSpin method", () => {
  const body = extractMethod(mainSource, "setInteractionSpin", 2);
  assert.ok(body, "setInteractionSpin() body not found in main.js");
  assert.match(body, /this\.interactionSpin = value/);
});

test("WebGPUOrbRenderer exposes a setInteractionSpin method", () => {
  const body = extractMethod(engineSource, "setInteractionSpin", 2);
  assert.ok(body, "setInteractionSpin() body not found in webgpu-engine.js");
  assert.match(body, /this\.interactionSpin = value/);
});

test("both renderers expose a shader-space pitch control", () => {
  assert.match(mainSource, /setInteractionPitch\(value\)/);
  assert.match(engineSource, /setInteractionPitch\(value\)/);
});

test("both renderers expose a shader-space roll control", () => {
  assert.match(mainSource, /setInteractionRoll\(value\)/);
  assert.match(engineSource, /setInteractionRoll\(value\)/);
});

test("both renderers expose autonomous spin controls", () => {
  assert.match(mainSource, /setAutonomousSpin\(enabled\)/);
  assert.match(engineSource, /setAutonomousSpin\(enabled\)/);
});

// --- new renderer state ---

test("initializeRendererPool applies interactionCurrent to new WebGL renderers", () => {
  const body = extractMethod(mainSource, "initializeRendererPool", 0);
  assert.ok(body, "initializeRendererPool() body not found");
  assert.match(body, /renderer\.setInteractionSpin\(interactionCurrent\)/);
});

test("initializeWebGPU applies interactionCurrent to new WebGPU renderers", () => {
  const body = extractMethod(mainSource, "initializeWebGPU", 0);
  assert.ok(body, "initializeWebGPU() body not found");
  assert.match(body, /renderer\.setInteractionSpin\(interactionCurrent\)/);
  assert.match(body, /engine\.interactiveMotion = interactiveEnabled/);
});

// --- debug observability ---

test("window.__orbDebug exposes interaction state", () => {
  assert.match(mainSource, /interaction: \{/);
  assert.match(mainSource, /enabled: interactiveEnabled/);
  assert.match(mainSource, /source: interactionSource/);
  assert.match(mainSource, /target: \+interactionTarget\.toFixed\(4\)/);
  assert.match(mainSource, /current: \+interactionCurrent\.toFixed\(4\)/);
  assert.match(mainSource, /targetPitch: \+interactionTargetPitch\.toFixed\(4\)/);
  assert.match(mainSource, /currentPitch: \+interactionCurrentPitch\.toFixed\(4\)/);
  assert.match(mainSource, /targetRoll: \+interactionTargetRoll\.toFixed\(4\)/);
  assert.match(mainSource, /currentRoll: \+interactionCurrentRoll\.toFixed\(4\)/);
  assert.match(mainSource, /permission: interactionPermission/);
});
