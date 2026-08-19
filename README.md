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
batched submission per frame) or **WebGL**. The WebGL path requests **WebGL 2**
first and falls back to **WebGL 1**, then `experimental-webgl`; the GLSL ES 1.00
shader source runs unchanged on either context family. The Renderer control
switches between the stacks and persists the choice; the badge under the stage
shows which stack is live, including the WebGL 2 vs WebGL 1 family. A WebGPU
failure is reported instead of silently changing the backend.

WebGL 2 is a capability and diagnostics improvement — the context is created
WebGL 2-first when the browser supports it, and the badge and
`window.__orbDebug().stack` report `webgl2` vs `webgl` — but it is **not a
guaranteed FPS improvement**: both families execute the identical GLSL ES 1.00
fragment pass.

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

WebGPU is optional. With no explicit saved preference, compact/mobile devices
start on WebGL for compatibility and GPU budget; larger devices select
WebGPU only when the browser exposes `navigator.gpu` in a secure context.
Stock Firefox for Android does not expose `navigator.gpu`, so it always runs
the WebGL renderer: a stored or toggled WebGPU choice there is reported as
unsupported and WebGL remains active (the stored preference is preserved for
browsers that do support WebGPU). WebGPU also requires browser support plus a
secure context (`https:` or `localhost`). The renderer control lets you switch
explicitly and persists that choice. A requested WebGPU mode that is
unavailable, loses its device, or fails validation does not silently switch
back: the badge reports the state and the control lets you choose WebGL. This
keeps Chrome, Edge, Safari, Firefox, mobile, and insecure-context behavior
testable without hiding which backend is active.

No optional WebGPU features are requested, and the shader uses core WGSL
constructs only.

## Adaptive quality

`quality.js` samples per-frame time, smooths it with an EMA, and walks a
resolution ladder: sustained lag drops a rung (down to 50% on weak devices),
sustained headroom climbs back to 100%. Manual modes pin a fixed rung;
compact/coarse-pointer devices start at the 70% rung; compact Auto stays
capped there and can lower only after sustained lag, while desktop Auto adapts
from 100% after the warmup window. Both renderers expose
`setQualityScale()`, `setDisplayScale()`, `setFidelity()`, and `setLens()`, so
the manager drives either stack identically.

Side cards are CSS-scaled by the carousel (`1` / `.62` / `.36`), so each
assigned renderer also receives a matching **display scale** for its backing
store: `1` for the center orb, `.62` for the near cards, and a floor of `.5`
for the furthest visible cards. Off-hero orbs therefore never render at full
hero pixel resolution, and both backends re-measure their backing store only
when the display scale, window, or quality actually changes.

The Render controls panel also offers `Auto`, `30`, `20`, and `15 FPS`. FPS
caps preserve shader appearance and reduce work by rendering fewer frames:
capped modes skip intermediate animation frames while absolute time keeps
advancing, and the auto ladder's ceiling drops to the 70% rung so adaptive
headroom cannot climb back while the cap is active (manual resolution modes
stay authoritative). They never change the shader — the chromatic lens, rim,
and specular passes render identically at every FPS setting; **Fidelity Lite**
remains the explicit visual-quality tradeoff. Because the cap is enforced
inside the `requestAnimationFrame` callback, the achieved frame rate is
approximate on displays whose refresh rate is not an exact multiple of the
selected FPS.

## Lens

The hero fragment shader evaluates a chromatic lens near the rim (`uLens`,
default `0.4`) by sampling separate RGB offsets for the dispersion effect. The
**Lens** control (`#lens-setting`, values `on` / `off`, default `on`) toggles
it on both stacks: `on` sets `uLens` to `0.4`, `off` sets it to `0`. Disabling
the lens is an explicit, user-visible visual-quality tradeoff intended for A/B
performance comparisons — losing the chromatic edge is expected, and the
setting never interacts with FPS caps, which gate render frequency only.

## Interactive motion

The **Interactive motion** toggle (`#interactive-motion`, default off) opts into
pointer- and gyroscope-driven orb rotation. When unchecked, the default
animation and visuals are unchanged; when checked:

- **Desktop**: pointer movement over `.orb-stage` influences the orb's spin.
  Horizontal position is the primary axis (±0.6 radians); vertical position
  adds a small contribution (±0.06 radians).
- **Mobile**: device orientation maps gamma/beta into independent screen axes.
  Left/right tilt controls horizontal spin, while forward/back tilt controls a
  visible up/down pitch. A neutral baseline is captured on enable, and the
  mapping follows portrait or landscape screen orientation.
- **iOS Safari**: `DeviceOrientationEvent.requestPermission()` is requested
  from the checkbox user gesture. If permission is denied or the API is
  unavailable, the toggle remains checked but the hint updates to indicate
  pointer-only controls.
- **Firefox/Chrome Android**: no permission request is needed; gyroscope
  access is immediate.

The interaction offset is smoothly interpolated per frame and added to the
existing `uSpin` uniform. Interactive mode disables only the autonomous sphere
spin; the shared shader clock keeps running, so shooting stars, shimmer, and
aurora motion continue. The renderers carry compact pitch and motion uniforms
for the two-axis sphere orientation. Listeners are registered only while the
mode is active, and the offset decays cleanly to zero when disabled.

Pointer and tilt drive yaw and pitch inside the sphere shaders, rather than
tilting the canvas. The galaxy therefore moves over the orb surface like a real
ball in both directions. Autonomous roll and precession stop in interactive
mode while independent visual effects continue from the shared shader clock.

`window.__orbDebug().interaction` exposes the current enabled state, input
source, target/current offsets, and permission status.

## Debug / performance overlay

Append `?debug=1` to the URL, or check **Debug** (`#debug-setting`) in the
render settings panel, to enable the performance overlay (`#perfDebugPanel`
with its `#perfDebugOutput` `<pre>`). While enabled the overlay refreshes at
most 4 times per second from `window.__orbDebug()` and shows the actual stack,
FPS mode and interval, adaptive quality/EMA, lens state, the renderer count
with per-orb display scales and canvas sizes, and WebGPU submission data when
available. While disabled no timer runs and the frame/render hot paths contain
no debug work.

## Tests

```powershell
node --test "test/*.test.js"   # unit: spec parity, uniform layout, ladder, WGSL sanity, WebGL2/display-scale/lens/debug wiring
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
