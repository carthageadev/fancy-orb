import { highQualityFragmentShader, highQualityVertexShader } from "./high-quality-shaders.js";

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

let selectedIndex = 0;
let paused = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let seedOffset = 0;

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function mixRgb(first, second, amount) {
  return first.map((channel, index) => channel + (second[index] - channel) * amount);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, highQualityVertexShader);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, highQualityFragmentShader);
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
    this.data = data;
    this.index = index;
    this.seed = index * 17.13 + 4.7;
    this.audio = index === 0 ? 0.035 : 0;
    this.phase = this.seed * 0.73 + data.name.length * 0.13;
    this.spin = this.seed * 0.19;
    this.starDensity = data.starDensity ?? 1;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.locations = null;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance"
    });
    if (!this.gl) {
      throw new Error("WebGL is required for orb-of-fate; no CSS fallback is provided.");
    }
    this.program = createProgram(this.gl);
    this.buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 1,
        1, -1, 1, 1,
        -1, 1, 0, 0,
        1, 1, 1, 0
      ]),
      this.gl.STATIC_DRAW
    );
    this.locations = {
      position: 0,
      uv: 1,
      resolution: this.gl.getUniformLocation(this.program, "uRes"),
      background: this.gl.getUniformLocation(this.program, "uBg"),
      anchor: this.gl.getUniformLocation(this.program, "uAnchor"),
      color0: this.gl.getUniformLocation(this.program, "uC0"),
      color1: this.gl.getUniformLocation(this.program, "uC1"),
      color2: this.gl.getUniformLocation(this.program, "uC2"),
      time: this.gl.getUniformLocation(this.program, "uTime"),
      phase: this.gl.getUniformLocation(this.program, "uPhase"),
      audio: this.gl.getUniformLocation(this.program, "uAudio"),
      spin: this.gl.getUniformLocation(this.program, "uSpin"),
      archetype: this.gl.getUniformLocation(this.program, "uArch"),
      lens: this.gl.getUniformLocation(this.program, "uLens"),
      starDensity: this.gl.getUniformLocation(this.program, "uStarDensity")
    };
    this.accentA = hexToRgb(data.a);
    this.accentB = hexToRgb(data.b);
    this.accentC = hexToRgb(data.c || data.b);
    this.anchor = mixRgb(this.accentA, this.accentB, 0.28);
  }

  setSelected(isSelected) {
    this.audio = isSelected ? 0.035 : 0;
  }

  setSeed(seed) {
    this.seed = seed;
    this.phase = seed * 0.73 + this.data.name.length * 0.13;
    this.spin = seed * 0.19;
  }

  resize() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.lastWidth = width;
    this.lastHeight = height;
    this.gl.viewport(0, 0, width, height);
  }

  render(time) {
    this.resize();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.locations.uv);
    gl.vertexAttribPointer(this.locations.uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniform2f(this.locations.resolution, this.canvas.width, this.canvas.height);
    gl.uniform3fv(this.locations.background, [0, 0, 0]);
    gl.uniform3fv(this.locations.anchor, this.anchor);
    gl.uniform3fv(this.locations.color0, this.accentA);
    gl.uniform3fv(this.locations.color1, this.accentB);
    gl.uniform3fv(this.locations.color2, this.accentC);
    gl.uniform1f(this.locations.time, time);
    gl.uniform1f(this.locations.phase, this.phase);
    gl.uniform1f(this.locations.audio, this.audio);
    gl.uniform1f(this.locations.spin, this.spin + time * 0.08);
    gl.uniform1f(this.locations.archetype, -1);
    gl.uniform1f(this.locations.lens, 0.4);
    gl.uniform1f(this.locations.starDensity, this.starDensity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

const renderers = [];
const cards = [];

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
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    visual.append(canvas);

    const label = document.createElement("span");
    label.className = "orb-label";
    label.textContent = data.name;
    card.append(visual, label);
    track.append(card);
    cards.push(card);

    const renderer = new OrbRenderer(canvas, data, index);
    renderers.push(renderer);
    card.addEventListener("click", () => selectOrb(index));
  });

  rendererBadge.textContent = "webgl / hero glsl online";
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

function updateLayout() {
  cards.forEach((card, index) => {
    const distance = circularDistance(index, selectedIndex, orbData.length);
    const absoluteDistance = Math.abs(distance);
    const layout = layoutByDistance[Math.min(absoluteDistance, 3)];
    const offset = distance < 0 ? -layout.offset : layout.offset;
    card.style.setProperty("--orb-offset", `${offset}px`);
    card.style.setProperty("--orb-scale", `${layout.scale}`);
    card.style.setProperty("--orb-opacity", `${layout.opacity}`);
    card.classList.toggle("is-visible", absoluteDistance <= 2);
    card.classList.toggle("is-center", absoluteDistance === 0);
    card.classList.toggle("is-near", absoluteDistance === 1);
    card.setAttribute("aria-selected", absoluteDistance === 0 ? "true" : "false");
    renderers[index].setSelected(absoluteDistance === 0);
  });
  updateMeta();
}

function selectOrb(index) {
  selectedIndex = (index + orbData.length) % orbData.length;
  updateLayout();
}

function shiftOrb(amount) {
  selectOrb(selectedIndex + amount);
}

function randomizeSeeds() {
  seedOffset = Math.random() * 1000;
  renderers.forEach((renderer, index) => renderer.setSeed(seedOffset + index * 17.13 + 4.7));
}

previousButton.addEventListener("click", () => shiftOrb(-1));
nextButton.addEventListener("click", () => shiftOrb(1));
shuffleButton.addEventListener("click", randomizeSeeds);
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume field" : "Pause field";
});
window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") shiftOrb(-1);
  if (event.key === "ArrowRight") shiftOrb(1);
});
window.addEventListener("resize", () => renderers.forEach((renderer) => renderer.resize()));

buildOrbCards();
updateLayout();
pauseButton.textContent = paused ? "Resume field" : "Pause field";

let lastTime = 0;
function frame(now) {
  if (!paused) lastTime = now * 0.001;
  renderers.forEach((renderer) => renderer.render(lastTime));
  window.requestAnimationFrame(frame);
}

window.requestAnimationFrame(frame);
