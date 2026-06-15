import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ─────────────────────────────────────────────────────────────
   Halation — a procedural Greek-letter field placed from image
   data, over five clean controls: Letters, Bloom, Blur (tap-to-
   focus depth of field), and Image (exposure / contrast / saturation).
   ───────────────────────────────────────────────────────────── */

const MAX_SIDE_IMAGE = 3072;
const MAX_SIDE_VIDEO = 1440;
const MAX_LETTERS = 14000;
const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω'; // 24 lowercase

const dom = {
  canvas:    document.getElementById('gl'),
  focusRing: document.getElementById('focusRing'),
  stage:     document.getElementById('stage'),
  empty:     document.getElementById('empty'),
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

const state = {
  // letters (signature effect)
  gOn: true, gMode: 0, gDensity: 0.5, gSize: 0.55, gOpacity: 0.95,
  // bloom
  bloomStrength: 0.8, bloomRadius: 0.6, bloomThreshold: 0.75,
  // blur + tap-to-focus depth of field
  blur: 0, focusSize: 0.32, focusPtX: 0.5, focusPtY: 0.5,
  // image tone
  exposure: 0, contrast: 0, saturation: 0,
};
const GLYPH_KEYS = ['gOn', 'gMode', 'gDensity'];

const CONTROLS = {
  letters: [
    { t: 'toggle', key: 'gOn', label: 'Greek-letter field' },
    { t: 'select', key: 'gMode', label: 'Cluster in', options: [
      { label: 'Dark areas', val: 0 }, { label: 'Light areas', val: 1 }, { label: 'Everywhere', val: 2 } ] },
    { t: 'slider', key: 'gDensity', label: 'Density', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gSize',    label: 'Size',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gOpacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
  ],
  bloom: [
    { t: 'slider', key: 'bloomStrength',  label: 'Strength',  min: 0, max: 3, step: 0.01 },
    { t: 'slider', key: 'bloomRadius',    label: 'Radius',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomThreshold', label: 'Threshold', min: 0, max: 1, step: 0.01 },
  ],
  blur: [
    { t: 'note', text: 'Tap the image to set the focus point · pinch with two fingers to resize the in-focus area. Everything outside stays sharp until you raise Blur.' },
    { t: 'slider', key: 'blur',      label: 'Blur',         min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'focusSize', label: 'Focus area',   min: 0.05, max: 0.9, step: 0.01 },
  ],
  image: [
    { t: 'slider', key: 'exposure',   label: 'Exposure',   min: -1, max: 1, step: 0.01 },
    { t: 'slider', key: 'contrast',   label: 'Contrast',   min: -1, max: 1, step: 0.01 },
    { t: 'slider', key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
  ],
};

/* ─────────────────────────── Shaders ─────────────────────────── */
const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const PASS_VERT = `varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

/* Image tone — exposure (stops) · contrast · saturation */
const AdjustShader = {
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 0 }, uContrast: { value: 0 }, uSaturation: { value: 0 } },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uExposure, uContrast, uSaturation; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c *= pow(2.0, uExposure);
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.0 + uSaturation);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/* Tap-to-focus depth of field — golden-angle bokeh disc whose radius
   grows with distance from the focus point. Sharp (early-out) when Blur = 0. */
const DofShader = {
  uniforms: {
    tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
    uBlur: { value: 0 }, uFocusPt: { value: new THREE.Vector2(0.5, 0.5) }, uFocusR: { value: 0.32 }, uAspect: { value: 1 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel, uFocusPt; uniform float uBlur, uFocusR, uAspect;
    varying vec2 vUv;
    void main(){
      vec2 fd = (vUv - uFocusPt) * vec2(uAspect, 1.0);
      float coc = smoothstep(uFocusR, uFocusR + 0.38, length(fd));
      float radius = uBlur * coc;
      if (radius < 0.0015){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }
      vec3 col = vec3(0.0); float wsum = 0.0;
      const float GA = 2.39996323;
      for (int i = 0; i < 28; i++){
        float fi = float(i);
        float r = sqrt((fi + 0.5) / 28.0);
        float a = fi * GA;
        vec2 o = vec2(cos(a), sin(a)) * r * radius * uTexel * 95.0;
        col += texture2D(tDiffuse, vUv + o).rgb; wsum += 1.0;
      }
      gl_FragColor = vec4(col / wsum, 1.0);
    }`,
};

/* Bloom — byte targets (iOS-safe): bright-pass → separable blur → add. */
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
  uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse, tBloom; uniform float uStrength; varying vec2 vUv;
    void main(){ vec3 base = texture2D(tDiffuse, vUv).rgb; vec3 bloom = texture2D(tBloom, vUv).rgb * uStrength;
      gl_FragColor = vec4(base + bloom, 1.0); }`,
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
    this.rtBright.setSize(dw, dh); this.rtA.setSize(dw, dh); this.rtB.setSize(dw, dh); this.texel.set(1 / dw, 1 / dh);
  }
  render(renderer, writeBuffer, readBuffer) {
    const c = this.compQuad.material.uniforms;
    if (this.strength <= 0.0001) {
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

/* ── Greek-letter field (procedural placement from image data) ── */
function buildGreekAtlas() {
  const cell = 96, cols = 6, rows = 4;
  const c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * cell;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `${Math.round(cell * 0.68)}px "IBM Plex Mono", "Times New Roman", serif`;
  for (let i = 0; i < GREEK.length; i++) x.fillText(GREEK[i], (i % cols) * cell + cell / 2, ((i / cols) | 0) * cell + cell / 2);
  const tex = new THREE.CanvasTexture(c); tex.flipY = false; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const glyphScene = new THREE.Scene();
const glyphGeo = new THREE.BufferGeometry();
const posArr = new Float32Array(MAX_LETTERS * 3), sizeArr = new Float32Array(MAX_LETTERS), glyphArr = new Float32Array(MAX_LETTERS), alphaArr = new Float32Array(MAX_LETTERS);
const posAttr = new THREE.BufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage);
const sizeAttr = new THREE.BufferAttribute(sizeArr, 1).setUsage(THREE.DynamicDrawUsage);
const glyphAttr = new THREE.BufferAttribute(glyphArr, 1).setUsage(THREE.DynamicDrawUsage);
const alphaAttr = new THREE.BufferAttribute(alphaArr, 1).setUsage(THREE.DynamicDrawUsage);
glyphGeo.setAttribute('position', posAttr); glyphGeo.setAttribute('aSize', sizeAttr);
glyphGeo.setAttribute('aGlyph', glyphAttr); glyphGeo.setAttribute('aAlpha', alphaAttr);
glyphGeo.setDrawRange(0, 0);
const glyphMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
  uniforms: { uAtlas: { value: buildGreekAtlas() }, uSizeMul: { value: 1 }, uGlow: { value: 0.95 } },
  vertexShader: `
    attribute float aSize, aGlyph, aAlpha;
    uniform float uSizeMul; varying float vGlyph, vAlpha;
    void main(){
      vGlyph = aGlyph; vAlpha = aAlpha;
      gl_PointSize = clamp(aSize * uSizeMul, 4.0, 480.0);
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas; uniform float uGlow; varying float vGlyph, vAlpha;
    void main(){
      float gi = vGlyph; vec2 cell = vec2(mod(gi, 6.0), floor(gi / 6.0));
      vec2 guv = (cell + gl_PointCoord) / vec2(6.0, 4.0);
      float a = texture2D(uAtlas, guv).a * vAlpha * uGlow;
      if (a < 0.02) discard;
      gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    }`,
});
glyphScene.add(new THREE.Points(glyphGeo, glyphMat));
let glyphCount = 0;
const gridCanvas = document.createElement('canvas');

/* ── Composer ── */
let composer, adjustPass, dofPass, bloomPass;
function buildComposer(w, h) {
  if (composer) composer.dispose();
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1); composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  adjustPass = new ShaderPass(AdjustShader); composer.addPass(adjustPass);
  dofPass = new ShaderPass(DofShader); dofPass.uniforms.uTexel.value.set(1 / w, 1 / h); dofPass.uniforms.uAspect.value = w / h; composer.addPass(dofPass);
  bloomPass = new HalationBloomPass(w, h); composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  applyState();
}

/* ─────────────────────────── Media loading ─────────────────────────── */
let media = { type: null, el: null, w: 0, h: 0 };
function fitCanvasStyle(w, h) {
  const sw = dom.stage.clientWidth, sh = dom.stage.clientHeight; if (!sw || !sh) return;
  const scale = Math.min(sw / w, sh / h);
  dom.canvas.style.width = Math.round(w * scale) + 'px'; dom.canvas.style.height = Math.round(h * scale) + 'px';
  updateFocusMarker();
}
function capSize(w, h, maxSide) { const s = Math.min(1, maxSide / Math.max(w, h)); return [Math.round(w * s), Math.round(h * s)]; }

async function loadImage(src, revoke) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('This image format can’t be decoded by your browser (e.g. HEIC). Try a JPG or PNG.')); img.src = src; });
  if (revoke) URL.revokeObjectURL(src);
  const [w, h] = capSize(img.naturalWidth, img.naturalHeight, MAX_SIDE_IMAGE);
  const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  setupMedia('image', img, w, h, tex);
}
async function loadVideo(src) {
  const v = dom.video; v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('This video format can’t be played by your browser. Try an MP4 (H.264).')); });
  const [w, h] = capSize(v.videoWidth, v.videoHeight, MAX_SIDE_VIDEO);
  const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  setupMedia('video', v, w, h, tex);
  v.play().catch(() => {});
}
function setupMedia(type, el, w, h, tex) {
  media = { type, el, w, h };
  quad.material.map = tex; quad.material.needsUpdate = true;
  renderer.setSize(w, h, false); buildComposer(w, h); fitCanvasStyle(w, h);
  dom.empty.classList.add('hidden');
  dom.compare.classList.remove('hidden'); dom.compare.disabled = false;
  dom.exportBtn.disabled = false; dom.exportBtn.textContent = type === 'video' ? 'Record' : 'Export';
  computeGlyphField();
  requestRender();
}

/* ── Greek-letter procedural placement (content-weighted scatter) ── */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d / mx : 0, mx];
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function pickCell(prefix, r) { let lo = 0, hi = prefix.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (prefix[mid] < r) lo = mid + 1; else hi = mid; } return lo; }
function computeGlyphField() {
  // Positions importance-sampled from a weight map (dark / light / everywhere),
  // seeded so a still image is stable while video tracks its content.
  if (!media.type || !state.gOn) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); requestRender(); return; }
  const A = 160, ar = media.w / media.h;
  let aw, ah; if (ar >= 1) { aw = A; ah = Math.max(1, Math.round(A / ar)); } else { ah = A; aw = Math.max(1, Math.round(A * ar)); }
  gridCanvas.width = aw; gridCanvas.height = ah;
  const gx = gridCanvas.getContext('2d', { willReadFrequently: true });
  let d; try { gx.drawImage(media.el, 0, 0, aw, ah); d = gx.getImageData(0, 0, aw, ah).data; } catch (e) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); return; }
  const M = aw * ah, wt = new Float32Array(M), prefix = new Float32Array(M);
  let total = 0, maxW = 1e-4;
  for (let i = 0; i < M; i++) {
    const v = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
    let w;
    if (state.gMode === 0) w = (1 - v) * (1 - v);      // dark areas
    else if (state.gMode === 1) w = v * v;             // light areas
    else w = 1;                                        // everywhere
    wt[i] = w; total += w; if (w > maxW) maxW = w;
    prefix[i] = total;
  }
  if (total <= 0) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); requestRender(); return; }
  const N = Math.min(MAX_LETTERS, Math.round(180 + state.gDensity * 6200));
  const basePx = media.h / (16 + state.gDensity * 42);
  const rng = mulberry32(0x9E37 ^ state.gMode);
  let n = 0;
  for (let k = 0; k < N; k++) {
    const ci = pickCell(prefix, rng() * total);
    const cx = ci % aw, cy = (ci / aw) | 0, wnorm = wt[ci] / maxW;
    posArr[n * 3] = (cx + rng()) / aw * 2 - 1;
    posArr[n * 3 + 1] = (1 - (cy + rng()) / ah) * 2 - 1;
    posArr[n * 3 + 2] = 0;
    sizeArr[n] = basePx * (0.55 + 0.85 * wnorm) * (0.75 + 0.55 * rng());
    glyphArr[n] = (rng() * 24) | 0;
    alphaArr[n] = 0.35 + 0.65 * wnorm;
    n++;
  }
  glyphCount = n;
  posAttr.needsUpdate = sizeAttr.needsUpdate = glyphAttr.needsUpdate = alphaAttr.needsUpdate = true;
  glyphGeo.setDrawRange(0, n);
  requestRender();
}

/* ─────────────────────────── Render loop ─────────────────────────── */
const clock = new THREE.Clock();
let bypass = false, dirty = true, vframe = 0;
function requestRender() { dirty = true; }
function animating() { return media.type === 'video'; }
function renderFrame() {
  if (!composer) return;
  if (bypass) { renderer.render(scene, camera); return; }
  composer.render();
  if (glyphCount > 0) { renderer.autoClear = false; renderer.render(glyphScene, camera); renderer.autoClear = true; }
  if (media.type === 'video') { vframe++; if (state.gOn && vframe % 15 === 0) computeGlyphField(); }
}
function tick() { requestAnimationFrame(tick); if (!media.type) return; if (animating() || dirty) { renderFrame(); dirty = false; } }
tick();

/* ─────────────────────────── State → uniforms ─────────────────────────── */
function applyState() {
  if (bloomPass) { bloomPass.strength = state.bloomStrength; bloomPass.radius = state.bloomRadius; bloomPass.threshold = state.bloomThreshold; }
  if (adjustPass) { const u = adjustPass.uniforms; u.uExposure.value = state.exposure; u.uContrast.value = state.contrast; u.uSaturation.value = state.saturation; }
  if (dofPass) { const u = dofPass.uniforms; u.uBlur.value = state.blur; u.uFocusPt.value.set(state.focusPtX, state.focusPtY); u.uFocusR.value = state.focusSize; }
  glyphMat.uniforms.uSizeMul.value = 0.5 + state.gSize * 1.8;
  glyphMat.uniforms.uGlow.value = state.gOpacity;
  updateFocusMarker(); requestRender();
}

/* ── Focus marker ── */
function focusActive() { return state.blur > 0.001; }
function updateFocusMarker() {
  if (!media.type || bypass || !focusActive()) { dom.focusRing.classList.add('hidden'); return; }
  const gr = dom.canvas.getBoundingClientRect(), sr = dom.stage.getBoundingClientRect();
  const left = (gr.left - sr.left) + state.focusPtX * gr.width, top = (gr.top - sr.top) + (1 - state.focusPtY) * gr.height, diam = 2 * state.focusSize * gr.height;
  dom.focusRing.style.left = left + 'px'; dom.focusRing.style.top = top + 'px'; dom.focusRing.style.width = diam + 'px'; dom.focusRing.style.height = diam + 'px';
  dom.focusRing.classList.remove('hidden');
}

/* ── Tap to focus (drag = move point, pinch = resize focus area) ── */
const fptr = new Map(); let pinch = null, fmoved = false;
function uvFromXY(cx, cy) { const r = dom.canvas.getBoundingClientRect(); return [(cx - r.left) / r.width, (cy - r.top) / r.height]; }
function setCenterXY(cx, cy) { const [u, vt] = uvFromXY(cx, cy); if (u < -0.05 || u > 1.05 || vt < -0.05 || vt > 1.05) return; state.focusPtX = Math.min(1, Math.max(0, u)); state.focusPtY = 1 - Math.min(1, Math.max(0, vt)); applyState(); }
dom.canvas.addEventListener('pointerdown', e => {
  if (!media.type) return; fptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); fmoved = false;
  try { dom.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  if (fptr.size === 2) { const p = [...fptr.values()]; pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), r: state.focusSize }; }
});
dom.canvas.addEventListener('pointermove', e => {
  if (!fptr.has(e.pointerId)) return; fptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); fmoved = true;
  const p = [...fptr.values()];
  if (p.length >= 2) {
    const cur = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinch) state.focusSize = Math.min(0.9, Math.max(0.05, pinch.r * (cur / pinch.d)));
    if (sliderEls.focusSize) { sliderEls.focusSize.input.value = state.focusSize; sliderEls.focusSize.paint(); }
    setCenterXY((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
  } else if (focusActive()) { setCenterXY(e.clientX, e.clientY); }
});
function endPtr(e) { if (!fptr.has(e.pointerId)) return; fptr.delete(e.pointerId); if (fptr.size < 2) pinch = null; if (fptr.size === 0 && !fmoved && focusActive()) setCenterXY(e.clientX, e.clientY); }
dom.canvas.addEventListener('pointerup', endPtr);
dom.canvas.addEventListener('pointercancel', endPtr);

/* ─────────────────────────── Panel UI ─────────────────────────── */
const sliderEls = {};
function buildPanel() {
  let first = true;
  for (const [tab, controls] of Object.entries(CONTROLS)) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (first ? ' pane--active' : ''); pane.dataset.pane = tab; first = false;
    let chipRow = null;
    for (const c of controls) {
      if (c.t === 'slider') pane.appendChild(buildSlider(c));
      else if (c.t === 'select') pane.appendChild(buildSelect(c));
      else if (c.t === 'note') { const n = document.createElement('p'); n.className = 'note'; n.textContent = c.text; pane.appendChild(n); }
      else if (c.t === 'toggle') { if (!chipRow) { chipRow = document.createElement('div'); chipRow.className = 'chips'; pane.appendChild(chipRow); } chipRow.appendChild(buildToggle(c)); }
    }
    dom.panes.appendChild(pane);
  }
}
function onChange(key) {
  applyState();
  if (GLYPH_KEYS.includes(key)) computeGlyphField();
}
function buildSlider(c) {
  const wrap = document.createElement('label'); wrap.className = 'ctrl';
  const row = document.createElement('div'); row.className = 'ctrl__row';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const val = document.createElement('span'); val.className = 'ctrl__val';
  const input = document.createElement('input'); input.type = 'range'; input.min = c.min; input.max = c.max; input.step = c.step; input.value = state[c.key];
  const fmt = v => (c.step >= 1 ? String(Math.round(v)) : (+v).toFixed(2));
  const paint = () => { val.textContent = fmt(input.value); input.style.setProperty('--fill', ((input.value - c.min) / (c.max - c.min)) * 100 + '%'); };
  input.addEventListener('input', () => { state[c.key] = parseFloat(input.value); paint(); onChange(c.key); });
  paint(); row.append(lab, val); wrap.append(row, input); sliderEls[c.key] = { input, paint }; return wrap;
}
function buildSelect(c) {
  const wrap = document.createElement('div'); wrap.className = 'ctrl';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const chips = document.createElement('div'); chips.className = 'chips';
  c.options.forEach(o => {
    const b = document.createElement('button'); b.className = 'chip' + (state[c.key] === o.val ? ' chip--on' : ''); b.textContent = o.label;
    b.onclick = () => { state[c.key] = o.val; chips.querySelectorAll('.chip').forEach(x => x.classList.remove('chip--on')); b.classList.add('chip--on'); onChange(c.key); };
    chips.appendChild(b);
  });
  wrap.append(lab, chips); return wrap;
}
function buildToggle(c) {
  const b = document.createElement('button'); b.className = 'chip' + (state[c.key] ? ' chip--on' : ''); b.textContent = c.label;
  b.onclick = () => { state[c.key] = !state[c.key]; b.classList.toggle('chip--on', state[c.key]); onChange(c.key); };
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

/* ── Panel: drag/tap to resize ── */
const PANEL_MIN = 46; let panelOpenH = Math.round(Math.min(window.innerHeight * 0.46, 460)); let drag = null;
function setPanelHeight(h, animate) { dom.panel.classList.toggle('dragging', !animate); dom.panel.style.height = h + 'px'; if (media.w) fitCanvasStyle(media.w, media.h); }
function snapPanel(open) { dom.panel.classList.remove('dragging'); dom.panel.style.height = (open ? panelOpenH : PANEL_MIN) + 'px'; dom.panel.classList.toggle('collapsed', !open); }
dom.handle.addEventListener('pointerdown', e => { drag = { startY: e.clientY, startH: dom.panel.getBoundingClientRect().height, moved: false }; dom.handle.setPointerCapture(e.pointerId); });
dom.handle.addEventListener('pointermove', e => { if (!drag) return; const dy = e.clientY - drag.startY; if (Math.abs(dy) > 3) drag.moved = true; const max = Math.round(window.innerHeight * 0.7); setPanelHeight(Math.max(PANEL_MIN, Math.min(max, drag.startH - dy)), false); });
dom.handle.addEventListener('pointerup', () => { if (!drag) return; const h = dom.panel.getBoundingClientRect().height; if (!drag.moved) snapPanel(dom.panel.classList.contains('collapsed')); else { const open = h > PANEL_MIN + 80; if (open) panelOpenH = Math.round(h); snapPanel(open); } drag = null; });
dom.panel.addEventListener('transitionend', e => { if (e.propertyName === 'height' && media.w) fitCanvasStyle(media.w, media.h); });

/* ── Compare ── */
['pointerdown', 'pointerleave', 'pointerup', 'pointercancel'].forEach(ev =>
  dom.compare.addEventListener(ev, e => { bypass = (ev === 'pointerdown'); requestRender(); updateFocusMarker(); if (ev === 'pointerdown') e.preventDefault(); }));

/* ─────────────────────────── File input ─────────────────────────── */
function pickFile() { dom.file.click(); }
dom.addBtn.onclick = pickFile; dom.emptyAdd.onclick = pickFile;
dom.file.addEventListener('change', () => {
  const f = dom.file.files[0]; if (!f) return; const url = URL.createObjectURL(f); resetMedia();
  (f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
  dom.file.value = '';
});
dom.sampleBtn.onclick = () => {
  resetMedia();
  loadImage('https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1600&q=80&auto=format', false)
    .catch(() => showError('Could not load the sample (network/CORS). Try adding your own photo.'));
};
function resetMedia() { stopRecording(true); if (media.type === 'video') { dom.video.pause(); dom.video.removeAttribute('src'); dom.video.load(); } bypass = false; }
['dragover', 'drop'].forEach(ev => dom.stage.addEventListener(ev, e => e.preventDefault()));
dom.stage.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]; if (!f) return; const url = URL.createObjectURL(f); resetMedia();
  (f.type.startsWith('video') ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
});

/* ─────────────────────────── Export (share to Photos) ─────────────────────────── */
let recorder = null, recChunks = [], recMime = '';
function pickMime() { return ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ''; }
async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
dom.exportBtn.onclick = () => { if (media.type === 'image') exportImage(); else if (media.type === 'video') toggleRecording(); };
function exportImage() {
  bypass = false; renderFrame();
  const out = document.createElement('canvas'); out.width = dom.canvas.width; out.height = dom.canvas.height;
  out.getContext('2d').drawImage(dom.canvas, 0, 0);
  out.toBlob(b => { if (b) shareOrDownload(b, `halation-${Date.now()}.png`); }, 'image/png');
}
function toggleRecording() {
  if (recorder) { stopRecording(); return; }
  recMime = pickMime(); if (!recMime) { showError('Recording is not supported in this browser.'); return; }
  const stream = dom.canvas.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: 16_000_000 });
  recChunks = []; recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => { const ext = recMime.includes('mp4') ? 'mp4' : 'webm'; shareOrDownload(new Blob(recChunks, { type: recMime }), `halation-${Date.now()}.${ext}`); };
  dom.video.currentTime = 0; dom.video.loop = false; dom.video.play(); recorder.start();
  dom.rec.classList.remove('hidden'); dom.exportBtn.textContent = 'Stop'; dom.video.onended = () => stopRecording();
}
function stopRecording(silent) {
  if (!recorder) return; try { recorder.stop(); } catch (e) {}
  recorder = null; dom.video.loop = true; dom.video.onended = null;
  if (!silent && media.type === 'video') dom.video.play().catch(() => {});
  dom.rec.classList.add('hidden'); if (dom.exportBtn) dom.exportBtn.textContent = media.type === 'video' ? 'Record' : 'Export';
}

/* ── Errors ── */
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
window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { if (media.w) fitCanvasStyle(media.w, media.h); }); });

/* ── Init ── */
buildPanel(); snapPanel(true);
if (!renderer.getContext()) showError('WebGL is not available in this browser — the effects need it.');
