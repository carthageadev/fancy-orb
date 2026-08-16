// Source-level regression tests for the Firefox-Android WebGPU capability fix
// in main.js: stored and toggled WebGPU choices must be preflighted against
// navigator.gpu before any lifecycle state changes, so stock Firefox for
// Android (no navigator.gpu) stays on the working WebGL pool instead of
// tearing it down into a blank page. These are source-level assertions, so
// they run in Node without a browser (same style as the WebGL hot-path tests).

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8");

// Extract the body of `name(` at the given indentation. Top-level functions in
// main.js use indentation 0 with an optional `async function `/`function `
// prefix. The body opening brace is found by balancing the parameter list
// first, so default values containing braces (e.g. `options = {}`) are not
// mistaken for the function body. Braces are balanced afterwards so object
// literals and nested callbacks inside the body do not confuse the scan.
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

test("hasWebGPUSupport() gates on navigator presence and the gpu member", () => {
  const body = extractMethod(mainSource, "hasWebGPUSupport", 0);
  assert.ok(body, "hasWebGPUSupport() body not found");
  assert.match(body, /typeof navigator !== "undefined"/);
  assert.match(body, /Boolean\(navigator\.gpu\)/);
});

test("resolveDefaultRenderMode() ignores a stored WebGPU preference without the API", () => {
  const body = extractMethod(mainSource, "resolveDefaultRenderMode", 0);
  assert.ok(body, "resolveDefaultRenderMode() body not found");
  // The stored-preference branch must fall back to WebGL when the API is
  // missing, before the stored preference is honored.
  const guard = body.indexOf('if (stored === "webgpu" && !hasWebGPUSupport()) return "webgl";');
  const storedReturn = body.indexOf("return stored;");
  assert.ok(guard > -1, "unsupported-WebGPU guard not found in the stored branch");
  assert.ok(storedReturn > -1, "stored preference return not found");
  assert.ok(guard < storedReturn, "the unsupported-WebGPU fallback must precede honoring the stored preference");
  // The stored preference must stay intact for later browsers that support it.
  assert.doesNotMatch(body, /localStorage\.removeItem/, "stored preference must be preserved");
  // The no-preference default reuses the same capability helper.
  assert.match(body, /return hasWebGPUSupport\(\) \? "webgpu" : "webgl";/);
});

test("switchRendererMode() preflights WebGPU before touching lifecycle state", () => {
  const body = extractMethod(mainSource, "switchRendererMode", 0);
  assert.ok(body, "switchRendererMode() body not found");
  const preflight = body.indexOf("hasWebGPUSupport()");
  assert.ok(preflight > -1, "capability preflight not found");
  const steps = [
    ["lifecycle token bump", "++rendererLifecycleToken"],
    ["persistence", "writeStoredRenderMode"],
    ["requestedMode assignment", "requestedMode = normalized"],
    ["renderer teardown", "teardownRenderers()"]
  ];
  for (const [name, marker] of steps) {
    const index = body.indexOf(marker);
    assert.ok(index > -1, `${name} step not found`);
    assert.ok(preflight < index, `preflight must run before ${name}`);
  }
  // Both user-visible badges: WebGL pool stays live vs no active backend.
  assert.match(body, /webgpu \/ unsupported in this browser — WebGL remains active/);
  assert.match(body, /webgpu \/ unsupported in this browser — choose WebGL/);
});

test("initializeWebGPU() guards capability and bounds engine.initialize()", () => {
  const body = extractMethod(mainSource, "initializeWebGPU", 0);
  assert.ok(body, "initializeWebGPU() body not found");
  // Defensive capability guard (a direct call must not tear down a pool).
  assert.match(body, /!hasWebGPUSupport\(\)/);
  assert.match(body, /webgpu \/ unsupported in this browser — WebGL remains active/);
  // engine.initialize() must be bounded by withTimeout...
  assert.match(body, /withTimeout\(engine\.initialize\(\), 5000\)/);
  // ...and only a settled (non-null) initialize() result counts as ready:
  // successful initialize() resolves undefined while timeout/rejection
  // resolves null.
  assert.match(body, /engineInitResult !== null/, "null timeout/rejection must not count as ready");
  // withTimeout is pulled into scope from the same dynamic import.
  assert.match(mainSource, /const \{ initWebGPU, WebGPUOrbRenderer, withTimeout \} = await import\("\.\/webgpu-engine\.js"\)/);
});
