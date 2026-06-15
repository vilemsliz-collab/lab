import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// MediaPipe is loaded lazily (dynamic import) inside getSegmenter() so a CDN
// failure there can never take down the core preview + effects.

/* ─────────────────────────────────────────────────────────────
   Halation — photo/video effects lab. Bloom + lens blurs +
   chromatic dispersion + a glitch pack + a particle system, all
   live-controllable, with subject tracking via MediaPipe.
   ───────────────────────────────────────────────────────────── */

const MAX_SIDE_IMAGE = 1920;
const MAX_SIDE_VIDEO = 1280;
const MAX_PARTICLES = 3000;

const dom = {
  canvas:    document.getElementById('gl'),
  stage:     document.getElementById('stage'),
  empty:     document.getElementById('empty'),
  loading:   document.getElementById('loading'),
  loadingTx: document.getElementById('loadingText'),
  rec:       document.getElementById('recBadge'),
  compare:   document.getElementById('compareBtn'),
  file:      document.getElementById('file'),
  video:     document.getElementById('video'),
  addBtn:    document.getElementById('addBtn'),
  emptyAdd:  document.getElementById('emptyAdd'),
  sampleBtn: document.getElementById('sampleBtn'),
  exportBtn: document.getElementById('exportBtn'),
  tabs:      document.getElementById('tabs'),
  panes:     document.getElementById('panes'),
  panel:     document.getElementById('panel'),
  handle:    document.getElementById('panelHandle'),
};

/* ── Effect state (single source of truth) ── */
const state = {
  // blur / lens
  bloomStrength: 0.6, bloomRadius: 0.6, bloomThreshold: 0.8,
  soft: 0, zoom: 0, motion: 0, motionAngle: 0, dofBg: 0,
  dispAmount: 0.006, focus: 0.1,
  // glitch (each independent)
  glTrack: 0.5, glRgb: 0, glSlice: 0, glScan: 0, glNoise: 0, glWave: 0, glPixel: 0, glCrush: 0,
  maskInvert: false,
  // particles
  pCount: 0, pSize: 0.5, pSpeed: 0.5, pGlow: 0.6, pHue: 0, pType: 0,
};

/* ── Control schema → builds the panel UI ── */
const CONTROLS = {
  blur: [
    { t: 'slider', key: 'bloomStrength',  label: 'Halation glow',  min: 0, max: 3, step: 0.01 },
    { t: 'slider', key: 'bloomRadius',    label: 'Glow radius',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomThreshold', label: 'Glow threshold', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'soft',           label: 'Gaussian blur',  min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'zoom',           label: 'Zoom blur',      min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'motion',         label: 'Motion blur',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'motionAngle',    label: 'Motion angle',   min: 0, max: 6.283, step: 0.01 },
    { t: 'slider', key: 'dofBg',          label: 'Background DoF', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'dispAmount',     label: 'Chromatic aberration', min: 0, max: 0.06, step: 0.001 },
    { t: 'slider', key: 'focus',          label: 'Subject focus',  min: 0, max: 1, step: 0.01 },
  ],
  glitch: [
    { t: 'slider', key: 'glRgb',   label: 'RGB shift',     min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glSlice', label: 'Slice tear',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glWave',  label: 'Wave warp',     min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glPixel', label: 'Pixelate',      min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glCrush', label: 'Color crush',   min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glNoise', label: 'Digital noise', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glScan',  label: 'Scanlines',     min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'glTrack', label: 'Track subject', min: 0, max: 1, step: 0.01 },
    { t: 'toggle', key: 'maskInvert', label: 'Invert subject mask' },
    { t: 'burst' },
  ],
  particles: [
    { t: 'select', key: 'pType', label: 'Type', options: [
      { label: 'Dust', val: 0 }, { label: 'Bokeh', val: 1 }, { label: 'Snow', val: 2 }, { label: 'Sparks', val: 3 } ] },
    { t: 'slider', key: 'pCount', label: 'Amount',     min: 0, max: MAX_PARTICLES, step: 10 },
    { t: 'slider', key: 'pSize',  label: 'Size',       min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'pSpeed', label: 'Speed',      min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'pGlow',  label: 'Brightness', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'pHue',   label: 'Tint',       min: 0, max: 1, step: 0.01 },
  ],
};

/* ─────────────────────────── Shaders ─────────────────────────── */
const PASS_VERT = `varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const MASK_SAMPLE = `float maskAt(sampler2D t, vec2 uv, float inv){ float m = texture2D(t, vec2(uv.x, 1.0-uv.y)).r; return mix(m, 1.0-m, inv); }`;

const DispersionShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null },
    uAmount: { value: state.dispAmount }, uFocus: { value: state.focus }, uMaskInvert: { value: 0 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tMask; uniform float uAmount, uFocus, uMaskInvert; varying vec2 vUv;
    ${MASK_SAMPLE}
    void main(){
      float m = maskAt(tMask, vUv, uMaskInvert);
      vec2 dir = vUv - 0.5; float dist = length(dir);
      vec2 off = normalize(dir + 1e-6) * (uAmount * dist);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= 1.0 - uFocus * 0.6 * (1.0 - m);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const LensBlurShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, uTexel: { value: new THREE.Vector2() },
    uSoft: { value: 0 }, uZoom: { value: 0 }, uMotion: { value: 0 }, uAngle: { value: 0 },
    uDofBg: { value: 0 }, uMaskInvert: { value: 0 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tMask; uniform vec2 uTexel;
    uniform float uSoft, uZoom, uMotion, uAngle, uDofBg, uMaskInvert; varying vec2 vUv;
    ${MASK_SAMPLE}
    void main(){
      float m = maskAt(tMask, vUv, uMaskInvert);
      float soft = uSoft + uDofBg * (1.0 - m);
      vec3 col = texture2D(tDiffuse, vUv).rgb; float wsum = 1.0;
      if (soft > 0.002){
        for (int i = 0; i < 10; i++){
          float a = float(i) / 10.0 * 6.2831853;
          vec2 o = vec2(cos(a), sin(a)) * uTexel * soft * 22.0;
          col += texture2D(tDiffuse, vUv + o).rgb;
          col += texture2D(tDiffuse, vUv + o * 0.5).rgb;
          wsum += 2.0;
        }
      }
      if (uZoom > 0.002){
        vec2 dir = 0.5 - vUv;
        for (int i = 1; i <= 8; i++){
          float s = float(i) / 8.0;
          col += texture2D(tDiffuse, vUv + dir * s * uZoom * 0.3).rgb; wsum += 1.0;
        }
      }
      if (uMotion > 0.002){
        vec2 dir = vec2(cos(uAngle), sin(uAngle));
        for (int i = -6; i <= 6; i++){
          if (i == 0) continue;
          col += texture2D(tDiffuse, vUv + dir * float(i) * uMotion * uTexel * 7.0).rgb; wsum += 1.0;
        }
      }
      gl_FragColor = vec4(col / wsum, 1.0);
    }`,
};

const GlitchShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    uRgb: { value: 0 }, uSlice: { value: 0 }, uScan: { value: 0 }, uNoise: { value: 0 },
    uWave: { value: 0 }, uPixel: { value: 0 }, uCrush: { value: 0 },
    uTrack: { value: state.glTrack }, uBurst: { value: 0 }, uMaskInvert: { value: 0 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tMask; uniform vec2 uRes;
    uniform float uTime, uRgb, uSlice, uScan, uNoise, uWave, uPixel, uCrush, uTrack, uBurst, uMaskInvert;
    varying vec2 vUv;
    ${MASK_SAMPLE}
    float hash(float n){ return fract(sin(n) * 43758.5453123); }
    float hash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      float m = maskAt(tMask, vUv, uMaskInvert);
      float track = mix(1.0, m, uTrack);
      float t = floor(uTime * 14.0);
      vec2 uv = vUv;

      if (uPixel > 0.002){ float cells = mix(1200.0, 22.0, uPixel); uv = (floor(uv * cells) + 0.5) / cells; }

      uv.x += sin(uv.y * 38.0 + uTime * 3.0) * 0.02 * uWave * track;
      uv.y += cos(uv.x * 26.0 + uTime * 2.2) * 0.012 * uWave * track;

      float sl = floor(vUv.y * 26.0);
      float sliceOn = step(0.7, hash(sl + t * 1.7));
      uv.x += (hash(sl * 3.3 + t) - 0.5) * 0.16 * (uSlice + uBurst) * sliceOn * track;

      float rgbAmt = 0.024 * (uRgb + uBurst) * track;
      rgbAmt *= mix(1.0, 3.0, step(0.92, hash(t * 2.1)));
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(rgbAmt, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(rgbAmt, 0.0)).b;

      vec2 blk = floor(vUv * (uRes / 8.0));
      float hit = step(0.96, hash2(blk + t)) * (uNoise + uBurst) * track;
      col = mix(col, vec3(hash2(blk * 1.31 + t)), clamp(hit, 0.0, 1.0) * 0.85);

      if (uCrush > 0.002){ float levels = mix(255.0, 3.0, uCrush); col = floor(col * levels + 0.5) / levels; }

      float scan = sin(vUv.y * uRes.y * 1.5) * 0.5 + 0.5;
      col *= 1.0 - uScan * 0.25 * scan;

      gl_FragColor = vec4(col, 1.0);
    }`,
};

/* ── Custom bloom — byte render targets only (iOS-safe). ── */
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BrightShader = {
  uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.8 } }, vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uThreshold; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(c.r, max(c.g, c.b));
      gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.2, l), 1.0); }`,
};
const BlurShader = {
  uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 uDir, uTexel; uniform float uRadius; varying vec2 vUv;
    void main(){ vec2 d = uDir * uTexel * uRadius;
      vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
      c += (texture2D(tDiffuse, vUv + d).rgb     + texture2D(tDiffuse, vUv - d).rgb)     * 0.1945946;
      c += (texture2D(tDiffuse, vUv + d*2.0).rgb + texture2D(tDiffuse, vUv - d*2.0).rgb) * 0.1216216;
      c += (texture2D(tDiffuse, vUv + d*3.0).rgb + texture2D(tDiffuse, vUv - d*3.0).rgb) * 0.0540540;
      c += (texture2D(tDiffuse, vUv + d*4.0).rgb + texture2D(tDiffuse, vUv - d*4.0).rgb) * 0.0162162;
      gl_FragColor = vec4(c, 1.0); }`,
};
const CompositeShader = {
  uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } }, vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse, tBloom; uniform float uStrength; varying vec2 vUv;
    void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength, 1.0); }`,
};

class HalationBloomPass extends Pass {
  constructor(w, h) {
    super();
    this.strength = state.bloomStrength; this.radius = state.bloomRadius; this.threshold = state.bloomThreshold;
    const opt = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace };
    this.rtBright = new THREE.WebGLRenderTarget(1, 1, opt);
    this.rtA = new THREE.WebGLRenderTarget(1, 1, opt);
    this.rtB = new THREE.WebGLRenderTarget(1, 1, opt);
    this.brightQuad = new FullScreenQuad(new THREE.ShaderMaterial(BrightShader));
    this.blurQuad = new FullScreenQuad(new THREE.ShaderMaterial(BlurShader));
    this.compQuad = new FullScreenQuad(new THREE.ShaderMaterial(CompositeShader));
    this.texel = new THREE.Vector2();
    this.setSize(w, h);
  }
  setSize(w, h) {
    const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1);
    this.rtBright.setSize(dw, dh); this.rtA.setSize(dw, dh); this.rtB.setSize(dw, dh);
    this.texel.set(1 / dw, 1 / dh);
  }
  render(renderer, writeBuffer, readBuffer) {
    if (this.strength <= 0.0001) {
      const c = this.compQuad.material.uniforms;
      c.tDiffuse.value = readBuffer.texture; c.tBloom.value = readBuffer.texture; c.uStrength.value = 0;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.compQuad.render(renderer); return;
    }
    const b = this.brightQuad.material.uniforms;
    b.tDiffuse.value = readBuffer.texture; b.uThreshold.value = this.threshold;
    renderer.setRenderTarget(this.rtBright); this.brightQuad.render(renderer);
    const blur = this.blurQuad.material.uniforms; blur.uTexel.value.copy(this.texel);
    let src = this.rtBright;
    for (let i = 0; i < 5; i++) {
      const r = (1.0 + i) * (0.6 + this.radius * 2.4);
      blur.tDiffuse.value = src.texture; blur.uDir.value.set(1, 0); blur.uRadius.value = r;
      renderer.setRenderTarget(this.rtA); this.blurQuad.render(renderer);
      blur.tDiffuse.value = this.rtA.texture; blur.uDir.value.set(0, 1);
      renderer.setRenderTarget(this.rtB); this.blurQuad.render(renderer);
      src = this.rtB;
    }
    const c = this.compQuad.material.uniforms;
    c.tDiffuse.value = readBuffer.texture; c.tBloom.value = src.texture; c.uStrength.value = this.strength;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.compQuad.render(renderer);
  }
  dispose() {
    this.rtBright.dispose(); this.rtA.dispose(); this.rtB.dispose();
    this.brightQuad.dispose(); this.blurQuad.dispose(); this.compQuad.dispose();
  }
}

/* ─────────────────────────── Renderer ─────────────────────────── */
const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: false, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: null }));
scene.add(quad);

/* ── Particle system (drawn over the composed image) ── */
const particleScene = new THREE.Scene();
let particleMat;
function buildParticles() {
  const pos = new Float32Array(MAX_PARTICLES * 3);
  const rnd = new Float32Array(MAX_PARTICLES);
  const idx = new Float32Array(MAX_PARTICLES);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    pos[i * 3] = Math.random() * 2 - 1;
    pos[i * 3 + 1] = Math.random() * 2 - 1;
    pos[i * 3 + 2] = Math.random();        // phase seed
    rnd[i] = Math.random();
    idx[i] = i;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  geo.setAttribute('aIndex', new THREE.BufferAttribute(idx, 1));

  particleMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uCount: { value: 0 }, uType: { value: 0 },
      uSize: { value: 0.5 }, uSpeed: { value: 0.5 }, uGlow: { value: 0.6 }, uHue: { value: 0 }, uScale: { value: 1 },
    },
    vertexShader: `
      attribute float aRand; attribute float aIndex;
      uniform float uTime, uCount, uType, uSize, uSpeed, uScale;
      varying float vType;
      void main(){
        vType = uType;
        if (aIndex >= uCount){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        vec2 p = position.xy; float ph = position.z; float t = uTime; float sp = uSpeed;
        if (uType < 0.5){            // dust — gentle brownian drift
          p.x += sin(t * 0.3 * sp + ph * 6.28) * 0.06;
          p.y += cos(t * 0.23 * sp + ph * 9.42) * 0.06;
        } else if (uType < 1.5){     // bokeh — slow upward float
          p.y = mod(p.y + 1.0 + t * 0.05 * sp * (0.5 + aRand), 2.0) - 1.0;
          p.x += sin(t * 0.2 * sp + ph * 6.28) * 0.03;
        } else if (uType < 2.5){     // snow — fall down + sway
          p.y = 1.0 - mod(ph * 2.0 + t * 0.18 * sp * (0.5 + aRand), 2.0);
          p.x += sin(t * 0.8 * sp + ph * 12.0) * 0.04;
        } else {                     // sparks — rise fast + flicker
          p.y = -1.0 + mod(ph * 2.0 + t * 0.5 * sp * (0.6 + aRand), 2.0);
          p.x += sin(t * 2.0 * sp + ph * 20.0) * 0.02;
        }
        float typeSize = (uType < 0.5) ? 0.5 : (uType < 1.5) ? 2.2 : (uType < 2.5) ? 1.0 : 0.6;
        gl_PointSize = uSize * (3.0 + aRand * 26.0) * typeSize * uScale;
        gl_Position = vec4(p, 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform float uGlow, uHue; varying float vType;
      vec3 hsv2rgb(vec3 c){ vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
      void main(){
        vec2 q = gl_PointCoord - 0.5; float d = length(q); float a;
        if (vType < 1.5){ a = smoothstep(0.5, 0.0, d); if (vType > 0.5) a = mix(a, smoothstep(0.5, 0.42, d), 0.4); }
        else if (vType < 2.5){ a = smoothstep(0.5, 0.12, d); }
        else { a = smoothstep(0.5, 0.0, d); a *= a; }
        if (a < 0.01) discard;
        vec3 col = mix(vec3(1.0), hsv2rgb(vec3(uHue, 0.7, 1.0)), step(0.001, uHue));
        gl_FragColor = vec4(col, a * uGlow);
      }`,
  });
  particleScene.add(new THREE.Points(geo, particleMat));
}
buildParticles();

/* ── Composer ── */
let composer, bloomPass, dispPass, blurPass, glitchPass;
function buildComposer(w, h) {
  if (composer) composer.dispose();
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1); composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));

  dispPass = new ShaderPass(DispersionShader); composer.addPass(dispPass);
  blurPass = new ShaderPass(LensBlurShader); blurPass.uniforms.uTexel.value.set(1 / w, 1 / h); composer.addPass(blurPass);
  bloomPass = new HalationBloomPass(w, h); composer.addPass(bloomPass);
  glitchPass = new ShaderPass(GlitchShader); glitchPass.uniforms.uRes.value.set(w, h); composer.addPass(glitchPass);
  composer.addPass(new OutputPass());

  particleMat.uniforms.uScale.value = h / 1000;
  applyState();
}

/* ── Foreground mask texture ── */
let maskTex = makeMaskTexture(new Uint8Array([255]), 1, 1);
function makeMaskTexture(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
  return tex;
}
let maskBuf = null;
function setMaskUniforms() {
  if (dispPass) dispPass.uniforms.tMask.value = maskTex;
  if (blurPass) blurPass.uniforms.tMask.value = maskTex;
  if (glitchPass) glitchPass.uniforms.tMask.value = maskTex;
}
function updateMaskFromResult(result) {
  const mask = result.confidenceMasks && result.confidenceMasks[0];
  if (!mask) return;
  const w = mask.width, h = mask.height, f32 = mask.getAsFloat32Array();
  if (!maskBuf || maskBuf.length !== w * h) maskBuf = new Uint8Array(w * h);
  for (let i = 0; i < f32.length; i++) maskBuf[i] = (f32[i] * 255) | 0;
  if (maskTex.image.width !== w || maskTex.image.height !== h) { maskTex.dispose(); maskTex = makeMaskTexture(maskBuf, w, h); }
  else { maskTex.image.data = maskBuf; maskTex.needsUpdate = true; }
  setMaskUniforms();
}

/* ─────────────────────── MediaPipe segmenter ─────────────────────── */
let segmenter = null, segmenterMode = null;
async function getSegmenter(mode) {
  if (segmenter && segmenterMode === mode) return segmenter;
  showLoading(true, 'Loading subject model…');
  try {
    if (!segmenter) {
      const { FilesetResolver, ImageSegmenter } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18');
      const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm');
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', delegate: 'GPU' },
        runningMode: mode, outputConfidenceMasks: true, outputCategoryMask: false,
      });
    } else { await segmenter.setOptions({ runningMode: mode }); }
    segmenterMode = mode;
  } catch (e) { console.warn('Segmenter unavailable; effects apply globally.', e); segmenter = null; }
  finally { showLoading(false); }
  return segmenter;
}

/* ─────────────────────────── Media loading ─────────────────────────── */
let media = { type: null, el: null, w: 0, h: 0 };
let lastVideoTs = -1;

function fitCanvasStyle(w, h) {
  const sw = dom.stage.clientWidth, sh = dom.stage.clientHeight;
  if (!sw || !sh) return;
  const scale = Math.min(sw / w, sh / h);
  dom.canvas.style.width = Math.round(w * scale) + 'px';
  dom.canvas.style.height = Math.round(h * scale) + 'px';
}
function capSize(w, h, maxSide) { const s = Math.min(1, maxSide / Math.max(w, h)); return [Math.round(w * s), Math.round(h * s)]; }

async function loadImage(src, revoke) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('This image format can’t be decoded by your browser (e.g. HEIC). Try a JPG or PNG.'));
    img.src = src;
  });
  if (revoke) URL.revokeObjectURL(src);
  const [w, h] = capSize(img.naturalWidth, img.naturalHeight, MAX_SIDE_IMAGE);
  const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  setupMedia('image', img, w, h, tex);
  const seg = await getSegmenter('IMAGE');
  if (seg) { try { updateMaskFromResult(seg.segment(img)); } catch (e) { console.warn(e); } }
}

async function loadVideo(src) {
  const v = dom.video; v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error('This video format can’t be played by your browser. Try an MP4 (H.264).'));
  });
  const [w, h] = capSize(v.videoWidth, v.videoHeight, MAX_SIDE_VIDEO);
  const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  setupMedia('video', v, w, h, tex);
  await getSegmenter('VIDEO'); lastVideoTs = -1; v.play().catch(() => {});
}

function setupMedia(type, el, w, h, tex) {
  media = { type, el, w, h };
  quad.material.map = tex; quad.material.needsUpdate = true;
  renderer.setSize(w, h, false);
  buildComposer(w, h);
  fitCanvasStyle(w, h);
  setMaskUniforms();
  dom.empty.classList.add('hidden');
  dom.compare.classList.remove('hidden'); dom.compare.disabled = false;
  dom.exportBtn.disabled = false;
  dom.exportBtn.textContent = type === 'video' ? 'Record' : 'Export';
}

/* ─────────────────────────── Render loop ─────────────────────────── */
const clock = new THREE.Clock();
let bypass = false, burst = 0;

function renderFrame() {
  if (media.type === 'video' && !dom.video.paused && segmenter && segmenterMode === 'VIDEO') {
    const ts = performance.now();
    if (ts !== lastVideoTs) { lastVideoTs = ts; try { segmenter.segmentForVideo(dom.video, ts, updateMaskFromResult); } catch (e) {} }
  }
  if (burst > 0) { burst = Math.max(0, burst - clock.getDelta() * 2.2); }
  if (glitchPass) { glitchPass.uniforms.uTime.value = clock.elapsedTime; glitchPass.uniforms.uBurst.value = burst; }
  if (!composer) return;
  if (bypass) { renderer.render(scene, camera); return; }
  composer.render();
  if (state.pCount > 0) {
    particleMat.uniforms.uTime.value = clock.elapsedTime;
    renderer.autoClear = false; renderer.render(particleScene, camera); renderer.autoClear = true;
  }
}
function tick() { requestAnimationFrame(tick); if (media.type) renderFrame(); }
tick();

/* ─────────────────────────── State → uniforms ─────────────────────────── */
function applyState() {
  if (bloomPass) { bloomPass.strength = state.bloomStrength; bloomPass.radius = state.bloomRadius; bloomPass.threshold = state.bloomThreshold; }
  if (dispPass) { const u = dispPass.uniforms; u.uAmount.value = state.dispAmount; u.uFocus.value = state.focus; u.uMaskInvert.value = state.maskInvert ? 1 : 0; }
  if (blurPass) { const u = blurPass.uniforms; u.uSoft.value = state.soft; u.uZoom.value = state.zoom; u.uMotion.value = state.motion; u.uAngle.value = state.motionAngle; u.uDofBg.value = state.dofBg; u.uMaskInvert.value = state.maskInvert ? 1 : 0; }
  if (glitchPass) { const u = glitchPass.uniforms;
    u.uRgb.value = state.glRgb; u.uSlice.value = state.glSlice; u.uScan.value = state.glScan; u.uNoise.value = state.glNoise;
    u.uWave.value = state.glWave; u.uPixel.value = state.glPixel; u.uCrush.value = state.glCrush; u.uTrack.value = state.glTrack;
    u.uMaskInvert.value = state.maskInvert ? 1 : 0; }
  const p = particleMat.uniforms;
  p.uCount.value = state.pCount; p.uType.value = state.pType; p.uSize.value = state.pSize;
  p.uSpeed.value = state.pSpeed; p.uGlow.value = state.pGlow; p.uHue.value = state.pHue;
}

/* ─────────────────────────── Panel UI ─────────────────────────── */
const sliderEls = {};
function buildPanel() {
  for (const [tab, controls] of Object.entries(CONTROLS)) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (tab === 'blur' ? ' pane--active' : ''); pane.dataset.pane = tab;
    let chipRow = null;
    for (const c of controls) {
      if (c.t === 'slider') pane.appendChild(buildSlider(c));
      else if (c.t === 'select') pane.appendChild(buildSelect(c));
      else if (c.t === 'toggle') { if (!chipRow) { chipRow = document.createElement('div'); chipRow.className = 'chips'; pane.appendChild(chipRow); } chipRow.appendChild(buildToggle(c)); }
      else if (c.t === 'burst') {
        const b = document.createElement('button'); b.className = 'burst'; b.textContent = '⚡ Glitch burst';
        b.onclick = () => { burst = 1; }; pane.appendChild(b);
      }
    }
    dom.panes.appendChild(pane);
  }
}
function buildSlider(c) {
  const wrap = document.createElement('label'); wrap.className = 'ctrl';
  const row = document.createElement('div'); row.className = 'ctrl__row';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const val = document.createElement('span'); val.className = 'ctrl__val';
  const input = document.createElement('input'); input.type = 'range'; input.min = c.min; input.max = c.max; input.step = c.step; input.value = state[c.key];
  const fmt = v => (c.step >= 1 ? String(Math.round(v)) : c.step < 0.01 ? (+v).toFixed(3) : (+v).toFixed(2));
  const paint = () => { val.textContent = fmt(input.value); input.style.setProperty('--fill', ((input.value - c.min) / (c.max - c.min)) * 100 + '%'); };
  input.addEventListener('input', () => { state[c.key] = parseFloat(input.value); paint(); applyState(); });
  paint(); row.append(lab, val); wrap.append(row, input); sliderEls[c.key] = { input, paint }; return wrap;
}
function buildSelect(c) {
  const wrap = document.createElement('div'); wrap.className = 'ctrl';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const chips = document.createElement('div'); chips.className = 'chips';
  c.options.forEach(o => {
    const b = document.createElement('button'); b.className = 'chip' + (state[c.key] === o.val ? ' chip--on' : ''); b.textContent = o.label;
    b.onclick = () => { state[c.key] = o.val; chips.querySelectorAll('.chip').forEach(x => x.classList.remove('chip--on')); b.classList.add('chip--on'); applyState(); };
    chips.appendChild(b);
  });
  wrap.append(lab, chips); return wrap;
}
function buildToggle(c) {
  const b = document.createElement('button'); b.className = 'chip' + (state[c.key] ? ' chip--on' : ''); b.textContent = c.label;
  b.onclick = () => { state[c.key] = !state[c.key]; b.classList.toggle('chip--on', state[c.key]); applyState(); };
  return b;
}

/* ── Tabs ── */
dom.tabs.addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('pane--active'));
  tab.classList.add('tab--active');
  dom.panes.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add('pane--active');
});

/* ── Panel: drag to resize / slide away, enlarging the viewport ── */
const PANEL_MIN = 46;
let panelOpenH = Math.round(Math.min(window.innerHeight * 0.46, 460));
let drag = null;
function setPanelHeight(h, animate) {
  dom.panel.classList.toggle('dragging', !animate);
  dom.panel.style.height = h + 'px';
  if (media.w) fitCanvasStyle(media.w, media.h);
}
function snapPanel(open) {
  dom.panel.classList.remove('dragging');
  dom.panel.style.height = (open ? panelOpenH : PANEL_MIN) + 'px';
  dom.panel.classList.toggle('collapsed', !open);
}
dom.handle.addEventListener('pointerdown', e => {
  drag = { startY: e.clientY, startH: dom.panel.getBoundingClientRect().height, moved: false };
  dom.handle.setPointerCapture(e.pointerId);
});
dom.handle.addEventListener('pointermove', e => {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  if (Math.abs(dy) > 3) drag.moved = true;
  const max = Math.round(window.innerHeight * 0.7);
  const h = Math.max(PANEL_MIN, Math.min(max, drag.startH - dy));
  setPanelHeight(h, false);
});
dom.handle.addEventListener('pointerup', e => {
  if (!drag) return;
  const h = dom.panel.getBoundingClientRect().height;
  if (!drag.moved) { snapPanel(dom.panel.classList.contains('collapsed')); }     // tap toggles
  else { const open = h > PANEL_MIN + 80; if (open) panelOpenH = Math.round(h); snapPanel(open); }
  drag = null;
});
dom.panel.addEventListener('transitionend', e => { if (e.propertyName === 'height' && media.w) fitCanvasStyle(media.w, media.h); });

/* ── Compare (press & hold = original) ── */
['pointerdown', 'pointerleave', 'pointerup', 'pointercancel'].forEach(ev =>
  dom.compare.addEventListener(ev, e => { bypass = (ev === 'pointerdown'); if (ev === 'pointerdown') e.preventDefault(); }));

/* ─────────────────────────── File input ─────────────────────────── */
function pickFile() { dom.file.click(); }
dom.addBtn.onclick = pickFile; dom.emptyAdd.onclick = pickFile;
dom.file.addEventListener('change', () => {
  const f = dom.file.files[0]; if (!f) return;
  const url = URL.createObjectURL(f); resetMedia();
  (f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
  dom.file.value = '';
});
dom.sampleBtn.onclick = () => {
  resetMedia();
  loadImage('https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1600&q=80&auto=format', false)
    .catch(() => showError('Could not load the sample (network/CORS). Try adding your own photo.'));
};
function resetMedia() {
  stopRecording(true);
  if (media.type === 'video') { dom.video.pause(); dom.video.removeAttribute('src'); dom.video.load(); }
  bypass = false; burst = 0;
}
['dragover', 'drop'].forEach(ev => dom.stage.addEventListener(ev, e => e.preventDefault()));
dom.stage.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]; if (!f) return;
  const url = URL.createObjectURL(f); resetMedia();
  (f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
});

/* ─────────────────────────── Export (share to Photos) ─────────────────────────── */
let recorder = null, recChunks = [], recMime = '';
function pickMime() { return ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ''; }

async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }   // user cancelled
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

dom.exportBtn.onclick = () => { if (media.type === 'image') exportImage(); else if (media.type === 'video') toggleRecording(); };
function exportImage() {
  renderFrame();
  dom.canvas.toBlob(b => { if (b) shareOrDownload(b, `halation-${Date.now()}.png`); }, 'image/png');
}
function toggleRecording() {
  if (recorder) { stopRecording(); return; }
  recMime = pickMime(); if (!recMime) { showError('Recording is not supported in this browser.'); return; }
  const stream = dom.canvas.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: 12_000_000 });
  recChunks = [];
  recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => { const ext = recMime.includes('mp4') ? 'mp4' : 'webm'; shareOrDownload(new Blob(recChunks, { type: recMime }), `halation-${Date.now()}.${ext}`); };
  dom.video.currentTime = 0; dom.video.loop = false; dom.video.play(); recorder.start();
  dom.rec.classList.remove('hidden'); dom.exportBtn.textContent = 'Stop';
  dom.video.onended = () => stopRecording();
}
function stopRecording(silent) {
  if (!recorder) return;
  try { recorder.stop(); } catch (e) {}
  recorder = null; dom.video.loop = true; dom.video.onended = null;
  if (!silent && media.type === 'video') dom.video.play().catch(() => {});
  dom.rec.classList.add('hidden');
  if (dom.exportBtn) dom.exportBtn.textContent = media.type === 'video' ? 'Record' : 'Export';
}

/* ── Overlays ── */
function showLoading(on, text) { if (text) dom.loadingTx.textContent = text; dom.loading.classList.toggle('hidden', !on); }
let errEl = null;
function showError(msg) {
  console.error('[halation]', msg);
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.style.cssText = 'position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:88%;background:rgba(40,8,8,.92);border:1px solid #5a1d1d;color:#ffb3b3;font-size:11.5px;line-height:1.5;padding:10px 14px;border-radius:10px;text-align:center;z-index:50;backdrop-filter:blur(8px);cursor:pointer';
    errEl.onclick = () => errEl.classList.add('hidden'); dom.stage.appendChild(errEl);
  }
  errEl.textContent = msg; errEl.classList.remove('hidden');
}
window.addEventListener('error', e => showError('Error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e => showError('Error: ' + ((e.reason && e.reason.message) || e.reason)));

/* ── Resize ── */
let resizeRaf;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (media.w) fitCanvasStyle(media.w, media.h); });
});

/* ── Init ── */
buildPanel();
snapPanel(true);
if (!renderer.getContext()) showError('WebGL is not available in this browser — the effects need it.');
