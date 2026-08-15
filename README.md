<div align="center">
  <img width="1200" alt="Banner" src="image.webp" />
</div>


# orb-of-fate

An original, dependency-free WebGL / WGSL study of a glassy star-orb carousel.

## Run it

From this folder, start any static HTTP server. For example:

```powershell
python -m http.server 4173
```

Then open <http://localhost:4173>.

Opening `index.html` directly may work in some browsers, but a local server is the reliable route for module scripts and WebGL/WebGPU testing.

## Render stacks

The app can run either **WebGPU** (single device, one shared pipeline, one
batched submission per frame) or **WebGL 1**. The Renderer control switches
between them and persists the choice; the badge under the stage shows which
stack is live. A WebGPU failure is reported instead of silently changing the
backend.

- `webgpu-engine.js` — batched WebGPU renderer: one dynamic-offset uniform
  buffer shared by every orb, all passes recorded in a single command
  encoder, one queue submission per animation frame.
- `webgpu-shaders.js` — the hero shader ported 1:1 to WGSL (same math as the
  GLSL original; the uniform struct layout is covered by tests).
- `high-quality-shaders.js` — the original WebGL/GLSL hero pass, untouched.
- `orb-spec.js` — per-orb derived state (seed, phase, spin, palette) shared
  by both stacks so they draw the same sky from the same inputs.

The hero fragment shader reconstructs a dual-layer glass sphere,
deterministic galaxy starfields, nebula pockets, Fresnel lighting, and a
refracted back wall. Its in-shader lens evaluates separate RGB offsets at
the rim for the chromatic dispersion effect; the CSS layer only adds a
restrained highlight.

## Compatibility

WebGPU is optional. With no saved preference, the app selects WebGPU only when
the browser exposes `navigator.gpu`; otherwise it starts WebGL 1. The renderer
control lets you switch explicitly and persists the choice. A requested
WebGPU mode that is unavailable, loses its device, or fails validation does
not silently switch back: the badge reports the state and the control lets
you choose WebGL. This keeps Chrome, Edge, Safari, Firefox, mobile, and
insecure-context behavior testable without hiding which backend is active.

No optional WebGPU features are requested, and the shader uses core WGSL
constructs only.

## Adaptive quality

`quality.js` samples per-frame time, smooths it with an EMA, and walks a
resolution ladder: sustained lag drops a rung (down to 50% on weak devices),
sustained headroom climbs back to 100%. Manual modes pin a fixed rung;
compact/coarse-pointer devices start at the 70% rung; compact Auto stays
capped there and can lower only after sustained lag, while desktop Auto adapts
from 100% after the warmup window. Both renderers expose
`setQualityScale()` and `setFidelity()`, so the manager drives either stack
identically.

## Tests

```powershell
node --test "test/*.test.js"   # unit: spec parity, uniform layout, ladder, WGSL sanity
node test/smoke.mjs            # end-to-end: explicit mode + persistence smoke
```

The smoke test spawns its own throwaway headless Chrome (temp profile, never
your real browser), waits for the selected stack, and manually switches to
WebGL when the explicitly requested WebGPU mode is unavailable. Set
`SMOKE_URL` for another port, `CHROME_PATH` for another Chrome.

## Rendering notes

- No Three.js, image textures, build step, or framework is required.
- Each orb is a square canvas with a raw context; the carousel UI is local
  to this folder and the shader source is kept verbatim as inspectable text.
- Aster and Vesper use a subdued star census so their static pinpoints stay
  readable without competing with the animated shooting-light accents.
