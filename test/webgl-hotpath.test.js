// Static regression tests for the WebGL 1 hot-path optimization in main.js:
// per-frame render() must only upload time/spin and draw, static GL state and
// static/per-orb uniforms are set up once in initializeGpu(), and resize work
// is gated behind a needsResize/requestResize flag so a steady frame never
// touches layout. These are source-level assertions, so they run in Node
// without a browser (same style as the shader source tests).

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const mainSource = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// Extract the body of `name(` at the given indentation (class methods use 2
// spaces, top-level functions use 0 with an optional `function ` prefix).
// Braces are balanced so object literals and nested callbacks inside the body
// do not confuse the scan.
function extractMethod(source, name, indent = 2) {
  const pattern = new RegExp(`^ {${indent}}(?:function )?${name}\\(`, "m");
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

// Extract the arrow-function body stored on `this.<property>` in the
// constructor, e.g. this.handleContextRestored = () => { ... };
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

test("createWebGLContext disables MSAA and requests the high-performance GPU", () => {
  const body = extractMethod(mainSource, "createWebGLContext", 0);
  assert.ok(body, "createWebGLContext() body not found");
  assert.match(body, /antialias: false/);
  assert.doesNotMatch(body, /antialias: true/);
  assert.match(body, /powerPreference: "high-performance"/);
});

test("orb visuals explicitly clip the WebGL canvas to a circle", () => {
  const block = stylesSource.match(/\.orb-visual\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(block, ".orb-visual CSS block not found");
  assert.match(block, /overflow:\s*hidden/);
  assert.match(block, /border-radius:\s*50%/);
  assert.match(block, /-webkit-clip-path:\s*circle\(50% at 50% 50%\)/);
  assert.match(block, /clip-path:\s*circle\(50% at 50% 50%\)/);
});

test("render() keeps only time/spin uploads and the draw on the hot path", () => {
  const render = extractMethod(mainSource, "render");
  assert.ok(render, "render() body not found");
  assert.match(render, /gl\.uniform1f\(this\.locations\.time, time\)/);
  assert.match(render, /gl\.uniform1f\(this\.locations\.spin, this\.spin \+ time \* 0\.08 \+ \(this\.interactionSpin \|\| 0\)\)/);
  assert.match(render, /gl\.drawArrays\(gl\.TRIANGLE_STRIP, 0, 4\)/);
  // static GL state is bound in initializeGpu(), never per frame
  assert.doesNotMatch(render, /useProgram/);
  assert.doesNotMatch(render, /bindBuffer/);
  assert.doesNotMatch(render, /enableVertexAttribArray/);
  assert.doesNotMatch(render, /vertexAttribPointer/);
  // static/per-orb uniforms are re-uploaded only when their setters run
  assert.doesNotMatch(render, /uniform3fv/);
  assert.doesNotMatch(render, /uniform2f/);
  assert.doesNotMatch(render, /uniform1f\(this\.locations\.(phase|audio|archetype|lens|starDensity|fidelity|background)/);
  assert.doesNotMatch(render, /\[0, 0, 0\]/, "no per-frame background allocation");
  // no direct layout reads on the hot path
  assert.doesNotMatch(render, /clientWidth/);
  assert.doesNotMatch(render, /clientHeight/);
});

test("initializeGpu() performs the static GL state setup once", () => {
  const initializeGpu = extractMethod(mainSource, "initializeGpu");
  assert.ok(initializeGpu, "initializeGpu() body not found");
  assert.match(initializeGpu, /gl\.useProgram\(this\.program\)/);
  assert.match(initializeGpu, /gl\.bindBuffer\(gl\.ARRAY_BUFFER, this\.buffer\)/);
  assert.match(initializeGpu, /gl\.enableVertexAttribArray\(this\.locations\.position\)/);
  assert.match(initializeGpu, /gl\.enableVertexAttribArray\(this\.locations\.uv\)/);
  assert.match(initializeGpu, /gl\.vertexAttribPointer\(this\.locations\.position, 2, gl\.FLOAT, false, 16, 0\)/);
  assert.match(initializeGpu, /gl\.vertexAttribPointer\(this\.locations\.uv, 2, gl\.FLOAT, false, 16, 8\)/);
  assert.match(initializeGpu, /uploadStaticUniforms\(\)/);
  assert.match(initializeGpu, /this\.needsResize = true/, "first render after init/restore must re-measure");
});

test("static/per-orb uniforms are uploaded in one place and re-applied by every setter", () => {
  const upload = extractMethod(mainSource, "uploadStaticUniforms");
  assert.ok(upload, "uploadStaticUniforms() body not found");
  for (const location of ["background", "anchor", "color0", "color1", "color2"]) {
    assert.match(upload, new RegExp(`this\\.locations\\.${location}`), `missing ${location}`);
  }
  for (const uniform of ["phase", "audio", "archetype", "lens", "starDensity", "fidelity"]) {
    assert.match(upload, new RegExp(`this\\.locations\\.${uniform}`), `missing ${uniform}`);
  }
  for (const setter of ["setOrb", "setSelected", "setSeed", "setFidelity"]) {
    const body = extractMethod(mainSource, setter);
    assert.ok(body, `${setter}() body not found`);
    assert.match(body, /uploadStaticUniforms\(\)/, `${setter} must re-apply uniforms`);
  }
});

test("setOrb caches palette colors as Float32Array once per orb", () => {
  const setOrb = extractMethod(mainSource, "setOrb");
  assert.ok(setOrb, "setOrb() body not found");
  assert.match(setOrb, /this\.accentA = new Float32Array\(spec\.accentA\)/);
  assert.match(setOrb, /this\.accentB = new Float32Array\(spec\.accentB\)/);
  assert.match(setOrb, /this\.accentC = new Float32Array\(spec\.accentC\)/);
  assert.match(setOrb, /this\.anchor = new Float32Array\(spec\.anchor\)/);
  // the scene background stays a single module-level allocation
  assert.match(mainSource, /const backgroundUniform = new Float32Array\(\[0, 0, 0\]\)/);
});

test("resize work is gated behind a needsResize/requestResize flag", () => {
  const resize = extractMethod(mainSource, "resize");
  assert.ok(resize, "resize() body not found");
  assert.match(resize, /if \(!this\.needsResize\) return/, "steady frames must skip layout reads");
  assert.match(resize, /this\.needsResize = false/);
  assert.match(resize, /uniform2f\(this\.locations\.resolution/, "uRes is re-uploaded by the resize path");
  const requestResize = extractMethod(mainSource, "requestResize");
  assert.ok(requestResize, "requestResize() body not found");
  assert.match(requestResize, /this\.needsResize = true/);
});

test("window resize and quality changes request a re-measure", () => {
  const setQualityScale = extractMethod(mainSource, "setQualityScale");
  assert.ok(setQualityScale, "setQualityScale() body not found");
  assert.match(setQualityScale, /this\.needsResize = true/);
  assert.match(mainSource, /renderer\.requestResize\(\)/, "window resize must flag a re-measure");
});

test("context restore re-initializes the GPU and resets the cached size", () => {
  const restored = extractStoredHandler(mainSource, "handleContextRestored");
  assert.ok(restored, "handleContextRestored body not found");
  assert.match(restored, /this\.initializeGpu\(\)/);
  assert.match(restored, /this\.lastWidth = 0/);
  assert.match(restored, /this\.lastHeight = 0/);
});
