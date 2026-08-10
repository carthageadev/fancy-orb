// agent-orb.js — "Fancy Orbs"
// ---------------------------------------------------------------------------
// A tidy, dependency-free WebGL orb engine. The GLSL in shaders.js is
// byte-for-byte from the original AgentOrb template literals; the driver
// below is a faithful port of the same module's render loop and physics.
//
// Differences from the original, by design:
//   * main-thread only (the bundle itself falls back to this path when
//     OffscreenCanvas workers are unavailable — identical visuals)
//   * plain DOM instead of React
//   * visual-only: the live-audio input subsystem is removed; orbs render
//     exactly as the originals do while no input plays
//
// Public API:
//   createOrb(options) -> { element, canvas, destroy }
//   hashSeed(str), DEFAULT_PALETTES, ARCHETYPES, orbState, orbDebug, MAX_DPR

import { SHADERS } from './shaders.js';

// ── constants (copied from the bundle) ─────────────────────────────────────

export const BATCH_MAX_PX = 512;
export const FRAME_MS = 1000 / 60;
export const GL_CONTEXT_OPTS = {
  premultipliedAlpha: true,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
};
export const MAX_DPR = 2;
export const MAX_PX = 1280;

const ORB_UNIFORMS = [
  'uRes', 'uBg', 'uAnchor', 'uC0', 'uC1', 'uC2',
  'uTime', 'uPhase', 'uAudio', 'uSpin', 'uArch', 'uLens',
];

// ── tiny hash/color helpers (from the bundle) ──────────────────────────────

/** FNV-1a — the same string hash the site uses for seed -> palette/phase. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x1000193);
  }
  return h >>> 0;
}

export function toRGB(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

// `A(e, t, a)` in the bundle: HSL (h in degrees, s, l) -> [r, g, b] 0..1
function hueRgb(hue, sat, lig) {
  const k = sat * Math.min(lig, 1 - lig);
  const f = (n) => {
    n = (n + hue / 30) % 12;
    return lig - k * Math.max(-1, Math.min(n - 3, 9 - n, 1));
  };
  return [f(0), f(8), f(4)];
}

function rgbHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(255 * v).toString(16).padStart(2, '0')).join('')}`;
}

const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

// The site's default hue table — an orb with no explicit palette picks the
// entry indexed by hashSeed(seed) and derives anchor + 3 accents from it.
export const HUE_TABLE = [13, 34, 125, 146, 166, 187, 208, 228, 249, 270, 290, 311, 332, 353];

export const DEFAULT_PALETTES = HUE_TABLE.map((hue) => {
  const t = 0.2 * (1 - luma(hueRgb(hue, 1, 0.5)));
  return {
    anchor: rgbHex(hueRgb(hue, 0.85, 0.42 + t)),
    accents: [
      rgbHex(hueRgb(hue, 0.95, Math.min(0.72, 0.6 + t))),
      rgbHex(hueRgb((hue + 16) % 360, 0.8, Math.min(0.82, 0.7 + t))),
      rgbHex(hueRgb((hue + 34) % 360, 0.9, Math.min(0.9, 0.8 + t))),
    ],
  };
});

export const ARCHETYPES = ['spiral', 'nebula', 'core', 'deep'];
const ARCH_MAP = { spiral: 0, nebula: 1, core: 2, deep: 3 };

// ── per-frame spec update (bundle fn `d`) ─────────────────────────────────
// Audio smoothing (slow/fast attack), the tumbling spin physics, oscillation
// ── per-frame spec update (bundle fn `d`) ─────────────────────────────────
// Audio smoothing (slow/fast attack), the tumbling spin physics, oscillation
// flip queueing and the audio-driven spin kicks. Ported line for line.
// The bundle feeds a live voice level into this via WebAudio; in this
// visual-only build the level source is removed, so `target` stays 0 — the
// orbs render exactly as the site's do when no voice is playing.

function tickSpec(spec, now) {
  const dt = spec.lastT === null ? 0 : Math.min(0.1, Math.max(0, now - spec.lastT));
  spec.lastT = now;

  const target = 0; // site: Math.max(coreLevel, perSeedLevels.get(spec.seed) ?? 0)
  const slowTau = target > spec.audioSmooth ? 0.11 : 0.3;
  spec.audioSmooth += (target - spec.audioSmooth) * (dt > 0 ? 1 - Math.exp(-dt / slowTau) : 0);
  const fastTau = target > spec.audioFast ? 0.04 : 0.18;
  spec.audioFast += (target - spec.audioFast) * (dt > 0 ? 1 - Math.exp(-dt / fastTau) : 0);

  const wobble = (6.31 * spec.phase) % 1;
  const breathe = 0.35 * Math.sin(now * (0.11 + 0.08 * ((2.17 * spec.phase) % 1)) + spec.phase);
  const energy = spec.audioFast;

  const osc = Math.sin(now * (0.45 + 0.2 * wobble) + spec.phase);
  if (Math.sign(osc) !== spec.oscSign) {
    spec.oscSign = Math.sign(osc);
    spec.flipQueued = true;
  }
  if (spec.flipQueued && energy < 0.18) {
    spec.spinDir = -spec.spinDir;
    spec.flipQueued = false;
  }

  const targetVel = 0.65 * (0.65 + 0.7 * wobble) * (1 + breathe) + spec.spinDir * energy * 2.2;
  spec.spinVel += (targetVel - spec.spinVel) * (dt > 0 ? 1 - Math.exp(-dt / 0.35) : 0);

  const kick = Math.max(0, energy - spec.prevA);
  spec.prevA = energy;
  spec.spinVel += spec.spinDir * Math.min(6 * kick, 1.4) * dt * 14;
  spec.spin += spec.spinVel * dt;
}

// ── GL plumbing ────────────────────────────────────────────────────────────

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[AgentOrb] shader compile failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

// Fullscreen-quad vertex buffer (shared by both programs).
function quadBuffer(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]),
    gl.STATIC_DRAW
  );
  return buf;
}

// ── single-orb renderer ("hero" program: DUAL_LAYER + lens) ───────────────

class OrbRenderer {
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.prog = null;
    this.u = null;
    this.ready = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ready = false;
    });
    canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  init() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, SHADERS.quadVert);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, SHADERS.heroFrag);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUV');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[AgentOrb] hero link failed:', gl.getProgramInfoLog(prog));
      return;
    }

    this.prog = prog;
    this.u = {};
    for (const name of ORB_UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);

    quadBuffer(gl);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    this.ready = true;
  }

  render(spec, px, now) {
    if (!this.ready || !this.prog || !this.u) return false;
    const gl = this.gl;
    const y = this.canvas.height - px;
    gl.useProgram(this.prog);
    gl.viewport(0, y, px, px);
    gl.scissor(0, y, px, px);

    const u = this.u;
    gl.uniform2f(u.uRes, px, px);
    gl.uniform3f(u.uBg, spec.bg[0], spec.bg[1], spec.bg[2]);
    gl.uniform3f(u.uAnchor, spec.anchor[0], spec.anchor[1], spec.anchor[2]);
    gl.uniform3f(u.uC0, ...spec.accents[0]);
    gl.uniform3f(u.uC1, ...spec.accents[1]);
    gl.uniform3f(u.uC2, ...spec.accents[2]);
    gl.uniform1f(u.uTime, now);
    gl.uniform1f(u.uPhase, spec.phase);
    gl.uniform1f(u.uArch, spec.arch);
    gl.uniform1f(u.uLens, spec.lens);
    tickSpec(spec, now);
    gl.uniform1f(u.uAudio, spec.audioSmooth);
    gl.uniform1f(u.uSpin, spec.spin);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}

// ── batched atlas renderer (instanced, for small list orbs) ───────────────

class OrbBatchRenderer {
  constructor(canvas, gl, ext) {
    this.canvas = canvas;
    this.gl = gl;
    this.ext = ext;
    this.prog = null;
    this.uTime = null;
    this.uCanvas = null;
    this.instBuffer = null;
    this.data = new Float32Array(24 * 1024); // 24 floats per instance
    this.ready = false;
    this.init();
  }

  init() {
    const gl = this.gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, SHADERS.instVert);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, SHADERS.batchFrag);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    for (let i = 0; i < 8; i++) {
      const name = i < 2 ? (i === 0 ? 'aPos' : 'aUV') : `i${['Pos', 'Dyn', 'Bg', 'Anc', 'C0b', 'C2'][i - 2]}`;
      gl.bindAttribLocation(prog, i, name);
    }
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[AgentOrb] instanced link failed:', gl.getProgramInfoLog(prog));
      return;
    }

    this.prog = prog;
    this.uTime = gl.getUniformLocation(prog, 'uTime');
    this.uCanvas = gl.getUniformLocation(prog, 'uCanvas');

    quadBuffer(gl);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    this.instBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    for (let t = 0; t < 6; t++) {
      gl.enableVertexAttribArray(2 + t);
      gl.vertexAttribPointer(2 + t, 4, gl.FLOAT, false, 96, 16 * t);
      this.ext.vertexAttribDivisorANGLE(2 + t, 1);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.ready = true;
  }

  writeInstance(idx, x, y, px, spec) {
    const s = this.data;
    const o = 24 * idx;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = px;
    s[o + 3] = spec.spin;
    s[o + 4] = spec.audioSmooth;
    s[o + 5] = spec.phase;
    s[o + 6] = spec.arch;
    s[o + 7] = 0;
    s[o + 8] = spec.bg[0];
    s[o + 9] = spec.bg[1];
    s[o + 10] = spec.bg[2];
    s[o + 11] = spec.anchor[0];
    s[o + 12] = spec.anchor[1];
    s[o + 13] = spec.anchor[2];
    s[o + 14] = spec.accents[0][0];
    s[o + 15] = spec.accents[0][1];
    s[o + 16] = spec.accents[0][2];
    s[o + 17] = spec.accents[1][0];
    s[o + 18] = spec.accents[1][1];
    s[o + 19] = spec.accents[1][2];
    s[o + 20] = spec.accents[2][0];
    s[o + 21] = spec.accents[2][1];
    s[o + 22] = spec.accents[2][2];
    s[o + 23] = 0;
  }

  renderGroup(orbs, tile, now) {
    if (!this.ready || !this.prog) return false;
    const gl = this.gl;
    const cols = Math.max(1, Math.floor(this.canvas.width / tile));
    const perBatch = Math.min(cols * Math.max(1, Math.floor(this.canvas.height / tile)), 1024);

    gl.useProgram(this.prog);
    gl.uniform1f(this.uTime, now);
    gl.uniform2f(this.uCanvas, this.canvas.width, this.canvas.height);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuffer);

    for (let s = 0; s < orbs.length; s += perBatch) {
      const count = Math.min(perBatch, orbs.length - s);
      for (let r = 0; r < count; r++) {
        const orb = orbs[s + r];
        tickSpec(orb.spec, now);
        const col = r % cols;
        const row = Math.floor(r / cols);
        this.writeInstance(r, col * tile, row * tile, tile, orb.spec);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, 24 * count));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, count);
      for (let a = 0; a < count; a++) {
        const orb = orbs[s + a];
        const col = a % cols;
        const row = Math.floor(a / cols);
        orb.ctx.drawImage(this.canvas, col * tile, row * tile, tile, tile, 0, 0, tile, tile);
      }
    }
    return true;
  }
}

// ── the engine: singletons + master rAF loop (bundle fns O/V) ─────────────

class OrbEngine {
  constructor() {
    this.heroRenderer = null;
    this.heroFailed = false;
    this.batchRenderer = null;
    this.batchFailed = false;
    this.orbs = new Map(); // canvas -> { ctx, spec, px, visible, animate, crossfade, booted, rendered }
    this.raf = 0;
    this.frameAt = 0;
    this.clock = 4000 * Math.random(); // per-tab time offset, like the bundle
    this.observer = null;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  ensureHero() {
    if (this.heroRenderer || this.heroFailed) return this.heroRenderer;
    const canvas = document.createElement('canvas');
    canvas.width = MAX_PX;
    canvas.height = MAX_PX;
    const gl = canvas.getContext('webgl', GL_CONTEXT_OPTS);
    if (!gl) {
      this.heroFailed = true;
      return null;
    }
    this.heroRenderer = new OrbRenderer(canvas, gl);
    return this.heroRenderer;
  }

  ensureBatch() {
    if (this.batchRenderer || this.batchFailed) return this.batchRenderer;
    const canvas = document.createElement('canvas');
    canvas.width = BATCH_MAX_PX;
    canvas.height = BATCH_MAX_PX;
    const gl = canvas.getContext('webgl', GL_CONTEXT_OPTS);
    const ext = gl?.getExtension('ANGLE_instanced_arrays') ?? null;
    if (!gl || !ext) {
      this.batchFailed = true;
      return null;
    }
    this.batchRenderer = new OrbBatchRenderer(canvas, gl, ext);
    return this.batchRenderer;
  }

  mount(canvas, spec, px, animate, crossfade) {
    if (this.orbs.has(canvas)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation = 'copy';

    const entry = {
      ctx,
      spec,
      px,
      visible: true,
      animate: animate && !this.reducedMotion,
      crossfade,
      booted: false,
      rendered: false,
    };
    this.orbs.set(canvas, entry);

    this.observer ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const orb = this.orbs.get(e.target);
          if (orb) orb.visible = e.isIntersecting;
        }
      },
      { threshold: 0 }
    );
    this.observer.observe(canvas);

    // One still frame at boot through the hero program (the bundle renders
    // every orb this way exactly once before the loop takes over), then the
    // boot-in animation, then the real loop for animating orbs.
    const hero = this.ensureHero();
    if (hero && hero.render(spec, px, performance.now() / 1000 + this.clock)) {
      ctx.drawImage(hero.canvas, 0, 0, px, px, 0, 0, px, px);
      entry.rendered = true;
      if (crossfade && !entry.booted) {
        entry.booted = true;
        canvas.style.animation = 'orb-boot-in 460ms cubic-bezier(0.2, 0.8, 0.2, 1) both';
      }
    }

    if (!entry.animate) return;
    if (!this.raf) {
      this.frameAt = performance.now();
      this.raf = requestAnimationFrame(() => this.frame());
    }
  }

  unmount(canvas) {
    const entry = this.orbs.get(canvas);
    if (entry) {
      this.observer?.unobserve(canvas);
      this.orbs.delete(canvas);
    }
    if (this.orbs.size === 0 && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  // Single still frame for non-animating orbs.
  renderOnce(entry) {
    const hero = this.ensureHero();
    const batch = this.ensureBatch();
    const now = performance.now() / 1000 + this.clock;
    if (entry.spec.lens > 0 || !batch) {
      if (hero && hero.render(entry.spec, entry.px, now)) {
        entry.ctx.drawImage(hero.canvas, 0, 0, entry.px, entry.px, 0, 0, entry.px, entry.px);
        entry.rendered = true;
      }
    } else {
      batch.renderGroup([entry], entry.px, now);
      entry.rendered = true;
    }
    if (entry.crossfade && entry.rendered && !entry.booted) {
      entry.booted = true;
      entry.canvas.style.animation = 'orb-boot-in 460ms cubic-bezier(0.2, 0.8, 0.2, 1) both';
    }
  }

  frame() {
    this.raf = this.orbs.size > 0 ? requestAnimationFrame(() => this.frame()) : 0;
    const t = performance.now();
    if (t - this.frameAt < FRAME_MS) return;
    this.frameAt = t - ((t - this.frameAt) % FRAME_MS);
    const now = t / 1000 + this.clock;

    const hero = this.ensureHero();
    const batch = this.ensureBatch();
    const grouped = new Map();

    for (const [canvas, entry] of this.orbs) {
      if (!entry.visible) continue;
      if (entry.spec.lens > 0 || !batch) {
        if (hero && hero.render(entry.spec, entry.px, now)) {
          entry.ctx.drawImage(hero.canvas, 0, 0, entry.px, entry.px, 0, 0, entry.px, entry.px);
          entry.rendered = true;
        }
      } else {
        const arr = grouped.get(entry.px) ?? [];
        arr.push(entry);
        grouped.set(entry.px, arr);
      }
      if (entry.crossfade && entry.rendered && !entry.booted) {
        entry.booted = true;
        canvas.style.animation = 'orb-boot-in 460ms cubic-bezier(0.2, 0.8, 0.2, 1) both';
      }
    }

    if (batch) {
      for (const [px, orbs] of grouped) {
        batch.renderGroup(orbs, px, now);
        for (const o of orbs) o.rendered = true;
      }
    }
  }
}

const engine = new OrbEngine();

// ── spec factory (bundle fn G) ─────────────────────────────────────────────

function buildSpec(size, seed, palette, archetype, isDark, dpr) {
  const hash = hashSeed(seed);
  const bg = isDark ? '#000000' : '#FFFFFF';
  return {
    bg: toRGB(bg),
    anchor: toRGB(palette.anchor),
    accents: palette.accents.map(toRGB),
    phase: (hash % 6283) / 1000,
    arch: archetype !== undefined ? ARCH_MAP[archetype] : -1,
    seed,
    lens: 0.4 * (size >= 48 ? 1 : 0),
    audioSmooth: 0,
    audioFast: 0,
    spinDir: 1,
    spinVel: 0,
    prevA: 0,
    flipQueued: false,
    oscSign: 1,
    spin: ((hash % 6283) / 1000) * 3.7,
    lastT: null,
  };
}

function computeRes(size, dpr) {
  const scale = dpr === 'full' || size >= 48 ? Math.min(MAX_DPR, window.devicePixelRatio || 1) : 1;
  return Math.min(MAX_PX, Math.round(size * scale));
}

// ── public component ───────────────────────────────────────────────────────

export const PLACEHOLDER_SRC = 'assets-placeholder-orb.png';

/**
 * Build an orb. Options mirror the site's AgentOrb props:
 *   size        CSS size in px (site: 40 for list orbs, 168 for the voice
 *               carousel, up to 300 for the hero preview)
 *   seed        string that drives phase, palette (if none given) and audio
 *   palette     { anchor, accents: [c0, c1, c2] } hex strings
 *   archetype   'spiral' | 'nebula' | 'core' | 'deep' (default: from seed)
 *   animate     start the animation loop (default true)
 *   crossfade   show the placeholder orb + boot-in animation
 *   dpr         'auto' | 'full' (scales rendering resolution)
 *   chrome      'auto' | 'full' (glass highlight chrome vs. plain ring)
 *   isDark      background color the orb blends toward
 * Returns { element, canvas, destroy }.
 */
export function createOrb({
  size = 46,
  seed = '',
  palette,
  archetype,
  animate = true,
  crossfade = false,
  dpr = 'auto',
  chrome = 'auto',
  isDark = true,
  placeholderSrc = PLACEHOLDER_SRC,
} = {}) {
  const hash = hashSeed(seed);
  const full = chrome === 'full' || size >= 48;
  const resolvedPalette = palette ?? DEFAULT_PALETTES[hash % DEFAULT_PALETTES.length];
  const spec = buildSpec(size, seed, resolvedPalette, archetype, isDark, dpr);
  const px = computeRes(size, dpr);

  const wrapper = document.createElement('div');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.className = 'agent-orb';
  wrapper.style.cssText = `position:relative;display:block;flex-shrink:0;width:${size}px;height:${size}px;`;

  const stage = document.createElement('div');
  if (full) {
    stage.style.cssText =
      'position:absolute;inset:0;border-radius:50%;overflow:hidden;' +
      'clip-path:circle(50% at 50% 50%);-webkit-clip-path:circle(50% at 50% 50%);' +
      'mask-image:radial-gradient(closest-side,#000 calc(100% - 0.5px),transparent);' +
      '-webkit-mask-image:radial-gradient(closest-side,#000 calc(100% - 0.5px),transparent);';
  } else {
    stage.style.cssText =
      'position:absolute;inset:0;border-radius:50%;overflow:hidden;' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18);';
  }

  if (crossfade) {
    const img = document.createElement('img');
    img.src = placeholderSrc;
    img.alt = '';
    img.style.cssText =
      `position:absolute;inset:0;width:${size}px;height:${size}px;display:block;` +
      `filter:hue-rotate(${HUE_TABLE[hash % HUE_TABLE.length] - 255}deg);`;
    stage.appendChild(img);
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'block';
  canvas.width = px;
  canvas.height = px;
  canvas.style.cssText = full
    ? `position:relative;width:${size}px;height:${size}px;` +
      'clip-path:circle(50% at 50% 50%);-webkit-clip-path:circle(50% at 50% 50%);'
    : `position:relative;width:${size}px;height:${size}px;`;
  stage.appendChild(canvas);
  wrapper.appendChild(stage);

  if (full) {
    const shine = document.createElement('div');
    shine.style.cssText =
      'position:absolute;inset:0;border-radius:50%;pointer-events:none;opacity:.35;' +
      `box-shadow:inset 0 1px 1px rgba(255,255,255,0.7),` +
      `inset 0 -1px 1px rgba(255,255,255,0.45),` +
      `inset 0 0 0 1px rgba(255,255,255,0.22),` +
      `inset 0 0 ${(0.06 * size).toFixed(1)}px rgba(255,255,255,0.18);`;
    wrapper.appendChild(shine);
  }

  engine.mount(canvas, spec, px, animate, crossfade);
  return {
    element: wrapper,
    canvas,
    destroy: () => engine.unmount(canvas),
  };
}

// ── debug helpers ────────────────────────────────────────────────────────────
/** Debug helper: current live spec fields for a mounted orb canvas. */
export function orbState(canvas) {
  const entry = engine.orbs.get(canvas);
  if (!entry) return null;
  const s = entry.spec;
  return {
    seed: s.seed,
    phase: s.phase,
    spin: s.spin,
    spinVel: s.spinVel,
    audioSmooth: s.audioSmooth,
    audioFast: s.audioFast,
    lens: s.lens,
    arch: s.arch,
    px: entry.px,
  };
}

/** Debug helper: engine + per-orb live state. */
export function orbDebug() {
  return {
    heroReady: engine.heroRenderer ? engine.heroRenderer.ready : null,
    heroFailed: engine.heroFailed,
    batchReady: engine.batchRenderer ? engine.batchRenderer.ready : null,
    batchFailed: engine.batchFailed,
    raf: !!engine.raf,
    frameAt: engine.frameAt,
    clock: engine.clock,
    count: engine.orbs.size,
    orbs: [...engine.orbs.entries()].map(([c, e]) => ({
      seed: e.spec.seed,
      visible: e.visible,
      animate: e.animate,
      crossfade: e.crossfade,
      px: e.px,
      lens: e.spec.lens,
      spin: e.spec.spin,
      lastT: e.spec.lastT,
      audioSmooth: e.spec.audioSmooth,
      audioFast: e.spec.audioFast,
    })),
  };
}

