import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// NOTE: MediaPipe is loaded lazily (dynamic import) inside getSegmenter() so a
// CDN/network failure there can never take down the core preview + effects.

/* ─────────────────────────────────────────────────────────────
   Halation — natural bloom + chromatic dispersion + subject-tracked
   glitch for photos & video. Foreground mask via MediaPipe; effects
   via a Three.js postprocessing chain. Runs fully in the browser.
   ───────────────────────────────────────────────────────────── */

const MAX_SIDE_IMAGE = 1920;   // cap processing resolution for stills
const MAX_SIDE_VIDEO = 1280;   // and for video frames

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
  presets:   document.getElementById('presets'),
  tabs:      document.getElementById('tabs'),
  panes:     document.getElementById('panes'),
  panel:     document.getElementById('panel'),
  handle:    document.getElementById('panelHandle'),
};

/* ── Effect state (single source of truth, mirrored into uniforms) ── */
const state = {
  bloomStrength: 0.9, bloomRadius: 0.6, bloomThreshold: 0.82,
  dispAmount: 0.012, dispMaskMix: -0.3, focus: 0.2,
  glAmount: 0, glTrack: 0.6, glRgb: 1, glSlice: 1, glScan: 0.5, glNoise: 0.6,
  maskInvert: false,
};

/* ── Control schema → builds the panel UI ── */
const CONTROLS = {
  bloom: [
    { key: 'bloomStrength', label: 'Strength',  min: 0, max: 3, step: 0.01 },
    { key: 'bloomRadius',   label: 'Radius',    min: 0, max: 1, step: 0.01 },
    { key: 'bloomThreshold',label: 'Threshold', min: 0, max: 1, step: 0.01 },
  ],
  dispersion: [
    { key: 'dispAmount',  label: 'Amount',          min: 0,  max: 0.06, step: 0.001 },
    { key: 'dispMaskMix', label: 'Subject ↔ Background', min: -1, max: 1, step: 0.01 },
    { key: 'focus',       label: 'Subject focus',   min: 0,  max: 1,  step: 0.01 },
  ],
  glitch: [
    { key: 'glAmount', label: 'Intensity',     min: 0, max: 1, step: 0.01 },
    { key: 'glTrack',  label: 'Track subject', min: 0, max: 1, step: 0.01 },
    { key: 'glRgb',    label: 'RGB shift',     min: 0, max: 1, step: 0.01 },
    { key: 'glSlice',  label: 'Slices',        min: 0, max: 1, step: 0.01 },
    { key: 'glScan',   label: 'Scanlines',     min: 0, max: 1, step: 0.01 },
    { key: 'glNoise',  label: 'Noise',         min: 0, max: 1, step: 0.01 },
  ],
};

const PRESETS = {
  Clean:     { bloomStrength: 0.0, dispAmount: 0,     focus: 0,    glAmount: 0 },
  Halation:  { bloomStrength: 1.0, bloomRadius: 0.65, bloomThreshold: 0.8, dispAmount: 0.012, dispMaskMix: -0.3, focus: 0.22, glAmount: 0 },
  Nightlife: { bloomStrength: 1.5, bloomRadius: 0.8,  bloomThreshold: 0.7, dispAmount: 0.022, dispMaskMix: -0.45, focus: 0.38, glAmount: 0.12, glTrack: 0.5, glRgb: 1, glSlice: 0.3, glScan: 0.2, glNoise: 0.2 },
  VHS:       { bloomStrength: 0.5, bloomRadius: 0.5,  bloomThreshold: 0.7, dispAmount: 0.01,  dispMaskMix: 0, focus: 0.1, glAmount: 0.45, glTrack: 0.25, glRgb: 1, glSlice: 0.6, glScan: 1, glNoise: 0.7 },
  Datamosh:  { bloomStrength: 0.7, bloomRadius: 0.7,  bloomThreshold: 0.6, dispAmount: 0.018, dispMaskMix: 0.4, focus: 0.3, glAmount: 0.8, glTrack: 1, glRgb: 1, glSlice: 1, glScan: 0.4, glNoise: 0.9 },
};

/* ─────────────────────────── Shaders ─────────────────────────── */

const DispersionShader = {
  uniforms: {
    tDiffuse:   { value: null },
    tMask:      { value: null },
    uAmount:    { value: state.dispAmount },
    uMaskMix:   { value: state.dispMaskMix },
    uFocus:     { value: state.focus },
    uMaskInvert:{ value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tMask;
    uniform float uAmount, uMaskMix, uFocus, uMaskInvert;
    varying vec2 vUv;
    void main(){
      float m = texture2D(tMask, vec2(vUv.x, 1.0 - vUv.y)).r;   // foreground prob
      m = mix(m, 1.0 - m, uMaskInvert);
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      float w = 1.0 + uMaskMix * (m - 0.5) * 2.0;               // bias toward subject/bg
      vec2 off = normalize(dir + 1e-6) * (uAmount * dist * max(w, 0.0));
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= 1.0 - uFocus * 0.6 * (1.0 - m);                    // dim background
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const GlitchShader = {
  uniforms: {
    tDiffuse:   { value: null },
    tMask:      { value: null },
    uTime:      { value: 0 },
    uAmount:    { value: 0 },
    uTrack:     { value: state.glTrack },
    uRgb:       { value: state.glRgb },
    uSlice:     { value: state.glSlice },
    uScan:      { value: state.glScan },
    uNoise:     { value: state.glNoise },
    uMaskInvert:{ value: 0 },
    uRes:       { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tMask;
    uniform float uTime, uAmount, uTrack, uRgb, uSlice, uScan, uNoise, uMaskInvert;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(float n){ return fract(sin(n) * 43758.5453123); }
    float hash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      float amt = uAmount;
      if (amt <= 0.0) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

      float m = texture2D(tMask, vec2(vUv.x, 1.0 - vUv.y)).r;
      m = mix(m, 1.0 - m, uMaskInvert);
      float track = mix(1.0, m, uTrack);          // concentrate on subject
      float t = floor(uTime * 14.0);              // chunky glitch "frames"
      vec2 uv = vUv;

      // horizontal slice displacement
      float rows = 26.0;
      float sl = floor(vUv.y * rows);
      float active = step(0.7, hash(sl + t * 1.7));
      uv.x += (hash(sl * 3.3 + t) - 0.5) * 0.16 * amt * uSlice * active * track;
      uv.x += (hash(t * 0.7) - 0.5) * 0.012 * amt * uSlice * step(0.85, hash(t)) * track;

      // chromatic RGB shift (with occasional bursts)
      float rgbAmt = (0.004 + 0.02 * amt) * uRgb * track;
      rgbAmt *= mix(1.0, 3.0, step(0.92, hash(t * 2.1)));
      vec3 col;
      col.r = texture2D(tDiffuse, uv + vec2(rgbAmt, 0.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - vec2(rgbAmt, 0.0)).b;

      // blocky digital noise
      vec2 blk = floor(vUv * (uRes / 8.0));
      float hit = step(0.96, hash2(blk + t)) * uNoise * amt * track;
      col = mix(col, vec3(hash2(blk * 1.31 + t)), hit * 0.85);

      // scanlines
      float scan = sin(vUv.y * uRes.y * 1.5) * 0.5 + 0.5;
      col *= 1.0 - uScan * 0.22 * scan * amt;

      gl_FragColor = vec4(col, 1.0);
    }`,
};

/* ── Custom bloom (halation) — byte render targets only, so it works on
   iOS Safari where half-float render targets used by UnrealBloomPass /
   EffectComposer come out black. Bright-pass + iterative separable blur
   at half resolution, additively composited over the sharp original. ── */
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BrightShader = {
  uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.8 } },
  vertexShader: FS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uThreshold; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = max(c.r, max(c.g, c.b));
      float k = smoothstep(uThreshold, uThreshold + 0.2, l);
      gl_FragColor = vec4(c * k, 1.0);
    }`,
};
const BlurShader = {
  uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
  vertexShader: FS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uDir, uTexel; uniform float uRadius; varying vec2 vUv;
    void main(){
      vec2 d = uDir * uTexel * uRadius;
      vec3 c  = texture2D(tDiffuse, vUv).rgb * 0.227027;
      c += (texture2D(tDiffuse, vUv + d).rgb       + texture2D(tDiffuse, vUv - d).rgb)       * 0.1945946;
      c += (texture2D(tDiffuse, vUv + d*2.0).rgb   + texture2D(tDiffuse, vUv - d*2.0).rgb)   * 0.1216216;
      c += (texture2D(tDiffuse, vUv + d*3.0).rgb   + texture2D(tDiffuse, vUv - d*3.0).rgb)   * 0.0540540;
      c += (texture2D(tDiffuse, vUv + d*4.0).rgb   + texture2D(tDiffuse, vUv - d*4.0).rgb)   * 0.0162162;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
const CompositeShader = {
  uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } },
  vertexShader: FS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tBloom; uniform float uStrength; varying vec2 vUv;
    void main(){
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec3 bloom = texture2D(tBloom, vUv).rgb;
      gl_FragColor = vec4(base + bloom * uStrength, 1.0);
    }`,
};

class HalationBloomPass extends Pass {
  constructor(w, h) {
    super();
    this.strength = state.bloomStrength;
    this.radius = state.bloomRadius;
    this.threshold = state.bloomThreshold;
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
    if (this.strength <= 0.0001) { // bloom off → straight copy
      this.compQuad.material.uniforms.tDiffuse.value = readBuffer.texture;
      this.compQuad.material.uniforms.tBloom.value = readBuffer.texture;
      this.compQuad.material.uniforms.uStrength.value = 0;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.compQuad.render(renderer);
      return;
    }
    const b = this.brightQuad.material.uniforms;
    b.tDiffuse.value = readBuffer.texture; b.uThreshold.value = this.threshold;
    renderer.setRenderTarget(this.rtBright); this.brightQuad.render(renderer);

    const blur = this.blurQuad.material.uniforms;
    blur.uTexel.value.copy(this.texel);
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

const renderer = new THREE.WebGLRenderer({
  canvas: dom.canvas, antialias: false, preserveDrawingBuffer: true, alpha: false,
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
const quad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: null })
);
scene.add(quad);

let composer, bloomPass, dispPass, glitchPass;
function buildComposer(w, h) {
  if (composer) { composer.dispose(); }
  // byte render target — half-float targets render black on iOS Safari
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));

  dispPass = new ShaderPass(DispersionShader);
  composer.addPass(dispPass);

  bloomPass = new HalationBloomPass(w, h);
  composer.addPass(bloomPass);

  glitchPass = new ShaderPass(GlitchShader);
  glitchPass.uniforms.uRes.value.set(w, h);
  composer.addPass(glitchPass);

  composer.addPass(new OutputPass());
  applyState();
}

/* ── Foreground mask texture (R8, linear-filtered for smooth edges) ── */
let maskTex = makeMaskTexture(new Uint8Array([255]), 1, 1); // default: all foreground
function makeMaskTexture(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
let maskBuf = null; // reused Uint8Array for video frames

function updateMaskFromResult(result) {
  const mask = result.confidenceMasks && result.confidenceMasks[0];
  if (!mask) return;
  const w = mask.width, h = mask.height;
  const f32 = mask.getAsFloat32Array();
  if (!maskBuf || maskBuf.length !== w * h) maskBuf = new Uint8Array(w * h);
  for (let i = 0; i < f32.length; i++) maskBuf[i] = (f32[i] * 255) | 0;
  if (maskTex.image.width !== w || maskTex.image.height !== h) {
    maskTex.dispose();
    maskTex = makeMaskTexture(maskBuf, w, h);
  } else {
    maskTex.image.data = maskBuf;
    maskTex.needsUpdate = true;
  }
  dispPass.uniforms.tMask.value = maskTex;
  glitchPass.uniforms.tMask.value = maskTex;
}

/* ─────────────────────── MediaPipe segmenter ─────────────────────── */
let segmenter = null, segmenterMode = null;
async function getSegmenter(mode) {
  if (segmenter && segmenterMode === mode) return segmenter;
  showLoading(true, 'Loading subject model…');
  try {
    if (!segmenter) {
      const { FilesetResolver, ImageSegmenter } = await import(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18'
      );
      const fileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
          delegate: 'GPU',
        },
        runningMode: mode,
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    } else {
      await segmenter.setOptions({ runningMode: mode });
    }
    segmenterMode = mode;
  } catch (e) {
    console.warn('Segmenter unavailable, effects apply globally.', e);
    segmenter = null;
  } finally {
    showLoading(false);
  }
  return segmenter;
}

/* ─────────────────────────── Media loading ─────────────────────────── */
let media = { type: null, el: null, w: 0, h: 0 };
let lastVideoTs = -1;

function fitCanvasStyle(w, h) {
  // canvas internal size == media size (capped); CSS object-fit handles letterboxing
  const stageW = dom.stage.clientWidth, stageH = dom.stage.clientHeight;
  const scale = Math.min(stageW / w, stageH / h);
  dom.canvas.style.width = Math.round(w * scale) + 'px';
  dom.canvas.style.height = Math.round(h * scale) + 'px';
}

function capSize(w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

async function loadImage(src, revoke) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('This image format can’t be decoded by your browser (e.g. HEIC). Try a JPG or PNG.'));
    img.src = src;
  });
  if (revoke) URL.revokeObjectURL(src);

  const [w, h] = capSize(img.naturalWidth, img.naturalHeight, MAX_SIDE_IMAGE);
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  setupMedia('image', img, w, h, tex);

  // one-shot segmentation
  const seg = await getSegmenter('IMAGE');
  if (seg) { try { updateMaskFromResult(seg.segment(img)); } catch (e) { console.warn(e); } }
  renderOnce();
}

async function loadVideo(src) {
  const v = dom.video;
  v.src = src;
  v.muted = true; v.loop = true; v.playsInline = true;
  await new Promise((res, rej) => {
    v.onloadeddata = res;
    v.onerror = () => rej(new Error('This video format can’t be played by your browser. Try an MP4 (H.264).'));
  });

  const [w, h] = capSize(v.videoWidth, v.videoHeight, MAX_SIDE_VIDEO);
  const tex = new THREE.VideoTexture(v);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  setupMedia('video', v, w, h, tex);
  await getSegmenter('VIDEO');
  lastVideoTs = -1;
  v.play().catch(() => {});
}

function setupMedia(type, el, w, h, tex) {
  media = { type, el, w, h };
  quad.material.map = tex;
  quad.material.needsUpdate = true;
  renderer.setSize(w, h, false);
  buildComposer(w, h);
  fitCanvasStyle(w, h);
  // reset mask to "all foreground" until first segmentation lands
  dispPass.uniforms.tMask.value = maskTex;
  glitchPass.uniforms.tMask.value = maskTex;

  dom.empty.classList.add('hidden');
  dom.compare.classList.remove('hidden'); dom.compare.disabled = false;
  dom.exportBtn.disabled = false;
  dom.exportBtn.textContent = type === 'video' ? 'Record' : 'Export';
}

/* ─────────────────────────── Render loop ─────────────────────────── */
const clock = new THREE.Clock();
let bypass = false;
let burst = 0;

function renderFrame() {
  if (media.type === 'video' && !dom.video.paused && segmenter && segmenterMode === 'VIDEO') {
    const ts = performance.now();
    if (ts !== lastVideoTs) {
      lastVideoTs = ts;
      try { segmenter.segmentForVideo(dom.video, ts, updateMaskFromResult); } catch (e) {}
    }
  }
  if (burst > 0) burst = Math.max(0, burst - clock.getDelta() * 2.2);
  const effGlitch = Math.max(state.glAmount, burst);
  glitchPass.uniforms.uTime.value = clock.elapsedTime;
  glitchPass.uniforms.uAmount.value = effGlitch;

  if (!composer) return;
  if (bypass) renderer.render(scene, camera);
  else composer.render();
}

function tick() {
  requestAnimationFrame(tick);
  if (media.type) renderFrame();
}
tick();

function renderOnce() { if (composer) (bypass ? renderer.render(scene, camera) : composer.render()); }

/* ─────────────────────────── State → uniforms ─────────────────────────── */
function applyState() {
  if (bloomPass) {
    bloomPass.strength = state.bloomStrength;
    bloomPass.radius = state.bloomRadius;
    bloomPass.threshold = state.bloomThreshold;
  }
  if (dispPass) {
    dispPass.uniforms.uAmount.value = state.dispAmount;
    dispPass.uniforms.uMaskMix.value = state.dispMaskMix;
    dispPass.uniforms.uFocus.value = state.focus;
    dispPass.uniforms.uMaskInvert.value = state.maskInvert ? 1 : 0;
  }
  if (glitchPass) {
    glitchPass.uniforms.uTrack.value = state.glTrack;
    glitchPass.uniforms.uRgb.value = state.glRgb;
    glitchPass.uniforms.uSlice.value = state.glSlice;
    glitchPass.uniforms.uScan.value = state.glScan;
    glitchPass.uniforms.uNoise.value = state.glNoise;
    glitchPass.uniforms.uMaskInvert.value = state.maskInvert ? 1 : 0;
  }
}

/* ─────────────────────────── UI: build panel ─────────────────────────── */
const sliderEls = {};
function buildPanel() {
  // presets
  Object.keys(PRESETS).forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'preset' + (name === 'Halation' ? ' preset--active' : '');
    b.textContent = name;
    b.onclick = () => applyPreset(name, b);
    dom.presets.appendChild(b);
  });

  // panes
  for (const [tab, controls] of Object.entries(CONTROLS)) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (tab === 'bloom' ? ' pane--active' : '');
    pane.dataset.pane = tab;

    controls.forEach(c => pane.appendChild(buildSlider(c)));

    if (tab === 'glitch') {
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.appendChild(buildChip('Invert mask', 'maskInvert'));
      pane.appendChild(chips);

      const burstBtn = document.createElement('button');
      burstBtn.className = 'burst';
      burstBtn.textContent = '⚡ Glitch burst';
      burstBtn.onclick = () => { burst = 1; renderOnce(); };
      pane.appendChild(burstBtn);
    }
    dom.panes.appendChild(pane);
  }
}

function buildSlider(c) {
  const wrap = document.createElement('label');
  wrap.className = 'ctrl';
  const row = document.createElement('div');
  row.className = 'ctrl__row';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const val = document.createElement('span'); val.className = 'ctrl__val';
  const input = document.createElement('input');
  input.type = 'range'; input.min = c.min; input.max = c.max; input.step = c.step;
  input.value = state[c.key];

  const fmt = v => (c.step < 0.01 ? (+v).toFixed(3) : (+v).toFixed(2));
  const paint = () => {
    val.textContent = fmt(input.value);
    const pct = ((input.value - c.min) / (c.max - c.min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  };
  input.addEventListener('input', () => {
    state[c.key] = parseFloat(input.value);
    paint(); applyState(); if (media.type === 'image') renderOnce();
  });
  paint();

  row.append(lab, val); wrap.append(row, input);
  sliderEls[c.key] = { input, paint };
  return wrap;
}

function buildChip(label, key) {
  const b = document.createElement('button');
  b.className = 'chip' + (state[key] ? ' chip--on' : '');
  b.textContent = label;
  b.onclick = () => {
    state[key] = !state[key];
    b.classList.toggle('chip--on', state[key]);
    applyState(); if (media.type === 'image') renderOnce();
  };
  return b;
}

function applyPreset(name, btn) {
  Object.assign(state, PRESETS[name]);
  // refresh sliders to reflect new values
  for (const [key, { input, paint }] of Object.entries(sliderEls)) {
    input.value = state[key]; paint();
  }
  applyState();
  document.querySelectorAll('.preset').forEach(p => p.classList.remove('preset--active'));
  if (btn) btn.classList.add('preset--active');
  if (media.type === 'image') renderOnce();
}

/* ── Tabs ── */
dom.tabs.addEventListener('click', e => {
  const tab = e.target.closest('.tab'); if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('pane--active'));
  tab.classList.add('tab--active');
  dom.panes.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add('pane--active');
});

/* ── Panel collapse ── */
dom.handle.addEventListener('click', () => dom.panel.classList.toggle('collapsed'));

/* ── Compare (press & hold = original) ── */
['pointerdown', 'pointerleave', 'pointerup', 'pointercancel'].forEach(ev => {
  dom.compare.addEventListener(ev, e => {
    bypass = (ev === 'pointerdown');
    if (media.type === 'image') renderOnce();
    if (ev === 'pointerdown') e.preventDefault();
  });
});

/* ─────────────────────────── File input ─────────────────────────── */
function pickFile() { dom.file.click(); }
dom.addBtn.onclick = pickFile;
dom.emptyAdd.onclick = pickFile;

dom.file.addEventListener('change', () => {
  const f = dom.file.files[0]; if (!f) return;
  const url = URL.createObjectURL(f);
  resetMedia();
  const p = f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true);
  p.catch(err => showError(err.message || String(err)));
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

/* ── Drag & drop ── */
['dragover', 'drop'].forEach(ev => dom.stage.addEventListener(ev, e => e.preventDefault()));
dom.stage.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]; if (!f) return;
  const url = URL.createObjectURL(f);
  resetMedia();
  const p = f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true);
  p.catch(err => showError(err.message || String(err)));
});

/* ─────────────────────────── Export ─────────────────────────── */
let recorder = null, recChunks = [], recMime = '';

function pickMime() {
  const cands = ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return cands.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

dom.exportBtn.onclick = () => {
  if (media.type === 'image') exportImage();
  else if (media.type === 'video') toggleRecording();
};

function exportImage() {
  renderOnce();
  dom.canvas.toBlob(b => download(b, `halation-${Date.now()}.png`), 'image/png');
}

function toggleRecording() {
  if (recorder) { stopRecording(); return; }
  recMime = pickMime();
  if (!recMime) { alert('Recording not supported in this browser.'); return; }
  const stream = dom.canvas.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: 12_000_000 });
  recChunks = [];
  recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const ext = recMime.includes('mp4') ? 'mp4' : 'webm';
    download(new Blob(recChunks, { type: recMime }), `halation-${Date.now()}.${ext}`);
  };
  dom.video.currentTime = 0;
  dom.video.loop = false;
  dom.video.play();
  recorder.start();
  dom.rec.classList.remove('hidden');
  dom.exportBtn.textContent = 'Stop';
  dom.video.onended = () => stopRecording();
}

function stopRecording(silent) {
  if (!recorder) return;
  try { recorder.stop(); } catch (e) {}
  recorder = null;
  dom.video.loop = true; dom.video.onended = null;
  if (!silent && media.type === 'video') dom.video.play().catch(() => {});
  dom.rec.classList.add('hidden');
  if (dom.exportBtn) dom.exportBtn.textContent = media.type === 'video' ? 'Record' : 'Export';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── Loading overlay ── */
function showLoading(on, text) {
  if (text) dom.loadingTx.textContent = text;
  dom.loading.classList.toggle('hidden', !on);
}

/* ── On-screen error reporter (so failures are visible, not silent) ── */
let errEl = null;
function showError(msg) {
  console.error('[halation]', msg);
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.style.cssText =
      'position:absolute;left:50%;bottom:64px;transform:translateX(-50%);max-width:88%;' +
      'background:rgba(40,8,8,.92);border:1px solid #5a1d1d;color:#ffb3b3;font-size:11.5px;' +
      'line-height:1.5;padding:10px 14px;border-radius:10px;text-align:center;z-index:50;' +
      'backdrop-filter:blur(8px);cursor:pointer';
    errEl.title = 'Tap to dismiss';
    errEl.onclick = () => errEl.classList.add('hidden');
    dom.stage.appendChild(errEl);
  }
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}
window.addEventListener('error', e => showError('Error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e =>
  showError('Error: ' + ((e.reason && e.reason.message) || e.reason)));

/* ── Resize ── */
let resizeRaf;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (media.w) fitCanvasStyle(media.w, media.h); });
});

/* ── Init ── */
buildPanel();
if (!renderer.getContext()) {
  showError('WebGL is not available in this browser — the effects need it.');
}
