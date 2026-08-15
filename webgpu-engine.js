// webgpu-engine.js — WebGPU renderer for orb-of-fate.
//
// Architecture:
//   * one device for the whole page, one shared pipeline (batched)
//   * every orb renders into its own canvas context, all render passes share
//     a single command encoder and one submission per frame
//   * uniforms live in one big dynamic-offset buffer: switching orbs is just
//     a dynamic offset change, no pipeline/bind-group churn
//   * WebGPUOrbRenderer mirrors the WebGL OrbRenderer interface so main.js
//     treats both pools identically
//
// Feature detection:
//   initWebGPU() returns an engine or null; callers fall back to WebGL.

import { buildOrbSpec, specFromSeed } from "./orb-spec.js";
import { HERO_WGSL } from "./webgpu-shaders.js";

export const UNIFORM_SLOT_ALIGN = 256; // dynamic offsets must align to device limit (usually 256)
export const UNIFORM_BYTES = 128;

// Uniform layout — WGSL struct in webgpu-shaders.js must match this exactly.
// Offsets (std140-style):
//   0  uRes       vec2f
//   16 uBg        vec3f
//   32 uAnchor    vec3f
//   48 uC0        vec3f
//   64 uC1        vec3f
//   80 uC2        vec3f
//   96 uTime      f32
//   100 uPhase    f32
//   104 uAudio    f32
//   108 uSpin     f32
//   112 uArch     f32
//   116 uLens     f32
//   120 uStarDensity f32
//   124 uFidelity f32
export const UNIFORM_OFFSETS = {
  res: 0,
  bg: 16,
  anchor: 32,
  c0: 48,
  c1: 64,
  c2: 80,
  time: 96,
  phase: 100,
  audio: 104,
  spin: 108,
  arch: 112,
  lens: 116,
  starDensity: 120,
  fidelity: 124
};

export function writeUniforms(view, offsets, values) {
  view.set([values.res[0], values.res[1]], offsets.res / 4);
  view.set(values.bg, offsets.bg / 4);
  view.set(values.anchor, offsets.anchor / 4);
  view.set(values.c0, offsets.c0 / 4);
  view.set(values.c1, offsets.c1 / 4);
  view.set(values.c2, offsets.c2 / 4);
  view[offsets.time / 4] = values.time;
  view[offsets.phase / 4] = values.phase;
  view[offsets.audio / 4] = values.audio;
  view[offsets.spin / 4] = values.spin;
  view[offsets.arch / 4] = values.arch;
  view[offsets.lens / 4] = values.lens;
  view[offsets.starDensity / 4] = values.starDensity;
  view[offsets.fidelity / 4] = values.fidelity;
}

export class WebGPUEngine {
  constructor(device, format) {
    this.device = device;
    this.format = format;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.uniformBuffer = null;
    this.uniformData = null;
    this.slotCount = 0;
    this.frameEncoder = null;
    this.failed = false;
    this.renderPasses = 0; // frames * passes, for the debug badge / smoke tests

    device.lost.then((info) => {
      this.failed = true;
      console.warn("WebGPU device lost:", info.message);
    });

    this.uniformData = new Float32Array(8 * (UNIFORM_SLOT_ALIGN / 4)); // 8 slots max
    this.uniformBuffer = device.createBuffer({
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  getUniformView(slot) {
    return new Float32Array(
      this.uniformData.buffer,
      this.uniformData.byteOffset + slot * UNIFORM_SLOT_ALIGN,
      UNIFORM_BYTES / 4
    );
  }

  flushUniforms() {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
  }

  async initialize() {
    const shaderSource = await this.buildShaderSource();
    const shaderModule = this.device.createShaderModule({ code: shaderSource });
    if (shaderModule.getCompilationInfo) {
      const info = await shaderModule.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === "error");
      if (errors.length > 0) {
        throw new Error(
          "WGSL compilation failed:\n" +
            errors.map((message) => `  ${message.lineNum}:${message.linePos} ${message.message}`).join("\n")
        );
      }
    }

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true }
      }]
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout]
      }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" }
    });

    this.slotCount = Math.floor(this.uniformData.length / (UNIFORM_SLOT_ALIGN / 4));
  }

  async buildShaderSource() {
    return HERO_WGSL;
  }

  // Batch: one encoder per frame, shared by every visible orb render pass,
  // submitted once. Returns the same encoder until endFrame().
  encoder() {
    if (!this.frameEncoder) {
      this.frameEncoder = this.device.createCommandEncoder();
    }
    return this.frameEncoder;
  }

  endFrame() {
    if (!this.frameEncoder) return;
    this.device.queue.submit([this.frameEncoder.finish()]);
    this.frameEncoder = null;
  }

  destroy() {
    this.failed = true;
    this.frameEncoder = null;
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.pipeline) this.pipeline = null;
    if (this.bindGroupLayout) this.bindGroupLayout = null;
  }
}

export async function initWebGPU() {
  if (!navigator.gpu) return null;
  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    return null;
  }
  if (!adapter) return null;
  let device;
  try {
    device = await adapter.requestDevice();
  } catch {
    return null;
  }
  if (!device) return null;
  return new WebGPUEngine(device, navigator.gpu.getPreferredCanvasFormat());
}

export class WebGPUOrbRenderer {
  constructor(engine, canvas, data, index) {
    this.engine = engine;
    this.canvas = canvas;
    this.ctx = canvas.getContext("webgpu");
    if (!this.ctx) {
      throw new Error("WebGPU canvas context unavailable.");
    }
    this.ctx.configure({
      device: engine.device,
      format: engine.format,
      alphaMode: "opaque"
    });
    this.slot = index % engine.slotCount;
    this.data = data;
    this.index = index;
    this.seed = 0;
    this.phase = 0;
    this.spin = 0;
    this.audio = 0;
    this.starDensity = 1;
    this.accentA = [0, 0, 0];
    this.accentB = [0, 0, 0];
    this.accentC = [0, 0, 0];
    this.anchor = [0, 0, 0];
    this.qualityScale = 1;
    this.fidelity = 1;
    this.visible = true;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.bindGroup = null;
  }

  setOrb(data, index) {
    this.data = data;
    this.index = index;
    const spec = buildOrbSpec(data, index);
    this.seed = spec.seed;
    this.phase = spec.phase;
    this.spin = spec.spin;
    this.starDensity = spec.starDensity;
    this.accentA = spec.accentA;
    this.accentB = spec.accentB;
    this.accentC = spec.accentC;
    this.anchor = spec.anchor;
    this.audio = 0;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.bindGroup = null;
  }

  setSeed(seed) {
    this.seed = seed;
    const motion = specFromSeed(this.data, seed);
    this.phase = motion.phase;
    this.spin = motion.spin;
  }

  setSelected(isSelected) {
    this.audio = isSelected ? 0.035 : 0;
  }

  setVisible(isVisible) {
    this.visible = isVisible;
  }

  setQualityScale(scale) {
    this.qualityScale = scale;
    this.lastWidth = 0;
    this.lastHeight = 0;
  }

  setFidelity(value) {
    this.fidelity = value;
  }

  resize() {
    const isCompact = this.engine.compactQuery?.matches ?? false;
    const maxPixelRatio = isCompact ? (this.engine.compactMaxDpr ?? 1.25) : 1.75;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio) * this.qualityScale;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.lastWidth = width;
    this.lastHeight = height;
  }

  render(time) {
    if (!this.visible) return false;
    this.resize();

    const engine = this.engine;
    const view = engine.getUniformView(this.slot);
    writeUniforms(view, UNIFORM_OFFSETS, {
      res: [this.canvas.width, this.canvas.height],
      bg: [0, 0, 0],
      anchor: this.anchor,
      c0: this.accentA,
      c1: this.accentB,
      c2: this.accentC,
      time: time,
      phase: this.phase,
      audio: this.audio,
      spin: this.spin + time * 0.08,
      arch: -1,
      lens: 0.4,
      starDensity: this.starDensity,
      fidelity: this.fidelity
    });
    engine.flushUniforms();

    if (!this.bindGroup) {
      this.bindGroup = engine.device.createBindGroup({
        layout: engine.bindGroupLayout,
        entries: [{
          binding: 0,
          resource: { buffer: engine.uniformBuffer, size: UNIFORM_BYTES }
        }]
      });
    }

    const encoder = engine.encoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store"
      }]
    });
    pass.setPipeline(engine.pipeline);
    pass.setBindGroup(0, this.bindGroup, [this.slot * UNIFORM_SLOT_ALIGN]);
    pass.draw(3);
    pass.end();

    engine.renderPasses += 1;
    return true;
  }
}