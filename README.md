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

The app tries **WebGPU first** (single device, one shared pipeline, one
batched submission per frame) and falls back to **WebGL 1** if WebGPU is
unavailable — on unsupported browsers, low-end devices, or after a device
loss mid-session. The badge under the stage shows which stack is live.

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

WebGPU is opportunistic, not required. The app uses it only when the browser
exposes `navigator.gpu`, an adapter and device arrive within the bounded init
window, and the WGSL pipeline validates successfully. Chrome, Edge, Safari,
and Firefox implementations that do not meet those conditions automatically
use the WebGL 1 renderer instead, including mobile and insecure-context cases.

The same fallback also runs after a WebGPU device loss or uncaptured GPU
validation error. No optional WebGPU features are requested, and the shader
uses core WGSL constructs only.

## Adaptive quality

`quality.js` samples per-frame time, smooths it with an EMA, and walks a
resolution ladder: sustained lag drops a rung (down to 50% on weak devices),
sustained headroom climbs back to 100%. Manual modes pin a fixed rung;
compact/coarse-pointer devices start one rung lower. Both renderers expose
`setQualityScale()` and `setFidelity()`, so the manager drives either stack
identically.

## Tests

```powershell
node --test "test/*.test.js"   # unit: spec parity, uniform layout, ladder, WGSL sanity
node test/smoke.mjs            # end-to-end: real headless Chrome, badge online
```

The smoke test spawns its own throwaway headless Chrome (temp profile, never
your real browser) and polls until either the WebGPU or the WebGL stack
comes online. Set `SMOKE_URL` for another port, `CHROME_PATH` for another
Chrome.

## Rendering notes

- No Three.js, image textures, build step, or framework is required.
- Each orb is a square canvas with a raw context; the carousel UI is local
  to this folder and the shader source is kept verbatim as inspectable text.
- Aster and Vesper use a subdued star census so their static pinpoints stay
  readable without competing with the animated shooting-light accents.
