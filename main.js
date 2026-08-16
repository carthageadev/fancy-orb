import { highQualityFragmentShader, highQualityVertexShader } from "./high-quality-shaders.js";
import { buildOrbSpec, specFromSeed, getSeedOffset, setSeedOffset } from "./orb-spec.js";
import { QualityManager, AUTO_BUDGET_MS, FIDELITY_MODES, FPS_DEFAULT, isFpsSetting, fpsToInterval, frameDue } from "./quality.js";

// The active renderer pass is imported from high-quality-shaders.js above.
const orbData = [
  { name: "Aster", description: "A pale field with a soft blue edge.", tags: ["calm", "blue"], a: "#6d8cff", b: "#c7b8ff", c: "#9de5ff", starDensity: 0.24 },
  { name: "Vesper", description: "A violet dusk threaded with small sparks.", tags: ["violet", "slow"], a: "#846bff", b: "#e19bff", c: "#ff94d7", starDensity: 0.30 },
  { name: "Fathom", description: "A deep pocket of cold light and dust.", tags: ["deep", "quiet"], a: "#397dba", b: "#7ac6ff", c: "#6d91ff" },
  { name: "Serein", description: "Warm haze floating behind a dark glass shell.", tags: ["warm", "soft"], a: "#d68b62", b: "#ffcf92", c: "#ff9f63" },
  { name: "Nacre", description: "Pearlescent color at the edge of focus.", tags: ["pearl", "bright"], a: "#e68bd9", b: "#96d7ff", c: "#fff1bd" },
  { name: "Morrow", description: "A rising horizon of blue-white particles.", tags: ["dawn", "clear"], a: "#64a6ff", b: "#f5e4b0", c: "#9dfff2" },
  { name: "Cinder", description: "Ember-colored dust inside a cool rim.", tags: ["ember", "bold"], a: "#ff7f59", b: "#9a7cff", c: "#ffbd66" },
  { name: "Lumen", description: "A bright constellation with a clean center.", tags: ["bright", "precise"], a: "#ffe18d", b: "#83b4ff", c: "#fff9d2" },
  { name: "Nocturne", description: "Sparse stars under a blue-violet veil.", tags: ["night", "sparse"], a: "#4e4fba", b: "#9c9cff", c: "#6bdbff" },
  { name: "Halcyon", description: "A calm teal current passing through the dark.", tags: ["teal", "steady"], a: "#52bfac", b: "#9ba7ff", c: "#c8fff0" },
  { name: "Ember", description: "A last orange flare, almost out of frame.", tags: ["flare", "rare"], a: "#fb9a55", b: "#f0b0ff", c: "#ffdd7d" }
];

const layoutByDistance = {
  0: { offset: 0, scale: 1, opacity: 1, className: "is-center" },
  1: { offset: 150, scale: 0.62, opacity: 0.92, className: "is-near" },
  2: { offset: 255, scale: 0.36, opacity: 0.68, className: "is-visible" },
  3: { offset: 330, scale: 0.2, opacity: 0, className: "" }
};

const track = document.querySelector("#orbTrack");
const orbStage = document.querySelector(".orb-stage");
const previousButton = document.querySelector("#previousOrb");
const nextButton = document.querySelector("#nextOrb");
const pauseButton = document.querySelector("#pauseToggle");
const shuffleButton = document.querySelector("#shuffleButton");
const rendererBadge = document.querySelector("#rendererBadge");
const selectedIndexLabel = document.querySelector("#selectedIndexLabel");
const selectedOrbName = document.querySelector("#selectedOrbName");
const selectedOrbDescription = document.querySelector("#selectedOrbDescription");
const selectedOrbTags = document.querySelector("#selectedOrbTags");
const heroSubtitle = document.querySelector(".hero h1 span");
const brandSettingsToggle = document.querySelector("#brandSettingsToggle");
const renderSettings = document.querySelector("#renderSettings");
const resolutionSetting = document.querySelector("#resolutionSetting");
const fidelitySetting = document.querySelector("#fidelitySetting");
const fpsSettingControl = document.querySelector("#fps-setting");

let selectedIndex = 0;
let paused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const compactDeviceQuery = window.matchMedia("(max-width: 640px), (pointer: coarse)");
let fidelityValue = 1;
// Frame-rate cap state. Auto keeps the current behavior (render every rAF);
// capped modes gate rendering by interval while absolute time still advances.
// Caps reduce render frequency only: the shader — chromatic lens, rim, and
// specular passes — renders identically at every FPS setting.
let fpsSetting = FPS_DEFAULT;
let fpsIntervalMs = 0; // per-render budget in ms; 0 = no cap (auto)
let lastRenderAt = 0; // rAF timestamp of the last render; 0 = not rendered yet
let needsRender = true;
let stageInView = true;
const startupStartedAt = performance.now();
let rendererReadyAt = null;
let firstRenderAt = null;

function syncViewportMetrics() {
  const viewportHeight = Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight));
  const viewportUnit = viewportHeight / 100;
  const root = document.documentElement;
  root.style.setProperty("--viewport-height", `${viewportHeight}px`);
  root.style.setProperty("--viewport-1-5vh", `${viewportUnit * 1.5}px`);
  root.style.setProperty("--viewport-1-8vh", `${viewportUnit * 1.8}px`);
  root.style.setProperty("--viewport-2-5vh", `${viewportUnit * 2.5}px`);
  root.style.setProperty("--viewport-3-8vh", `${viewportUnit * 3.8}px`);
  root.style.setProperty("--viewport-5vh", `${viewportUnit * 5}px`);
  root.style.setProperty("--viewport-9vh", `${viewportUnit * 9}px`);
  root.style.setProperty("--viewport-10vh", `${viewportUnit * 10}px`);
  root.style.setProperty("--viewport-19vh", `${viewportUnit * 19}px`);
  root.style.setProperty("--viewport-23vh", `${viewportUnit * 23}px`);
}

syncViewportMetrics();
window.visualViewport?.addEventListener("resize", syncViewportMetrics, { passive: true });

function hexToRgb(hex) { // legacy: superseded by orb-spec.js
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function mixRgb(first, second, amount) { // legacy: superseded by orb-spec.js
  return first.map((channel, index) => channel + (second[index] - channel) * amount);
}

function stripShaderComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, stripShaderComments(source));
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function getFragmentPrecision(gl) {
  if (typeof gl.getShaderPrecisionFormat !== "function") return "mediump";
  const highPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  return highPrecision && highPrecision.precision > 0 ? "highp" : "mediump";
}

function getFragmentShaderSource(gl) {
  const precision = getFragmentPrecision(gl);
  return highQualityFragmentShader
    .replace("precision highp float;", `precision ${precision} float;`)
    .replace("uniform float uStarDensity;", "uniform float uStarDensity;\nuniform float uFidelity;")
    .replace("float detail = smoothstep(90.0, 200.0, uRes.y);", "float detail = smoothstep(90.0, 200.0, uRes.y) * uFidelity;")
    .replace("gl_FragColor = vec4(col, 1.0);", "gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);")
    .replace("gl_FragColor = vec4(shade(p), 1.0);", "gl_FragColor = vec4(clamp(shade(p), 0.0, 1.0), 1.0);");
}

function createWebGLContext(canvas) {
  const attributes = {
    alpha: false,
    // The scene is one fullscreen shader quad: polygon-edge MSAA can never
    // affect the output, so disable it and skip the multisample framebuffer
    // allocation. Unknown attributes (like powerPreference on older browsers)
    // are ignored gracefully by the context factory.
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: new URLSearchParams(window.location.search).has("readback"),
    powerPreference: "high-performance"
  };
  return canvas.getContext("webgl", attributes) || canvas.getContext("experimental-webgl", attributes);
}

const quadVertices = new Float32Array([
  -1, -1, 0, 1,
  1, -1, 1, 1,
  -1, 1, 0, 0,
  1, 1, 1, 0
]);

// Constant scene background (uBg). Shared across renderers and never mutated,
// so it can be allocated once at module load instead of per frame.
const backgroundUniform = new Float32Array([0, 0, 0]);

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, highQualityVertexShader);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, getFragmentShaderSource(gl));
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.bindAttribLocation(program, 1, "aUV");
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown program link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

class OrbRenderer {
  constructor(canvas, data, index) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.locations = null;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.needsResize = true;
    this.visible = true;
    this.contextLost = false;
    this.destroyed = false;
    this.qualityScale = quality.scale;
    this.fidelity = fidelityValue;
    this.setOrb(data, index);
    this.gl = createWebGLContext(canvas);
    if (!this.gl) {
      throw new Error("WebGL is required for orb-of-fate; no CSS fallback is provided.");
    }
    this.handleContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      needsRender = true;
    };
    this.handleContextRestored = () => {
      if (this.destroyed) return;
      this.contextLost = false;
      this.initializeGpu();
      this.lastWidth = 0;
      this.lastHeight = 0;
      needsRender = true;
    };
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost, { passive: false });
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.initializeGpu();
  }

  initializeGpu() {
    if (this.destroyed) return;
    const gl = this.gl;
    this.program = createProgram(gl);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    this.locations = {
      position: 0,
      uv: 1,
      resolution: gl.getUniformLocation(this.program, "uRes"),
      background: gl.getUniformLocation(this.program, "uBg"),
      anchor: gl.getUniformLocation(this.program, "uAnchor"),
      color0: gl.getUniformLocation(this.program, "uC0"),
      color1: gl.getUniformLocation(this.program, "uC1"),
      color2: gl.getUniformLocation(this.program, "uC2"),
      time: gl.getUniformLocation(this.program, "uTime"),
      phase: gl.getUniformLocation(this.program, "uPhase"),
      audio: gl.getUniformLocation(this.program, "uAudio"),
      spin: gl.getUniformLocation(this.program, "uSpin"),
      archetype: gl.getUniformLocation(this.program, "uArch"),
      lens: gl.getUniformLocation(this.program, "uLens"),
      starDensity: gl.getUniformLocation(this.program, "uStarDensity"),
      fidelity: gl.getUniformLocation(this.program, "uFidelity")
    };
    gl.clearColor(0, 0, 0, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    // Static GL state: program, quad buffer and vertex layout never change
    // between draws, so bind them once here. initializeGpu() runs again after
    // a context restore, which is exactly when this state must be rebuilt.
    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.locations.uv);
    gl.vertexAttribPointer(this.locations.uv, 2, gl.FLOAT, false, 16, 8);
    this.uploadStaticUniforms();
    // Initial render (and any render after a context restore) must re-measure
    // the backing store and re-upload uRes.
    this.needsResize = true;
  }

  uploadStaticUniforms() {
    const gl = this.gl;
    if (!gl || !this.locations) return;
    // Static/per-orb uniforms. Called from initializeGpu() after program
    // creation and from setOrb/setSelected/setSeed/setFidelity whenever one of
    // them changes, so the values are always current for the bound program.
    gl.uniform3fv(this.locations.background, backgroundUniform);
    gl.uniform3fv(this.locations.anchor, this.anchor);
    gl.uniform3fv(this.locations.color0, this.accentA);
    gl.uniform3fv(this.locations.color1, this.accentB);
    gl.uniform3fv(this.locations.color2, this.accentC);
    gl.uniform1f(this.locations.phase, this.phase);
    gl.uniform1f(this.locations.audio, this.audio);
    gl.uniform1f(this.locations.archetype, -1);
    gl.uniform1f(this.locations.lens, 0.4);
    gl.uniform1f(this.locations.starDensity, this.starDensity);
    gl.uniform1f(this.locations.fidelity, this.fidelity);
  }

  setSelected(isSelected) {
    this.audio = isSelected ? 0.035 : 0;
    this.uploadStaticUniforms();
  }

  setVisible(isVisible) {
    this.visible = isVisible;
  }

  setQualityScale(scale) {
    this.qualityScale = scale;
    this.needsResize = true;
  }

  setFidelity(value) {
    this.fidelity = value;
    this.uploadStaticUniforms();
  }

  setOrb(data, index) {
    this.data = data;
    this.index = index;
    const spec = buildOrbSpec(data, index);
    this.seed = spec.seed;
    this.phase = spec.phase;
    this.spin = spec.spin;
    this.starDensity = spec.starDensity;
    this.accentA = new Float32Array(spec.accentA);
    this.accentB = new Float32Array(spec.accentB);
    this.accentC = new Float32Array(spec.accentC);
    this.anchor = new Float32Array(spec.anchor);
    this.audio = 0;
    this.needsResize = true;
    this.uploadStaticUniforms();
  }

  setSeed(seed) {
    this.seed = seed;
    const motion = specFromSeed(this.data, seed);
    this.phase = motion.phase;
    this.spin = motion.spin;
    this.uploadStaticUniforms();
  }

  requestResize() {
    this.needsResize = true;
  }

  resize() {
    // Layout reads (clientWidth/clientHeight) only happen when the backing
    // store may have changed: window resize, quality change, setOrb moving a
    // renderer to a different card, the initial render, or a context restore.
    if (!this.needsResize) return;
    this.needsResize = false;
    const isCompactDevice = compactDeviceQuery.matches;
    const maxPixelRatio = isCompactDevice ? 1.25 : 1.75;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio) * this.qualityScale;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.lastWidth = width;
    this.lastHeight = height;
    this.gl.viewport(0, 0, width, height);
    this.gl.uniform2f(this.locations.resolution, width, height);
  }

  render(time) {
    if (this.destroyed) return false;
    const contextLost = this.contextLost
      || (typeof this.gl.isContextLost === "function" && this.gl.isContextLost());
    if (contextLost) return false;
    this.resize();
    const gl = this.gl;
    // Per-frame uniforms only: time and the animated spin. Everything else is
    // static GL state or an unchanged uniform re-uploaded by the setters and
    // initializeGpu().
    gl.uniform1f(this.locations.time, time);
    gl.uniform1f(this.locations.spin, this.spin + time * 0.08);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
    }
    this.program = null;
    this.buffer = null;
    this.canvas.remove?.();
    needsRender = true;
  }
}

const renderers = orbData.map(() => null);
const rendererPool = [];
const cards = [];

const quality = new QualityManager({
  compact: compactDeviceQuery.matches,
  onLevelChange: (scale) => {
    rendererPool.forEach((renderer) => renderer.setQualityScale(scale));
    needsRender = true;
  }
});

function applyResolutionMode(mode) {
  quality.setMode(mode);
  needsRender = true;
}

function applyFidelityMode(mode) {
  fidelityValue = FIDELITY_MODES[mode] ?? FIDELITY_MODES.full;
  rendererPool.forEach((renderer) => renderer.setFidelity(fidelityValue));
  needsRender = true;
}

function applyFpsSetting(value) {
  const normalized = isFpsSetting(value) ? value : FPS_DEFAULT;
  if (normalized === fpsSetting) return;
  fpsSetting = normalized;
  fpsIntervalMs = fpsToInterval(normalized);
  // While a cap is active, the auto ladder's ceiling drops to the 70% rung so
  // adaptive headroom cannot climb back to full resolution; manual resolution
  // modes are unaffected. Clearing the cap restores the normal auto maximum.
  quality.setFpsCeiling(fpsIntervalMs > 0);
  needsRender = true;
  lastRenderAt = 0; // apply the new cadence on the next rAF
  quality.reset();
}

function setRenderSettingsOpen(isOpen) {
  if (!brandSettingsToggle || !renderSettings) return;
  renderSettings.hidden = !isOpen;
  brandSettingsToggle.setAttribute("aria-expanded", String(isOpen));
}

function setupRenderSettings() {
  if (!brandSettingsToggle || !renderSettings) return;

  brandSettingsToggle.addEventListener("click", () => {
    setRenderSettingsOpen(renderSettings.hidden);
  });

  resolutionSetting?.addEventListener("change", (event) => {
    applyResolutionMode(event.target.value);
  });

  fidelitySetting?.addEventListener("change", (event) => {
    applyFidelityMode(event.target.value);
  });

  fpsSettingControl?.addEventListener("change", (event) => {
    applyFpsSetting(event.target.value);
  });
  applyFpsSetting(fpsSettingControl?.value);

  document.querySelector("#renderModeToggle")?.addEventListener("click", toggleRendererMode);
  updateRendererModeControl();

  document.addEventListener("click", (event) => {
    if (renderSettings.hidden) return;
    if (!renderSettings.contains(event.target) && !brandSettingsToggle.contains(event.target)) {
      setRenderSettingsOpen(false);
    }
  });
}

function updateAdaptiveQuality(frameMs, didRender) {
  if (!didRender || paused || document.hidden || !stageInView) return;
  quality.sample(frameMs, fpsIntervalMs > 0 ? fpsIntervalMs : AUTO_BUDGET_MS);
}

function renderVisibleOrbs(time) {
  let didRender = false;
  rendererPool.forEach((renderer) => {
    if (renderer.visible && renderer.render(time)) didRender = true;
  });
  if (didRender) needsRender = false;
  return didRender;
}

function circularDistance(index, center, length) {
  let distance = index - center;
  if (distance > length / 2) distance -= length;
  if (distance < -length / 2) distance += length;
  return distance;
}

function buildOrbCards() {
  orbData.forEach((data, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "orb-card";
    card.setAttribute("aria-label", `Select ${data.name} orb`);
    card.setAttribute("aria-selected", index === selectedIndex ? "true" : "false");

    const visual = document.createElement("span");
    visual.className = "orb-visual";

    const label = document.createElement("span");
    label.className = "orb-label";
    label.textContent = data.name;
    card.append(visual, label);
    track.append(card);
    cards.push(card);

    card.addEventListener("click", () => selectOrb(index));
  });

  rendererBadge.textContent = "initializing renderer";
}

const maxRendererPoolSize = compactDeviceQuery.matches ? 3 : Math.min(5, orbData.length);
let rendererInitializationFailed = false;
let gpuEngine = null;

// Explicit renderer mode selection. The requested mode is persisted under a
// namespaced key (storage access is guarded — it can throw in private or
// blocked-cookie contexts), while the active mode tracks which backend
// actually has live renderers. `?forceWebGL` remains a session-only test
// override and never overwrites the stored selection.
const RENDER_MODE_STORAGE_KEY = "orb-of-fate-render-mode";
const RENDER_MODE_EXPLICIT_KEY = "orb-of-fate-render-mode-explicit";
let requestedMode = null;
let activeMode = null;
// Bumped on every switch; async init and progressive pool steps re-check it
// so a stale initialization can never create duplicate pools or canvases
// after a newer toggle.
let rendererLifecycleToken = 0;

function isRenderMode(value) {
  return value === "webgpu" || value === "webgl";
}

function otherRenderMode(mode) {
  return mode === "webgpu" ? "webgl" : "webgpu";
}

function readStoredRenderMode() {
  try {
    const stored = window.localStorage.getItem(RENDER_MODE_STORAGE_KEY);
    return isRenderMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredRenderMode(mode) {
  if (!isRenderMode(mode)) return;
  try {
    window.localStorage.setItem(RENDER_MODE_STORAGE_KEY, mode);
    window.localStorage.setItem(RENDER_MODE_EXPLICIT_KEY, "1");
  } catch {
    // storage unavailable — the selection still applies for this session
  }
}

function hasExplicitStoredRenderMode() {
  try {
    return window.localStorage.getItem(RENDER_MODE_EXPLICIT_KEY) === "1";
  } catch {
    return false;
  }
}

function hasForceWebGLOverride() {
  return new URLSearchParams(window.location.search).has("forceWebGL");
}

function resolveDefaultRenderMode() {
  if (hasForceWebGLOverride()) return "webgl";
  const stored = readStoredRenderMode();
  if (isRenderMode(stored) && (!compactDeviceQuery.matches || hasExplicitStoredRenderMode())) return stored;
  // Compact/mobile devices start on WebGL: it is the broadly supported,
  // lower-risk path there. The renderer toggle still allows explicit WebGPU
  // testing on devices that expose it.
  if (compactDeviceQuery.matches) return "webgl";
  // No stored preference: prefer WebGPU on larger devices where it exists.
  return typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "webgl";
}

function updateRendererModeControl() {
  const toggle = document.querySelector("#renderModeToggle");
  if (!toggle) return;
  const current = isRenderMode(requestedMode)
    ? requestedMode
    : (isRenderMode(activeMode) ? activeMode : "webgl");
  const target = otherRenderMode(current);
  const value = document.querySelector("#renderModeValue");
  const action = document.querySelector("#renderModeSwitch");
  if (value) value.textContent = current;
  if (action) action.textContent = `switch to ${target}`;
  toggle.setAttribute("aria-label", `Renderer: ${current}. Switch to ${target}.`);
}

function toggleRendererMode() {
  const current = isRenderMode(requestedMode)
    ? requestedMode
    : (isRenderMode(activeMode) ? activeMode : "webgl");
  switchRendererMode(otherRenderMode(current));
}

// Drop every live renderer (WebGL or WebGPU) plus the engine before a new
// backend starts. Safe to call when nothing is running.
function teardownRenderers() {
  rendererPool.forEach((renderer) => renderer.destroy?.());
  rendererPool.length = 0;
  renderers.fill(null);
  const engine = gpuEngine;
  gpuEngine = null;
  if (engine) {
    engine.onLost = null;
    engine.destroy?.();
  }
  activeMode = null;
  needsRender = true;
}

function reportModeStatus(badgeText) {
  rendererBadge.textContent = badgeText;
  if (badgeText.endsWith("online") && rendererReadyAt === null) {
    rendererReadyAt = performance.now();
  }
  updateRendererModeControl();
}

// Device loss / uncaptured validation errors only stop the WebGPU backend and
// report it; they never silently start the other backend. The user picks the
// next mode from the render settings control.
function handleWebGPUDeviceLost() {
  if (activeMode !== "webgpu") return;
  console.warn("WebGPU device lost; renderer stopped. Choose WebGL to continue.");
  reportModeStatus("webgpu / device lost — choose WebGL");
  teardownRenderers();
}

async function switchRendererMode(mode, options = {}) {
  const normalized = isRenderMode(mode) ? mode : "webgl";
  const token = ++rendererLifecycleToken;
  requestedMode = normalized;
  if (options.persist !== false) writeStoredRenderMode(normalized);
  rendererInitializationFailed = false;
  reportModeStatus(`${normalized} / switching…`);
  teardownRenderers();
  updateRendererModeControl();
  updateLayout();
  if (normalized === "webgpu") {
    await initializeWebGPU(token);
  } else {
    initializeRendererPool(token);
  }
}

async function initializeWebGPU(token) {
  let engine = null;
  try {
    const { initWebGPU, WebGPUOrbRenderer } = await import("./webgpu-engine.js");
    if (token !== rendererLifecycleToken) return;
    engine = await initWebGPU();
    if (token !== rendererLifecycleToken) {
      engine?.destroy?.();
      return;
    }
    if (!engine) {
      reportModeStatus("webgpu / unavailable — choose WebGL");
      return;
    }
    gpuEngine = engine;
    engine.compactQuery = compactDeviceQuery;
    engine.compactMaxDpr = 1.25;
    // Wire the once-only loss/uncaptured-error handler BEFORE initialize: an
    // early device loss must stop the backend cleanly instead of limping on.
    engine.onLost = () => handleWebGPUDeviceLost();

    let engineReady = false;
    if (!engine.failed) {
      try {
        await engine.initialize();
        if (token !== rendererLifecycleToken) return;
        engineReady = !engine.failed;
      } catch (error) {
        if (token === rendererLifecycleToken) console.error("WebGPU initialization failed:", error);
      }
    }
    if (token !== rendererLifecycleToken) return;

    if (engineReady) {
      try {
        for (let index = 0; index < maxRendererPoolSize; index += 1) {
          const canvas = document.createElement("canvas");
          canvas.setAttribute("aria-hidden", "true");
          const renderer = new WebGPUOrbRenderer(engine, canvas, orbData[index], index);
          renderer.setQualityScale(quality.scale);
          renderer.setFidelity(fidelityValue);
          rendererPool.push(renderer);
        }
        if (engine.failed) engineReady = false;
      } catch (error) {
        console.error("WebGPU renderer creation failed:", error);
        engineReady = false;
      }
    }
    if (token !== rendererLifecycleToken) return;

    if (engineReady && !engine.failed) {
      activeMode = "webgpu";
      reportModeStatus("webgpu / hero wgsl online");
      updateLayout();
      return;
    }
    reportModeStatus(engine.lost ? "webgpu / device lost — choose WebGL" : "webgpu / unavailable — choose WebGL");
    teardownRenderers();
  } catch (error) {
    if (token !== rendererLifecycleToken) return;
    console.error("WebGPU unavailable:", error);
    teardownRenderers();
    reportModeStatus("webgpu / unavailable — choose WebGL");
  }
}

function scheduleRendererWork(callback) {
  window.requestAnimationFrame(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(callback, { timeout: 350 });
    } else {
      // Safari and older mobile browsers may not expose requestIdleCallback.
      // Yield out of the animation frame before compiling the next GLSL
      // program so the first paint is never blocked by shader compilation.
      window.setTimeout(callback, 0);
    }
  });
}

function initializeRendererPool(token, index = 0) {
  if (token !== rendererLifecycleToken) return;
  if (index >= maxRendererPoolSize) {
    reportModeStatus(rendererInitializationFailed
      ? "webgl / partial renderer"
      : "webgl / hero glsl online");
    if (token === rendererLifecycleToken && rendererPool.length > 0) activeMode = "webgl";
    updateRendererModeControl();
    updateLayout();
    return;
  }

  scheduleRendererWork(() => {
    if (token !== rendererLifecycleToken) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    try {
      const renderer = new OrbRenderer(canvas, orbData[index], index);
      rendererPool.push(renderer);
    } catch (error) {
      rendererInitializationFailed = true;
      console.error(`Could not initialize orb renderer ${index}.`, error);
    }
    rendererBadge.textContent = `webgl / loading shader ${rendererPool.length}/${maxRendererPoolSize}`;
    updateLayout();
    initializeRendererPool(token, index + 1);
  });
}

function getVisibleDistance() {
  return Math.min(2, Math.floor(Math.max(0, rendererPool.length - 1) / 2));
}

function updateMeta() {
  const data = orbData[selectedIndex];
  selectedIndexLabel.textContent = `${String(selectedIndex + 1).padStart(2, "0")} / ${String(orbData.length).padStart(2, "0")}`;
  selectedOrbName.textContent = data.name;
  selectedOrbDescription.textContent = data.description;
  heroSubtitle.style.setProperty("--title-c0", data.b);
  heroSubtitle.style.setProperty("--title-c1", data.c);
  heroSubtitle.style.setProperty("--title-c2", data.a);
  heroSubtitle.style.setProperty("--title-c3", data.b);
  heroSubtitle.style.setProperty("--title-angle", `${118 + selectedIndex * 17}deg`);
  selectedOrbTags.replaceChildren(...data.tags.map((tag) => {
    const pill = document.createElement("span");
    pill.className = "meta-pill";
    pill.textContent = tag;
    return pill;
  }));
}

function assignVisibleRenderers() {
  renderers.fill(null);
  rendererPool.forEach((renderer) => renderer.setVisible(false));

  const maxVisibleDistance = getVisibleDistance();
  const visibleIndices = cards
    .map((_, index) => index)
    .filter((index) => Math.abs(circularDistance(index, selectedIndex, orbData.length)) <= maxVisibleDistance)
    .sort((first, second) => {
      const firstDistance = Math.abs(circularDistance(first, selectedIndex, orbData.length));
      const secondDistance = Math.abs(circularDistance(second, selectedIndex, orbData.length));
      return firstDistance - secondDistance;
    });

  visibleIndices.forEach((index, poolIndex) => {
    const renderer = rendererPool[poolIndex];
    if (!renderer) return;
    const visual = cards[index].querySelector(".orb-visual");
    if (renderer.canvas.parentElement !== visual) visual.append(renderer.canvas);
    renderer.setOrb(orbData[index], index);
    renderer.setVisible(true);
    renderers[index] = renderer;
  });
}

function updateLayout() {
  assignVisibleRenderers();
  const maxVisibleDistance = getVisibleDistance();
  cards.forEach((card, index) => {
    const distance = circularDistance(index, selectedIndex, orbData.length);
    const absoluteDistance = Math.abs(distance);
    const layout = layoutByDistance[Math.min(absoluteDistance, 3)];
    const offset = distance < 0 ? -layout.offset : layout.offset;
    card.style.setProperty("--orb-offset", `${offset}px`);
    card.style.setProperty("--orb-scale", `${layout.scale}`);
    card.style.setProperty("--orb-opacity", `${layout.opacity}`);
    card.classList.toggle("is-visible", absoluteDistance <= maxVisibleDistance);
    card.classList.toggle("is-center", absoluteDistance === 0);
    card.classList.toggle("is-near", absoluteDistance === 1);
    card.setAttribute("aria-selected", absoluteDistance === 0 ? "true" : "false");
    const renderer = renderers[index];
    if (renderer) {
      renderer.setSelected(absoluteDistance === 0);
      renderer.setVisible(absoluteDistance <= maxVisibleDistance);
    }
  });
  updateMeta();
  needsRender = true;
}

function selectOrb(index) {
  selectedIndex = (index + orbData.length) % orbData.length;
  updateLayout();
}

function shiftOrb(amount) {
  selectOrb(selectedIndex + amount);
}

function randomizeSeeds() {
  setSeedOffset(Math.random() * 1000);
  rendererPool.forEach((renderer) => renderer.setSeed(getSeedOffset() + renderer.index * 17.13 + 4.7));
  needsRender = true;
}

previousButton.addEventListener("click", () => shiftOrb(-1));
nextButton.addEventListener("click", () => shiftOrb(1));
shuffleButton.addEventListener("click", randomizeSeeds);
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume field" : "Pause field";
  needsRender = true;
  quality.reset();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setRenderSettingsOpen(false);
  if (event.key === "ArrowLeft") shiftOrb(-1);
  if (event.key === "ArrowRight") shiftOrb(1);
});
window.addEventListener("resize", () => {
  syncViewportMetrics();
  rendererPool.forEach((renderer) => {
    // WebGL renderers only record that a re-measure is due; the next render()
    // performs it. The WebGPU renderer has no requestResize, so it keeps
    // resizing eagerly here.
    if (typeof renderer.requestResize === "function") renderer.requestResize();
    else renderer.resize();
  });
  needsRender = true;
  quality.reset();
});

document.addEventListener("visibilitychange", () => {
  needsRender = true;
  quality.reset();
});

if (orbStage && "IntersectionObserver" in window) {
  const stageObserver = new IntersectionObserver((entries) => {
    stageInView = entries.some((entry) => entry.isIntersecting);
    if (stageInView) {
      needsRender = true;
      quality.reset();
    }
  }, { threshold: 0.01 });
  stageObserver.observe(orbStage);
}

setupRenderSettings();
buildOrbCards();
updateLayout();
switchRendererMode(resolveDefaultRenderMode(), { persist: false });
pauseButton.textContent = paused ? "Resume field" : "Pause field";

let lastTime = 0;
let lastFrameNow = 0;
function frame(now) {
  if (!paused) {
    lastTime = typeof window.__orbFreezeTime === "number" ? window.__orbFreezeTime : now * 0.001;
  }
  const frameMs = lastFrameNow ? now - lastFrameNow : AUTO_BUDGET_MS;
  lastFrameNow = now;
  // The cadence gate skips rendering work on in-between rAFs while time still
  // advances and rAF keeps scheduling. `needsRender` survives skipped ticks,
  // so an interaction settles on the next due frame. Auto (interval 0) is due
  // every frame, preserving the current behavior.
  const renderDue = frameDue(now, lastRenderAt, fpsIntervalMs);
  const shouldRender = renderDue && stageInView && !document.hidden && (!paused || needsRender);
  let didRender = false;
  if (shouldRender) {
    try {
      didRender = renderVisibleOrbs(lastTime);
      // The cadence anchor advances only after a render actually succeeds, so
      // a frame that fails under a cap never consumes its interval.
      if (didRender) lastRenderAt = now;
    } catch (error) {
      console.error("Renderer frame failed:", error);
      // Reset the anchor so capped mode retries on the next rAF instead of
      // waiting out the whole interval. Auto (interval 0) is unaffected — it
      // is due every frame regardless.
      lastRenderAt = 0;
      if (activeMode === "webgpu") handleWebGPUDeviceLost();
    }
  }
  if (didRender && firstRenderAt === null) firstRenderAt = performance.now();
  if (didRender) gpuEngine?.endFrame();
  updateAdaptiveQuality(frameMs, didRender && !paused);
  window.requestAnimationFrame(frame);
}

window.__orbDebug = () => ({
  stack: gpuEngine ? "webgpu" : "webgl",
  mode: {
    requested: requestedMode,
    active: activeMode
  },
  badge: rendererBadge.textContent,
  renderers: rendererPool.map((renderer) => ({
    seed: renderer.seed?.toFixed(3),
    phase: renderer.phase?.toFixed(3),
    spin: renderer.spin?.toFixed(3),
    audio: renderer.audio,
    visible: renderer.visible,
    canvas: [renderer.canvas?.width, renderer.canvas?.height]
  })),
  gpu: gpuEngine
    ? {
        format: gpuEngine.format,
        renderPasses: gpuEngine.renderPasses,
        submissions: gpuEngine.frameSubmissions,
        failed: gpuEngine.failed
      }
    : null,
  engine: gpuEngine,
  quality: {
    enabled: quality.enabled,
    scale: quality.scale,
    label: quality.label,
    emaMs: +quality.emaMs.toFixed(2),
    index: quality.index
  },
  startup: {
    rendererReadyMs: rendererReadyAt === null ? null : +(rendererReadyAt - startupStartedAt).toFixed(1),
    firstRenderMs: firstRenderAt === null ? null : +(firstRenderAt - startupStartedAt).toFixed(1)
  },
  fidelity: fidelityValue,
  fps: {
    setting: fpsSetting,
    intervalMs: +fpsIntervalMs.toFixed(2)
  }
});

window.requestAnimationFrame(frame);
