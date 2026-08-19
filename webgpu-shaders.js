// webgpu-shaders.js — WGSL port of the hero fragment shader.
//
// Ported 1:1 from high-quality-shaders.js (GLSL ES 1.00): same math, same
// constants, same structure. Notable mechanical differences:
//   * atan(y, x)  -> atan2(y, x)
//   * ternaries   -> select() / if
//   * int loops   -> u32 loops
//   * gl_FragColor -> fs_main return value
//   * uniforms in one struct (layout matches UNIFORM_OFFSETS in webgpu-engine.js)
// DUAL_LAYER is always on (this program only serves hero orbs).

// Star-scale census, shared between the WGSL shader and the JS regression
// tests. Indexed by star scale s (0 = bright/large, 1 = mid, 2 = dense dust).
// These exact values are the GLSL reference from high-quality-shaders.js:
//   sharp  = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0))
//   bright = (s == 0 ? 1.7   : (s == 1 ? 0.9   : 0.5))
export const STAR_SHARP_BY_SCALE = [260.0, 700.0, 1600.0];
export const STAR_BRIGHT_BY_SCALE = [1.7, 0.9, 0.5];

function wgslFloat(value) {
  const text = String(Number(value));
  return text.includes(".") || text.includes("e") || text.includes("E") ? text : `${text}.0`;
}

// Build the WGSL select() chain that mirrors the GLSL ternary above. WGSL's
// select(falseValue, trueValue, condition): the outer select picks s == 0,
// the inner one s == 1, exactly like the nested ternary (s == 2 falls out).
export function wgslSelectByScale(values) {
  const [v0, v1, v2] = values;
  return `select(select(${wgslFloat(v2)}, ${wgslFloat(v1)}, s == 1u), ${wgslFloat(v0)}, s == 0u)`;
}

export const HERO_WGSL = `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) vUV: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var pos = array<vec2f, 3>(vec2f(-1.0, 1.0), vec2f(3.0, 1.0), vec2f(-1.0, -3.0));
  var out: VSOut;
  out.pos = vec4f(pos[vi], 0.0, 1.0);
  out.vUV = uv[vi];
  return out;
}

struct U {
  res: vec2f,
  _p0: vec2f,
  bg: vec3f,
  _p1: f32,
  anchor: vec3f,
  _p2: f32,
  c0: vec3f,
  _p3: f32,
  c1: vec3f,
  _p4: f32,
  c2: vec3f,
  _p5: f32,
  time: f32,
  phase: f32,
  audio: f32,
  spin: f32,
  arch: f32,
  lens: f32,
  starDensity: f32,
  fidelity: f32,
  pitch: f32,
  motion: f32,
};

@group(0) @binding(0) var<uniform> u: U;

fn h1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }

// ── starfield — a real galaxy in a glass sphere: a tilted galactic band
// of dense star-dust and glowing nebula pockets, dark dust lanes cutting
// through it, three scales of twinkling stars, deep-space black behind.
fn starfield(n: vec3f, t: f32) -> vec4f {
  let starDensity = clamp(u.starDensity, 0.0, 1.0);
  let starOpacity = mix(0.34, 1.0, starDensity);
  let lon = atan2(n.z, n.x);
  let lat = asin(clamp(n.y, -1.0, 1.0));

  // per-orb structural variance, derived from the seed phase: every orb gets
  // its own galaxy — band tilt/undulation/width, star density, pocket hues
  let v1 = fract(u.phase * 7.13);
  let v2 = fract(u.phase * 3.71);
  let v3 = fract(u.phase * 5.37);

  // ── galaxy ARCHETYPE: each orb is one of four different skies
  // 0 spiral (milky-way band) · 1 emission nebula (vivid cloud, few stars)
  // 2 galactic core (warm blazing bulge) · 3 deep field (sparse, crystalline)
  let at = select(u.arch, floor(fract(u.phase * 9.73) * 4.0), u.arch < 0.0);
  let isNeb = step(0.5, at) * (1.0 - step(1.5, at));
  let isCore = step(1.5, at) * (1.0 - step(2.5, at));
  let isDeep = step(2.5, at);

  // galactic plane: density concentrates in a band around a tilted equator.
  // lon frequencies MUST be integers: lon wraps at ±π, and a non-integer
  // frequency doesn't tile across that seam — it stamps a hard crease that
  // tumbles into view as the sphere spins.
  let gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
         + 0.12 * sin(lon * 3.0 + t * 0.1);
  var band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = mix(band, max(band, 0.8), isNeb); // nebula: cloud fills the whole sky
  band *= 1.0 - 0.85 * isDeep; // deep field: nearly empty void

  // nebula: two octaves of warped wisps, glowing pockets along the band
  let n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  let n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  let neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  // dark dust lanes carved through the bright band
  let lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  var galaxy = band * neb * (1.0 - lane * (0.55 + 0.35 * v2));
  let w0g = clamp(galaxy, 0.0, 1.0); // ensure the band registers in alpha
  galaxy = w0g;
  // Milky-Way dust: mostly cool blue-white star haze, the palette only as a
  // faint cast — real galaxies are desaturated except the warm core
  // per-orb color identity: how strongly (and with which accents) the dust is
  // tinted varies orb to orb — some stay silver-blue, others go violet/amber
  var hue = mix(mix(u.c0, u.c1, v1), mix(u.c1, u.c2, v3), 0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2));
  // saturation push: keep the dust hue vivid even after all the mixing
  let hueGrey = vec3f(dot(hue, vec3f(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, vec3f(0.0), vec3f(1.0));
  // the palette carries each agent's identity — dust leans firmly into it
  // (different agents on one screen read as different colored skies)
  let dust = mix(vec3f(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);
  var col = dust * galaxy * (0.6 + 0.9 * isNeb);
  // rotation streaks: faint orbital shear lines inside the band, drifting —
  // the galaxy visibly *turns*
  let shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * 0.14;
  // a second, fainter dust arm crossing the main band — spiral-galaxy depth
  let gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  let arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += mix(dust, u.c1, 0.35) * arm * 0.2;
  // the void itself is never pure black: a whisper of deep indigo that
  // breathes — the "magic" ambient of a long-exposure sky
  // the void itself carries the agent's hue — the strongest identity cue,
  // since it covers the whole sphere
  let voidGlow = mix(vec3f(0.04, 0.03, 0.1), mix(u.c0, mix(u.c1, u.c2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);
  // warm amber core glow deep in the band
  col += vec3f(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * 0.4;
  // galactic-core archetype: a blazing warm bulge with a halo of star-fog,
  // fixed to the rotating sphere so it wheels around as the galaxy turns
  let ca = v2 * 6.28318;
  let Cdir = normalize(vec3f(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  let bulge = max(dot(n, Cdir), 0.0);
  col += mix(vec3f(1.0, 0.85, 0.6), u.c2, 0.25) * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;
  // nebula pockets, two layers in different hues: hot spots of saturated
  // palette color glowing in the dust, slowly breathing
  let pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * 0.6 + lon * 3.0));
  col += mix(u.c2, u.c0, fract(v1 + 0.5 * sin(lon * 2.0) + 0.5)) * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb);
  let pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += mix(u.c1, u.c2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb);
  // Detail factor by orb size (1 = large): small list orbs keep faded bright stars but drop the grain
  // and most of the dense faint dust — those are what read as granular noise / alias at list sizes.
  let detail = smoothstep(90.0, 200.0, u.res.y) * u.fidelity;
  // milky grain: ultra-fine star dust packed into the band — the granular
  // texture that says "Milky Way" in long-exposure shots
  let gg = vec2f(lon, lat) * 34.0;
  let gc = floor(gg);
  let gf = fract(gg);
  let gh = h1(gc.x * 3.7 + gc.y * 11.3);
  let gp = vec2f(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  let gd = length((gf - gp) * vec2f(cos(lat), 1.0));
  let grain = exp(-gd * gd * 700.0 * clamp(u.res.y / 420.0, 0.22, 1.0)) * step(0.3, gh) * (0.15 + 0.85 * band);
  col += vec3f(0.88, 0.9, 1.0) * grain * 0.4 * detail * mix(0.2, 1.0, starDensity);
  var w = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);

  // three star scales: a few bright, many mid, dense faint dust (denser in band)
  for (var s: u32 = 0u; s < 3u; s += 1u) {
    let K = select(select(19.0, 11.0, s == 1u), 6.0, s == 0u);
    let g = vec2f(lon, lat) * K;
    let cell = floor(g);
    let f = fract(g);
    let hx = h1(cell.x * 13.7 + cell.y * 7.3 + f32(s) * 91.0);
    let hy = h1(cell.x * 5.1 + cell.y * 17.9 + f32(s) * 37.0);
    let sp = vec2f(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    let d = length((f - sp) * vec2f(cos(lat), 1.0));
    // archetype star census: nebulae are star-poor, cores star-rich,
    // deep fields sparse but every star counts
    let census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    let densityLift = (1.0 - starDensity) * select(0.22, 0.34, s == 2u);
    let keep = step(select(0.55, 0.3, s == 2u) + census + densityLift, h1(hx * 89.0 + hy * 31.0) + band * 0.25);
    // small orbs: stars must stay >= ~1px and twinkle gently, or they alias
    // into flicker as the sphere tumbles
    let resFac = clamp(u.res.y / 420.0, 0.22, 1.0);
    let tw = mix(0.92, 0.6 + 0.4 * sin(t * (1.5 + 3.0 * hx) + hx * 40.0), resFac);
    // per-star size: each star draws its own radius from the hash (4x range),
    // and brightness follows size — a real magnitude distribution
    let hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    let sizeJit = 0.35 + 1.8 * hz * hz; // few big, many small
    let sharp = ${wgslSelectByScale(STAR_SHARP_BY_SCALE)} / sizeJit * resFac;
    let star = exp(-d * d * sharp) * keep * tw;
    // near-white stars with the faintest temperature variation, like the sky
    let tintSel = select(
      select(mix(vec3f(1.0), u.c1, 0.3), vec3f(1.0, 0.95, 0.85), hx < 0.66),
      vec3f(0.85, 0.9, 1.0),
      hx < 0.33
    );
    let tint = mix(vec3f(1.0), tintSel, 0.6);
    let bright = ${wgslSelectByScale(STAR_BRIGHT_BY_SCALE)} * (0.55 + 0.7 * sizeJit);
    // small orbs: keep the bright/mid stars (just faded), but drop most of the dense faint dust (s==2)
    // and the grain — those are what read as granular noise at list sizes.
    let starFade = mix(select(0.45, 0.14, s == 2u), 1.0, detail);
    col += tint * star * bright * starFade * starOpacity;
    // the biggest stars get a soft halo bloom + diffraction-cross sparkle
    if (s == 0u) {
      let big = smoothstep(1.2, 2.0, sizeJit);
      col += tint * exp(-d * d * 60.0) * 0.18 * big * tw * starFade * starOpacity;
      let dd = (f - sp) * vec2f(cos(lat), 1.0);
      let spike = exp(-dd.x * dd.x * 1200.0) * exp(-dd.y * dd.y * 26.0)
                + exp(-dd.y * dd.y * 1200.0) * exp(-dd.x * dd.x * 26.0);
      col += tint * spike * 0.3 * big * tw * starFade * starOpacity;
      w = max(w, spike * 0.3 * big * starFade * starOpacity);
    }
    w = max(w, star * min(bright, 1.5) * starFade * starOpacity);
  }

  // pulsar: one bright star per orb that flashes rhythmically with a halo —
  // audio pushes its beat brighter and faster
  let pa = v1 * 6.28318;
  let P = normalize(vec3f(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  let pd = max(dot(n, P), 0.0);
  var beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3 + 1.5 * u.audio) + v3 * 6.28), 8.0);
  beat = min(1.0, beat + 0.6 * u.audio);
  let pulsarFade = mix(0.45, 1.0, detail);
  col += vec3f(0.9, 0.95, 1.0) * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  w = max(w, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);

  return vec4f(min(col, vec3f(1.0)), min(w, 1.0));
}

// Sample the rotating sphere at 3D point n (unit sphere). The ball TUMBLES:
// it spins around a tilted axis while that axis itself slowly precesses and
// the whole ball rolls — rotation on multiple axes, like a marble turned in
// the hand, so the pattern travels over the poles too, not just sideways.
fn sphereAt(n0: vec3f, spin: f32, t: f32) -> vec4f {
  var n = n0;
  let roll = t * 0.13 * u.motion; // roll around the view axis
  let cr = cos(roll);
  let sr = sin(roll);
  n = vec3f(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);
  let tilt = (0.45 + 0.35 * sin(t * 0.24)) * u.motion; // precessing axis
  let cx = cos(tilt);
  let sx = sin(tilt);
  n = vec3f(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);
  let cs = cos(spin);
  let ss = sin(spin);
  n = vec3f(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);
  let cp = cos(u.pitch);
  let sp = sin(u.pitch);
  n = vec3f(n.x, cp * n.y - sp * n.z, sp * n.y + cp * n.z);
  return starfield(n, t);
}

// The whole orb as a pure function of the (pre-lens) screen point p — the
// in-shader lens re-evaluates this at displaced coordinates per RGB channel.
fn shade(p: vec2f) -> vec3f {
  let r = length(p);
  // DUAL_LAYER is always defined in this program (hero only), so the square
  // corners are painted with overscan like the original hero pass.
  let t = u.time * 0.8 + u.phase;

  // sphere geometry
  let rr = min(r, 0.9995);
  let z = sqrt(1.0 - rr * rr);
  let N = vec3f(p.x, p.y, z);
  let fres = pow(1.0 - z, 2.4); // 0 center -> 1 at the limb

  // Front hemisphere point is N itself; the see-through far wall is hit by
  // the refracted ray continuing through the glass to the back of the ball.
  let I = vec3f(0.0, 0.0, -1.0);
  let R = refract(I, N, 0.75);
  // exit point of the ray on the back of the unit sphere
  let dHit = -2.0 * dot(N, R);
  let B = normalize(N + R * dHit);

  // both layers live on the SAME rotating sphere — the front face and the
  // far wall seen through the glass — so the whole ball reads as one object
  // spinning, with the back side counter-sliding in true perspective.
  // organic motion: the spin angle is integrated on the CPU (uSpin) so the
  // rotation can accelerate, ease, and reverse smoothly — especially under
  // audio. Pattern time keeps its own gentle warp for non-linear drift.
  let sv = fract(u.phase * 6.31);
  let sw = fract(u.phase * 2.17);
  let tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);
  let front = sphereAt(N, u.spin, tWarp);
  // The back-wall galaxy sample doubles fragment cost; only the hero (single-orb)
  // program keeps it. Batched list orbs skip it (invisible at small sizes).
  let back = sphereAt(B, u.spin, tWarp * 0.8 + 2.7);

  // glass body: deep-space glass — near-black void with the anchor color
  // breathing at the rim; just enough page light leaks through the edge
  // to keep it reading as glass rather than a flat black disc
  let voidCol = mix(u.anchor * 0.04, u.anchor * 0.35, fres);
  var col = mix(u.bg, voidCol, 0.97 - 0.04 * fres);
  // mix (not add): the band REPLACES the glass color where it lives, so it
  // reads on light pages instead of clipping to white
  let fa = clamp(front.a, 0.0, 1.0);
  let ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba * 0.16); // far-wall echo
  col = mix(col, front.rgb, fa * 0.85);
  {
    // ── aurora borealis, voice as light — drawn in VIEW space so the
    // curtains always hang in the visible upper sky (the galaxy tumbles
    // behind them). Amplitude undulates like speech; fine rays shimmer
    // through; classic green at the base climbing into violet.
    let alon = atan2(N.x, N.z);
    let speech = pow(0.5 + 0.5 * sin(alon * 3.0 + sin(alon * 7.0 + t * 1.1) * 0.7 + t * 0.5), 3.0)
               * (0.55 + 0.45 * sin(alon * 5.0 - t * 0.65 + 1.7));
    let sky = -N.y; // canvas blit flips Y: -N.y is the visible upper sky
    let hang = smoothstep(-0.15, 0.5, sky);
    let rays = 0.7 + 0.3 * sin(alon * 24.0 + sin(alon * 9.0 - t * 0.8) * 2.0 + t * 1.6);
    // audio: the voice IS the aurora — curtains surge with live amplitude
    let aur = clamp(speech, 0.0, 1.0) * hang * rays * (1.0 + 2.2 * u.audio);
    // per-orb aurora character: some classic green→violet, others lean into
    // the palette (teal→pink, blue→gold…)
    let av = fract(u.phase * 2.93);
    let aurCol = mix(vec3f(0.12, 0.95, 0.55), vec3f(0.45, 0.35, 1.0),
                     smoothstep(0.0, 0.95, sky + 0.35 * speech));
    let aurCol2 = mix(aurCol, mix(u.c0, u.c2, av), 0.15 + 0.4 * av);
    col += aurCol2 * aur * 0.8;

    // shooting star: every ~6s a meteor streaks across a random trajectory,
    // white-hot head with an exponentially fading tail
    let met = 4.5 + 3.5 * fract(u.phase * 4.91); // per-orb meteor cadence
    let epoch = floor(t / met);
    let ph = fract(t / met);
    let s0 = vec2f(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
    let sd = normalize(vec2f(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
    let head = s0 + sd * ph * 2.8;
    let rel = p - head;
    let along = dot(rel, sd);
    let perp = dot(rel, vec2f(-sd.y, sd.x));
    let vis = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.32, ph);
    let tail = exp(-perp * perp * 1600.0) * exp(along * 9.0) * step(along, 0.0)
             * smoothstep(-0.5, -0.02, along);
    let headGlow = exp(-dot(rel, rel) * 900.0);
    col += (vec3f(1.0) * headGlow * 1.2 + mix(vec3f(1.0), u.c1, 0.3) * tail * 0.85) * vis;

    // moving illumination: a broad diffuse gradient (a soft terminator)
    // sweeps around the sphere, brightening whole regions of sky and dust in
    // turn — this is what makes the ball feel LIT, not printed
    let LD = normalize(vec3f(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
    var diffuse = 0.62 + 0.65 * max(dot(N, LD), 0.0);
    // audio: the whole sky brightens and breathes with the voice
    diffuse *= 1.0 + 0.35 * u.audio;
    col *= diffuse;
    // ── voice light: while speaking, a warm core flare wakes deep in the
    // sphere and the rim catches the agent's color — the orb visibly *emits*
    let voiceCol = mix(u.c1, vec3f(1.0, 0.97, 0.9), 0.45);
    col += voiceCol * pow(1.0 - rr, 1.8) * u.audio * 0.5; // inner flare
    col += (u.c1 * 0.7 + vec3f(0.12)) * fres * u.audio * 0.65; // rim ignition
    // sparkle excitement: stars glitter harder while the voice is live
    col += col * u.audio * 0.18 * sin(t * 14.0 + rr * 40.0 + u.phase * 7.0);
    // counter-rim: a faint atmospheric glow opposite the moving light
    let counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
    col += mix(u.c0, vec3f(0.5, 0.6, 0.9), 0.5) * counter * 0.18;
  }

  // 3D lighting off the sphere normal — the key light DRIFTS slowly (like a
  // light source moving in the room) and breathes in intensity, so the glass
  // never feels statically lit
  let L1 = normalize(vec3f(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  let keyAmp = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  col += vec3f(1.0) * pow(max(dot(N, L1), 0.0), 150.0) * keyAmp;
  // broad soft sheen sweeping across the dome on a long period
  let LS = normalize(vec3f(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += vec3f(1.0) * pow(max(dot(N, LS), 0.0), 7.0) * 0.05;
  let L2 = normalize(vec3f(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69)); // counter glint
  col += vec3f(1.0) * pow(max(dot(N, L2), 0.0), 140.0) * 0.25;
  // fresnel rim — a bubble's edge catches a touch of the band's color
  col = mix(col, front.rgb, fa * fres * 0.3);
  // whisper of limb compression
  let limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col * 0.85, limb * 0.4);

  return col;
}

@fragment
fn fs_main(@location(0) vUV: vec2f) -> @location(0) vec4f {
  let p = vUV * 2.0 - 1.0;
  if (u.lens > 0.0) {
    let r = length(p);
    // erf edge falloff: 0 inside, 1 at the silhouette (erf ≈ tanh(1.7725x),
    // expanded — GLSL ES 1.00 has no tanh); band starts at 1 - depth
    // (depth = 0.1), scale = 1/(depth·√2)
    let ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
    let fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);
    if (fall > 0.004) {
      // swell: same incommensurate sines the SVG loop animated, so the rim
      // compression re-spikes and the chroma fringe shimmers — free here
      let swell = 1.0 + 0.16 * (0.6 * sin(u.time * 0.9 + u.phase)
                              + 0.4 * sin(u.time * 1.7 + u.phase * 1.3));
      let k = u.lens * fall * swell;
      // per-channel displacement (chromaAmount 2 → R ×1.4, G ×1.2, B ×1.0),
      // each with its own slow shimmer (the old per-channel chan factor)
      let cR = 1.4 * (1.0 + 0.06 * sin(u.time * 1.3 + u.phase));
      let cG = 1.2 * (1.0 + 0.06 * sin(u.time * 1.3 + u.phase + 2.1));
      let cB = 1.0 * (1.0 + 0.06 * sin(u.time * 1.3 + u.phase + 4.2));
      var col = vec3f(shade(p * (1.0 - k * cR)).r,
                      shade(p * (1.0 - k * cG)).g,
                      shade(p * (1.0 - k * cB)).b);
      // specular pass (the map's B channel): glow lobes at ±40° fading in at
      // the rim, plus hard catchlights right at the silhouette edge
      let a2 = min(abs(p), vec2f(1.0));
      let lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
      let glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
      let glow2 = 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
      col += vec3f(0.25) * min(glow + glow2, 1.0);
      return vec4f(col, 1.0);
    }
  }
  return vec4f(shade(p), 1.0);
}
`;
