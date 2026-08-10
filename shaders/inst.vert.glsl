
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 iPos;  // cellX, cellY, sizePx, spin
attribute vec4 iDyn;  // audio, phase, arch, _
attribute vec4 iBg;   // bg.rgb, anchor.r
attribute vec4 iAnc;  // anchor.gb, c0.rg
attribute vec4 iC0b;  // c0.b, c1.rgb
attribute vec4 iC2;   // c2.rgb, _
uniform vec2 uCanvas; // atlas size in device px
varying vec2 vUV;
varying vec2 uRes;
varying vec3 uBg, uAnchor, uC0, uC1, uC2;
varying float uPhase, uAudio, uSpin, uArch;
void main() {
  vUV = aUV;
  uSpin = iPos.w;
  uAudio = iDyn.x;
  uPhase = iDyn.y;
  uArch = iDyn.z;
  uRes = vec2(iPos.z);
  uBg = iBg.rgb;
  uAnchor = vec3(iBg.a, iAnc.x, iAnc.y);
  uC0 = vec3(iAnc.z, iAnc.w, iC0b.x);
  uC1 = iC0b.yzw;
  uC2 = iC2.xyz;
  vec2 pPx = iPos.xy + aUV * iPos.z;          // top-down px within the cell
  float ndcX = pPx.x / uCanvas.x * 2.0 - 1.0;
  float ndcY = 1.0 - pPx.y / uCanvas.y * 2.0; // flip to GL y-up
  gl_Position = vec4(ndcX, ndcY, 0.0, 1.0);
}