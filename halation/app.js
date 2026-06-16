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
// Opening of Homer's Odyssey (Book 1). Diacritics are stripped (NFD → drop
// combining marks) so the base Greek letters render in IBM Plex Mono; the words
// still read as the Odyssey. The letter field streams this text through the blobs.
const ODYSSEY_RAW = 'ἄνδρα μοι ἔννεπε μοῦσα πολύτροπον ὃς μάλα πολλὰ πλάγχθη ἐπεὶ Τροίης ἱερὸν πτολίεθρον ἔπερσεν πολλῶν δ’ ἀνθρώπων ἴδεν ἄστεα καὶ νόον ἔγνω πολλὰ δ’ ὅ γ’ ἐν πόντῳ πάθεν ἄλγεα ὃν κατὰ θυμόν ἀρνύμενος ἥν τε ψυχὴν καὶ νόστον ἑταίρων ἀλλ’ οὐδ’ ὧς ἑτάρους ἐρρύσατο ἱέμενός περ αὐτῶν γὰρ σφετέρῃσιν ἀτασθαλίῃσιν ὄλοντο νήπιοι οἳ κατὰ βοῦς ὑπερίονος ἠελίοιο ἤσθιον αὐτὰρ ὁ τοῖσιν ἀφείλετο νόστιμον ἦμαρ';
const TEXT = ODYSSEY_RAW.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^α-ω ]/g, ' ').replace(/\s+/g, ' ').trim();
const CHARSET = [...new Set(TEXT)];                       // unique chars incl. space
const CHAR_INDEX = {}; CHARSET.forEach((c, i) => (CHAR_INDEX[c] = i));
const SPACE_CODE = CHAR_INDEX[' '];
const TEXT_CODES = [...TEXT].map(c => CHAR_INDEX[c]);
const ATLAS_COLS = 8, ATLAS_ROWS = Math.ceil(CHARSET.length / ATLAS_COLS);

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
  gOn: true, gDensity: 0.42, gTol: 0.4, gSize: 0.55, gOpacity: 0.95,
  // bloom
  bloomStrength: 0.8, bloomRadius: 0.6, bloomThreshold: 0.75,
  // zoom blur
  blur: 0, blurRadius: 0.15, blurSmooth: 0.5, zoomCx: 0.5, zoomCy: 0.5,
  // image tone
  exposure: 0, contrast: 0, saturation: 0,
};
const MASK_KEYS = ['gOn', 'gSize'];   // changing these rebuilds the letter mask

const CONTROLS = {
  letters: [
    { t: 'toggle', key: 'gOn', label: 'Odyssey letters' },
    { t: 'note', text: 'Letters lock onto tracked blobs (bright regions / objects) and follow them. Tolerance = how much counts as a blob; Density = how full.' },
    { t: 'slider', key: 'gTol',     label: 'Tolerance', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gDensity', label: 'Density',   min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gSize',    label: 'Size',      min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gOpacity', label: 'Opacity',   min: 0, max: 1, step: 0.01 },
  ],
  bloom: [
    { t: 'slider', key: 'bloomStrength',  label: 'Strength',  min: 0, max: 3, step: 0.01 },
    { t: 'slider', key: 'bloomRadius',    label: 'Radius',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomThreshold', label: 'Threshold', min: 0, max: 1, step: 0.01 },
  ],
  blur: [
    { t: 'note', text: 'Zoom blur — tap or drag on the image to set the centre.' },
    { t: 'slider', key: 'blur',       label: 'Amount',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'blurRadius', label: 'Radius',    min: 0, max: 0.6, step: 0.01 },
    { t: 'slider', key: 'blurSmooth', label: 'Smoothing', min: 0, max: 1, step: 0.01 },
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

/* Zoom blur from a tap-set centre. Radius keeps a sharp central disc; blur
   ramps up outside it. Smoothing jitters the taps to remove banding.
   Sharp (early-out) when Amount = 0 or inside the sharp radius. */
const BlurZoomShader = {
  uniforms: {
    tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uAspect: { value: 1 },
    uAmount: { value: 0 }, uRadius: { value: 0.15 }, uSmooth: { value: 0.5 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uTexel, uCenter; uniform float uAmount, uRadius, uSmooth, uAspect;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      float dist = length((vUv - uCenter) * vec2(uAspect, 1.0));
      float coc = smoothstep(uRadius, uRadius + 0.25, dist);
      float amt = uAmount * coc;
      if (amt < 0.002){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }
      const int N = 28;
      float jit = hash(vUv / max(uTexel, vec2(1e-4))) * uSmooth;
      vec3 col = vec3(0.0);
      for (int i = 0; i < N; i++){
        float tt = (float(i) + jit) / float(N);
        col += texture2D(tDiffuse, vUv + (vUv - uCenter) * tt * amt * 1.1).rgb;
      }
      gl_FragColor = vec4(col / float(N), 1.0);
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
function buildTextAtlas() {
  const cell = 96;
  const c = document.createElement('canvas'); c.width = ATLAS_COLS * cell; c.height = ATLAS_ROWS * cell;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `${Math.round(cell * 0.62)}px "IBM Plex Mono", "Times New Roman", serif`;
  for (let i = 0; i < CHARSET.length; i++) { if (CHARSET[i] === ' ') continue; x.fillText(CHARSET[i], (i % ATLAS_COLS) * cell + cell / 2, ((i / ATLAS_COLS) | 0) * cell + cell / 2); }
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
  uniforms: { uAtlas: { value: buildTextAtlas() }, uAtlasDim: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) }, uSizeMul: { value: 1 }, uGlow: { value: 0.95 } },
  vertexShader: `
    attribute float aSize, aGlyph, aAlpha;
    uniform float uSizeMul; varying float vGlyph, vAlpha;
    void main(){
      vGlyph = aGlyph; vAlpha = aAlpha;
      gl_PointSize = clamp(aSize * uSizeMul, 4.0, 480.0);
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas; uniform vec2 uAtlasDim; uniform float uGlow; varying float vGlyph, vAlpha;
    void main(){
      vec2 cell = vec2(mod(vGlyph, uAtlasDim.x), floor(vGlyph / uAtlasDim.x));
      vec2 guv = (cell + gl_PointCoord) / uAtlasDim;
      float a = texture2D(uAtlas, guv).a * vAlpha * uGlow;
      if (a < 0.02) discard;
      gl_FragColor = vec4(1.0, 1.0, 1.0, a);
    }`,
});
glyphScene.add(new THREE.Points(glyphGeo, glyphMat));
let glyphCount = 0;
const gridCanvas = document.createElement('canvas');
// Monospace grid + blob-tracking state. cellBlob[i] = id of the tracked blob a
// cell belongs to (or -1); flicker re-rolls glyphs/visibility every frame.
let gCols = 0, gRows = 0, gCellPx = 0;
let cellBlob = null, cellRate = null, cellPhase = null, salSmooth = null, labelBuf = null, stackBuf = null;
let tracks = [], nextTrackId = 1, gSampled = false;

/* ── Composer ── */
let composer, adjustPass, blurPass, bloomPass;
function buildComposer(w, h) {
  if (composer) composer.dispose();
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1); composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  adjustPass = new ShaderPass(AdjustShader); composer.addPass(adjustPass);
  blurPass = new ShaderPass(BlurZoomShader); blurPass.uniforms.uTexel.value.set(1 / w, 1 / h); blurPass.uniforms.uAspect.value = w / h; composer.addPass(blurPass);
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
  const v = dom.video;
  v.muted = true; v.loop = true; v.playsInline = true;
  v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
  v.src = src; v.load();
  // iOS Safari won't decode frames until play() is called, so awaiting
  // 'loadeddata' before playing can deadlock. Kick play() and resolve as
  // soon as the dimensions are known (any of metadata / data / canplay).
  await new Promise((res, rej) => {
    let done = false;
    const ok = () => { if (!done && v.videoWidth) { done = true; cleanup(); res(); } };
    const fail = () => { if (!done) { done = true; cleanup(); rej(new Error('This video format can’t be played by your browser. Try an MP4 (H.264).')); } };
    const cleanup = () => { clearTimeout(t); ['loadedmetadata', 'loadeddata', 'canplay'].forEach(e => v.removeEventListener(e, ok)); v.removeEventListener('error', fail); };
    ['loadedmetadata', 'loadeddata', 'canplay'].forEach(e => v.addEventListener(e, ok));
    v.addEventListener('error', fail);
    v.play().then(ok).catch(() => {});
    const t = setTimeout(fail, 12000);
  });
  const [w, h] = capSize(v.videoWidth, v.videoHeight, MAX_SIDE_VIDEO);
  const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  setupMedia('video', v, w, h, tex);
  v.play().catch(() => {});
  v.addEventListener('playing', () => buildGlyphMask(), { once: true });
}
function setupMedia(type, el, w, h, tex) {
  media = { type, el, w, h };
  quad.material.map = tex; quad.material.needsUpdate = true;
  renderer.setSize(w, h, false); buildComposer(w, h); fitCanvasStyle(w, h);
  dom.empty.classList.add('hidden');
  dom.compare.classList.remove('hidden'); dom.compare.disabled = false;
  dom.exportBtn.disabled = false; dom.exportBtn.textContent = type === 'video' ? 'Record' : 'Export';
  buildGlyphMask(); updateGlyphFlicker(now());
  requestRender();
}

/* ── Greek-letter field: blob tracking, letters bonded to tracked blobs ──
   Proven blob-tracking pipeline, run on the downsampled monospace grid:
     1. segment — threshold a temporally-smoothed brightness saliency into a
        foreground mask (Tolerance sets the threshold);
     2. label — 8-connected components → discrete blobs (area + centroid + bbox);
     3. track — associate blobs to persistent tracks by nearest centroid (with
        EMA smoothing + a miss counter), so a blob keeps its identity and only
        confirmed/again-seen blobs are drawn (rejects 1-frame noise);
     4. bond — letters fill the cells of confirmed tracked blobs, and flicker
        their glyphs fast. Letters therefore stick to coherent objects and move
        with them, instead of scattering. */
function hash01(a, b) { let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0; h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

function buildGlyphMask() {
  if (!media.type || !state.gOn) { gCols = 0; cellBlob = null; tracks = []; glyphCount = 0; glyphGeo.setDrawRange(0, 0); requestRender(); return; }
  const rows = Math.max(4, Math.round(60 - state.gSize * 48));   // small → many tiny cells, large → few big cells
  const cellPx = media.h / rows;
  const cols = Math.max(2, Math.round(media.w / cellPx));
  gCols = cols; gRows = rows; gCellPx = cellPx;
  const M = cols * rows;
  cellBlob = new Int32Array(M); cellRate = new Float32Array(M); cellPhase = new Float32Array(M);
  salSmooth = new Float32Array(M); labelBuf = new Int32Array(M); stackBuf = new Int32Array(M);
  tracks = []; gSampled = false;
  for (let i = 0; i < M; i++) { cellRate[i] = 13 + hash01(i, 7) * 30; cellPhase[i] = hash01(i, 3); }   // fast, varied glyph rates
  sampleMask();
}

function sampleMask() {
  if (!cellBlob || !media.type) return;
  const cols = gCols, rows = gRows, M = cols * rows;
  gridCanvas.width = cols; gridCanvas.height = rows;
  const gx = gridCanvas.getContext('2d', { willReadFrequently: true });
  let d; try { gx.drawImage(media.el, 0, 0, cols, rows); d = gx.getImageData(0, 0, cols, rows).data; } catch (e) { return; }
  const firstSample = !gSampled; gSampled = true;
  // 1 ─ saliency (brightness, contrast-normalised) with temporal smoothing for stability
  let mn = 1e9, mx = -1e9; const lum = new Float32Array(M);
  for (let i = 0; i < M; i++) { const L = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255; lum[i] = L; if (L < mn) mn = L; if (L > mx) mx = L; }
  const range = Math.max(1e-3, mx - mn);
  for (let i = 0; i < M; i++) { const sal = Math.pow((lum[i] - mn) / range, 1.4); salSmooth[i] = firstSample ? sal : sal * 0.45 + salSmooth[i] * 0.55; labelBuf[i] = -1; }
  const thr = 0.32 + (1 - state.gTol) * 0.52;     // Tolerance: high → lower threshold → bigger/more blobs
  // 2 ─ connected components (8-connected flood fill) → blobs
  const blobs = [], minArea = Math.max(2, Math.round(M * 0.004));
  for (let s = 0; s < M; s++) {
    if (labelBuf[s] !== -1 || salSmooth[s] <= thr) continue;
    const id = blobs.length; let sp = 0; stackBuf[sp++] = s; labelBuf[s] = id;
    let area = 0, sx = 0, sy = 0, x0 = cols, y0 = rows, x1 = 0, y1 = 0;
    while (sp) {
      const p = stackBuf[--sp], px = p % cols, py = (p / cols) | 0;
      area++; sx += px; sy += py; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const q = ny * cols + nx; if (labelBuf[q] === -1 && salSmooth[q] > thr) { labelBuf[q] = id; stackBuf[sp++] = q; }
      }
    }
    blobs.push({ area, cx: sx / area, cy: sy / area, keep: area >= minArea });
  }
  // 3 ─ track association (nearest centroid, EMA-smoothed, with persistence)
  const kept = blobs.filter(b => b.keep).sort((a, b) => b.area - a.area).slice(0, 12);
  const gate = 0.16;
  for (const k of kept) { k.ncx = k.cx / cols; k.ncy = k.cy / rows; k.track = null; }
  for (const t of tracks) {
    let best = null, bd = gate;
    for (const k of kept) { if (k.track) continue; const dd = Math.hypot(k.ncx - t.ncx, k.ncy - t.ncy); if (dd < bd) { bd = dd; best = k; } }
    if (best) { best.track = t; t.vx = best.ncx - t.ncx; t.vy = best.ncy - t.ncy; t.ncx = t.ncx * 0.5 + best.ncx * 0.5; t.ncy = t.ncy * 0.5 + best.ncy * 0.5; t.hits++; t.missed = 0; }
    else t.missed++;
  }
  for (const k of kept) { if (!k.track) { k.track = { id: nextTrackId++, ncx: k.ncx, ncy: k.ncy, vx: 0, vy: 0, hits: 0, missed: 0 }; tracks.push(k.track); } }
  tracks = tracks.filter(t => t.missed <= 12);
  // confirmed = first frame, or a track we've seen before, or an unmistakably large blob
  for (const b of blobs) b.draw = false;
  for (const k of kept) if (firstSample || k.track.hits >= 1 || k.area >= minArea * 2.5) { k.draw = true; k.bid = k.track.id; }
  // 4 ─ bond cells to their confirmed blob
  for (let i = 0; i < M; i++) { const li = labelBuf[i]; cellBlob[i] = (li >= 0 && blobs[li].draw) ? blobs[li].bid : -1; }
}

function updateGlyphFlicker(time) {
  if (!cellBlob || !state.gOn) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); return; }
  const cols = gCols, rows = gRows, M = cols * rows, sp = 6.0;          // natively very fast on/off flicker
  const duty = Math.min(0.96, 0.34 + state.gDensity * 0.62);            // how full each blob is
  const scroll = Math.floor(time * 7.0);                               // Odyssey streams through the blobs
  let n = 0;
  for (let i = 0; i < M && n < MAX_LETTERS; i++) {
    if (cellBlob[i] < 0) continue;                                      // only inside tracked blobs
    const tick = Math.floor(time * cellRate[i] * sp + cellPhase[i] * 101);
    if (hash01(i, tick) > duty) continue;
    const cx = i % cols, cy = (i / cols) | 0;
    const code = TEXT_CODES[((cy * cols + cx + scroll) % TEXT_CODES.length + TEXT_CODES.length) % TEXT_CODES.length];
    if (code === SPACE_CODE) continue;                                  // word gaps stay blank
    posArr[n * 3] = (cx + 0.5) / cols * 2 - 1;
    posArr[n * 3 + 1] = (1 - (cy + 0.5) / rows) * 2 - 1;
    posArr[n * 3 + 2] = 0;
    sizeArr[n] = gCellPx;
    glyphArr[n] = code;
    alphaArr[n] = 1;
    n++;
  }
  glyphCount = n;
  posAttr.needsUpdate = sizeAttr.needsUpdate = glyphAttr.needsUpdate = alphaAttr.needsUpdate = true;
  glyphGeo.setDrawRange(0, n);
}

/* ─────────────────────────── Render loop ─────────────────────────── */
const now = () => performance.now() * 0.001;   // seconds; advances every frame for the flicker
let bypass = false, dirty = true;
function requestRender() { dirty = true; }
function animating() { return media.type === 'video' || (media.type && state.gOn); }
function renderFrame() {
  if (!composer) return;
  if (bypass) { renderer.render(scene, camera); return; }
  if (state.gOn) {
    if (media.type === 'video') sampleMask();   // re-track the live frame every frame
    updateGlyphFlicker(now());
  }
  composer.render();
  if (glyphCount > 0) { renderer.autoClear = false; renderer.render(glyphScene, camera); renderer.autoClear = true; }
}
function tick() { requestAnimationFrame(tick); if (!media.type) return; if (animating() || dirty) { renderFrame(); dirty = false; } }
tick();

/* ─────────────────────────── State → uniforms ─────────────────────────── */
function applyState() {
  if (bloomPass) { bloomPass.strength = state.bloomStrength; bloomPass.radius = state.bloomRadius; bloomPass.threshold = state.bloomThreshold; }
  if (adjustPass) { const u = adjustPass.uniforms; u.uExposure.value = state.exposure; u.uContrast.value = state.contrast; u.uSaturation.value = state.saturation; }
  if (blurPass) { const u = blurPass.uniforms; u.uAmount.value = state.blur; u.uRadius.value = state.blurRadius; u.uSmooth.value = state.blurSmooth; u.uCenter.value.set(state.zoomCx, state.zoomCy); }
  glyphMat.uniforms.uSizeMul.value = 1;
  glyphMat.uniforms.uGlow.value = state.gOpacity;
  updateFocusMarker(); requestRender();
}

/* ── Zoom-centre marker (ring shows the sharp central radius) ── */
function blurActive() { return state.blur > 0.001; }
function updateFocusMarker() {
  if (!media.type || bypass || !blurActive()) { dom.focusRing.classList.add('hidden'); return; }
  const gr = dom.canvas.getBoundingClientRect(), sr = dom.stage.getBoundingClientRect();
  const left = (gr.left - sr.left) + state.zoomCx * gr.width, top = (gr.top - sr.top) + (1 - state.zoomCy) * gr.height;
  const diam = Math.max(0.05, 2 * state.blurRadius) * gr.height;
  dom.focusRing.style.left = left + 'px'; dom.focusRing.style.top = top + 'px'; dom.focusRing.style.width = diam + 'px'; dom.focusRing.style.height = diam + 'px';
  dom.focusRing.classList.remove('hidden');
}

/* ── Tap / drag on the image to set the zoom centre (image AND video). ── */
let pressing = false;
function uvFromXY(cx, cy) { const r = dom.canvas.getBoundingClientRect(); return [(cx - r.left) / r.width, (cy - r.top) / r.height]; }
function setCenterXY(cx, cy) { const [u, vt] = uvFromXY(cx, cy); state.zoomCx = Math.min(1, Math.max(0, u)); state.zoomCy = 1 - Math.min(1, Math.max(0, vt)); applyState(); }
dom.canvas.addEventListener('pointerdown', e => {
  if (!media.type || !blurActive()) return;
  pressing = true; try { dom.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  setCenterXY(e.clientX, e.clientY); e.preventDefault();
});
dom.canvas.addEventListener('pointermove', e => { if (pressing && blurActive()) setCenterXY(e.clientX, e.clientY); });
function endPtr() { pressing = false; }
dom.canvas.addEventListener('pointerup', endPtr);
dom.canvas.addEventListener('pointercancel', endPtr);
dom.canvas.addEventListener('lostpointercapture', endPtr);

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
  if (MASK_KEYS.includes(key)) { buildGlyphMask(); updateGlyphFlicker(now()); }
  else if (key === 'gTol') { sampleMask(); updateGlyphFlicker(now()); }   // re-weight a still image live
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
// Files from the iOS Photos library often arrive with an empty MIME type,
// so fall back to the extension to tell video from image.
function isVideoFile(f) { return f.type ? f.type.startsWith('video') : /\.(mp4|mov|m4v|webm|ogv|avi|mkv|3gp)$/i.test(f.name || ''); }
dom.addBtn.onclick = pickFile; dom.emptyAdd.onclick = pickFile;
dom.file.addEventListener('change', () => {
  const f = dom.file.files[0]; if (!f) return; const url = URL.createObjectURL(f); resetMedia();
  (isVideoFile(f) ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
  dom.file.value = '';
});
dom.sampleBtn.onclick = () => {
  resetMedia();
  loadImage('https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1600&q=80&auto=format', false)
    .catch(() => showError('Could not load the sample (network/CORS). Try adding your own photo.'));
};
function resetMedia() { stopRecording(true); pendingBlob = null; if (media.type === 'video') { dom.video.pause(); dom.video.removeAttribute('src'); dom.video.load(); } bypass = false; }
['dragover', 'drop'].forEach(ev => dom.stage.addEventListener(ev, e => e.preventDefault()));
dom.stage.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]; if (!f) return; const url = URL.createObjectURL(f); resetMedia();
  (isVideoFile(f) ? loadVideo(url) : loadImage(url, true)).catch(err => showError(err.message || String(err)));
});

/* ─────────────────────────── Export (share to Photos) ─────────────────────────── */
let recorder = null, recChunks = [], recMime = '', pendingBlob = null, pendingName = '';
function pickMime() { return ['video/mp4;codecs=h264', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ''; }
// Returns true if it handled the save; false if it needs a user gesture (iOS share).
async function trySave(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return true; return false; }   // NotAllowed → needs a gesture
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
function setPending(blob, name) {   // couldn't save without a gesture — let the next tap do it
  pendingBlob = blob; pendingName = name;
  dom.exportBtn.textContent = 'Save video'; dom.exportBtn.classList.add('btn--accent');
}
dom.exportBtn.onclick = async () => {
  if (pendingBlob) { const b = pendingBlob, n = pendingName; pendingBlob = null; dom.exportBtn.textContent = 'Record'; if (!await trySave(b, n)) setPending(b, n); return; }
  if (media.type === 'image') exportImage();
  else if (media.type === 'video') toggleRecording();
};
function exportImage() {
  bypass = false; renderFrame();
  const out = document.createElement('canvas'); out.width = dom.canvas.width; out.height = dom.canvas.height;
  out.getContext('2d').drawImage(dom.canvas, 0, 0);
  out.toBlob(b => { if (b) trySave(b, `halation-${Date.now()}.png`); }, 'image/png');
}
function toggleRecording() {
  if (recorder) { stopRecording(); return; }
  recMime = pickMime(); if (!recMime) { showError('Recording is not supported in this browser.'); return; }
  let stream; try { stream = dom.canvas.captureStream(30); } catch (e) { showError('Recording is not supported on this canvas.'); return; }
  try { recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: 12_000_000 }); }
  catch (e) { try { recorder = new MediaRecorder(stream); } catch (e2) { showError('Recording is not supported in this browser.'); return; } }
  recChunks = []; recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    const type = (recorder && recorder.mimeType) || recMime;
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(recChunks, { type });
    if (!blob.size) { showError('Recording came back empty — try again.'); return; }
    const name = `halation-${Date.now()}.${ext}`;
    // Manual stop is still inside the tap's activation window, so try to save now;
    // if the clip auto-ended (no gesture) the share is blocked → stash for one tap.
    if (!await trySave(blob, name)) setPending(blob, name);
  };
  dom.video.currentTime = 0; dom.video.loop = false; dom.video.play(); recorder.start();
  dom.rec.classList.remove('hidden'); dom.exportBtn.textContent = 'Stop'; dom.video.onended = () => stopRecording();
}
function stopRecording(silent) {
  if (!recorder) return; try { recorder.stop(); } catch (e) {}
  recorder = null; dom.video.loop = true; dom.video.onended = null;
  if (!silent && media.type === 'video') dom.video.play().catch(() => {});
  dom.rec.classList.add('hidden');
  if (dom.exportBtn && !pendingBlob) dom.exportBtn.textContent = media.type === 'video' ? 'Record' : 'Export';
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
