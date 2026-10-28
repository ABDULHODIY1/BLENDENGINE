/* SPDX-License-Identifier: GPL-2.0-or-later
 *
 * BlendEngine Runtime
 *
 * Standalone, dependency-free WebGL2 game runtime for scenes exported by the
 * BlendEngine add-on (scene_export.py). Runs in desktop browsers, Android
 * WebView and iOS WKWebView.
 *
 *   Rendering : physically based shading (GGX), sun with soft PCF shadow map,
 *               point/spot lights, procedural sky + image-free ambient,
 *               height fog, HDR pipeline with bloom, SSAO, ACES tone mapping,
 *               FXAA and dynamic resolution.
 *   Physics   : static triangle world in a spatial hash, swept character
 *               controller (slopes, steps, ground snapping), ray casts,
 *               sphere-approximated rigid bodies, door colliders.
 *   Gameplay  : player controllers (first/third person, top-down, side
 *               scroller, flying, vehicle), NPC AI templates, health, weapons,
 *               triggers, the no-code behavior system (events, conditions,
 *               actions), pickups, checkpoints, win/lose flow.
 *   Platform  : keyboard + mouse (pointer lock), gamepads, touch controls,
 *               procedural WebAudio sound effects, scripting hooks.
 *
 * Coordinates are Blender's: Z up, right handed, metres.
 */
(function () {
  'use strict';

  // ===========================================================================
  // Math
  // ===========================================================================

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
  const vNorm = (a) => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const vLerp = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const vDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const vDist2D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const angleWrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  // Direction for a yaw angle, matching Blender's rotation about Z applied to +Y.
  const yawDir = (yaw) => [-Math.sin(yaw), Math.cos(yaw), 0];
  const dirYaw = (d) => Math.atan2(-d[0], d[1]);

  const M4 = {
    create() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    copy(out, a) { out.set(a); return out; },
    mul(out, a, b) {
      const r = out === a || out === b ? new Float32Array(16) : out;
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        r[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        r[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        r[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        r[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
      if (r !== out) out.set(r);
      return out;
    },
    fromTRS(out, p, q, s) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0]; out[3] = 0;
      out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1]; out[7] = 0;
      out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2]; out[11] = 0;
      out[12] = p[0]; out[13] = p[1]; out[14] = p[2]; out[15] = 1;
      return out;
    },
    invert(out, a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return out.fill(0);
      det = 1 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },
    perspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
      return out;
    },
    ortho(out, l, r, b, t, n, f) {
      const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
      out.fill(0);
      out[0] = -2 * lr; out[5] = -2 * bt; out[10] = 2 * nf; out[15] = 1;
      out[12] = (l + r) * lr; out[13] = (t + b) * bt; out[14] = (f + n) * nf;
      return out;
    },
    lookAt(out, eye, target, up) {
      let z = vNorm(vSub(eye, target));
      let x = vCross(up, z);
      if (vLen(x) < 1e-6) x = vCross([0, 1, 0], z);
      x = vNorm(x);
      const y = vCross(z, x);
      out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
      out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
      out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
      out[12] = -vDot(x, eye); out[13] = -vDot(y, eye); out[14] = -vDot(z, eye); out[15] = 1;
      return out;
    },
    normal3(out, m) {
      // Inverse transpose of the upper 3x3.
      const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
      const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
      let det = a00 * b01 + a01 * b11 + a02 * b21;
      if (!det) { out.fill(0); out[0] = out[4] = out[8] = 1; return out; }
      det = 1 / det;
      out[0] = b01 * det; out[3] = (-a22 * a01 + a02 * a21) * det; out[6] = (a12 * a01 - a02 * a11) * det;
      out[1] = b11 * det; out[4] = (a22 * a00 - a02 * a20) * det; out[7] = (-a12 * a00 + a02 * a10) * det;
      out[2] = b21 * det; out[5] = (-a21 * a00 + a01 * a20) * det; out[8] = (a11 * a00 - a01 * a10) * det;
      return out;
    },
    point(m, p) {
      return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
    },
    dir(m, d) {
      return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
    },
    maxScale(m) {
      return Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
    },
  };

  const Q = {
    // Blender 'XYZ' Euler order: R = Rz * Ry * Rx.
    fromEuler(x, y, z) {
      const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
      return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
    },
    axisZ(a) { return [0, 0, Math.sin(a / 2), Math.cos(a / 2)]; },
    mul(a, b) {
      return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      ];
    },
  };

  // Frustum planes from a view-projection matrix (Gribb/Hartmann).
  function frustumPlanes(m) {
    const planes = [];
    const rows = [[m[3], m[7], m[11], m[15]], [m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]]];
    const add = (sign, i) => {
      const p = [rows[0][0] + sign * rows[i][0], rows[0][1] + sign * rows[i][1], rows[0][2] + sign * rows[i][2], rows[0][3] + sign * rows[i][3]];
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      planes.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
    };
    add(1, 1); add(-1, 1); add(1, 2); add(-1, 2); add(1, 3); add(-1, 3);
    return planes;
  }
  function sphereInFrustum(planes, c, r) {
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
    }
    return true;
  }

  // ===========================================================================
  // Shaders
  // ===========================================================================

  const SKY_GLSL = `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
vec3 skyGradient(vec3 d) {
  float h = d.z;
  vec3 up = mix(uSkyHorizon, uSkyZenith, pow(clamp(h, 0.0, 1.0), 0.45));
  vec3 down = mix(uSkyHorizon, uSkyGround, clamp(-h * 3.0, 0.0, 1.0));
  return h >= 0.0 ? up : down;
}
vec3 toneMap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
`;

  const PBR_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat4 uShadowMat;
uniform mat3 uNormalMat;
uniform float uNormalBias;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec4 vShadow;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vUV = vec2(aUV.x, 1.0 - aUV.y);
  vShadow = uShadowMat * vec4(w.xyz + vNormal * uNormalBias, 1.0);
  gl_Position = uViewProj * w;
}`;

  const PBR_FS = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
#define MAX_LIGHTS 16
const float PI = 3.14159265;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec4 vShadow;
uniform vec4 uBaseColor;
uniform float uMetallic;
uniform float uRoughness;
uniform vec3 uEmission;
uniform float uNormalStrength;
uniform sampler2D uBaseTex;
uniform sampler2D uNormalTex;
uniform sampler2D uRoughTex;
uniform sampler2D uEmitTex;
uniform ivec4 uTexFlags;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2DShadow uShadowMap;
uniform float uShadowOn;
uniform float uShadowTexel;
uniform int uLightCount;
uniform vec4 uLightPos[MAX_LIGHTS];
uniform vec4 uLightColor[MAX_LIGHTS];
uniform vec4 uLightSpot[MAX_LIGHTS];
uniform float uLightInner[MAX_LIGHTS];
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFlash;
uniform float uDirect;
uniform float uExposure;
uniform float uBlend;
${SKY_GLSL}
out vec4 outColor;

mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return mat3(T * invmax, B * invmax, N);
}

vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 albedo, float metal, float rough, vec3 F0) {
  float NoL = dot(N, L);
  if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(V + L);
  float NoV = max(dot(N, V), 1e-4), NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
  float a = rough * rough, a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (NoV / (NoV * (1.0 - k) + k)) * (NoL / (NoL * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
  vec3 spec = D * G * F / (4.0 * NoV * NoL + 1e-4);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * albedo / PI + spec) * NoL;
}

vec2 envBRDF(float NoV, float r) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r4 = r * c0 + c1;
  float a004 = min(r4.x * r4.x, exp2(-9.28 * NoV)) * r4.x + r4.y;
  return vec2(-1.04, 1.04) * a004 + r4.zw;
}

float shadowFactor() {
  if (uShadowOn < 0.5) return 1.0;
  vec3 s = vShadow.xyz / vShadow.w * 0.5 + 0.5;
  if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || s.z >= 1.0) return 1.0;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      sum += texture(uShadowMap, vec3(s.xy + vec2(x, y) * uShadowTexel * 1.25, s.z));
  float edge = smoothstep(0.0, 0.08, min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y)));
  return mix(1.0, sum / 9.0, edge);
}

void main() {
  vec4 base = uBaseColor;
  if (uTexFlags.x == 1) base *= texture(uBaseTex, vUV);
  if (uBlend < 0.5 && uTexFlags.x == 1 && base.a < 0.5) discard;
  vec3 albedo = base.rgb;
  float rough = uRoughness;
  if (uTexFlags.z == 1) rough *= texture(uRoughTex, vUV).g;
  rough = clamp(rough, 0.04, 1.0);
  float metal = uMetallic;

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  if (uTexFlags.y == 1) {
    vec3 t = texture(uNormalTex, vUV).xyz * 2.0 - 1.0;
    t.y = -t.y;
    t.xy *= uNormalStrength;
    N = normalize(cotangentFrame(N, vWorld, vUV) * t);
  }
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 F0 = mix(vec3(0.04), albedo, metal);

  vec3 color = brdf(N, V, uSunDir, albedo, metal, rough, F0) * uSunColor * shadowFactor();

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 Lv = uLightPos[i].xyz - vWorld;
    float d2 = max(dot(Lv, Lv), 1e-4);
    float d = sqrt(d2);
    float range = uLightPos[i].w;
    float win = clamp(1.0 - pow(d / range, 4.0), 0.0, 1.0);
    float att = win * win / d2;
    vec3 L = Lv / d;
    if (uLightColor[i].w > 0.5) {
      float cd = dot(-L, uLightSpot[i].xyz);
      att *= smoothstep(uLightSpot[i].w, uLightInner[i], cd);
    }
    if (att > 1e-5) color += brdf(N, V, L, albedo, metal, rough, F0) * uLightColor[i].rgb * att;
  }

  float NoV = max(dot(N, V), 1e-4);
  vec3 irradiance = mix(uSkyGround, mix(uSkyHorizon, uSkyZenith, clamp(N.z, 0.0, 1.0)), smoothstep(-0.6, 0.4, N.z)) * uAmbient;
  vec3 R = reflect(-V, N);
  vec3 prefiltered = mix(skyGradient(R) * uAmbient, irradiance, rough * rough);
  vec2 ab = envBRDF(NoV, rough);
  float horizon = clamp(1.0 + 1.3 * dot(R, N), 0.0, 1.0);
  vec3 ambient = irradiance * albedo * (1.0 - metal) + prefiltered * (F0 * ab.x + ab.y) * horizon * horizon;
  color += ambient;

  vec3 emission = uEmission;
  if (uTexFlags.w == 1) emission *= texture(uEmitTex, vUV).rgb;
  color += emission + albedo * uFlash;

  if (uFogDensity > 0.0) {
    float fog = 1.0 - exp(-uFogDensity * dist * exp(-0.04 * max(vWorld.z, 0.0)));
    float sunAmount = pow(max(dot(-V, uSunDir), 0.0), 8.0);
    vec3 fogColor = uFogColor + uSunColor * 0.05 * sunAmount;
    color = mix(color, fogColor, fog);
  }

  float alpha = uBlend > 0.5 ? base.a : 1.0;
  if (uDirect > 0.5) color = toSRGB(toneMap(color * uExposure));
  outColor = vec4(color, alpha);
}`;

  const DEPTH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uModel;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }`;

  const DEPTH_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(1.0); }`;

  const FULLSCREEN_VS = `#version 300 es
out vec2 vUV;
uniform float uClipDepth;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, uClipDepth, 1.0);
}`;

  const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDisk;
uniform float uSkyIntensity;
uniform float uDirect;
uniform float uExposure;
uniform float uOrtho;
${SKY_GLSL}
out vec4 outColor;
void main() {
  vec4 w = uInvViewProj * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(w.xyz / w.w - uCamPos);
  // Orthographic views look along one direction; use a screen-space gradient instead.
  if (uOrtho > 0.5) d = normalize(vec3(0.0, 1.0, (vUV.y - 0.25) * 1.4));
  vec3 col = skyGradient(d) * uSkyIntensity;
  if (uSunDisk > 0.5) {
    float mu = max(dot(d, uSunDir), 0.0);
    col += uSunColor * (0.015 * pow(mu, 6.0) + 0.12 * pow(mu, 120.0));
    col += uSunColor * 12.0 * smoothstep(0.99990, 0.99996, mu) * step(-0.02, d.z);
  }
  if (uDirect > 0.5) col = toSRGB(toneMap(col * uExposure));
  outColor = vec4(col, 1.0);
}`;

  const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUV + uTexel * vec2(-0.5, -0.5)).rgb + texture(uSrc, vUV + uTexel * vec2(0.5, -0.5)).rgb
         + texture(uSrc, vUV + uTexel * vec2(-0.5, 0.5)).rgb + texture(uSrc, vUV + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  o = vec4(min(c * contrib, vec3(64.0)), 1.0);
}`;

  const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUV).rgb * 4.0;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;

  const UP_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(c / 12.0, 1.0);
}`;

  const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uDepth;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec2 uTexel;
uniform vec3 uKernel[12];
uniform float uRadius;
out vec4 o;
vec3 viewPos(vec2 uv) {
  float d = texture(uDepth, uv).r;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
void main() {
  float d = texture(uDepth, vUV).r;
  if (d >= 1.0) { o = vec4(1.0); return; }
  vec3 P = viewPos(vUV);
  vec3 pl = viewPos(vUV - vec2(uTexel.x, 0.0)), pr = viewPos(vUV + vec2(uTexel.x, 0.0));
  vec3 pd = viewPos(vUV - vec2(0.0, uTexel.y)), pu = viewPos(vUV + vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float ang = noise * 6.2831853;
  vec3 rv = vec3(cos(ang), sin(ang), 0.0);
  vec3 T = normalize(rv - N * dot(rv, N));
  vec3 B = cross(N, T);
  mat3 tbn = mat3(T, B, N);
  float occ = 0.0;
  for (int i = 0; i < 12; i++) {
    vec3 s = P + tbn * uKernel[i] * uRadius;
    vec4 q = uProj * vec4(s, 1.0);
    vec2 suv = q.xy / q.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float sz = viewPos(suv).z;
    float range = smoothstep(0.0, 1.0, uRadius / max(abs(P.z - sz), 1e-4));
    occ += (sz >= s.z + 0.03 ? 1.0 : 0.0) * range;
  }
  o = vec4(vec3(1.0 - occ / 12.0), 1.0);
}`;

  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main() {
  float s = 0.0;
  for (int y = -2; y < 2; y++)
    for (int x = -2; x < 2; x++)
      s += texture(uSrc, vUV + (vec2(x, y) + 0.5) * uTexel).r;
  o = vec4(vec3(s / 16.0), 1.0);
}`;

  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform sampler2D uDepth;
uniform sampler2D uDof;
uniform float uBloomStrength;
uniform float uAOStrength;
uniform float uExposure;
uniform float uVignette;
uniform vec3 uTint;
uniform float uChromatic;
uniform float uMotionBlur;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uDofOn;
uniform vec4 uDofParams;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uLetterbox;
uniform float uAspect;
${SKY_GLSL}
out vec4 o;
float linearDepth(float d) {
  // Converted with the inverse projection packed in uDofParams.w (near) and the far plane in z.
  float n = uDofParams.w, f = uDofParams.z;
  float z = d * 2.0 - 1.0;
  return 2.0 * n * f / (f + n - z * (f - n));
}
vec3 sceneColor(vec2 uv) {
  if (uChromatic <= 0.0) return texture(uScene, uv).rgb;
  vec2 dir = (uv - 0.5) * uChromatic * 0.012;
  return vec3(texture(uScene, uv + dir).r, texture(uScene, uv).g, texture(uScene, uv - dir).b);
}
void main() {
  vec3 c = sceneColor(vUV);
  float d = texture(uDepth, vUV).r;
  if (uMotionBlur > 0.0 && d < 1.0) {
    // Camera motion blur by reprojecting this pixel into the previous frame.
    vec4 w = uInvViewProj * vec4(vUV * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 prev = uPrevViewProj * vec4(w.xyz / w.w, 1.0);
    vec2 vel = (vUV - (prev.xy / prev.w * 0.5 + 0.5)) * uMotionBlur * 0.5;
    vel = clamp(vel, vec2(-0.015), vec2(0.015));
    vec3 acc = c;
    for (int i = 1; i < 8; i++) acc += sceneColor(vUV - vel * (float(i) / 7.0 - 0.5));
    c = acc / 8.0;
  }
  if (uDofOn > 0.5) {
    float D = linearDepth(d);
    float coc = abs(uDofParams.x * (D - uDofParams.y) / max(D, 1e-3));
    c = mix(c, texture(uDof, vUV).rgb, smoothstep(0.6, 2.5, coc));
  }
  float ao = texture(uAO, vUV).r;
  c *= mix(1.0, ao, uAOStrength);
  c += texture(uBloom, vUV).rgb * uBloomStrength;
  c *= uExposure * uTint;
  c *= vec3(1.0 + uTemperature * 0.12, 1.0, 1.0 - uTemperature * 0.12);
  c = toneMap(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  vec2 v = vUV - 0.5;
  c *= 1.0 - uVignette * dot(v, v) * 1.6;
  if (uLetterbox > 0.0 && uAspect < uLetterbox) {
    float bar = 0.5 * (1.0 - uAspect / uLetterbox);
    if (vUV.y < bar || vUV.y > 1.0 - bar) c = vec3(0.0);
  }
  o = vec4(toSRGB(c), 1.0);
}`;

  // Depth of field gather: a golden-angle disc whose radius follows the circle of confusion.
  const DOF_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform vec4 uDofParams;
uniform float uMaxCoc;
out vec4 o;
float linearDepth(float d) {
  float n = uDofParams.w, f = uDofParams.z;
  float z = d * 2.0 - 1.0;
  return 2.0 * n * f / (f + n - z * (f - n));
}
float cocAt(vec2 uv) {
  float D = linearDepth(texture(uDepth, uv).r);
  return min(abs(uDofParams.x * (D - uDofParams.y) / max(D, 1e-3)), uMaxCoc);
}
void main() {
  float coc = cocAt(vUV);
  vec3 sum = texture(uScene, vUV).rgb;
  float wsum = 1.0;
  for (int i = 1; i < 40; i++) {
    float r = sqrt(float(i) / 40.0) * coc;
    float a = float(i) * 2.39996;
    vec2 uv = vUV + vec2(cos(a), sin(a)) * r * uTexel;
    float sc = cocAt(uv);
    float w = smoothstep(r - 1.0, r + 1.0, max(sc, coc * 0.5));
    sum += texture(uScene, uv).rgb * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 1.0);
}`;

  // Weighted copy used to accumulate film sub-frames and to present them with grain.
  const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform float uWeight;
uniform float uGrain;
uniform float uTime;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 17.17) * 43758.5453); }
void main() {
  vec3 c = texture(uSrc, vUV).rgb * uWeight;
  if (uGrain > 0.0) c += (hash(gl_FragCoord.xy) - 0.5) * uGrain * (1.0 - c * 0.6);
  o = vec4(c, 1.0);
}`;

  const FXAA_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 o;
void main() {
  vec3 rgbNW = texture(uSrc, vUV + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture(uSrc, vUV + vec2(1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture(uSrc, vUV + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 rgbSE = texture(uSrc, vUV + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 rgbM = texture(uSrc, vUV).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma), lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma), lM = dot(rgbM, luma);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(uSrc, vUV + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSrc, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uSrc, vUV - dir * 0.5).rgb + texture(uSrc, vUV + dir * 0.5).rgb);
  float lB = dot(b, luma);
  o = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;

  // ===========================================================================
  // Renderer
  // ===========================================================================

  const QUALITY = {
    shadow: { OFF: [0, 0], LOW: [1024, 22], MEDIUM: [2048, 32], HIGH: [2048, 42], ULTRA: [4096, 55] },
  };

  class Program {
    constructor(gl, vs, fs, name) {
      this.gl = gl;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(s);
          throw new Error(name + ' shader failed: ' + log);
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ' link failed: ' + gl.getProgramInfoLog(p));
      this.handle = p;
      this.locs = new Map();
    }
    use() { this.gl.useProgram(this.handle); return this; }
    loc(name) {
      let l = this.locs.get(name);
      if (l === undefined) { l = this.gl.getUniformLocation(this.handle, name); this.locs.set(name, l); }
      return l;
    }
    f1(n, v) { this.gl.uniform1f(this.loc(n), v); }
    i1(n, v) { this.gl.uniform1i(this.loc(n), v); }
    v2(n, a, b) { this.gl.uniform2f(this.loc(n), a, b); }
    v3(n, v) { this.gl.uniform3f(this.loc(n), v[0], v[1], v[2]); }
    v4(n, v) { this.gl.uniform4f(this.loc(n), v[0], v[1], v[2], v[3]); }
    m4(n, m) { this.gl.uniformMatrix4fv(this.loc(n), false, m); }
    m3(n, m) { this.gl.uniformMatrix3fv(this.loc(n), false, m); }
  }

  class Target {
    constructor(gl, w, h, opts) {
      this.gl = gl; this.w = w; this.h = h;
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      if (opts.color) {
        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, opts.color, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      }
      if (opts.depth) {
        this.depth = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.depth);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
        const filter = opts.compare ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (opts.compare) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        }
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
      }
      if (!opts.color) { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
    }
    bind() { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, this.w, this.h); }
    dispose() {
      const gl = this.gl;
      gl.deleteFramebuffer(this.fbo);
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.depth) gl.deleteTexture(this.depth);
    }
  }

  class Renderer {
    constructor(canvas, settings) {
      this.canvas = canvas;
      this.settings = settings;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('This device does not support WebGL2.');
      this.gl = gl;
      this.hdr = !!gl.getExtension('EXT_color_buffer_float');
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      this.pbr = new Program(gl, PBR_VS, PBR_FS, 'pbr');
      this.depthProg = new Program(gl, DEPTH_VS, DEPTH_FS, 'depth');
      this.sky = new Program(gl, FULLSCREEN_VS, SKY_FS, 'sky');
      if (this.hdr) {
        this.bright = new Program(gl, FULLSCREEN_VS, BRIGHT_FS, 'bright');
        this.down = new Program(gl, FULLSCREEN_VS, DOWN_FS, 'down');
        this.up = new Program(gl, FULLSCREEN_VS, UP_FS, 'up');
        this.ssao = new Program(gl, FULLSCREEN_VS, SSAO_FS, 'ssao');
        this.blur = new Program(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
        this.composite = new Program(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
        this.fxaa = new Program(gl, FULLSCREEN_VS, FXAA_FS, 'fxaa');
        this.dof = new Program(gl, FULLSCREEN_VS, DOF_FS, 'dof');
        this.copy = new Program(gl, FULLSCREEN_VS, COPY_FS, 'copy');
      }
      this.emptyVao = gl.createVertexArray();
      this.white = this.makeSolidTexture([255, 255, 255, 255]);
      this.black = this.makeSolidTexture([0, 0, 0, 255]);
      const [shadowSize, shadowRadius] = QUALITY.shadow[settings.shadowQuality] || QUALITY.shadow.MEDIUM;
      this.shadowRadius = shadowRadius;
      this.shadow = new Target(gl, Math.max(1, shadowSize), Math.max(1, shadowSize), { depth: true, compare: true });
      this.shadowOn = shadowSize > 0;
      this.shadowMat = M4.create();
      this.kernel = new Float32Array(36);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 * 2.618, r = Math.sqrt((i + 0.5) / 12);
        let s = [Math.cos(a) * r, Math.sin(a) * r, Math.sqrt(Math.max(0.05, 1 - r * r))];
        s = vScale(vNorm(s), lerp(0.15, 1.0, ((i + 1) / 12) ** 2));
        this.kernel.set(s, i * 3);
      }
      this.scale = clamp(settings.resolutionScale || 1, 0.4, 1);
      this.targets = null;
      this.size = [0, 0];
      this.stats = { draws: 0, tris: 0 };
      this.normal3 = new Float32Array(9);
      this.viewProj = M4.create();
      this.view = M4.create();
      this.proj = M4.create();
      this.invProj = M4.create();
      this.invViewProj = M4.create();
      this.prevViewProj = null;
      this.fixedSize = null;
      this.jitter = [0, 0];
      this.lightData = { pos: new Float32Array(64), color: new Float32Array(64), spot: new Float32Array(64), inner: new Float32Array(16) };
    }

    makeSolidTexture(rgba) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
      return t;
    }

    uploadTexture(image, srgb) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      return t;
    }

    uploadMesh(mesh, buffer) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const attrib = (loc, offset, size) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(buffer, offset, mesh.vertexCount * size), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      attrib(0, mesh.position, 3);
      attrib(1, mesh.normal, 3);
      if (mesh.uv >= 0) attrib(2, mesh.uv, 2);
      else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      const IndexArray = mesh.indexType === 'uint16' ? Uint16Array : Uint32Array;
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new IndexArray(buffer, mesh.index, mesh.indexCount), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, indexType: mesh.indexType === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, indexSize: mesh.indexType === 'uint16' ? 2 : 4 };
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = this.fixedSize ? this.fixedSize[0] : Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const ch = this.fixedSize ? this.fixedSize[1] : Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      const w = Math.max(1, Math.round(cw * this.scale)), h = Math.max(1, Math.round(ch * this.scale));
      if (!this.hdr || (this.size[0] === w && this.size[1] === h && this.targets)) { this.size = [w, h]; return; }
      this.size = [w, h];
      if (this.targets) for (const t of Object.values(this.targets).flat()) t.dispose();
      const gl = this.gl;
      const bloom = [];
      let bw = w, bh = h;
      for (let i = 0; i < 5; i++) {
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
        bloom.push(new Target(gl, bw, bh, { color: gl.RGBA16F }));
      }
      const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
      this.targets = {
        scene: new Target(gl, w, h, { color: gl.RGBA16F, depth: true }),
        ldr: new Target(gl, w, h, { color: gl.RGBA8 }),
        ao: new Target(gl, hw, hh, { color: gl.RGBA8 }),
        aoBlur: new Target(gl, hw, hh, { color: gl.RGBA8 }),
        dof: new Target(gl, hw, hh, { color: gl.RGBA16F }),
        final: new Target(gl, w, h, { color: gl.RGBA8 }),
        accum: new Target(gl, w, h, { color: gl.RGBA16F }),
        bloom,
      };
    }

    setScale(s) {
      s = clamp(s, 0.4, 1);
      if (Math.abs(s - this.scale) > 0.01) { this.scale = s; this.resize(); }
    }

    // frame: { camera: {world, proj, pos}, items, sun, env, lights, flash }
    // output: a Target to receive the final image (film accumulation) or null for the canvas.
    render(frame, output) {
      const gl = this.gl, st = this.stats;
      st.draws = 0; st.tris = 0;
      this.resize();
      const [w, h] = this.hdr ? this.size : [this.canvas.width, this.canvas.height];
      const direct = !this.hdr;
      M4.invert(this.view, frame.camera.world);
      M4.copy(this.proj, frame.camera.proj(w / h));
      if (this.jitter[0] || this.jitter[1]) {
        // Sub-pixel jitter for accumulated anti-aliasing (works for both projections).
        const jx = this.jitter[0] * 2 / w, jy = this.jitter[1] * 2 / h;
        if (this.proj[15] === 0) { this.proj[8] -= jx; this.proj[9] -= jy; } else { this.proj[12] += jx; this.proj[13] += jy; }
      }
      M4.mul(this.viewProj, this.proj, this.view);
      if (!this.prevViewProj || frame.resetHistory) this.prevViewProj = M4.copy(M4.create(), this.viewProj);
      M4.invert(this.invProj, this.proj);
      M4.invert(this.invViewProj, this.viewProj);
      const planes = frustumPlanes(this.viewProj);

      // Shadow pass.
      const sun = frame.sun;
      const shadowOn = this.shadowOn && sun.intensity > 0.01;
      if (shadowOn) this.renderShadow(frame, sun);

      // Scene pass.
      if (direct) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); }
      else this.targets.scene.bind();
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const p = this.pbr.use();
      p.m4('uViewProj', this.viewProj);
      p.m4('uShadowMat', this.shadowMat);
      p.f1('uNormalBias', shadowOn ? this.shadowRadius / this.shadow.w * 1.5 : 0);
      p.v3('uCamPos', frame.camera.pos);
      p.v3('uSunDir', sun.dir);
      p.v3('uSunColor', vScale(sun.color, sun.intensity));
      p.f1('uShadowOn', shadowOn ? 1 : 0);
      p.f1('uShadowTexel', 1 / this.shadow.w);
      const env = frame.env;
      p.v3('uSkyZenith', env.zenith); p.v3('uSkyHorizon', env.horizon); p.v3('uSkyGround', env.ground);
      p.f1('uAmbient', env.ambient);
      p.v3('uFogColor', env.fogColor);
      p.f1('uFogDensity', env.fogDensity);
      p.f1('uDirect', direct ? 1 : 0);
      p.f1('uExposure', env.exposure);
      p.i1('uBaseTex', 0); p.i1('uNormalTex', 1); p.i1('uRoughTex', 2); p.i1('uEmitTex', 3); p.i1('uShadowMap', 4);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.shadow.depth);
      this.uploadLights(p, frame.lights);

      const opaque = [], transparent = [];
      const camPos = frame.camera.pos;
      for (const item of frame.items) {
        if (!sphereInFrustum(planes, item.center, item.radius)) continue;
        if (item.material.blend) { item.sortKey = vDist(item.center, camPos); transparent.push(item); }
        else opaque.push(item);
      }
      opaque.sort((a, b) => a.matIndex - b.matIndex || a.meshIndex - b.meshIndex);
      transparent.sort((a, b) => b.sortKey - a.sortKey);

      gl.disable(gl.BLEND);
      let lastMat = null;
      for (const item of opaque) { this.drawItem(p, item, lastMat); lastMat = item.material; }

      // Sky fills untouched pixels at the far plane.
      gl.depthMask(false);
      const s = this.sky.use();
      gl.bindVertexArray(this.emptyVao);
      s.f1('uClipDepth', 1);
      s.m4('uInvViewProj', this.invViewProj);
      s.v3('uCamPos', camPos);
      s.v3('uSunDir', sun.dir);
      s.v3('uSunColor', vScale(sun.color, sun.intensity));
      s.f1('uSunDisk', env.sunDisk ? 1 : 0);
      s.f1('uSkyIntensity', env.skyIntensity);
      s.f1('uOrtho', frame.camera.ortho ? 1 : 0);
      s.v3('uSkyZenith', env.zenith); s.v3('uSkyHorizon', env.horizon); s.v3('uSkyGround', env.ground);
      s.f1('uDirect', direct ? 1 : 0);
      s.f1('uExposure', env.exposure);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (transparent.length) {
        p.use();
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        lastMat = null;
        for (const item of transparent) { this.drawItem(p, item, lastMat); lastMat = item.material; }
        gl.disable(gl.BLEND);
      }
      gl.depthMask(true);

      if (!direct) this.postProcess(frame, w, h, output);
      M4.copy(this.prevViewProj, this.viewProj);
    }

    // Film accumulation: clear, add weighted sub-frames, then present with grain.
    beginAccumulation() {
      const T = this.targets;
      T.accum.bind();
      this.gl.clearColor(0, 0, 0, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
    addSample(weight) {
      const gl = this.gl, T = this.targets, c = this.copy.use();
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T.final.tex);
      c.i1('uSrc', 0); c.f1('uWeight', weight); c.f1('uGrain', 0); c.f1('uTime', 0);
      this.fullscreen(c, T.accum);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
    }
    presentAccumulation(grain, time) {
      const gl = this.gl, T = this.targets, c = this.copy.use();
      gl.disable(gl.DEPTH_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T.accum.tex);
      c.i1('uSrc', 0); c.f1('uWeight', 1); c.f1('uGrain', grain); c.f1('uTime', time);
      this.fullscreen(c, null, this.canvas.width, this.canvas.height);
      gl.enable(gl.DEPTH_TEST);
    }

    uploadLights(p, lights) {
      const d = this.lightData;
      const n = Math.min(lights.length, 16);
      for (let i = 0; i < n; i++) {
        const l = lights[i];
        d.pos.set([l.pos[0], l.pos[1], l.pos[2], l.range], i * 4);
        d.color.set([l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, l.spot ? 1 : 0], i * 4);
        d.spot.set([l.dir[0], l.dir[1], l.dir[2], l.cosOuter], i * 4);
        d.inner[i] = l.cosInner;
      }
      const gl = this.gl;
      p.i1('uLightCount', n);
      gl.uniform4fv(p.loc('uLightPos'), d.pos);
      gl.uniform4fv(p.loc('uLightColor'), d.color);
      gl.uniform4fv(p.loc('uLightSpot'), d.spot);
      gl.uniform1fv(p.loc('uLightInner'), d.inner);
    }

    bindMaterial(p, m) {
      const gl = this.gl;
      p.v4('uBaseColor', m.baseColor);
      p.f1('uMetallic', m.metallic);
      p.f1('uRoughness', m.roughness);
      p.v3('uEmission', vScale(m.emission, m.emissionStrength));
      p.f1('uNormalStrength', m.normalStrength);
      p.f1('uBlend', m.blend ? 1 : 0);
      const tex = m.gpuTextures;
      gl.uniform4i(p.loc('uTexFlags'), tex[0] ? 1 : 0, tex[1] ? 1 : 0, tex[2] ? 1 : 0, tex[3] ? 1 : 0);
      for (let i = 0; i < 4; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex[i] || this.white);
      }
      if (m.doubleSided) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }
    }

    drawItem(p, item, lastMat) {
      const gl = this.gl;
      if (item.material !== lastMat || item.flash) this.bindMaterial(p, item.material);
      p.f1('uFlash', item.flash || 0);
      p.m4('uModel', item.world);
      p.m3('uNormalMat', M4.normal3(this.normal3, item.world));
      gl.bindVertexArray(item.gpu.vao);
      gl.drawElements(gl.TRIANGLES, item.count, item.gpu.indexType, item.first * item.gpu.indexSize);
      this.stats.draws++;
      this.stats.tris += item.count / 3;
      if (item.flash) this.bindMaterial(p, item.material);
    }

    renderShadow(frame, sun) {
      const gl = this.gl, R = this.shadowRadius;
      const focus = frame.shadowFocus;
      const dir = vScale(sun.dir, -1);
      const up = Math.abs(dir[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
      const lightView = M4.lookAt(M4.create(), [0, 0, 0], dir, up);
      const c = M4.point(lightView, focus);
      const texel = (2 * R) / this.shadow.w;
      c[0] = Math.floor(c[0] / texel) * texel; c[1] = Math.floor(c[1] / texel) * texel;
      const depthRange = R * 3;
      const proj = M4.ortho(M4.create(), c[0] - R, c[0] + R, c[1] - R, c[1] + R, -c[2] - depthRange, -c[2] + depthRange);
      M4.mul(this.shadowMat, proj, lightView);
      this.shadow.bind();
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.6, 3.0);
      const p = this.depthProg.use();
      p.m4('uViewProj', this.shadowMat);
      const planes = frustumPlanes(this.shadowMat);
      for (const item of frame.items) {
        if (!item.castShadow || item.material.blend) continue;
        if (!sphereInFrustum(planes, item.center, item.radius)) continue;
        p.m4('uModel', item.world);
        gl.bindVertexArray(item.gpu.vao);
        gl.drawElements(gl.TRIANGLES, item.count, item.gpu.indexType, item.first * item.gpu.indexSize);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    fullscreen(prog, target, w, h) {
      const gl = this.gl;
      if (target) target.bind(); else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); }
      prog.f1('uClipDepth', 0);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    postProcess(frame, w, h, output) {
      const gl = this.gl, T = this.targets, st = this.settings;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.depthMask(false);
      const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };

      // SSAO at half resolution.
      let aoTex = this.white;
      if (st.ssao) {
        const s = this.ssao.use();
        bind(0, T.scene.depth);
        s.i1('uDepth', 0);
        s.m4('uProj', this.proj);
        s.m4('uInvProj', this.invProj);
        s.v2('uTexel', 1 / w, 1 / h);
        s.f1('uRadius', 0.65);
        gl.uniform3fv(s.loc('uKernel'), this.kernel);
        this.fullscreen(s, T.ao);
        const b = this.blur.use();
        bind(0, T.ao.tex);
        b.i1('uSrc', 0);
        b.v2('uTexel', 1 / T.ao.w, 1 / T.ao.h);
        this.fullscreen(b, T.aoBlur);
        aoTex = T.aoBlur.tex;
      }

      // Bloom: threshold, downsample chain, additive upsample.
      let bloomTex = this.black;
      if (st.bloom > 0) {
        const chain = T.bloom;
        let prog = this.bright.use();
        bind(0, T.scene.tex);
        prog.i1('uSrc', 0);
        prog.v2('uTexel', 1 / w, 1 / h);
        prog.f1('uThreshold', 1.0);
        this.fullscreen(prog, chain[0]);
        prog = this.down.use();
        prog.i1('uSrc', 0);
        for (let i = 1; i < chain.length; i++) {
          bind(0, chain[i - 1].tex);
          prog.v2('uTexel', 1 / chain[i - 1].w, 1 / chain[i - 1].h);
          this.fullscreen(prog, chain[i]);
        }
        prog = this.up.use();
        prog.i1('uSrc', 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (let i = chain.length - 1; i > 0; i--) {
          bind(0, chain[i].tex);
          prog.v2('uTexel', 1 / chain[i].w, 1 / chain[i].h);
          this.fullscreen(prog, chain[i - 1]);
        }
        gl.disable(gl.BLEND);
        bloomTex = chain[0].tex;
      }

      // Cinematic depth of field (circle of confusion from the camera's lens settings).
      const film = frame.film || null;
      const lens = frame.camera.lens;
      let dofParams = [0, 10, 100, 0.1];
      const dofOn = !!(film && film.dof && lens && lens.dof && lens.dof.enabled && lens.fstop > 0);
      if (dofOn) {
        const f = lens.lens / 1000, S = Math.max(lens.focus, f * 1.5), A = f / lens.fstop;
        const pxPerMetre = w / (lens.sensor / 1000);
        dofParams = [A * f / (S - f) * pxPerMetre, S, frame.camera.far, frame.camera.near];
        const d = this.dof.use();
        bind(0, T.scene.tex); bind(1, T.scene.depth);
        d.i1('uScene', 0); d.i1('uDepth', 1);
        d.v2('uTexel', 1 / w, 1 / h);
        d.v4('uDofParams', dofParams);
        d.f1('uMaxCoc', Math.max(4, w / 90));
        this.fullscreen(d, T.dof);
      }

      const useFxaa = st.antiAliasing !== 'OFF';
      const c = this.composite.use();
      bind(0, T.scene.tex); bind(1, bloomTex); bind(2, aoTex); bind(3, T.scene.depth); bind(4, T.dof.tex);
      c.i1('uScene', 0); c.i1('uBloom', 1); c.i1('uAO', 2); c.i1('uDepth', 3); c.i1('uDof', 4);
      c.f1('uDofOn', dofOn ? 1 : 0);
      c.v4('uDofParams', dofParams);
      c.f1('uChromatic', film ? film.chromatic || 0 : 0);
      c.f1('uMotionBlur', film && !frame.accumulating ? film.motionBlur || 0 : 0);
      c.m4('uInvViewProj', this.invViewProj);
      c.m4('uPrevViewProj', this.prevViewProj);
      c.f1('uContrast', film ? film.contrast || 1 : 1);
      c.f1('uSaturation', film ? (film.saturation === undefined ? 1 : film.saturation) : 1);
      c.f1('uTemperature', film ? film.temperature || 0 : 0);
      c.f1('uLetterbox', film ? film.letterbox || 0 : 0);
      c.f1('uAspect', w / h);
      c.f1('uBloomStrength', st.bloom > 0 ? st.bloom * 0.08 : 0);
      c.f1('uAOStrength', st.ssao ? 0.85 : 0);
      c.f1('uExposure', frame.env.exposure);
      c.f1('uVignette', film && film.vignette !== undefined ? film.vignette : 0.35);
      c.v3('uTint', frame.tint || [1, 1, 1]);
      if (useFxaa) {
        this.fullscreen(c, T.ldr);
        const f = this.fxaa.use();
        bind(0, T.ldr.tex);
        f.i1('uSrc', 0);
        f.v2('uTexel', 1 / w, 1 / h);
        this.fullscreen(f, output || null, this.canvas.width, this.canvas.height);
      } else {
        this.fullscreen(c, output || null, this.canvas.width, this.canvas.height);
      }
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    }
  }

  // ===========================================================================
  // Physics: static triangle world
  // ===========================================================================

  const CP = [0, 0, 0];
  // Closest point on triangle (a, b, c) to p, written to CP (Ericson, RTCD 5.1.5).
  function closestPointTriangle(px, py, pz, t, o) {
    const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { CP[0] = ax; CP[1] = ay; CP[2] = az; return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { CP[0] = bx; CP[1] = by; CP[2] = bz; return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); CP[0] = ax + abx * v; CP[1] = ay + aby * v; CP[2] = az + abz * v; return; }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { CP[0] = cx; CP[1] = cy; CP[2] = cz; return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); CP[0] = ax + acx * w; CP[1] = ay + acy * w; CP[2] = az + acz * w; return; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      CP[0] = bx + (cx - bx) * w; CP[1] = by + (cy - by) * w; CP[2] = bz + (cz - bz) * w; return;
    }
    const sum = va + vb + vc;
    if (!(Math.abs(sum) > 1e-20)) { CP[0] = ax; CP[1] = ay; CP[2] = az; return; }
    const denom = 1 / sum, v = vb * denom, w = vc * denom;
    CP[0] = ax + abx * v + acx * w; CP[1] = ay + aby * v + acy * w; CP[2] = az + abz * v + acz * w;
  }

  class StaticWorld {
    constructor(cellSize) {
      this.cell = cellSize || 4;
      this.verts = [];
      this.owner = [];
      this.cells = new Map();
      this.large = [];
      this.stamp = null;
      this.query = 1;
    }
    key(x, y, z) { return ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096); }
    addMesh(positions, indices, world, ownerIndex) {
      const v = this.verts;
      const n = positions.length / 3;
      const wp = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const p = M4.point(world, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
        wp[i * 3] = p[0]; wp[i * 3 + 1] = p[1]; wp[i * 3 + 2] = p[2];
      }
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        // Skip degenerate triangles: they have no normal and break closest-point math.
        const ux = wp[b] - wp[a], uy = wp[b + 1] - wp[a + 1], uz = wp[b + 2] - wp[a + 2];
        const wx = wp[c] - wp[a], wy = wp[c + 1] - wp[a + 1], wz = wp[c + 2] - wp[a + 2];
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
        if (cx * cx + cy * cy + cz * cz < 1e-12) continue;
        v.push(wp[a], wp[a + 1], wp[a + 2], wp[b], wp[b + 1], wp[b + 2], wp[c], wp[c + 1], wp[c + 2]);
        this.owner.push(ownerIndex);
      }
    }
    build() {
      this.tris = new Float32Array(this.verts);
      this.verts = null;
      const count = this.tris.length / 9, t = this.tris, cs = this.cell;
      this.normals = new Float32Array(count * 3);
      this.stamp = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        const o = i * 9;
        const e1 = [t[o + 3] - t[o], t[o + 4] - t[o + 1], t[o + 5] - t[o + 2]];
        const e2 = [t[o + 6] - t[o], t[o + 7] - t[o + 1], t[o + 8] - t[o + 2]];
        const nrm = vNorm(vCross(e1, e2));
        this.normals.set(nrm, i * 3);
        const minX = Math.floor(Math.min(t[o], t[o + 3], t[o + 6]) / cs), maxX = Math.floor(Math.max(t[o], t[o + 3], t[o + 6]) / cs);
        const minY = Math.floor(Math.min(t[o + 1], t[o + 4], t[o + 7]) / cs), maxY = Math.floor(Math.max(t[o + 1], t[o + 4], t[o + 7]) / cs);
        const minZ = Math.floor(Math.min(t[o + 2], t[o + 5], t[o + 8]) / cs), maxZ = Math.floor(Math.max(t[o + 2], t[o + 5], t[o + 8]) / cs);
        if ((maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1) > 2048) { this.large.push(i); continue; }
        for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
          const k = this.key(x, y, z);
          let list = this.cells.get(k);
          if (!list) { list = []; this.cells.set(k, list); }
          list.push(i);
        }
      }
    }
    get triangleCount() { return this.tris ? this.tris.length / 9 : 0; }
    // Calls fn(triIndex) once per triangle overlapping the box.
    forBox(minX, minY, minZ, maxX, maxY, maxZ, fn) {
      const cs = this.cell, q = ++this.query, stamp = this.stamp;
      for (const i of this.large) { stamp[i] = q; fn(i); }
      const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs), y0 = Math.floor(minY / cs), y1 = Math.floor(maxY / cs);
      const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(this.key(x, y, z));
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const i = list[j];
          if (stamp[i] === q) continue;
          stamp[i] = q;
          fn(i);
        }
      }
    }
    // Push a sphere out of the geometry. Returns contacts [{n, depth}] and mutates center.
    resolveSphere(center, r, contacts) {
      if (!this.tris) return;
      const t = this.tris;
      this.forBox(center[0] - r, center[1] - r, center[2] - r, center[0] + r, center[1] + r, center[2] + r, (i) => {
        closestPointTriangle(center[0], center[1], center[2], t, i * 9);
        let dx = center[0] - CP[0], dy = center[1] - CP[1], dz = center[2] - CP[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) return;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          dx = this.normals[i * 3]; dy = this.normals[i * 3 + 1]; dz = this.normals[i * 3 + 2]; d = 0;
        } else { dx /= d; dy /= d; dz /= d; }
        const depth = r - d;
        center[0] += dx * depth; center[1] += dy * depth; center[2] += dz * depth;
        contacts.push({ n: [dx, dy, dz], depth, owner: this.owner[i] });
      });
    }
    // Ray against triangles (Moller-Trumbore) walking the grid with a 3D DDA.
    raycast(o, d, maxT) {
      if (!this.tris) return null;
      const t = this.tris, cs = this.cell, q = ++this.query, stamp = this.stamp;
      let best = maxT, bestI = -1;
      const test = (i) => {
        if (stamp[i] === q) return;
        stamp[i] = q;
        const k = i * 9;
        const e1x = t[k + 3] - t[k], e1y = t[k + 4] - t[k + 1], e1z = t[k + 5] - t[k + 2];
        const e2x = t[k + 6] - t[k], e2y = t[k + 7] - t[k + 1], e2z = t[k + 8] - t[k + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) return;
        const inv = 1 / det;
        const sx = o[0] - t[k], sy = o[1] - t[k + 1], sz = o[2] - t[k + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) return;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) return;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-4 && dist < best) { best = dist; bestI = i; }
      };
      for (const i of this.large) test(i);
      let x = Math.floor(o[0] / cs), y = Math.floor(o[1] / cs), z = Math.floor(o[2] / cs);
      const sx = Math.sign(d[0]), sy = Math.sign(d[1]), sz = Math.sign(d[2]);
      const next = (p, c, s, dir) => (s === 0 ? Infinity : ((c + (s > 0 ? 1 : 0)) * cs - p) / dir);
      let tx = next(o[0], x, sx, d[0]), ty = next(o[1], y, sy, d[1]), tz = next(o[2], z, sz, d[2]);
      const dx = sx === 0 ? Infinity : cs / Math.abs(d[0]), dy = sy === 0 ? Infinity : cs / Math.abs(d[1]), dz = sz === 0 ? Infinity : cs / Math.abs(d[2]);
      let traveled = 0;
      for (let steps = 0; steps < 4096; steps++) {
        const list = this.cells.get(this.key(x, y, z));
        if (list) for (let j = 0; j < list.length; j++) test(list[j]);
        traveled = Math.min(tx, ty, tz);
        if (best <= traveled || traveled > maxT) break;
        if (tx <= ty && tx <= tz) { x += sx; tx += dx; } else if (ty <= tz) { y += sy; ty += dy; } else { z += sz; tz += dz; }
      }
      if (bestI < 0) return null;
      // Geometry is treated as two-sided: report the normal facing the ray origin.
      let normal = [this.normals[bestI * 3], this.normals[bestI * 3 + 1], this.normals[bestI * 3 + 2]];
      if (vDot(normal, d) > 0) normal = vScale(normal, -1);
      return { t: best, point: vAdd(o, vScale(d, best)), normal, owner: this.owner[bestI] };
    }
  }

  // ===========================================================================
  // Audio: tiny procedural sound effects (no asset files).
  // ===========================================================================

  class Sfx {
    constructor() { this.ctx = null; this.volume = 0.5; }
    unlock() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    tone(type, f0, f1, dur, gain) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    }
    burst(dur, freq, gain) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      s.buffer = this.noise;
      f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(200, t + dur);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.master);
      s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
    }
    play(name) {
      switch (name) {
        case 'shot': this.burst(0.22, 5200, 0.9); this.tone('square', 180, 50, 0.12, 0.25); break;
        case 'hit': this.tone('square', 900, 500, 0.06, 0.15); break;
        case 'kill': this.tone('sawtooth', 300, 60, 0.35, 0.25); break;
        case 'pickup': this.tone('sine', 660, 1320, 0.18, 0.3); break;
        case 'heal': this.tone('triangle', 400, 900, 0.3, 0.3); break;
        case 'hurt': this.tone('sawtooth', 160, 70, 0.25, 0.35); break;
        case 'jump': this.tone('sine', 260, 520, 0.14, 0.18); break;
        case 'door': this.burst(0.6, 600, 0.4); break;
        case 'melee': this.burst(0.12, 2500, 0.5); break;
        case 'win': this.tone('triangle', 440, 880, 0.5, 0.3); setTimeout(() => this.tone('triangle', 660, 1320, 0.6, 0.3), 180); break;
        case 'lose': this.tone('sawtooth', 220, 55, 1.0, 0.3); break;
        default: break;
      }
    }
  }

  // ===========================================================================
  // Input
  // ===========================================================================

  const CODE_MAP = {
    Space: 'SPACE', ShiftLeft: 'LEFT_SHIFT', ShiftRight: 'RIGHT_SHIFT', ControlLeft: 'LEFT_CTRL', ControlRight: 'RIGHT_CTRL',
    AltLeft: 'LEFT_ALT', AltRight: 'RIGHT_ALT', Escape: 'ESC', Enter: 'RET', Tab: 'TAB', Backspace: 'BACK_SPACE',
    ArrowUp: 'UP_ARROW', ArrowDown: 'DOWN_ARROW', ArrowLeft: 'LEFT_ARROW', ArrowRight: 'RIGHT_ARROW',
  };
  const DIGITS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
  const MOUSE_NAMES = ['LEFTMOUSE', 'MIDDLEMOUSE', 'RIGHTMOUSE'];
  const DEFAULT_BINDINGS = {
    MOVE_FORWARD: ['W', 'UP_ARROW'], MOVE_BACKWARD: ['S', 'DOWN_ARROW'], MOVE_LEFT: ['A', 'LEFT_ARROW'], MOVE_RIGHT: ['D', 'RIGHT_ARROW'],
    JUMP: ['SPACE'], SPRINT: ['LEFT_SHIFT'], CROUCH: ['LEFT_CTRL', 'C'], INTERACT: ['E'], ATTACK: ['F', 'LEFTMOUSE'],
    AIM: ['RIGHTMOUSE'], PAUSE: ['ESC', 'P'], INVENTORY: ['I'], RELOAD: ['R'],
  };

  function blenderKey(e) {
    if (CODE_MAP[e.code]) return CODE_MAP[e.code];
    if (e.code.startsWith('Key')) return e.code.slice(3);
    if (e.code.startsWith('Digit')) return DIGITS[+e.code.slice(5)];
    if (/^F\d+$/.test(e.code)) return e.code;
    return e.code.toUpperCase();
  }

  class Input {
    constructor(canvas, bindings) {
      this.canvas = canvas;
      this.keys = new Set();
      this.pressedKeys = new Set();
      this.virtual = new Set();
      this.virtualPressed = new Set();
      this.look = [0, 0];
      this.move = [0, 0];
      this.touchMove = [0, 0];
      this.locked = false;
      this.bindings = {};
      for (const [action, keys] of Object.entries(DEFAULT_BINDINGS)) this.bindings[action] = new Set(keys);
      if (bindings && bindings.length) {
        const custom = {};
        for (const b of bindings) {
          const name = b.action === 'CUSTOM' && b.custom_action ? b.custom_action : b.action;
          (custom[name] = custom[name] || new Set()).add(String(b.key || '').toUpperCase());
        }
        for (const [action, keys] of Object.entries(custom)) {
          // Keep arrow-key fallbacks for movement next to the user's keys.
          const merged = new Set(keys);
          if (action.startsWith('MOVE_')) for (const k of DEFAULT_BINDINGS[action] || []) if (k.endsWith('ARROW')) merged.add(k);
          if (action === 'ATTACK') merged.add('LEFTMOUSE');
          if (action === 'PAUSE') merged.add('ESC');
          this.bindings[action] = merged;
        }
      }
      this.gamepadIndex = -1;
      this.prevPad = {};
      addEventListener('keydown', (e) => {
        const k = blenderKey(e);
        if (!this.keys.has(k)) this.pressedKeys.add(k);
        this.keys.add(k);
        if (['SPACE', 'UP_ARROW', 'DOWN_ARROW', 'LEFT_ARROW', 'RIGHT_ARROW', 'TAB'].includes(k)) e.preventDefault();
      });
      addEventListener('keyup', (e) => this.keys.delete(blenderKey(e)));
      addEventListener('blur', () => { this.keys.clear(); this.virtual.clear(); });
      canvas.addEventListener('mousedown', (e) => {
        const k = MOUSE_NAMES[e.button];
        if (k) { if (!this.keys.has(k)) this.pressedKeys.add(k); this.keys.add(k); }
      });
      addEventListener('mouseup', (e) => { const k = MOUSE_NAMES[e.button]; if (k) this.keys.delete(k); });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      addEventListener('mousemove', (e) => {
        if (!this.locked) return;
        // Browsers can report one huge jump right after locking; drop it and clamp spikes.
        if (performance.now() - this.lockTime < 80) return;
        this.look[0] += clamp(e.movementX, -150, 150);
        this.look[1] += clamp(e.movementY, -150, 150);
      });
      document.addEventListener('pointerlockchange', () => {
        this.locked = document.pointerLockElement === canvas;
        this.lockTime = performance.now();
        if (this.onLockChange) this.onLockChange(this.locked);
      });
      addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    }
    requestLock() {
      if (this.locked || !this.canvas.requestPointerLock) return;
      try {
        const r = this.canvas.requestPointerLock();
        if (r && r.catch) r.catch(() => {});
      } catch (err) { /* Pointer lock is optional. */ }
    }
    releaseLock() { if (document.exitPointerLock && this.locked) document.exitPointerLock(); }
    down(action) {
      if (this.virtual.has(action)) return true;
      const keys = this.bindings[action];
      if (!keys) return false;
      for (const k of keys) if (this.keys.has(k)) return true;
      return false;
    }
    pressed(action) {
      if (this.virtualPressed.has(action)) return true;
      const keys = this.bindings[action];
      if (!keys) return false;
      for (const k of keys) if (this.pressedKeys.has(k)) return true;
      return false;
    }
    keyDown(key) { return this.keys.has(String(key).toUpperCase()); }
    pollGamepad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let pad = pads && this.gamepadIndex >= 0 ? pads[this.gamepadIndex] : null;
      if (!pad && pads) for (const p of pads) if (p) { pad = p; this.gamepadIndex = p.index; break; }
      for (const a of ['JUMP', 'ATTACK', 'INTERACT', 'SPRINT', 'PAUSE', 'AIM', 'CROUCH', 'RELOAD']) this.virtual.delete(a);
      this.move = [this.touchMove[0], this.touchMove[1]];
      if (!pad) return;
      const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
      const ax = pad.axes;
      if (ax.length >= 2 && (dz(ax[0]) || dz(ax[1]))) this.move = [dz(ax[0]), -dz(ax[1])];
      if (ax.length >= 4) { this.look[0] += dz(ax[2]) * 14; this.look[1] += dz(ax[3]) * 10; }
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const map = { JUMP: b(0), INTERACT: b(2), RELOAD: b(3), SPRINT: b(4) || b(10), AIM: b(6), ATTACK: b(7) || b(5), PAUSE: b(9), CROUCH: b(1) };
      for (const [a, on] of Object.entries(map)) {
        if (on) { this.virtual.add(a); if (!this.prevPad[a]) this.virtualPressed.add(a); }
        this.prevPad[a] = on;
      }
    }
    endFrame() { this.pressedKeys.clear(); this.virtualPressed.clear(); this.look[0] = 0; this.look[1] = 0; }
  }

  function setupTouch(input, root) {
    root.classList.remove('hidden');
    const stick = root.querySelector('#stick'), knob = stick.firstElementChild;
    let stickId = null, origin = null;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      stickId = t.identifier;
      const r = stick.getBoundingClientRect();
      origin = [r.left + r.width / 2, r.top + r.height / 2];
      e.preventDefault();
    }, { passive: false });
    const moveStick = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== stickId) continue;
        let dx = t.clientX - origin[0], dy = t.clientY - origin[1];
        const l = Math.hypot(dx, dy), max = 55;
        if (l > max) { dx *= max / l; dy *= max / l; }
        setKnob(dx, dy);
        input.touchMove = [dx / max, -dy / max];
        input.virtual[Math.hypot(dx, dy) > max * 0.92 ? 'add' : 'delete']('SPRINT_TOUCH');
      }
      e.preventDefault();
    };
    const endStick = (e) => {
      for (const t of e.changedTouches) if (t.identifier === stickId) { stickId = null; setKnob(0, 0); input.touchMove = [0, 0]; }
    };
    stick.addEventListener('touchmove', moveStick, { passive: false });
    stick.addEventListener('touchend', endStick);
    stick.addEventListener('touchcancel', endStick);

    const look = root.querySelector('#look');
    const lastLook = new Map();
    look.addEventListener('touchstart', (e) => { for (const t of e.changedTouches) lastLook.set(t.identifier, [t.clientX, t.clientY]); e.preventDefault(); }, { passive: false });
    look.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        const last = lastLook.get(t.identifier);
        if (!last) continue;
        input.look[0] += (t.clientX - last[0]) * 1.6;
        input.look[1] += (t.clientY - last[1]) * 1.6;
        lastLook.set(t.identifier, [t.clientX, t.clientY]);
      }
      e.preventDefault();
    }, { passive: false });
    const endLook = (e) => { for (const t of e.changedTouches) lastLook.delete(t.identifier); };
    look.addEventListener('touchend', endLook);
    look.addEventListener('touchcancel', endLook);

    for (const btn of root.querySelectorAll('.tbtn')) {
      const action = btn.dataset.action;
      btn.addEventListener('touchstart', (e) => { input.touchButtons.add(action); input.touchPressed.add(action); e.preventDefault(); }, { passive: false });
      const up = (e) => { input.touchButtons.delete(action); e.preventDefault(); };
      btn.addEventListener('touchend', up, { passive: false });
      btn.addEventListener('touchcancel', up, { passive: false });
    }
  }

  // ===========================================================================
  // Scene graph nodes
  // ===========================================================================

  class Node {
    constructor(src, index) {
      this.src = src;
      this.index = index;
      this.name = src.name;
      this.type = src.type;
      this.parentIndex = src.parent;
      this.parent = null;
      this.children = [];
      this.position = src.position.slice();
      this.rotation = src.rotation.slice();
      this.scale = src.scale.slice();
      this.local = M4.create();
      this.world = new Float32Array(src.world);
      this.visible = src.visible !== false;
      this.alive = true;
      this.effectiveVisible = this.visible;
      this.game = src.game || null;
      this.tag = this.game ? this.game.tag || '' : '';
      this.components = new Set(this.game ? this.game.components.filter((c) => c.enabled).map((c) => c.type) : []);
      this.vars = new Map();
      if (this.game) for (const v of this.game.variables || []) this.vars.set(v.name, { type: v.type, value: v.value });
      this.health = this.game && this.game.health && this.game.health.enabled
        ? { max: this.game.health.max_health, cur: this.game.health.current_health || this.game.health.max_health, destroy: this.game.health.destroy_on_death, gameOver: this.game.health.game_over_on_death }
        : null;
      this.flash = 0;
      this.mesh = null;
      this.items = [];
    }
    has(c) { return this.components.has(c); }
    updateLocal() { M4.fromTRS(this.local, this.position, this.rotation, this.scale); }
    get worldPos() { return [this.world[12], this.world[13], this.world[14]]; }
  }

  // ===========================================================================
  // Game
  // ===========================================================================

  const ENEMY_TAGS = new Set(['Enemy', 'Zombie']);
  const GOAL_TAGS = new Set(['Goal', 'Exit', 'Finish', 'Portal']);

  class Game {
    constructor(data, buffer, ui) {
      this.data = data;
      this.buffer = buffer;
      this.ui = ui;
      this.gameData = data.game || { objects: [], project: {}, input: [] };
      this.project = this.gameData.project || {};
      this.settings = Object.assign({
        sky: 'AUTO', fogDensity: 0.004, bloom: 1, ssao: true, exposure: 1, shadowQuality: 'MEDIUM', antiAliasing: 'FXAA',
        resolutionScale: 1, targetFps: 60, dynamicResolution: true, maxDynamicLights: 8, builtinRules: true,
      }, data.settings || {});
      const params = new URLSearchParams(location.search);
      if (params.has('quality')) this.applyQualityOverride(params.get('quality'));
      this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
      this.renderer = new Renderer(ui.canvas, this.settings);
      this.input = new Input(ui.canvas, this.gameData.input);
      this.input.touchButtons = new Set();
      this.input.touchPressed = new Set();
      this.sfx = new Sfx();
      this.listeners = {};
      this.time = 0;
      this.state = 'menu';
      this.messages = [];
    }

    applyQualityOverride(q) {
      const presets = {
        low: { shadowQuality: 'LOW', ssao: false, bloom: 0, antiAliasing: 'OFF', resolutionScale: 0.7 },
        medium: { shadowQuality: 'MEDIUM', ssao: false, bloom: 1, antiAliasing: 'FXAA', resolutionScale: 0.85 },
        high: { shadowQuality: 'HIGH', ssao: true, bloom: 1, antiAliasing: 'FXAA', resolutionScale: 1 },
        ultra: { shadowQuality: 'ULTRA', ssao: true, bloom: 1.2, antiAliasing: 'FXAA', resolutionScale: 1 },
      };
      Object.assign(this.settings, presets[q] || {});
    }

    // ---------------------------------------------------------------- loading
    async load(progress) {
      const d = this.data, r = this.renderer;
      const textures = [];
      for (let i = 0; i < d.textures.length; i++) {
        const t = d.textures[i];
        try {
          const img = new Image();
          img.src = t.uri;
          await img.decode();
          textures.push(r.uploadTexture(img, t.srgb));
        } catch (err) {
          console.warn('BlendEngine: texture failed', t.name, err);
          textures.push(null);
        }
        progress(0.1 + 0.5 * (i + 1) / Math.max(1, d.textures.length));
      }
      this.materials = d.materials.map((m, i) => Object.assign({}, m, {
        index: i,
        gpuTextures: [m.baseColorTexture, m.normalTexture, m.roughnessTexture, m.emissionTexture].map((ti) => (ti >= 0 ? textures[ti] : null)),
      }));
      if (!this.materials.length) this.materials.push({ baseColor: [0.8, 0.8, 0.8, 1], metallic: 0, roughness: 0.6, emission: [0, 0, 0], emissionStrength: 0, normalStrength: 1, blend: false, doubleSided: true, gpuTextures: [null, null, null, null], index: 0 });
      this.meshes = d.meshes.map((m, i) => {
        progress(0.6 + 0.3 * (i + 1) / Math.max(1, d.meshes.length));
        const IndexArray = m.indexType === 'uint16' ? Uint16Array : Uint32Array;
        return Object.assign({}, m, {
          gpu: r.uploadMesh(m, this.buffer),
          positions: new Float32Array(this.buffer, m.position, m.vertexCount * 3),
          indices: new IndexArray(this.buffer, m.index, m.indexCount),
        });
      });
      this.reset();
      progress(1);
    }

    // --------------------------------------------------------------- level setup
    reset() {
      const d = this.data;
      this.nodes = d.nodes.map((src, i) => new Node(src, i));
      for (const n of this.nodes) {
        if (n.parentIndex >= 0) { n.parent = this.nodes[n.parentIndex]; n.parent.children.push(n); }
        n.mesh = n.src.mesh >= 0 ? this.meshes[n.src.mesh] : null;
      }
      this.byName = new Map(this.nodes.map((n) => [n.name, n]));
      this.order = [];
      const visit = (n) => { this.order.push(n); for (const c of n.children) visit(c); };
      for (const n of this.nodes) if (!n.parent) visit(n);

      this.cameraNode = d.camera >= 0 ? this.nodes[d.camera] : this.nodes.find((n) => n.type === 'CAMERA') || null;
      if (this.cameraNode && this.cameraNode.parent) {
        // Detach the gameplay camera so the rig controls it in world space.
        const c = this.cameraNode;
        c.parent.children = c.parent.children.filter((x) => x !== c);
        c.parent = null;
        const ws = this.decompose(c.world);
        c.position = ws.p; c.rotation = ws.q; c.scale = [1, 1, 1];
        this.order = [];
        for (const n of this.nodes) if (!n.parent) visit(n);
      }
      this.player = this.nodes.find((n) => n.game && n.game.player_controller && n.game.player_controller.enabled)
        || this.nodes.find((n) => n.has('PLAYER_CONTROLLER')) || null;
      this.lights = this.nodes.filter((n) => n.type === 'LIGHT');
      this.sunNode = this.lights.filter((n) => n.src.light.type === 'SUN').sort((a, b) => b.src.light.intensity - a.src.light.intensity)[0] || null;

      this.updateTransforms();
      this.computeBounds();
      this.buildPhysics();
      this.setupEnvironment();
      this.setupPlayer();
      this.setupActors();
      this.setupBodies();
      this.setupTimeline();

      this.time = 0;
      this.timers = new Map();
      this.triggerOverlaps = new Set();
      this.collisionOverlaps = new Set();
      this.objectives = { coins: this.nodes.filter((n) => n.tag === 'Coin').length, collected: 0 };
      this.won = false;
      this.dead = false;
      this.hitMarker = 0;
      this.damageFlash = 0;
      this.muzzle = 0;
      this.fireCooldown = 0;
      this.frameTimes = [];
      this.usesCollisionEvents = this.nodes.some((n) => n.game && n.game.behaviors.some((b) => b.events.some((e) => e.type === 'ON_COLLISION')));
      this.emit('start', this);
      this.runBehaviors('ON_START', 0);
    }

    decompose(m) {
      const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
      const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
      const trace = r[0] + r[4] + r[8];
      let q;
      if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        q = [(r[5] - r[7]) * s, (r[6] - r[2]) * s, (r[1] - r[3]) * s, 0.25 / s];
      } else if (r[0] > r[4] && r[0] > r[8]) {
        const s = 2 * Math.sqrt(1 + r[0] - r[4] - r[8]);
        q = [0.25 * s, (r[3] + r[1]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s];
      } else if (r[4] > r[8]) {
        const s = 2 * Math.sqrt(1 + r[4] - r[0] - r[8]);
        q = [(r[3] + r[1]) / s, 0.25 * s, (r[7] + r[5]) / s, (r[6] - r[2]) / s];
      } else {
        const s = 2 * Math.sqrt(1 + r[8] - r[0] - r[4]);
        q = [(r[6] + r[2]) / s, (r[7] + r[5]) / s, 0.25 * s, (r[1] - r[3]) / s];
      }
      return { p: [m[12], m[13], m[14]], q, s: [sx, sy, sz] };
    }

    updateTransforms() {
      for (const n of this.order) {
        n.updateLocal();
        if (n.parent) M4.mul(n.world, n.parent.world, n.local); else n.world.set(n.local);
        // A removed (dead, collected) node hides its whole subtree.
        n.hiddenSubtree = !n.alive || !!(n.parent && n.parent.hiddenSubtree);
        n.effectiveVisible = n.visible && !n.hiddenSubtree;
      }
    }

    // World-space AABB of a node's mesh.
    nodeAABB(n) {
      if (!n.mesh) {
        const p = n.worldPos, d = n.src.dimensions.map((v) => Math.max(v, 0.5) / 2);
        return { min: vSub(p, d), max: vAdd(p, d) };
      }
      const lo = n.mesh.boundsMin, hi = n.mesh.boundsMax;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < 8; i++) {
        const p = M4.point(n.world, [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
      }
      return { min, max };
    }

    subtreeAABB(n) {
      const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      const visit = (x) => {
        if (x.mesh) {
          const b = this.nodeAABB(x);
          for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], b.min[k]); box.max[k] = Math.max(box.max[k], b.max[k]); }
        }
        for (const c of x.children) visit(c);
      };
      visit(n);
      if (box.min[0] === Infinity) return this.nodeAABB(n);
      return box;
    }

    computeBounds() {
      for (const n of this.nodes) {
        n.items = [];
        if (!n.mesh) continue;
        for (const prim of n.mesh.primitives) {
          n.items.push({
            node: n, world: n.world, gpu: n.mesh.gpu, first: prim.first, count: prim.count,
            material: this.materials[prim.material] || this.materials[0], matIndex: prim.material, meshIndex: n.src.mesh,
            center: [0, 0, 0], radius: 0, castShadow: n.src.castShadow !== false,
          });
        }
      }
    }

    buildPhysics() {
      const world = new StaticWorld(4);
      const dynamicNames = new Set();
      for (const n of this.nodes) {
        const g = n.game;
        if (!g) continue;
        const opt = g.optimization || {};
        if (n.has('PLAYER_CONTROLLER') || n.has('NPC_CONTROLLER') || opt.dynamic_object || n.has('RIGIDBODY') || n.has('DOOR')) dynamicNames.add(n.name);
      }
      // Timeline-animated objects move, so they collide as kinematic boxes instead.
      for (const n of this.nodes) if (n.src.animation) dynamicNames.add(n.name);
      let blocking = this.nodes.filter((n) => n.mesh && n.src.blocking && !dynamicNames.has(n.name));
      if (!blocking.length) {
        // Scenes without colliders: every visible static mesh blocks movement.
        blocking = this.nodes.filter((n) => n.mesh && n.visible && !dynamicNames.has(n.name) && !(n.game && n.game.components.some((c) => c.type === 'TRIGGER_ZONE')));
      }
      for (const n of blocking) world.addMesh(n.mesh.positions, n.mesh.indices, n.world, n.index);
      world.build();
      this.world = world;
      this.doors = this.nodes.filter((n) => n.has('DOOR') || n.tag === 'Door' || n.tag === 'Gate').map((n) => ({ node: n, open: 0, opening: false, box: this.nodeAABB(n), base: n.position.slice() }));
      this.triggers = this.nodes.filter((n) => n.has('TRIGGER_ZONE') && n !== this.player);
      this.colliderNodes = this.nodes.filter((n) => n.has('COLLIDER'));
    }

    // ------------------------------------------------------------------ lighting
    setupEnvironment() {
      const world = this.data.world || { color: [0.05, 0.05, 0.05], strength: 1 };
      const sunLight = this.sunNode ? this.sunNode.src.light : null;
      const sunIntensity = sunLight ? sunLight.intensity : 0;
      const wc = vScale(world.color, world.strength);
      const worldLum = wc[0] * 0.2126 + wc[1] * 0.7152 + wc[2] * 0.0722;
      let mode = this.settings.sky;
      // Blender's untouched default world is 0.05 grey; treat it as 'no sky set up'.
      if (mode === 'AUTO') mode = worldLum > 0.12 ? 'WORLD' : sunIntensity >= 1 ? 'PROCEDURAL' : 'WORLD';
      this.skyMode = mode;
      const cm = this.data.colorManagement || {};
      const env = {
        exposure: Math.pow(2, (cm.exposure || 0)) * (this.settings.exposure || 1),
        fogDensity: this.settings.fogDensity,
        sunDisk: mode === 'PROCEDURAL',
        skyIntensity: 1,
        ambient: 1,
      };
      if (mode === 'PROCEDURAL') {
        const sunDir = this.sunNode ? vNorm(M4.dir(this.sunNode.world, [0, 0, 1])) : [0.3, -0.4, 0.8];
        const e = sunDir[2];
        const day = smoothstep(-0.1, 0.35, e);
        const sunset = (1 - smoothstep(0.0, 0.3, e)) * smoothstep(-0.12, 0.03, e);
        env.zenith = vLerp([0.008, 0.012, 0.035], [0.045, 0.14, 0.42], day);
        env.horizon = vLerp(vLerp([0.03, 0.035, 0.06], [0.42, 0.55, 0.74], day), [1.0, 0.45, 0.2], sunset * 0.7);
        env.ground = vLerp([0.01, 0.01, 0.012], [0.12, 0.11, 0.095], day);
        // Sky light is dimmer than the sky looks: keeps sun/shadow contrast realistic.
        env.ambient = 0.55;
      } else {
        const c = wc.map((v) => Math.max(v, 0.004));
        env.zenith = vScale(c, 1.0);
        env.horizon = vScale(c, 1.15);
        env.ground = vScale(c, 0.45);
        env.ambient = 1;
      }
      env.fogColor = env.horizon.slice();
      this.env = env;
    }

    collectLights(camPos) {
      const out = [];
      for (const n of this.lights) {
        const l = n.src.light;
        if (!n.alive || l.type === 'SUN') continue;
        const pos = n.worldPos;
        const intensity = l.intensity * (n.lightBoost || 1);
        const range = l.range > 0 ? l.range : Math.sqrt(Math.max(intensity, 1e-3) / 0.004);
        const dir = vNorm(M4.dir(n.world, [0, 0, -1]));
        const spot = l.type === 'SPOT';
        const half = (l.spotSize || Math.PI) / 2;
        out.push({
          pos, range, color: l.color, intensity, spot, dir,
          cosOuter: spot ? Math.cos(half) : -1, cosInner: spot ? Math.cos(half * (1 - (l.spotBlend || 0.15))) : 1,
          score: intensity / Math.max(1, vDist(pos, camPos) ** 2),
        });
      }
      if (this.muzzle > 0 && this.cameraNode) {
        const p = vAdd(this.camPos, vScale(this.camForward, 1.6));
        out.push({ pos: p, range: 10, color: [1, 0.72, 0.38], intensity: 1.6 * this.muzzle, spot: false, dir: [0, 0, -1], cosOuter: -1, cosInner: 1, score: 1e9 });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, clamp(this.settings.maxDynamicLights || 8, 2, 16));
    }

    // -------------------------------------------------------------------- player
    setupPlayer() {
      const p = this.player;
      this.camYaw = 0; this.camPitch = 0;
      this.camDistance = 6;
      if (!p) return;
      const pc = p.game.player_controller;
      const box = this.subtreeAABB(p);
      const height = Math.max(0.6, box.max[2] - box.min[2]);
      const radius = clamp(Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2, 0.22, 0.6);
      p.ctrl = {
        type: pc.controller_type || 'THIRD_PERSON',
        walk: pc.walk_speed || 4, run: pc.run_speed || 7, jump: pc.jump_force || 5, gravity: pc.gravity || this.project.physics_gravity || 9.81,
        height, radius, footOffset: p.position[2] - box.min[2],
        vel: [0, 0, 0], grounded: false, coyote: 0, yaw: 0, bob: 0,
        baseRot: p.rotation.slice(), spawn: p.position.slice(),
      };
      // Make sure a jump of jump_force clears ~1m even with Blender's small defaults.
      p.ctrl.jump = Math.max(p.ctrl.jump, Math.sqrt(2 * p.ctrl.gravity * 0.9));
      this.snapToGround(p, p.ctrl, box);
      if (!p.health) p.health = { max: 100, cur: 100, destroy: false, gameOver: true };
      p.health.gameOver = true;
      this.ensureVar(p, 'Score', 'INT', 0);

      const cam = this.cameraNode;
      if (cam) {
        const off = vSub(cam.worldPos, vAdd(p.position, [0, 0, height * 0.5]));
        this.camOffset = off;
        this.camBaseRot = cam.rotation.slice();
        // Side scrollers keep the player centred horizontally.
        if (p.ctrl.type === 'SIDE_SCROLLER') this.camOffset = [0, off[1], off[2]];
        this.camDistance = clamp(vLen(off), 2.5, 25);
        const fwd = vNorm(M4.dir(cam.world, [0, 0, -1]));
        this.camYaw = dirYaw(fwd);
        this.camPitch = Math.asin(clamp(fwd[2], -0.99, 0.99));
      }
      if (p.ctrl.type === 'FIRST_PERSON') {
        this.camPitch = 0;
        this.firstPersonHidden = new Set();
        const hide = (n) => {
          if (n === cam || n.tag === 'Weapon' || n.tag === 'FirstPersonArms') return;
          if (n.mesh) { this.firstPersonHidden.add(n); n.visible = false; }
          for (const c of n.children) hide(c);
        };
        hide(p);
        for (const n of this.nodes) if (n.tag === 'PlayerBody' && n.mesh) { n.visible = false; this.firstPersonHidden.add(n); }
      }
      this.weapon = this.nodes.filter((n) => n.tag === 'Weapon' || n.has('WEAPON'));
      this.shooter = p.ctrl.type === 'FIRST_PERSON' || this.weapon.length > 0 || p.vars.has('Ammo');
      this.autoFire = this.shooter;
      for (const w of this.weapon) w.basePos = w.position.slice();
      this.respawn = p.position.slice();
    }

    // Place a character's feet on the floor below it (spawn points are often slightly off).
    snapToGround(n, c, box) {
      const feet = box.min[2], limit = feet + c.height * 0.5;
      let z = Math.max(box.max[2], n.position[2]) + 0.05;
      // Walk down through overhangs (awnings, roofs) to the floor nearest the feet.
      for (let i = 0; i < 6; i++) {
        const hit = this.world.raycast([n.position[0], n.position[1], z], [0, 0, -1], z - feet + 3);
        if (!hit) return;
        if (hit.normal[2] > 0.5 && hit.point[2] <= limit) { n.position[2] = hit.point[2] + c.footOffset + 0.02; return; }
        z = hit.point[2] - 0.02;
      }
    }

    ensureVar(n, name, type, value) {
      if (!n.vars.has(name)) n.vars.set(name, { type, value });
      return n.vars.get(name);
    }

    setupActors() {
      this.actors = [];
      for (const n of this.nodes) {
        if (!n.game || n === this.player) continue;
        const npc = n.game.npc_behavior;
        if (!npc || !npc.enabled) continue;
        const box = this.subtreeAABB(n);
        const height = Math.max(0.4, box.max[2] - box.min[2]);
        const radius = clamp(Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) / 2, 0.2, 1.2);
        const hostile = ENEMY_TAGS.has(n.tag) || ['ATTACK', 'ENEMY_BOSS', 'GUARD_AREA'].includes(npc.behavior_template) || (n.health && npc.behavior_template !== 'COMPANION' && !['TALK', 'QUEST_GIVER', 'SHOPKEEPER', 'IDLE'].includes(npc.behavior_template) && ENEMY_TAGS.has(n.tag));
        n.actor = {
          npc, template: npc.behavior_template, hostile: hostile || ENEMY_TAGS.has(n.tag),
          speed: npc.move_speed || 2.5, detect: npc.detection_range || 14, range: Math.max(npc.attack_range || 1.4, radius + 0.6),
          patrol: npc.patrol_radius || 5, origin: n.position.slice(), height, radius, footOffset: n.position[2] - box.min[2],
          vel: [0, 0, 0], grounded: false, yaw: 0, baseRot: n.rotation.slice(), state: 'idle', wander: null, wanderTimer: 0,
          attackTimer: 0.6, bob: Math.random() * 6, seen: false,
        };
        if (!n.health && n.actor.hostile) n.health = { max: 60, cur: 60, destroy: true, gameOver: false };
        this.snapToGround(n, n.actor, box);
        n.actor.origin = n.position.slice();
        this.actors.push(n);
      }
    }

    // ----------------------------------------------------------------- timeline
    // Blender animation is baked per frame by the exporter; the sequencer plays it
    // as cutscenes / films and loops animated props during gameplay.
    setupTimeline() {
      const tl = this.data.timeline || {};
      this.timeline = { frameStart: tl.frameStart || 1, frameEnd: tl.frameEnd || 1, fps: tl.fps || 24, cameraMarkers: tl.cameraMarkers || [] };
      this.film = Object.assign({
        playMode: 'GAME', loopProps: true, letterbox: 2.39, dof: true, motionBlur: 0.5, grain: 0.035, chromatic: 0.15,
        vignette: 0.45, contrast: 1.05, saturation: 1, temperature: 0, samples: 16, resolution: [1920, 1080],
      }, this.settings.film || {});
      if (new URLSearchParams(location.search).get('mode') === 'film') this.film.playMode = 'FILM';
      this.animated = this.nodes.filter((n) => n.src.animation && n.src.animation.position.length >= 3);
      for (const n of this.animated) { n.track = n.src.animation; n.trackFrames = n.track.position.length / 3; }
      this.hasCinematic = this.animated.length > 0 || this.timeline.cameraMarkers.length > 0;
      this.kinematic = this.animated.filter((n) => n.mesh && n.src.blocking).map((n) => ({ node: n, box: this.nodeAABB(n), last: n.worldPos }));
      this.cinematic = null;
      this.activeCamera = null;
    }

    sampleNode(n, frame) {
      const t = n.track, count = n.trackFrames;
      const f = clamp(frame - this.timeline.frameStart, 0, count - 1);
      const i0 = Math.floor(f), i1 = Math.min(i0 + 1, count - 1), k = f - i0;
      const P = t.position, R = t.rotation, S = t.scale;
      n.position = [lerp(P[i0 * 3], P[i1 * 3], k), lerp(P[i0 * 3 + 1], P[i1 * 3 + 1], k), lerp(P[i0 * 3 + 2], P[i1 * 3 + 2], k)];
      const q0 = [R[i0 * 4], R[i0 * 4 + 1], R[i0 * 4 + 2], R[i0 * 4 + 3]];
      let q1 = [R[i1 * 4], R[i1 * 4 + 1], R[i1 * 4 + 2], R[i1 * 4 + 3]];
      if (q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3] < 0) q1 = q1.map((v) => -v);
      const q = [lerp(q0[0], q1[0], k), lerp(q0[1], q1[1], k), lerp(q0[2], q1[2], k), lerp(q0[3], q1[3], k)];
      const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      n.rotation = q.map((v) => v / ql);
      n.scale = [lerp(S[i0 * 3], S[i1 * 3], k), lerp(S[i0 * 3 + 1], S[i1 * 3 + 1], k), lerp(S[i0 * 3 + 2], S[i1 * 3 + 2], k)];
      if (t.fovY) n.animFov = lerp(t.fovY[i0], t.fovY[i1], k);
    }

    applyTimeline(frame, filter) {
      for (const n of this.animated) if (!filter || filter(n)) this.sampleNode(n, frame);
    }

    cameraForFrame(frame) {
      let cam = this.cameraNode;
      for (const m of this.timeline.cameraMarkers) if (m.frame <= frame + 1e-4 && this.nodes[m.camera]) cam = this.nodes[m.camera];
      return cam;
    }

    // Animated props keep looping during gameplay; moving colliders carry the player.
    updateAnimatedProps() {
      if (!this.film.loopProps || !this.animated.length) return;
      const tl = this.timeline, length = Math.max(1, tl.frameEnd - tl.frameStart + 1);
      const frame = tl.frameStart + ((this.time * tl.fps) % length);
      const gameplay = (n) => n !== this.player && !n.actor && n !== this.cameraNode && !n.body && !this.doors.some((d) => d.node === n);
      this.applyTimeline(frame, gameplay);
      if (!this.kinematic.length) return;
      this.updateTransforms();
      for (const k of this.kinematic) {
        const pos = k.node.worldPos, delta = vSub(pos, k.last);
        k.last = pos;
        k.box = this.nodeAABB(k.node);
        if (this.player && this.player.ctrl && this.player.ctrl.groundOwner === k.node.index) this.player.position = vAdd(this.player.position, delta);
        for (const a of this.actors) if (a.actor.groundOwner === k.node.index) a.position = vAdd(a.position, delta);
      }
    }

    startCinematic(opts = {}) {
      if (!this.hasCinematic) { this.toast('This scene has no timeline animation or camera shots'); return false; }
      const saved = opts.film ? null : [this.player, ...this.actors, ...this.animated].filter(Boolean).map((n) => [n, n.position.slice(), n.rotation.slice(), n.scale.slice()]);
      this.cinematic = { time: 0, film: !!opts.film, saved, onEnd: opts.onEnd || null, realtime: opts.realtime !== false };
      this.state = 'cinematic';
      this.input.releaseLock();
      this.ui.hud.classList.add('hidden');
      this.renderer.prevViewProj = null;
      this.applyTimeline(this.timeline.frameStart);
      this.updateTransforms();
      this.activeCamera = this.cameraForFrame(this.timeline.frameStart);
      this.emit('cutscene', 'start');
      return true;
    }

    cinematicFrame() { return this.timeline.frameStart + this.cinematic.time * this.timeline.fps; }

    updateCinematic(dt) {
      const c = this.cinematic;
      c.time += dt;
      const frame = this.cinematicFrame();
      this.applyTimeline(frame);
      this.updateTransforms();
      this.activeCamera = this.cameraForFrame(frame);
      const skip = this.input.pressed('PAUSE') || this.input.pressed('JUMP') || this.input.pressed('ATTACK');
      if ((!c.film && skip) || frame > this.timeline.frameEnd + 0.999) this.endCinematic();
    }

    endCinematic() {
      const c = this.cinematic;
      if (!c) return;
      this.cinematic = null;
      this.activeCamera = null;
      if (c.saved) for (const [n, p, r, sc] of c.saved) { n.position = p; n.rotation = r; n.scale = sc; }
      this.updateTransforms();
      this.renderer.prevViewProj = null;
      this.emit('cutscene', 'end');
      if (c.film) {
        this.state = 'ended';
        this.ui.showMenu('The End', `${this.project.title || 'Film'} · ${((this.timeline.frameEnd - this.timeline.frameStart + 1) / this.timeline.fps).toFixed(1)} s`, 'Watch again', true);
      } else {
        this.state = 'playing';
        this.ui.hud.classList.remove('hidden');
      }
      if (c.onEnd) c.onEnd();
    }

    // Offline film render: every frame accumulates jittered sub-frame samples across the
    // shutter (anti-aliasing + true motion blur for everything that moves), then the
    // frame is written as PNG into a ZIP. Deterministic and independent of real-time speed.
    async renderFilm(opts = {}) {
      const r = this.renderer, tl = this.timeline, film = this.film;
      if (!r.hdr) throw new Error('Film rendering needs float render targets (EXT_color_buffer_float).');
      const [W, H] = opts.size || film.resolution || [1920, 1080];
      const samples = Math.max(1, Math.round(opts.samples || film.samples || 16));
      const first = opts.frameStart || tl.frameStart, last = opts.frameEnd || tl.frameEnd;
      const halton = (i, b) => { let f = 1, x = 0; while (i > 0) { f /= b; x += f * (i % b); i = Math.floor(i / b); } return x; };
      const saved = { fixed: r.fixedSize, scale: r.scale, dyn: this.settings.dynamicResolution, state: this.state };
      r.fixedSize = [W, H]; r.scale = 1; this.settings.dynamicResolution = false; r.resize();
      this.startCinematic({ film: true, realtime: false });
      this.state = 'rendering';
      this.cancelRender = false;
      const files = [];
      try {
        for (let f = first; f <= last && !this.cancelRender; f++) {
          r.beginAccumulation();
          for (let sIdx = 0; sIdx < samples; sIdx++) {
            const sub = samples > 1 ? ((sIdx + 0.5) / samples - 0.5) * film.motionBlur : 0;
            this.applyTimeline(f + sub);
            this.updateTransforms();
            this.activeCamera = this.cameraForFrame(f);
            r.jitter = samples > 1 ? [halton(sIdx + 1, 2) - 0.5, halton(sIdx + 1, 3) - 0.5] : [0, 0];
            this.renderFrame({ output: r.targets.final, accumulating: true, resetHistory: true });
            r.addSample(1 / samples);
          }
          r.jitter = [0, 0];
          r.presentAccumulation(film.grain, f);
          const blob = await new Promise((res) => this.ui.canvas.toBlob(res, 'image/png'));
          files.push({ name: `frame_${String(f).padStart(5, '0')}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
          if (opts.onProgress) opts.onProgress((f - first + 1) / (last - first + 1), f);
          await new Promise((res) => setTimeout(res, 0));
        }
      } finally {
        r.fixedSize = saved.fixed; r.scale = saved.scale; this.settings.dynamicResolution = saved.dyn; r.resize();
        this.cinematic = null; this.activeCamera = null; this.state = 'ended';
      }
      files.push({ name: 'README.txt', data: new TextEncoder().encode(
        `${this.project.title || 'BlendEngine film'}\n${files.length} frames at ${tl.fps} fps, ${W}x${H}, ${samples} samples per frame.\n\n` +
        `Make a video:\n  ffmpeg -framerate ${tl.fps} -start_number ${first} -i frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 16 film.mp4\n`) });
      return makeZip(files);
    }

    // Real-time WebM recording of the film playback (MediaRecorder).
    recordFilm(onDone) {
      const canvas = this.ui.canvas;
      if (!canvas.captureStream || !window.MediaRecorder) { this.toast('Video recording is not supported in this browser'); return false; }
      const stream = canvas.captureStream(Math.round(this.timeline.fps));
      const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 16e6 } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => onDone(new Blob(chunks, { type: 'video/webm' }));
      recorder.start(250);
      return this.startCinematic({ film: true, onEnd: () => recorder.stop() });
    }

    // ------------------------------------------------------------- rigid bodies
    // Simple dynamic props approximated by spheres: gravity, bounce, friction,
    // pushing by characters, body-body separation and sleeping.
    setupBodies() {
      this.bodies = [];
      for (const n of this.nodes) {
        if (!n.has('RIGIDBODY') || n === this.player || n.actor) continue;
        const box = this.subtreeAABB(n);
        const half = vScale(vSub(box.max, box.min), 0.5);
        const center = vScale(vAdd(box.min, box.max), 0.5);
        n.body = { vel: [0, 0, 0], radius: clamp(Math.max(half[0], half[1], half[2]), 0.1, 3), offset: vSub(center, n.position), still: 0, sleeping: false };
        this.bodies.push(n);
      }
    }

    updateBodies(dt) {
      const g = this.project.physics_gravity || 9.81;
      const p = this.player;
      for (const n of this.bodies) {
        if (!n.alive) continue;
        const b = n.body;
        let center = vAdd(n.position, b.offset);
        const movers = [];
        if (p && p.ctrl) movers.push([p, p.ctrl]);
        for (const a of this.actors) if (a.alive) movers.push([a, a.actor]);
        for (const [m, c] of movers) {
          const d = [center[0] - m.position[0], center[1] - m.position[1]];
          const dist = Math.hypot(d[0], d[1]), min = b.radius + c.radius;
          const feet = m.position[2] - c.footOffset;
          if (dist < min && dist > 1e-4 && center[2] + b.radius > feet && center[2] - b.radius < feet + c.height) {
            const push = (min - dist) / dist;
            b.vel[0] += d[0] * push * 12; b.vel[1] += d[1] * push * 12;
            b.sleeping = false;
          }
        }
        for (const o of this.bodies) {
          if (o === n || !o.alive) continue;
          const oc = vAdd(o.position, o.body.offset), d = vSub(center, oc), dist = vLen(d), min = b.radius + o.body.radius;
          if (dist < min && dist > 1e-4) { const k = (min - dist) / dist * 0.5; center = vAdd(center, vScale(d, k)); b.sleeping = false; }
        }
        if (b.sleeping) continue;
        b.vel[2] -= g * dt;
        center = vAdd(center, vScale(b.vel, dt));
        const contacts = [];
        const before = center.slice();
        this.world.resolveSphere(center, b.radius, contacts);
        this.resolveDoors(center, b.radius, contacts);
        if (contacts.some((ct) => ct.n[2] > 0.6)) {
          // Resting on ground: resolve vertically so props do not creep down gentle slopes.
          center[0] = before[0]; center[1] = before[1];
          for (const ct of contacts) if (ct.n[2] <= 0.6) { center[0] += ct.n[0] * ct.depth; center[1] += ct.n[1] * ct.depth; }
        }
        for (const ct of contacts) {
          const vn = vDot(b.vel, ct.n);
          if (vn < 0) b.vel = vSub(b.vel, vScale(ct.n, vn * (vn < -2 ? 1.35 : 1)));
          if (ct.n[2] > 0.6) { const f = Math.max(0, 1 - 5 * dt); b.vel[0] *= f; b.vel[1] *= f; }
        }
        n.position = vSub(center, b.offset);
        b.still = vLen(b.vel) < 0.08 && contacts.length ? b.still + dt : 0;
        if (b.still > 0.8) { b.sleeping = true; b.vel = [0, 0, 0]; }
        if (n.position[2] < -60) n.alive = false;
      }
    }

    // ---------------------------------------------------------- character motion
    // Moves a capsule-like stack of spheres through the static world.
    moveCharacter(n, c, desired, dt, flying) {
      if (!flying) c.vel[2] -= c.gravity * dt;
      c.vel[0] = desired[0]; c.vel[1] = desired[1];
      if (flying) c.vel[2] = desired[2];
      const feet = [n.position[0], n.position[1], n.position[2] - c.footOffset];
      const disp = vScale(c.vel, dt);
      const steps = clamp(Math.ceil(vLen(disp) / (c.radius * 0.5)), 1, 10);
      const r = c.radius;
      const wasGrounded = c.grounded;
      c.grounded = false;
      c.groundOwner = -1;
      const contacts = [];
      const levels = c.height > r * 4 ? [r, c.height * 0.5, c.height - r] : [r, Math.max(r, c.height - r)];
      for (let s = 0; s < steps; s++) {
        feet[0] += disp[0] / steps; feet[1] += disp[1] / steps; feet[2] += disp[2] / steps;
        for (let iter = 0; iter < 3; iter++) {
          let moved = false;
          for (let li = 0; li < levels.length; li++) {
            const center = [feet[0], feet[1], feet[2] + levels[li]];
            contacts.length = 0;
            this.world.resolveSphere(center, r, contacts);
            this.resolveDoors(center, r, contacts);
            for (const ct of contacts) {
              moved = true;
              if (ct.n[2] > 0.65 && li === 0) {
                // Walkable ground: push straight up so slopes do not slide.
                c.grounded = true;
                c.groundOwner = ct.owner;
                if (c.vel[2] < 0) c.vel[2] = 0;
              } else {
                const vn = vDot(c.vel, ct.n);
                if (vn < 0) c.vel = vSub(c.vel, vScale(ct.n, vn));
              }
            }
            const delta = [center[0] - feet[0], center[1] - feet[1], center[2] - levels[li] - feet[2]];
            if (contacts.some((ct) => ct.n[2] > 0.65) && li === 0) {
              const up = contacts.reduce((acc, ct) => (ct.n[2] > 0.65 ? Math.max(acc, ct.depth / ct.n[2]) : acc), 0);
              feet[2] += Math.max(up, delta[2]);
              const side = contacts.filter((ct) => ct.n[2] <= 0.65);
              for (const ct of side) { feet[0] += ct.n[0] * ct.depth; feet[1] += ct.n[1] * ct.depth; }
            } else {
              feet[0] += delta[0]; feet[1] += delta[1]; feet[2] += delta[2];
            }
          }
          if (!moved) break;
        }
      }
      // Ground snap keeps characters glued to slopes and stairs going down.
      if (!c.grounded && wasGrounded && c.vel[2] <= 0.01 && !flying) {
        const hit = this.world.raycast([feet[0], feet[1], feet[2] + r], [0, 0, -1], r + 0.45);
        if (hit && hit.normal[2] > 0.65) { feet[2] = hit.point[2]; c.grounded = true; c.vel[2] = 0; }
      }
      if (c.grounded) c.coyote = 0.12; else c.coyote = Math.max(0, c.coyote - dt);
      n.position[0] = feet[0]; n.position[1] = feet[1]; n.position[2] = feet[2] + c.footOffset;
    }

    resolveDoors(center, r, contacts) {
      for (const k of this.kinematic || []) {
        if (!k.node.alive) continue;
        const b = k.box;
        const cx = clamp(center[0], b.min[0], b.max[0]), cy = clamp(center[1], b.min[1], b.max[1]), cz = clamp(center[2], b.min[2], b.max[2]);
        let dx = center[0] - cx, dy = center[1] - cy, dz = center[2] - cz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= r || dist < 1e-6) continue;
        dx /= dist; dy /= dist; dz /= dist;
        const depth = r - dist;
        center[0] += dx * depth; center[1] += dy * depth; center[2] += dz * depth;
        contacts.push({ n: [dx, dy, dz], depth, owner: k.node.index });
      }
      for (const d of this.doors) {
        if (d.open >= 0.98 || !d.node.alive) continue;
        const b = d.box;
        const cx = clamp(center[0], b.min[0], b.max[0]), cy = clamp(center[1], b.min[1], b.max[1]), cz = clamp(center[2], b.min[2] - d.open * (b.max[2] - b.min[2]), b.max[2] - d.open * (b.max[2] - b.min[2]));
        let dx = center[0] - cx, dy = center[1] - cy, dz = center[2] - cz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= r || dist < 1e-6) continue;
        dx /= dist; dy /= dist; dz /= dist;
        const depth = r - dist;
        center[0] += dx * depth; center[1] += dy * depth; center[2] += dz * depth;
        contacts.push({ n: [dx, dy, dz], depth, owner: d.node.index });
      }
    }

    // --------------------------------------------------------------- main update
    update(dt) {
      this.time += dt;
      const input = this.input;
      for (const a of input.touchButtons) input.virtual.add(a);
      for (const a of input.touchPressed) input.virtualPressed.add(a);
      input.touchPressed.clear();
      if (input.virtual.has('SPRINT_TOUCH')) input.virtual.add('SPRINT');

      if (input.pressed('PAUSE')) { this.pause(); return; }
      if (input.keys.has('F3') && !this.f3) this.ui.perf.classList.toggle('hidden');
      this.f3 = input.keys.has('F3');

      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      this.muzzle = Math.max(0, this.muzzle - dt * 12);
      this.hitMarker = Math.max(0, this.hitMarker - dt);
      this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);

      this.updateAnimatedProps();
      this.updatePlayer(dt);
      this.updateActors(dt);
      this.updateBodies(dt);
      this.updateDoors(dt);
      this.updatePickupsSpin(dt);
      this.runBehaviors('ON_UPDATE', dt);
      this.runBehaviors('ON_TIMER', dt);
      this.updateTransforms();
      this.updateTriggers(dt);
      if (this.usesCollisionEvents) this.updateCollisions(dt);
      this.updateCamera(dt);
      this.emit('update', dt);
      for (const n of this.nodes) if (n.flash > 0) n.flash = Math.max(0, n.flash - dt * 6);
    }

    updatePlayer(dt) {
      const p = this.player, input = this.input;
      if (!p || this.dead || this.won) return;
      const c = p.ctrl;
      const sens = 0.0024;
      this.camYaw -= input.look[0] * sens;
      this.camPitch = clamp(this.camPitch - input.look[1] * sens, -1.35, 1.35);

      let ax = input.move[0], ay = input.move[1];
      if (input.down('MOVE_LEFT')) ax -= 1;
      if (input.down('MOVE_RIGHT')) ax += 1;
      if (input.down('MOVE_FORWARD')) ay += 1;
      if (input.down('MOVE_BACKWARD')) ay -= 1;
      const mag = Math.hypot(ax, ay);
      if (mag > 1) { ax /= mag; ay /= mag; }

      const sprint = input.down('SPRINT');
      const crouch = input.down('CROUCH');
      let speed = sprint ? c.run : c.walk;
      if (crouch) speed *= 0.5;
      let desired = [0, 0, 0];
      const type = c.type;
      if (type === 'SIDE_SCROLLER') {
        desired = [ax * speed, 0, 0];
        if (Math.abs(ax) > 0.01) c.yaw = ax > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else if (type === 'VEHICLE') {
        c.speed = lerp(c.speed || 0, ay * speed * 1.8, dt * 1.5);
        c.yaw -= ax * dt * 1.8 * clamp((c.speed || 0) / 6, -1, 1);
        desired = vScale(yawDir(c.yaw), c.speed);
        this.camYaw = lerp(this.camYaw, c.yaw, dt * 3);
      } else {
        const yaw = this.camYaw;
        const fwd = yawDir(yaw), right = [Math.cos(yaw), Math.sin(yaw), 0];
        desired = vAdd(vScale(right, ax * speed), vScale(fwd, ay * speed));
        if (type === 'FIRST_PERSON') c.yaw = yaw;
        else if (mag > 0.05) {
          const target = dirYaw(desired);
          c.yaw += angleWrap(target - c.yaw) * Math.min(1, dt * 12);
        }
        if (type === 'FLYING') {
          const look = [-Math.sin(yaw) * Math.cos(this.camPitch), Math.cos(yaw) * Math.cos(this.camPitch), Math.sin(this.camPitch)];
          desired = vAdd(vScale(right, ax * speed), vScale(look, ay * speed));
          if (input.down('JUMP')) desired[2] += speed;
          if (crouch) desired[2] -= speed;
        }
      }
      const flying = type === 'FLYING';
      if (!flying && input.pressed('JUMP') && (c.grounded || c.coyote > 0)) {
        c.vel[2] = c.jump; c.grounded = false; c.coyote = 0; this.sfx.play('jump');
      }
      const wasAir = !c.grounded;
      const fallSpeed = c.vel[2];
      this.moveCharacter(p, c, desired, dt, flying);
      if (wasAir && c.grounded && fallSpeed < -14) this.damagePlayer((-fallSpeed - 14) * 6, 'fall');

      // Visual: face movement and bob while walking.
      const moving = Math.hypot(desired[0], desired[1]) > 0.1 && c.grounded;
      c.bob += dt * (moving ? (sprint ? 13 : 9) : 0);
      const lean = moving ? Math.sin(c.bob) * 0.03 : 0;
      // Side scrollers keep their authored orientation (sprites and boxes must not turn edge-on).
      const visualYaw = type === 'SIDE_SCROLLER' ? 0 : c.yaw;
      p.rotation = Q.mul(Q.mul(Q.axisZ(visualYaw), Q.fromEuler(type === 'SIDE_SCROLLER' ? 0 : lean, 0, 0)), c.baseRot);

      if (p.position[2] < -60) { p.position = this.respawn.slice(); c.vel = [0, 0, 0]; this.damagePlayer(25, 'fall'); }

      if ((input.pressed('ATTACK') || (this.shooter && input.down('ATTACK') && this.autoFire)) && this.fireCooldown <= 0) this.attack();
      if (input.pressed('RELOAD')) this.reload();
      if (input.pressed('INTERACT')) this.interact();
      this.runKeyBehaviors();
    }

    runKeyBehaviors() {
      for (const k of this.input.pressedKeys) this.runBehaviors('ON_KEY_PRESS', 0, { key: k });
    }

    updateCamera(dt) {
      const cam = this.cameraNode, p = this.player;
      if (!cam) return;
      if (!p) {
        this.setCameraFromNode();
        return;
      }
      const c = p.ctrl;
      const head = vAdd(p.position, [0, 0, -c.footOffset + c.height * 0.5]);
      let pos, yaw = this.camYaw, pitch = this.camPitch;
      if (c.type === 'FIRST_PERSON') {
        const eye = -c.footOffset + c.height * 0.92 - (this.input.down('CROUCH') ? 0.45 : 0);
        const bob = c.grounded ? Math.sin(c.bob) * 0.035 : 0;
        pos = vAdd(p.position, [0, 0, eye + bob]);
      } else if ((c.type === 'TOP_DOWN' || c.type === 'SIDE_SCROLLER') && this.camBaseRot) {
        // Fixed-angle follow camera: keep the authored rotation, track the player.
        pos = vAdd(head, this.camOffset);
        cam.position = pos;
        cam.rotation = this.camBaseRot;
        this.updateTransforms();
        this.camPos = pos;
        this.camForward = vNorm(M4.dir(cam.world, [0, 0, -1]));
        return;
      } else {
        const fwd = [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
        const pivot = vAdd(head, [0, 0, c.height * 0.3]);
        let dist = this.camDistance;
        const back = vScale(fwd, -1);
        const hit = this.world.raycast(pivot, back, dist + 0.3);
        if (hit) dist = Math.max(0.6, hit.t - 0.3);
        this.camDist = this.camDist === undefined ? dist : (dist < this.camDist ? dist : lerp(this.camDist, dist, Math.min(1, dt * 4)));
        pos = vAdd(pivot, vScale(back, this.camDist));
      }
      cam.position = pos;
      cam.rotation = Q.fromEuler(Math.PI / 2 + pitch, 0, yaw);
      this.camPos = pos;
      this.camForward = [-Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
      // Weapon sway + recoil for first-person view models parented to the camera.
      for (const w of this.weapon || []) {
        if (!w.basePos || w.parent !== cam) continue;
        const kick = this.muzzle * 0.05;
        const sway = c.grounded ? Math.sin(c.bob) * 0.006 : 0;
        w.position = [w.basePos[0] + sway, w.basePos[1] + Math.abs(sway), w.basePos[2] + kick];
      }
      this.updateTransforms();
    }

    setCameraFromNode() {
      const cam = this.cameraNode;
      this.camPos = cam.worldPos;
      this.camForward = vNorm(M4.dir(cam.world, [0, 0, -1]));
    }

    // ------------------------------------------------------------------- combat
    attack() {
      const p = this.player;
      if (!p) return;
      if (this.shooter) {
        const ammo = p.vars.get('Ammo');
        if (ammo && ammo.value <= 0) { this.toast('Out of ammo — press R to reload'); this.fireCooldown = 0.3; return; }
        if (ammo) ammo.value -= 1;
        this.fireCooldown = 0.16;
        this.muzzle = 1;
        this.sfx.play('shot');
        const origin = this.camPos, dir = this.camForward;
        const wallHit = this.world.raycast(origin, dir, 120);
        const maxT = wallHit ? wallHit.t : 120;
        let best = null, bestT = maxT;
        for (const a of this.actors) {
          if (!a.alive) continue;
          const t = this.rayActor(origin, dir, a);
          if (t !== null && t < bestT) { bestT = t; best = a; }
        }
        if (best) this.damageActor(best, 34, origin);
        this.runBehaviors('ON_CLICK_OBJECT', 0, { target: best || (wallHit ? this.nodes[wallHit.owner] : null) });
      } else {
        this.fireCooldown = 0.45;
        this.sfx.play('melee');
        const fwd = yawDir(p.ctrl.yaw);
        for (const a of this.actors) {
          if (!a.alive) continue;
          const to = vSub(a.position, p.position);
          const d = Math.hypot(to[0], to[1]);
          if (d < 2.3 + a.actor.radius && (d < 0.8 || (to[0] * fwd[0] + to[1] * fwd[1]) / d > 0.3)) this.damageActor(a, 25, p.position);
        }
      }
    }

    rayActor(o, d, a) {
      const ac = a.actor;
      const base = [a.position[0], a.position[1], a.position[2] - ac.footOffset];
      // Ray vs vertical capsule approximated by a cylinder with hemispherical slack.
      const ox = o[0] - base[0], oy = o[1] - base[1];
      const A = d[0] * d[0] + d[1] * d[1], B = 2 * (ox * d[0] + oy * d[1]), C = ox * ox + oy * oy - (ac.radius + 0.1) ** 2;
      if (A < 1e-8) return null;
      const disc = B * B - 4 * A * C;
      if (disc < 0) return null;
      const s = Math.sqrt(disc);
      for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
        if (t < 0) continue;
        const z = o[2] + d[2] * t - base[2];
        if (z >= 0 && z <= ac.height + 0.1) return t;
      }
      return null;
    }

    damageActor(a, amount, from) {
      if (!a.health) return;
      a.health.cur = Math.max(0, a.health.cur - amount);
      a.flash = 1;
      a.actor.seen = true;
      a.actor.state = 'chase';
      this.hitMarker = 0.18;
      this.sfx.play('hit');
      const push = vNorm(vSub(a.position, from));
      a.actor.knock = [push[0] * 4, push[1] * 4];
      this.runBehaviorsOn(a, 'ON_HEALTH_CHANGED', 0);
      if (a.health.cur <= 0) {
        a.alive = false;
        this.sfx.play('kill');
        const p = this.player;
        if (p) {
          const kills = this.ensureVar(p, 'Kills', 'INT', 0); kills.value += 1;
          const score = this.ensureVar(p, 'Score', 'INT', 0); score.value += 100;
        }
        this.toast(`${a.name.replace(/^BE_/, '').replace(/_/g, ' ')} eliminated  +100`);
        this.emit('kill', a);
        if (this.actors.every((x) => !x.alive || !x.actor.hostile) && this.actors.some((x) => x.actor.hostile)) this.toast('Area cleared!');
      }
    }

    damagePlayer(amount, source) {
      const p = this.player;
      if (!p || this.dead || this.won || amount <= 0) return;
      p.health.cur = Math.max(0, p.health.cur - amount);
      this.damageFlash = Math.min(1, this.damageFlash + amount / 25);
      if (source !== 'zone' || Math.random() < 0.08) this.sfx.play('hurt');
      this.runBehaviorsOn(p, 'ON_HEALTH_CHANGED', 0);
      if (p.health.cur <= 0) this.gameOver('You died');
    }

    reload() {
      const p = this.player;
      const ammo = p && p.vars.get('Ammo');
      if (!ammo) return;
      const max = p.maxAmmo || (p.maxAmmo = Math.max(ammo.value, 30));
      if (ammo.value >= max) return;
      this.fireCooldown = 1.0;
      setTimeout(() => { ammo.value = max; this.toast('Reloaded'); }, 900);
      this.sfx.play('door');
    }

    interact() {
      const p = this.player;
      if (!p) return;
      for (const d of this.doors) {
        if (d.opening || d.open > 0) continue;
        const b = d.box;
        const cx = clamp(p.position[0], b.min[0], b.max[0]), cy = clamp(p.position[1], b.min[1], b.max[1]);
        if (Math.hypot(p.position[0] - cx, p.position[1] - cy) < 2.5) { this.openDoor(d); return; }
      }
      for (const a of this.actors) {
        if (!a.alive || a.actor.hostile) continue;
        if (vDist(a.position, p.position) < 3.2) {
          this.toast(a.actor.npc.dialogue_text || `${a.name}: Hello!`);
          if (a.actor.npc.quest_id) this.emit('quest', a.actor.npc.quest_id);
          return;
        }
      }
    }

    openDoor(d) {
      if (d.opening) return;
      d.opening = true;
      this.sfx.play('door');
      this.toast('Door opened');
    }

    updateDoors(dt) {
      for (const d of this.doors) {
        if (!d.opening || d.open >= 1) continue;
        d.open = Math.min(1, d.open + dt * 0.8);
        const h = d.box.max[2] - d.box.min[2];
        d.node.position = [d.base[0], d.base[1], d.base[2] - h * 0.98 * smoothstep(0, 1, d.open)];
      }
    }

    updatePickupsSpin(dt) {
      for (const n of this.triggers) {
        if (n.tag !== 'Coin' || !n.alive) continue;
        n.spin = (n.spin || 0) + dt * 2.2;
        if (!n.baseRot) { n.baseRot = n.rotation.slice(); n.basePosZ = n.position[2]; }
        n.rotation = Q.mul(Q.axisZ(n.spin), n.baseRot);
        n.position[2] = n.basePosZ + Math.sin(this.time * 2.4 + n.index) * 0.06;
      }
    }

    // ---------------------------------------------------------------------- AI
    hasLineOfSight(from, to) {
      const d = vSub(to, from), l = vLen(d);
      if (l < 0.01) return true;
      const hit = this.world.raycast(from, vScale(d, 1 / l), l);
      return !hit;
    }

    updateActors(dt) {
      const p = this.player;
      for (const a of this.actors) {
        if (!a.alive) continue;
        const ac = a.actor;
        ac.attackTimer = Math.max(0, ac.attackTimer - dt);
        const target = (ac.npc.target_object && this.byName.get(ac.npc.target_object)) || p;
        let desired = [0, 0, 0];
        const toT = target ? vSub(target.position, a.position) : [0, 0, 0];
        const dist = target ? Math.hypot(toT[0], toT[1]) : Infinity;
        const eye = vAdd(a.position, [0, 0, -ac.footOffset + ac.height * 0.85]);
        const targetEye = target && target.ctrl ? vAdd(target.position, [0, 0, -target.ctrl.footOffset + target.ctrl.height * 0.8]) : target ? target.position : null;
        if (target && !this.dead && dist < ac.detect && (ac.seen || (this.frameNo + a.index) % 10 === 0)) {
          if (!ac.seen && this.hasLineOfSight(eye, targetEye)) ac.seen = true;
        }
        if (target && dist > ac.detect * 1.6) ac.seen = false;
        const chaseSpeed = ac.speed * 1.25;
        switch (ac.template) {
          case 'PATROL':
          case 'GUARD_AREA':
          case 'IDLE':
          case 'TALK':
          case 'QUEST_GIVER':
          case 'SHOPKEEPER': {
            if (ac.hostile && ac.seen && target === p) desired = this.steer(a, target.position, chaseSpeed, ac.range * 0.9);
            else if (ac.template === 'PATROL' || ac.template === 'GUARD_AREA') desired = this.wander(a, dt);
            else if (target && dist < 6 && !ac.hostile) ac.faceTarget = target.position;
            break;
          }
          case 'FOLLOW_PLAYER':
          case 'COMPANION':
            if (target && dist > 2.4) desired = this.steer(a, target.position, dist > 6 ? ac.speed * 1.4 : ac.speed, 2.0);
            break;
          case 'FLEE':
            if (target && dist < ac.detect) desired = this.steer(a, vAdd(a.position, vSub(a.position, target.position)), ac.speed * 1.2, 0);
            else desired = this.wander(a, dt);
            break;
          default: // ATTACK, ENEMY_BOSS
            if (target && (ac.seen || dist < ac.detect * 0.5)) desired = this.steer(a, target.position, chaseSpeed, ac.range * 0.9);
            else desired = this.wander(a, dt);
        }
        if (ac.hostile && target === p && p && !this.dead && dist <= ac.range + 0.2 && Math.abs(toT[2]) < 2.5) {
          ac.faceTarget = target.position;
          if (ac.attackTimer <= 0) {
            ac.attackTimer = ac.template === 'ENEMY_BOSS' ? 0.9 : 1.1;
            ac.lunge = 0.25;
            this.damagePlayer(ac.template === 'ENEMY_BOSS' ? 18 : 8, a.name);
          }
        }
        // Separation from other actors.
        for (const b of this.actors) {
          if (b === a || !b.alive) continue;
          const d = vSub(a.position, b.position), l = Math.hypot(d[0], d[1]), min = ac.radius + b.actor.radius;
          if (l < min && l > 1e-4) { desired[0] += d[0] / l * (min - l) * 6; desired[1] += d[1] / l * (min - l) * 6; }
        }
        // Knockback from hits decays quickly.
        if (ac.knock) {
          desired[0] += ac.knock[0]; desired[1] += ac.knock[1];
          const decay = Math.exp(-8 * dt);
          ac.knock[0] *= decay; ac.knock[1] *= decay;
        }
        ac.gravity = this.project.physics_gravity || 9.81;
        this.moveCharacter(a, ac, desired, dt, false);
        const sp = Math.hypot(desired[0], desired[1]);
        if (ac.faceTarget) { const f = vSub(ac.faceTarget, a.position); if (Math.hypot(f[0], f[1]) > 0.01) ac.yaw += angleWrap(dirYaw(f) - ac.yaw) * Math.min(1, dt * 8); ac.faceTarget = null; }
        else if (sp > 0.1) ac.yaw += angleWrap(dirYaw(desired) - ac.yaw) * Math.min(1, dt * 8);
        ac.bob += dt * sp * 2.6;
        ac.lunge = Math.max(0, (ac.lunge || 0) - dt);
        const lean = (sp > 0.1 ? Math.sin(ac.bob) * 0.05 : 0) + (ac.lunge > 0 ? 0.25 : 0);
        a.rotation = Q.mul(Q.mul(Q.axisZ(ac.yaw), Q.fromEuler(-lean, 0, Math.sin(ac.bob * 0.5) * 0.04)), ac.baseRot);
        // Falling out of the world removes the actor instead of looping respawns over a hole.
        if (a.position[2] < -60) { a.alive = false; this.log(`${a.name} fell out of the world`); }
      }
    }

    steer(a, target, speed, stop) {
      const ac = a.actor;
      const d = vSub(target, a.position);
      d[2] = 0;
      const l = vLen(d);
      if (l <= stop || l < 1e-3) return [0, 0, 0];
      let dir = vScale(d, 1 / l);
      // Feel ahead for walls and slide around them.
      const probeO = vAdd(a.position, [0, 0, -ac.footOffset + Math.min(ac.height * 0.5, 0.9)]);
      const hit = this.world.raycast(probeO, dir, ac.radius + 1.2);
      if (hit && hit.normal[2] < 0.6) {
        const side = vNorm([-hit.normal[1], hit.normal[0], 0]);
        if (vDot(side, dir) < 0) { side[0] = -side[0]; side[1] = -side[1]; }
        dir = vNorm(vAdd(vScale(side, 0.85), vScale(dir, 0.15)));
      }
      return vScale(dir, speed * Math.min(1, (l - stop) * 2 + 0.3));
    }

    wander(a, dt) {
      const ac = a.actor;
      ac.wanderTimer -= dt;
      if (!ac.wander || ac.wanderTimer <= 0 || vDist2D(a.position, ac.wander) < 0.6) {
        const ang = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * ac.patrol;
        ac.wander = [ac.origin[0] + Math.cos(ang) * r, ac.origin[1] + Math.sin(ang) * r, ac.origin[2]];
        ac.wanderTimer = 3 + Math.random() * 4;
        ac.pause = Math.random() < 0.35 ? 1 + Math.random() * 1.5 : 0;
      }
      if (ac.pause > 0) { ac.pause -= dt; return [0, 0, 0]; }
      return this.steer(a, ac.wander, ac.speed * 0.6, 0.3);
    }

    // ------------------------------------------------------- triggers & behaviors
    aabbOverlap(a, b) {
      return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
    }

    // Thin trigger meshes (rings, flat pads) get a minimum thickness so they are reachable.
    triggerAABB(t) {
      const b = this.nodeAABB(t);
      for (let k = 0; k < 3; k++) {
        const c = (b.min[k] + b.max[k]) / 2, h = Math.max((b.max[k] - b.min[k]) / 2, 0.6);
        b.min[k] = c - h; b.max[k] = c + h;
      }
      return b;
    }

    playerAABB() {
      const p = this.player, c = p.ctrl;
      const feet = p.position[2] - c.footOffset;
      return { min: [p.position[0] - c.radius, p.position[1] - c.radius, feet], max: [p.position[0] + c.radius, p.position[1] + c.radius, feet + c.height] };
    }

    updateTriggers(dt) {
      const active = new Set();
      const movers = [];
      if (this.player && !this.dead) movers.push([this.player, this.playerAABB()]);
      for (const a of this.actors) if (a.alive) movers.push([a, this.subtreeAABB(a)]);
      for (const t of this.triggers) {
        if (!t.alive) continue;
        const tb = this.triggerAABB(t);
        for (const [m, mb] of movers) {
          if (!this.aabbOverlap(tb, mb)) continue;
          const key = t.index + ':' + m.index;
          active.add(key);
          if (m === this.player) this.whileInTrigger(t, dt);
          if (this.triggerOverlaps.has(key)) continue;
          this.runBehaviorsOn(t, 'ON_ENTER_TRIGGER', dt, { tag: m.tag || (m === this.player ? 'Player' : '') });
          this.runBehaviorsOn(m, 'ON_ENTER_TRIGGER', dt, { tag: t.tag });
          if (m === this.player) this.enterTrigger(t);
          this.emit('trigger', t, m);
        }
      }
      this.triggerOverlaps = active;
    }

    enterTrigger(t) {
      if (!this.settings.builtinRules) return;
      const p = this.player;
      const tag = t.tag, name = t.name.toLowerCase();
      if (tag === 'Coin') {
        t.alive = false;
        this.objectives.collected += 1;
        this.ensureVar(p, 'Score', 'INT', 0).value += 10;
        this.sfx.play('pickup');
        this.toast(`Collected ${this.objectives.collected}/${this.objectives.coins}  +10`);
      } else if (tag === 'Health' || tag === 'Med' || tag === 'Medkit') {
        if (p.health.cur >= p.health.max) return;
        t.alive = false;
        p.health.cur = Math.min(p.health.max, p.health.cur + 35);
        this.sfx.play('heal');
        this.toast('+35 health');
      } else if (tag === 'Checkpoint') {
        this.respawn = p.position.slice();
        this.sfx.play('pickup');
        this.toast('Checkpoint saved');
      } else if (tag === 'Ammo') {
        t.alive = false;
        const ammo = this.ensureVar(p, 'Ammo', 'INT', 0);
        ammo.value += 30;
        this.sfx.play('pickup');
        this.toast('+30 ammo');
      } else if (GOAL_TAGS.has(tag) || /portal|exit|goal|finish/.test(name)) {
        const left = this.objectives.coins - this.objectives.collected;
        if (left > 0) { this.toast(`Collect ${left} more coin${left > 1 ? 's' : ''} first`); return; }
        this.victory();
      }
    }

    whileInTrigger(t, dt) {
      if (!this.settings.builtinRules) return;
      if (t.tag === 'Damage' || t.tag === 'Hazard' || t.tag === 'Lava') this.damagePlayer(18 * dt, 'zone');
      if (t.tag === 'Water' && this.player.ctrl) this.player.ctrl.vel[2] = Math.max(this.player.ctrl.vel[2], -2);
    }

    updateCollisions(dt) {
      const active = new Set();
      const movers = [];
      if (this.player) movers.push([this.player, this.playerAABB()]);
      for (const a of this.actors) if (a.alive) movers.push([a, this.subtreeAABB(a)]);
      for (const [m, mb] of movers) {
        for (const c of this.colliderNodes) {
          if (c === m || !c.alive) continue;
          if (!this.aabbOverlap(mb, this.nodeAABB(c))) continue;
          const key = Math.min(c.index, m.index) + ':' + Math.max(c.index, m.index);
          active.add(key);
          if (this.collisionOverlaps.has(key)) continue;
          this.runBehaviorsOn(c, 'ON_COLLISION', dt, { tag: m.tag });
          this.runBehaviorsOn(m, 'ON_COLLISION', dt, { tag: c.tag });
        }
      }
      this.collisionOverlaps = active;
    }

    runBehaviors(eventType, dt, ctx) {
      for (const n of this.nodes) if (n.game && n.game.behaviors.length && n.alive) this.runBehaviorsOn(n, eventType, dt, ctx);
    }

    runBehaviorsOn(n, eventType, dt, ctx = {}) {
      if (!n.game) return;
      for (const b of n.game.behaviors) {
        if (!b.enabled) continue;
        if (b.events.length) {
          if (!this.eventMatches(n, b, eventType, ctx)) continue;
        } else if (eventType !== 'ON_UPDATE') continue;
        if (!this.conditionsPass(n, b.conditions, ctx)) continue;
        for (const action of b.actions) this.runAction(n, action, dt, ctx);
      }
    }

    eventMatches(n, b, type, ctx) {
      for (const e of b.events) {
        if (e.type !== type) continue;
        if (type === 'ON_KEY_PRESS' && e.key && ctx.key && e.key.toUpperCase() !== ctx.key) continue;
        if ((type === 'ON_ENTER_TRIGGER' || type === 'ON_COLLISION') && e.tag && e.tag !== ctx.tag) continue;
        if (type === 'ON_CLICK_OBJECT' && ctx.target !== n) continue;
        if (type === 'CUSTOM_EVENT' && e.custom_event !== ctx.name) continue;
        if (type === 'ON_TIMER') {
          const key = n.index + ':' + b.name + ':' + e.name;
          if (!this.timers.has(key)) this.timers.set(key, this.time + e.timer_seconds);
          if (this.time < this.timers.get(key)) continue;
          this.timers.set(key, this.time + Math.max(0.01, e.timer_seconds));
        }
        return true;
      }
      return false;
    }

    conditionsPass(n, conditions, ctx) {
      const cmp = (l, op, r) => ({ EQUAL: l === r, NOT_EQUAL: l !== r, LESS: l < r, LESS_EQUAL: l <= r, GREATER: l > r, GREATER_EQUAL: l >= r })[op] || false;
      for (const c of conditions) {
        switch (c.type) {
          case 'ALWAYS': break;
          case 'KEY_HELD': if (!this.input.keyDown(c.text_value)) return false; break;
          case 'VARIABLE_COMPARE': {
            const v = n.vars.get(c.variable_name) || (this.player && this.player.vars.get(c.variable_name));
            if (!v) return false;
            const right = v.type === 'BOOL' ? c.bool_value : v.type === 'STRING' ? c.text_value : c.number_value;
            if (!cmp(v.value, c.compare, right)) return false;
            break;
          }
          case 'HEALTH_COMPARE': if (!n.health || !cmp(n.health.cur, c.compare, c.number_value)) return false; break;
          case 'IS_GROUNDED': { const ct = n.ctrl || n.actor; if (!ct || !ct.grounded) return false; break; }
          case 'TAG_MATCH': if ((ctx.tag || '') !== c.text_value) return false; break;
          case 'TIMER_FINISHED': {
            const key = n.index + ':cond:' + c.name;
            if (!this.timers.has(key)) this.timers.set(key, this.time + c.number_value);
            if (this.time < this.timers.get(key)) return false;
            this.timers.set(key, this.time + c.number_value);
            break;
          }
          case 'EVENT_TRIGGERED': if (!this.firedEvents || !this.firedEvents.has(c.text_value)) return false; break;
          default: break;
        }
      }
      return true;
    }

    runAction(owner, a, dt, ctx) {
      const target = (a.target_object && this.byName.get(a.target_object)) || owner;
      const step = dt > 0 ? dt : 1;
      switch (a.type) {
        case 'SHOW_LOG': this.log(a.text_value || `${owner.name} ran ${a.name}`); break;
        case 'MOVE_FORWARD': target.position = vAdd(target.position, vScale(yawDir(this.yawOf(target)), a.number_value * step)); break;
        case 'MOVE_OBJECT': target.position = vAdd(target.position, vScale(a.vector_value, step)); break;
        case 'ROTATE_OBJECT': target.rotation = Q.mul(Q.axisZ(a.number_value * step), target.rotation); break;
        case 'SET_VARIABLE': {
          const v = owner.vars.get(a.variable_name) || (this.player && this.player.vars.get(a.variable_name));
          if (v) v.value = v.type === 'STRING' ? a.text_value : v.type === 'BOOL' ? !!a.number_value : v.type === 'INT' ? Math.round(a.number_value) : a.number_value;
          else owner.vars.set(a.variable_name, { type: 'FLOAT', value: a.number_value });
          break;
        }
        case 'CHANGE_HEALTH': {
          if (!target.health) break;
          if (target === this.player && a.number_value < 0) this.damagePlayer(-a.number_value, owner.name);
          else if (target.actor && a.number_value < 0) this.damageActor(target, -a.number_value, owner.position);
          else target.health.cur = clamp(target.health.cur + a.number_value, 0, target.health.max);
          break;
        }
        case 'OPEN_DOOR': {
          const d = this.doors.find((x) => x.node === target);
          if (d) this.openDoor(d); else target.rotation = Q.mul(Q.axisZ(Math.PI / 2), target.rotation);
          break;
        }
        case 'SPAWN_OBJECT': this.spawn(target, a.vector_value); break;
        case 'PLAY_ANIMATION': this.emit('animation', target, a.animation); break;
        case 'START_CUTSCENE': if (!this.startCinematic()) this.toast(a.text_value || 'Cutscene'); break;
        case 'LOAD_SCENE': this.reset(); break;
        case 'GAME_OVER': this.gameOver(a.text_value || 'Game Over'); break;
        case 'CUSTOM_SCRIPT': {
          const fn = BlendEngine.scripts[a.text_value];
          if (typeof fn === 'function') { try { fn({ game: this, owner, target, action: a, dt }); } catch (err) { console.error(err); } }
          else this.log(`Script "${a.text_value}" not found in BlendEngine.scripts`);
          break;
        }
        default: break;
      }
      if (ctx && ctx.name) (this.firedEvents = this.firedEvents || new Set()).add(ctx.name);
    }

    yawOf(n) {
      if (n.ctrl) return n.ctrl.yaw;
      if (n.actor) return n.actor.yaw;
      const f = M4.dir(n.world, [0, 1, 0]);
      return dirYaw(f);
    }

    spawn(src, offset) {
      if (!src) return null;
      const copy = new Node(Object.assign({}, src.src, { name: src.name + '_' + this.nodes.length, parent: -1, world: Array.from(src.world) }), this.nodes.length);
      copy.mesh = src.mesh;
      const ws = this.decompose(src.world);
      copy.position = vAdd(ws.p, offset || [0, 0, 0]); copy.rotation = ws.q; copy.scale = ws.s;
      this.nodes.push(copy); this.order.push(copy);
      this.byName.set(copy.name, copy);
      copy.updateLocal(); copy.world.set(copy.local);
      this.computeBoundsFor(copy);
      if (copy.has('TRIGGER_ZONE')) this.triggers.push(copy);
      return copy;
    }

    computeBoundsFor(n) {
      n.items = [];
      if (!n.mesh) return;
      for (const prim of n.mesh.primitives) {
        n.items.push({ node: n, world: n.world, gpu: n.mesh.gpu, first: prim.first, count: prim.count, material: this.materials[prim.material] || this.materials[0], matIndex: prim.material, meshIndex: n.src.mesh, center: [0, 0, 0], radius: 0, castShadow: true });
      }
    }

    // --------------------------------------------------------------- game flow
    victory() {
      if (this.won) return;
      this.won = true;
      this.sfx.play('win');
      this.emit('victory');
      const score = this.player ? (this.player.vars.get('Score') || { value: 0 }).value : 0;
      this.ui.showMenu('Level complete!', `Score ${score} · Time ${this.time.toFixed(1)}s`, 'Play again', true);
      this.state = 'ended';
      this.input.releaseLock();
    }

    gameOver(text) {
      if (this.dead) return;
      this.dead = true;
      this.sfx.play('lose');
      this.emit('gameover', text);
      setTimeout(() => {
        this.ui.showMenu(text || 'Game Over', 'Press Restart to try again.', 'Restart', true);
        this.state = 'ended';
        this.input.releaseLock();
      }, 900);
    }

    pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      this.input.releaseLock();
      this.ui.showMenu('Paused', '', 'Resume', true);
    }

    log(text) {
      console.log('[BlendEngine] ' + text);
      if (this.project.debug_mode || this.settings.showLogs) this.toast(text);
    }

    toast(text) { this.ui.toast(text); }

    on(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); }
    emit(event, ...args) {
      for (const fn of this.listeners[event] || []) { try { fn(...args); } catch (err) { console.error(err); } }
      for (const fn of BlendEngine.handlers[event] || []) { try { fn(this, ...args); } catch (err) { console.error(err); } }
    }

    // ------------------------------------------------------------------- render
    renderFrame(opts = {}) {
      if (!this.camPos && this.cameraNode) this.setCameraFromNode();
      const cam = this.activeCamera || this.cameraNode;
      const cinematic = !!this.activeCamera;
      const camData = cam ? Object.assign({}, cam.src.camera) : { type: 'PERSP', fovY: 1, near: 0.1, far: 500 };
      if (cam && cam.animFov) camData.fovY = cam.animFov;
      const world = cam ? cam.world : M4.create();
      if (cinematic) { this.camPos = cam.worldPos; this.camForward = vNorm(M4.dir(cam.world, [0, 0, -1])); }
      const items = [];
      for (const n of this.nodes) {
        if (!n.effectiveVisible || !n.items.length) continue;
        if (cinematic && (n.tag === 'Weapon' || n.tag === 'FirstPersonArms')) continue;
        const center = M4.point(n.world, n.mesh.center), radius = n.mesh.radius * M4.maxScale(n.world);
        for (const it of n.items) { it.center = center; it.radius = radius; it.flash = n.flash || (n.parent && n.parent.flash) || 0; items.push(it); }
      }
      const sun = this.sunNode && this.sunNode.alive
        ? { dir: vNorm(M4.dir(this.sunNode.world, [0, 0, 1])), color: this.sunNode.src.light.color, intensity: this.sunNode.src.light.intensity }
        : { dir: [0.3, -0.4, 0.86], color: [1, 1, 1], intensity: 0 };
      const camPos = this.camPos || [world[12], world[13], world[14]];
      const fwd = this.camForward || [0, 1, 0];
      const R = this.renderer.shadowRadius;
      const focus = this.player && !cinematic ? vAdd(this.player.position, vScale([fwd[0], fwd[1], 0], R * 0.45)) : vAdd(camPos, vScale(fwd, R * 0.6));
      const near = Math.max(0.03, Math.min(camData.near || 0.1, this.player && this.player.ctrl && this.player.ctrl.type === 'FIRST_PERSON' ? 0.03 : 0.1));
      const far = Math.max(camData.far || 300, 50);
      let lens = null;
      if (camData.dof) {
        const fo = camData.dof.focusObject && this.byName.get(camData.dof.focusObject);
        lens = { lens: camData.lens || 50, sensor: camData.sensor || 36, fstop: camData.dof.fstop, dof: camData.dof, focus: fo ? Math.max(0.05, vDot(vSub(fo.worldPos, camPos), fwd)) : camData.dof.focusDistance };
      }
      const frame = {
        film: cinematic || this.state === 'rendering' ? this.film : null,
        accumulating: !!opts.accumulating, resetHistory: !!opts.resetHistory,
        camera: {
          world, pos: camPos, ortho: camData.type === 'ORTHO', lens, near, far,
          proj: (aspect) => (camData.type === 'ORTHO'
            ? M4.ortho(M4.create(), -camData.orthoScale / 2, camData.orthoScale / 2, -camData.orthoScale / 2 / aspect, camData.orthoScale / 2 / aspect, camData.near, camData.far)
            : M4.perspective(M4.create(), camData.fovY, aspect, near, far)),
        },
        items, sun, env: this.env, lights: this.collectLights(camPos), shadowFocus: focus,
        tint: this.damageFlash > 0 ? [1 + this.damageFlash * 0.6, 1 - this.damageFlash * 0.3, 1 - this.damageFlash * 0.3] : null,
      };
      this.renderer.render(frame, opts.output || null);
    }

    adaptResolution(frameMs) {
      if (!this.settings.dynamicResolution) return;
      const ft = this.frameTimes;
      ft.push(frameMs);
      if (ft.length < 45) return;
      const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
      ft.length = 0;
      const budget = 1000 / (this.settings.targetFps || 60);
      const r = this.renderer;
      const maxScale = clamp(this.settings.resolutionScale || 1, 0.4, 1);
      if (avg > budget * 1.2) r.setScale(r.scale - 0.08);
      else if (avg < budget * 0.75 && r.scale < maxScale) r.setScale(Math.min(maxScale, r.scale + 0.05));
    }
  }

  // ===========================================================================
  // ZIP (store) writer for PNG frame sequences
  // ===========================================================================

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const parts = [], central = [];
    let offset = 0;
    const enc = new TextEncoder();
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0, true); local.setUint16(8, 0, true);
      local.setUint16(10, 0, true); local.setUint16(12, 33, true); local.setUint32(14, crc, true); local.setUint32(18, size, true);
      local.setUint32(22, size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, name, f.data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true); cd.setUint16(14, 33, true); cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  // ===========================================================================
  // UI glue and boot
  // ===========================================================================

  function makeUI() {
    const $ = (id) => document.getElementById(id);
    const ui = {
      canvas: $('view'), hud: $('hud'), stats: $('stats'), healthBar: $('health').firstElementChild, perf: $('perf'),
      crosshair: $('crosshair'), toasts: $('toasts'), damage: $('damage'), loading: $('loading'), menu: $('menu'),
      onPlay: null,
      toast(text) {
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = text;
        ui.toasts.appendChild(el);
        while (ui.toasts.children.length > 4) ui.toasts.firstChild.remove();
        setTimeout(() => el.remove(), 2700);
      },
      showMenu(title, text, button, restart) {
        $('menu-title').textContent = title;
        $('menu-text').textContent = text;
        $('menu-play').textContent = button;
        $('menu-restart').classList.toggle('hidden', !restart || button === 'Restart' || button === 'Play again');
        ui.menu.classList.remove('hidden');
      },
      hideMenu() { ui.menu.classList.add('hidden'); },
    };
    return ui;
  }

  function decodeBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  const BlendEngine = {
    version: '2.0.0',
    scripts: {},
    handlers: {},
    game: null,
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); },
    async boot(data) {
      const ui = makeUI();
      const fail = (msg) => {
        document.body.insertAdjacentHTML('beforeend', `<div id="error"><div><h2>BlendEngine could not start</h2><p>${msg}</p></div></div>`);
      };
      if (!data || data.format !== 'BlendEngineScene') { fail('scene_data.js is missing or invalid. Re-export the game from BlendEngine.'); return; }
      const title = (data.game && data.game.project && data.game.project.title) || 'BlendEngine Game';
      document.title = title;
      document.getElementById('title').textContent = title;
      const bar = document.querySelector('#progress > div');
      let game;
      try {
        const buffer = decodeBase64(data.buffer || '');
        game = new Game(data, buffer, ui);
        this.game = game;
        await game.load((f) => { bar.style.width = Math.round(f * 100) + '%'; });
      } catch (err) {
        console.error(err);
        fail(String(err && err.message ? err.message : err));
        return;
      }
      ui.loading.classList.add('hidden');
      const controller = game.player ? game.player.ctrl.type : 'NONE';
      const mouseLook = ['FIRST_PERSON', 'THIRD_PERSON', 'FLYING'].includes(controller);
      document.getElementById('menu-controls').textContent = game.isTouch
        ? 'Left stick move · drag right side to look · buttons to jump, fire and use'
        : `WASD move · Space jump · Shift sprint · ${mouseLook ? 'Mouse look · ' : ''}${game.shooter ? 'Click fire · R reload' : 'F attack'} · E use · Esc pause · F3 stats`;
      const filmMode = game.film.playMode === 'FILM' || !game.player;
      if (filmMode && game.hasCinematic) ui.showMenu(title, `A BlendEngine film · ${((game.timeline.frameEnd - game.timeline.frameStart + 1) / game.timeline.fps).toFixed(1)} s`, 'Play film', false);
      else ui.showMenu(title, game.shooter ? 'Survive, clear the area and reach the exit.' : 'Explore, collect and reach the goal.', 'Play', false);
      document.getElementById('film-buttons').classList.toggle('hidden', !game.hasCinematic);
      const watchFilm = () => { game.sfx.unlock(); ui.hideMenu(); game.startCinematic({ film: true }); };
      document.getElementById('menu-film').addEventListener('click', watchFilm);
      document.getElementById('menu-record').addEventListener('click', () => {
        ui.hideMenu();
        game.recordFilm((blob) => download(blob, (title.replace(/[^\w-]+/g, '_') || 'film') + '.webm'));
      });
      const renderScreen = document.getElementById('render');
      document.getElementById('render-cancel').addEventListener('click', () => { game.cancelRender = true; });
      document.getElementById('menu-render').addEventListener('click', async () => {
        ui.hideMenu();
        renderScreen.classList.remove('hidden');
        const bar = renderScreen.querySelector('#render-progress > div'), text = document.getElementById('render-text');
        const started = performance.now();
        try {
          const zip = await game.renderFilm({
            onProgress: (f, frame) => {
              bar.style.width = (f * 100).toFixed(1) + '%';
              const left = (performance.now() - started) / f * (1 - f) / 1000;
              text.textContent = `Frame ${frame} · ${game.film.samples} samples · ${Math.round(f * 100)}% · ~${Math.ceil(left)} s left`;
            },
          });
          download(zip, (title.replace(/[^\w-]+/g, '_') || 'film') + '_frames.zip');
        } catch (err) {
          console.error(err);
          ui.toast(String(err.message || err));
        }
        renderScreen.classList.add('hidden');
        ui.showMenu(title, 'Film frames saved as a ZIP of PNG images.', 'Play', false);
      });
      if (game.isTouch) setupTouch(game.input, document.getElementById('touch'));
      if (game.project.show_fps || game.project.debug_mode) ui.perf.classList.remove('hidden');
      if (controller === 'FIRST_PERSON' || game.shooter) ui.crosshair.classList.remove('hidden');

      const start = () => {
        game.sfx.unlock();
        if (filmMode && game.hasCinematic) { if (game.state === 'ended') game.reset(); watchFilm(); return; }
        if (game.state === 'ended') { game.reset(); }
        game.state = 'playing';
        ui.hideMenu();
        ui.hud.classList.remove('hidden');
        if (mouseLook && !game.isTouch) game.input.requestLock();
        ui.canvas.focus();
      };
      document.getElementById('menu-play').addEventListener('click', start);
      document.getElementById('menu-restart').addEventListener('click', () => { game.state = 'ended'; start(); });
      game.input.onLockChange = (locked) => { if (!locked && game.state === 'playing' && mouseLook && !game.isTouch) game.pause(); };
      ui.canvas.addEventListener('click', () => { if (game.state === 'playing' && mouseLook && !game.isTouch) game.input.requestLock(); });
      addEventListener('resize', () => game.renderer.resize());
      document.addEventListener('visibilitychange', () => { if (document.hidden) game.pause(); });

      let last = performance.now(), hudTimer = 0, fpsAvg = 60;
      game.frameNo = 0;
      const frame = (now) => {
        const realDt = Math.min((now - last) / 1000, 0.1);
        last = now;
        game.frameNo++;
        const dt = Math.min(realDt, 1 / 20);
        game.input.pollGamepad();
        if (game.state === 'rendering') { game.input.endFrame(); requestAnimationFrame(frame); return; }
        if (game.state === 'playing') game.update(dt);
        else if (game.state === 'cinematic') game.updateCinematic(realDt);
        else if (game.state === 'paused' && game.input.pressed('PAUSE')) start();
        if (game.state !== 'playing' && !game.camPos) game.updateCamera(0);
        const t0 = performance.now();
        game.renderFrame();
        game.adaptResolution(realDt * 1000);
        fpsAvg = lerp(fpsAvg, 1 / Math.max(realDt, 1e-3), 0.08);
        hudTimer -= realDt;
        if (hudTimer <= 0) { hudTimer = 0.1; updateHud(game, ui, fpsAvg, performance.now() - t0); }
        game.input.endFrame();
        requestAnimationFrame(frame);
      };
      game.updateCamera(0);
      requestAnimationFrame(frame);
    },
  };

  function updateHud(game, ui, fps, cpuMs) {
    const p = game.player;
    if (p && p.health) ui.healthBar.style.width = (100 * p.health.cur / p.health.max).toFixed(1) + '%';
    const parts = [];
    if (p) {
      for (const [name, v] of p.vars) if (['Score', 'Ammo', 'Kills', 'Coins', 'Lives'].includes(name) || game.project.show_game_variables) parts.push(`${name} ${typeof v.value === 'number' ? Math.round(v.value * 100) / 100 : v.value}`);
      if (game.objectives.coins) parts.push(`Coins ${game.objectives.collected}/${game.objectives.coins}`);
    }
    const text = parts.join('   ');
    if (ui.stats.textContent !== text) ui.stats.textContent = text;
    ui.crosshair.classList.toggle('hit', game.hitMarker > 0);
    ui.damage.style.opacity = Math.min(0.9, game.damageFlash).toFixed(2);
    if (!ui.perf.classList.contains('hidden')) {
      const r = game.renderer;
      ui.perf.textContent = `FPS ${fps.toFixed(0)}  CPU ${cpuMs.toFixed(1)} ms\nDraws ${r.stats.draws}  Tris ${Math.round(r.stats.tris).toLocaleString()}\nRes ${r.size[0]}x${r.size[1]} (${Math.round(r.scale * 100)}%)\nCollision tris ${game.world.triangleCount.toLocaleString()}\n${r.hdr ? 'HDR' : 'LDR'} ${game.settings.ssao ? 'SSAO ' : ''}${game.settings.bloom ? 'Bloom ' : ''}${game.settings.antiAliasing !== 'OFF' ? 'FXAA' : ''}`;
    }
  }

  BlendEngine.math = { M4, Q, vAdd, vSub, vScale, vDot, vCross, vLen, vNorm, clamp, lerp };
  BlendEngine.StaticWorld = StaticWorld;
  window.BlendEngine = BlendEngine;
})();
