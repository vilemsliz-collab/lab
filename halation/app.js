import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// MediaPipe is loaded lazily inside getSegmenter() so a CDN failure can't blank the page.

/* ─────────────────────────────────────────────────────────────
   Halation — campaign content lab. Bloom (+tint), prism dispersion,
   finger-adjustable feathered focus mask, lens blurs, a procedural
   Greek-letter field placed from image data, and a HUD colour tracker.
   ───────────────────────────────────────────────────────────── */

const MAX_SIDE_IMAGE = 3072;
const MAX_SIDE_VIDEO = 1440;
const MAX_LETTERS = 14000;
const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω'; // 24 lowercase

const dom = {
  canvas:    document.getElementById('gl'),
  overlay:   document.getElementById('overlay'),
  focusRing: document.getElementById('focusRing'),
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

const state = {
  bloomStrength: 0.7, bloomRadius: 0.6, bloomThreshold: 0.8, bloomTintHue: 0.08, bloomTintAmt: 0,
  // blur & feathered focus mask
  soft: 0, zoom: 0, motion: 0, motionAngle: 0, dofBg: 0, focus: 0.1,
  focusBlur: 0, focusRadius: 0.34, focusFeather: 0.6, focusDark: 0, focusPtX: 0.5, focusPtY: 0.5,
  // dispersion
  dispAmount: 0.008, dispSpread: 0.66, dispHue: 0,
  // greek-letter field
  gOn: false, gMode: 0, gHue: 0, gTol: 0.5, gDensity: 0.5, gThreshold: 0.15, gSize: 0.5, gGlow: 0.9, gTintHue: 0, gMotion: 0,
  // colour tracking
  trackOn: false, trackAuto: true, trackLabels: true, trackHue: 0, trackTol: 0.5, trackBoxes: 8, trackMinSize: 0.25,
  maskInvert: false,
};
const GLYPH_PLACEMENT = ['gOn', 'gMode', 'gDensity', 'gThreshold', 'gHue', 'gTol'];

const CONTROLS = {
  bloom: [
    { t: 'slider', key: 'bloomStrength',  label: 'Glow strength',  min: 0, max: 3, step: 0.01 },
    { t: 'slider', key: 'bloomRadius',    label: 'Glow radius',    min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomThreshold', label: 'Glow threshold', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomTintAmt',   label: 'Glow tint',      min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'bloomTintHue',   label: 'Tint hue',       min: 0, max: 1, step: 0.001 },
  ],
  focus: [
    { t: 'note', text: 'Drag on the image to move the focus mask · pinch with two fingers to resize.' },
    { t: 'slider', key: 'focusBlur',    label: 'Focus blur (outside)', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'focusDark',    label: 'Darken outside',       min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'focusRadius',  label: 'Mask radius',          min: 0.05, max: 0.9, step: 0.01 },
    { t: 'slider', key: 'focusFeather', label: 'Feather (centre→edge)', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'focus',        label: 'Subject focus (mask)',  min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'dofBg',        label: 'Background DoF (mask)',  min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'soft',         label: 'Gaussian blur',         min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'zoom',         label: 'Zoom blur',             min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'motion',       label: 'Motion blur',           min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'motionAngle',  label: 'Motion angle',          min: 0, max: 6.283, step: 0.01 },
  ],
  dispersion: [
    { t: 'slider', key: 'dispAmount', label: 'Amount',        min: 0, max: 0.06, step: 0.001 },
    { t: 'slider', key: 'dispSpread', label: 'Colour spread', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'dispHue',    label: 'Hue offset',    min: 0, max: 1, step: 0.001 },
  ],
  particles: [
    { t: 'toggle', key: 'gOn', label: 'Greek-letter field' },
    { t: 'select', key: 'gMode', label: 'Placed by', options: [
      { label: 'Dark areas', val: 0 }, { label: 'Light areas', val: 1 }, { label: 'Colour', val: 2 }, { label: 'Uniform', val: 3 } ] },
    { t: 'slider', key: 'gDensity',   label: 'Density',     min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gThreshold', label: 'Threshold',   min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gHue',       label: 'Colour hue (Colour mode)', min: 0, max: 1, step: 0.001 },
    { t: 'slider', key: 'gTol',       label: 'Colour tolerance',         min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gSize',      label: 'Letter size', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gGlow',      label: 'Opacity',     min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'gMotion',    label: 'Drift',       min: 0, max: 1, step: 0.01 },
  ],
  track: [
    { t: 'toggle', key: 'trackOn',     label: 'Colour tracking' },
    { t: 'toggle', key: 'trackAuto',   label: 'Auto (most saturated)' },
    { t: 'toggle', key: 'trackLabels', label: 'Hex labels' },
    { t: 'slider', key: 'trackHue',     label: 'Track hue (manual)', min: 0, max: 1, step: 0.001 },
    { t: 'slider', key: 'trackTol',     label: 'Tolerance / sensitivity', min: 0, max: 1, step: 0.01 },
    { t: 'slider', key: 'trackBoxes',   label: 'Max boxes', min: 1, max: 24, step: 1 },
    { t: 'slider', key: 'trackMinSize', label: 'Min blob size', min: 0, max: 1, step: 0.01 },
  ],
};

/* ─────────────────────────── Shaders ─────────────────────────── */
const PASS_VERT = `varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const MASK_SAMPLE = `float maskAt(sampler2D t, vec2 uv, float inv){ float m = texture2D(t, vec2(uv.x, 1.0-uv.y)).r; return mix(m, 1.0-m, inv); }`;
const HSV = `vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0); vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y); }`;

const DispersionShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null },
    uAmount: { value: state.dispAmount }, uSpread: { value: state.dispSpread }, uHue: { value: state.dispHue },
    uFocus: { value: state.focus }, uMaskInvert: { value: 0 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tMask; uniform float uAmount, uSpread, uHue, uFocus, uMaskInvert; varying vec2 vUv;
    ${MASK_SAMPLE} ${HSV}
    void main(){
      float m = maskAt(tMask, vUv, uMaskInvert);
      vec2 dir = vUv - 0.5; float dist = length(dir); vec2 nd = normalize(dir + 1e-6);
      vec3 acc = vec3(0.0), wsum = vec3(0.0);
      for (int i = 0; i < 8; i++){
        float f = float(i) / 7.0;
        float off = (f - 0.5) * 2.0 * uAmount * dist;
        vec3 tint = hsv2rgb(vec3(fract(uHue + f * uSpread), 0.9, 1.0));
        acc += texture2D(tDiffuse, vUv + nd * off).rgb * tint;
        wsum += tint;
      }
      vec3 col = acc / max(wsum, vec3(1e-4));
      col *= 1.0 - uFocus * 0.6 * (1.0 - m);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const LensBlurShader = {
  uniforms: {
    tDiffuse: { value: null }, tMask: { value: null }, uTexel: { value: new THREE.Vector2() },
    uSoft: { value: 0 }, uZoom: { value: 0 }, uMotion: { value: 0 }, uAngle: { value: 0 }, uDofBg: { value: 0 }, uMaskInvert: { value: 0 },
    uFocusPt: { value: new THREE.Vector2(0.5, 0.5) }, uFocusR: { value: 0.34 }, uFeather: { value: 0.6 },
    uFocusBlur: { value: 0 }, uFocusDark: { value: 0 }, uAspect: { value: 1 },
  },
  vertexShader: PASS_VERT,
  fragmentShader: `
    uniform sampler2D tDiffuse, tMask; uniform vec2 uTexel, uFocusPt;
    uniform float uSoft, uZoom, uMotion, uAngle, uDofBg, uMaskInvert, uFocusR, uFeather, uFocusBlur, uFocusDark, uAspect;
    varying vec2 vUv;
    ${MASK_SAMPLE}
    void main(){
      float m = maskAt(tMask, vUv, uMaskInvert);
      vec2 fd = (vUv - uFocusPt) * vec2(uAspect, 1.0);
      float inner = uFocusR * (1.0 - uFeather);
      float grad = smoothstep(inner, uFocusR, length(fd));   // 0 at centre → 1 at edge
      float soft = uSoft + uDofBg * (1.0 - m) + uFocusBlur * grad;
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
      if (uZoom > 0.002){ vec2 d = 0.5 - vUv;
        for (int i = 1; i <= 8; i++){ float s = float(i) / 8.0; col += texture2D(tDiffuse, vUv + d * s * uZoom * 0.3).rgb; wsum += 1.0; } }
      if (uMotion > 0.002){ vec2 d = vec2(cos(uAngle), sin(uAngle));
        for (int i = -6; i <= 6; i++){ if (i == 0) continue; col += texture2D(tDiffuse, vUv + d * float(i) * uMotion * uTexel * 7.0).rgb; wsum += 1.0; } }
      vec3 outc = col / wsum;
      outc *= 1.0 - uFocusDark * grad * 0.9;
      gl_FragColor = vec4(outc, 1.0);
    }`,
};

/* ── Custom bloom (byte targets → iOS-safe), with tint ── */
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
  uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, uStrength: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 } },
  vertexShader: FS_VERT,
  fragmentShader: `uniform sampler2D tDiffuse, tBloom; uniform float uStrength, uTintAmt; uniform vec3 uTint; varying vec2 vUv;
    void main(){ vec3 base = texture2D(tDiffuse, vUv).rgb; vec3 bloom = texture2D(tBloom, vUv).rgb * uStrength;
      bloom = mix(bloom, bloom * (uTint * 2.0), uTintAmt);
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
const posArr = new Float32Array(MAX_LETTERS * 3), sizeArr = new Float32Array(MAX_LETTERS), glyphArr = new Float32Array(MAX_LETTERS), alphaArr = new Float32Array(MAX_LETTERS), randArr = new Float32Array(MAX_LETTERS);
const posAttr = new THREE.BufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage);
const sizeAttr = new THREE.BufferAttribute(sizeArr, 1).setUsage(THREE.DynamicDrawUsage);
const glyphAttr = new THREE.BufferAttribute(glyphArr, 1).setUsage(THREE.DynamicDrawUsage);
const alphaAttr = new THREE.BufferAttribute(alphaArr, 1).setUsage(THREE.DynamicDrawUsage);
const randAttr = new THREE.BufferAttribute(randArr, 1).setUsage(THREE.DynamicDrawUsage);
glyphGeo.setAttribute('position', posAttr); glyphGeo.setAttribute('aSize', sizeAttr);
glyphGeo.setAttribute('aGlyph', glyphAttr); glyphGeo.setAttribute('aAlpha', alphaAttr); glyphGeo.setAttribute('aRand', randAttr);
glyphGeo.setDrawRange(0, 0);
const glyphMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
  uniforms: { uAtlas: { value: buildGreekAtlas() }, uSizeMul: { value: 1 }, uGlow: { value: 0.9 }, uColor: { value: new THREE.Color(1, 1, 1) }, uTime: { value: 0 }, uMotion: { value: 0 } },
  vertexShader: `
    attribute float aSize, aGlyph, aAlpha, aRand;
    uniform float uSizeMul, uTime, uMotion; varying float vGlyph, vAlpha;
    void main(){
      vGlyph = aGlyph; vAlpha = aAlpha;
      vec2 p = position.xy;
      if (uMotion > 0.0){ p.x += sin(uTime * 1.3 + aRand * 6.28) * 0.012 * uMotion; p.y += cos(uTime * 1.1 + aRand * 9.0) * 0.012 * uMotion; }
      gl_PointSize = clamp(aSize * uSizeMul, 4.0, 480.0);
      gl_Position = vec4(p, 0.0, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas; uniform vec3 uColor; uniform float uGlow; varying float vGlyph, vAlpha;
    void main(){
      float gi = vGlyph; vec2 cell = vec2(mod(gi, 6.0), floor(gi / 6.0));
      vec2 guv = (cell + gl_PointCoord) / vec2(6.0, 4.0);
      float a = texture2D(uAtlas, guv).a * vAlpha * uGlow;
      if (a < 0.02) discard;
      gl_FragColor = vec4(uColor, a);
    }`,
});
glyphScene.add(new THREE.Points(glyphGeo, glyphMat));
let glyphCount = 0;
const gridCanvas = document.createElement('canvas');

/* ── Composer ── */
let composer, bloomPass, dispPass, blurPass;
function buildComposer(w, h) {
  if (composer) composer.dispose();
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1); composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  dispPass = new ShaderPass(DispersionShader); composer.addPass(dispPass);
  blurPass = new ShaderPass(LensBlurShader); blurPass.uniforms.uTexel.value.set(1 / w, 1 / h); blurPass.uniforms.uAspect.value = w / h; composer.addPass(blurPass);
  bloomPass = new HalationBloomPass(w, h); composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
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
function setMaskUniforms() { if (dispPass) dispPass.uniforms.tMask.value = maskTex; if (blurPass) blurPass.uniforms.tMask.value = maskTex; }
function updateMaskFromResult(result) {
  const mask = result.confidenceMasks && result.confidenceMasks[0]; if (!mask) return;
  const w = mask.width, h = mask.height, f32 = mask.getAsFloat32Array();
  if (!maskBuf || maskBuf.length !== w * h) maskBuf = new Uint8Array(w * h);
  for (let i = 0; i < f32.length; i++) maskBuf[i] = (f32[i] * 255) | 0;
  if (maskTex.image.width !== w || maskTex.image.height !== h) { maskTex.dispose(); maskTex = makeMaskTexture(maskBuf, w, h); }
  else { maskTex.image.data = maskBuf; maskTex.needsUpdate = true; }
  setMaskUniforms(); requestRender();
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
  } catch (e) { console.warn('Segmenter unavailable; mask effects apply globally.', e); segmenter = null; }
  finally { showLoading(false); }
  return segmenter;
}

/* ─────────────────────────── Media loading ─────────────────────────── */
let media = { type: null, el: null, w: 0, h: 0 };
let lastVideoTs = -1;
function fitCanvasStyle(w, h) {
  const sw = dom.stage.clientWidth, sh = dom.stage.clientHeight; if (!sw || !sh) return;
  const scale = Math.min(sw / w, sh / h);
  dom.canvas.style.width = Math.round(w * scale) + 'px'; dom.canvas.style.height = Math.round(h * scale) + 'px';
  positionOverlay(); updateFocusMarker(); drawBlobs();
}
function positionOverlay() {
  const gr = dom.canvas.getBoundingClientRect(), sr = dom.stage.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  dom.overlay.style.left = (gr.left - sr.left) + 'px'; dom.overlay.style.top = (gr.top - sr.top) + 'px';
  dom.overlay.style.width = gr.width + 'px'; dom.overlay.style.height = gr.height + 'px';
  dom.overlay.width = Math.max(1, Math.round(gr.width * dpr)); dom.overlay.height = Math.max(1, Math.round(gr.height * dpr));
}
function capSize(w, h, maxSide) { const s = Math.min(1, maxSide / Math.max(w, h)); return [Math.round(w * s), Math.round(h * s)]; }

async function loadImage(src, revoke) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('This image format can’t be decoded by your browser (e.g. HEIC). Try a JPG or PNG.')); img.src = src; });
  if (revoke) URL.revokeObjectURL(src);
  const [w, h] = capSize(img.naturalWidth, img.naturalHeight, MAX_SIDE_IMAGE);
  const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  setupMedia('image', img, w, h, tex);
  const seg = await getSegmenter('IMAGE');
  if (seg) { try { updateMaskFromResult(seg.segment(img)); } catch (e) { console.warn(e); } }
}
async function loadVideo(src) {
  const v = dom.video; v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('This video format can’t be played by your browser. Try an MP4 (H.264).')); });
  const [w, h] = capSize(v.videoWidth, v.videoHeight, MAX_SIDE_VIDEO);
  const tex = new THREE.VideoTexture(v); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  setupMedia('video', v, w, h, tex);
  await getSegmenter('VIDEO'); lastVideoTs = -1; v.play().catch(() => {});
}
function setupMedia(type, el, w, h, tex) {
  media = { type, el, w, h };
  quad.material.map = tex; quad.material.needsUpdate = true;
  renderer.setSize(w, h, false); buildComposer(w, h); fitCanvasStyle(w, h); setMaskUniforms();
  dom.empty.classList.add('hidden');
  dom.compare.classList.remove('hidden'); dom.compare.disabled = false;
  dom.exportBtn.disabled = false; dom.exportBtn.textContent = type === 'video' ? 'Record' : 'Export';
  computeGlyphField(); if (state.trackOn) { computeBlobs(); drawBlobs(); }
  requestRender();
}

/* ── Greek-letter procedural placement ── */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d / mx : 0, mx];
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function pickCell(prefix, r) { let lo = 0, hi = prefix.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (prefix[mid] < r) lo = mid + 1; else hi = mid; } return lo; }
function computeGlyphField() {
  // Content-weighted scatter: positions importance-sampled from a weight map
  // derived from the image (dark / light / colour / uniform), seeded so a still
  // image is stable while video tracks its content.
  if (!media.type || !state.gOn) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); requestRender(); return; }
  const A = 160, ar = media.w / media.h;
  let aw, ah; if (ar >= 1) { aw = A; ah = Math.max(1, Math.round(A / ar)); } else { ah = A; aw = Math.max(1, Math.round(A * ar)); }
  gridCanvas.width = aw; gridCanvas.height = ah;
  const gx = gridCanvas.getContext('2d', { willReadFrequently: true });
  let d; try { gx.drawImage(media.el, 0, 0, aw, ah); d = gx.getImageData(0, 0, aw, ah).data; } catch (e) { glyphCount = 0; glyphGeo.setDrawRange(0, 0); return; }
  const M = aw * ah, wt = new Float32Array(M), prefix = new Float32Array(M);
  const thr = state.gThreshold * 0.9, tol = 0.04 + state.gTol * 0.4;
  let total = 0, maxW = 1e-4;
  for (let i = 0; i < M; i++) {
    const [h, s, v] = rgbToHsv(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    let w;
    if (state.gMode === 0) w = 1 - v;
    else if (state.gMode === 1) w = v;
    else if (state.gMode === 2) { let dh = Math.abs(h - state.gHue); dh = Math.min(dh, 1 - dh); w = Math.max(0, 1 - dh / tol) * s * (v > 0.1 ? 1 : 0); }
    else w = 1;
    if (w < thr) w = 0;
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
    randArr[n] = rng();
    n++;
  }
  glyphCount = n;
  posAttr.needsUpdate = sizeAttr.needsUpdate = glyphAttr.needsUpdate = alphaAttr.needsUpdate = randAttr.needsUpdate = true;
  glyphGeo.setDrawRange(0, n);
  requestRender();
}

/* ─────────────────────── Colour-blob tracker (HUD) ─────────────────────── */
const analyzeCanvas = document.createElement('canvas');
let blobs = [];
function computeBlobs() {
  if (!media.type || !state.trackOn) { blobs = []; return; }
  const SAMPLE = 120, ar = media.w / media.h;
  let sw, sh; if (ar >= 1) { sw = SAMPLE; sh = Math.max(1, Math.round(SAMPLE / ar)); } else { sh = SAMPLE; sw = Math.max(1, Math.round(SAMPLE * ar)); }
  analyzeCanvas.width = sw; analyzeCanvas.height = sh;
  const x = analyzeCanvas.getContext('2d', { willReadFrequently: true });
  let data; try { x.drawImage(media.el, 0, 0, sw, sh); data = x.getImageData(0, 0, sw, sh).data; } catch (e) { blobs = []; return; }
  const N = sw * sh, mask = new Uint8Array(N);
  const satThr = state.trackAuto ? (0.34 - state.trackTol * 0.26) : 0.16, hueTol = 0.02 + state.trackTol * 0.22;
  for (let i = 0; i < N; i++) {
    const [h, s, v] = rgbToHsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    let hit = s > satThr && v > 0.12;
    if (hit && !state.trackAuto) { let dh = Math.abs(h - state.trackHue); dh = Math.min(dh, 1 - dh); hit = dh <= hueTol; }
    mask[i] = hit ? 1 : 0;
  }
  const seen = new Uint8Array(N), stack = new Int32Array(N), found = [];
  const minArea = Math.max(3, Math.round((0.0015 + state.trackMinSize * 0.05) * N));
  for (let i = 0; i < N; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let minx = sw, maxx = 0, miny = sh, maxy = 0, cnt = 0, sr = 0, sg = 0, sb = 0;
    while (sp) {
      const p = stack[--sp], px = p % sw, py = (p / sw) | 0;
      cnt++; sr += data[p * 4]; sg += data[p * 4 + 1]; sb += data[p * 4 + 2];
      if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < sw - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0 && mask[p - sw] && !seen[p - sw]) { seen[p - sw] = 1; stack[sp++] = p - sw; }
      if (py < sh - 1 && mask[p + sw] && !seen[p + sw]) { seen[p + sw] = 1; stack[sp++] = p + sw; }
    }
    if (cnt < minArea) continue;
    const hex = '#' + [sr, sg, sb].map(c => Math.round(c / cnt).toString(16).padStart(2, '0')).join('').toUpperCase();
    found.push({ x0: minx / sw, y0: miny / sh, x1: (maxx + 1) / sw, y1: (maxy + 1) / sh, area: cnt, hex });
  }
  found.sort((a, b) => b.area - a.area);
  blobs = found.slice(0, state.trackBoxes);
}
function drawBlobs() {
  const ctx = dom.overlay.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = dom.overlay.width / dpr, H = dom.overlay.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (!state.trackOn || bypass) return;
  const accent = '#c8ff00';
  ctx.font = '600 10px "IBM Plex Mono", monospace'; ctx.textBaseline = 'bottom';
  blobs.forEach((b, i) => {
    const x = b.x0 * W, y = b.y0 * H, w = (b.x1 - b.x0) * W, h = (b.y1 - b.y0) * H;
    ctx.strokeStyle = accent; ctx.lineWidth = 1.25; ctx.globalAlpha = 0.95; ctx.strokeRect(x, y, w, h);
    const t = Math.min(12, Math.min(w, h) * 0.3); ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y);
    ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t);
    ctx.moveTo(x + w, y + h - t); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - t, y + h);
    ctx.moveTo(x + t, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - t);
    ctx.stroke();
    if (state.trackLabels) {
      const label = `${String(i + 1).padStart(2, '0')} ${b.hex}`, tw = ctx.measureText(label).width, ly = y > 16 ? y - 4 : y + h + 14;
      ctx.globalAlpha = 0.85; ctx.fillStyle = 'rgba(8,8,8,0.8)'; ctx.fillRect(x, ly - 13, tw + 18, 15);
      ctx.globalAlpha = 1; ctx.fillStyle = b.hex; ctx.fillRect(x + 3, ly - 11, 8, 8);
      ctx.fillStyle = accent; ctx.fillText(label, x + 14, ly);
    }
    ctx.globalAlpha = 1;
  });
}

/* ─────────────────────────── Render loop ─────────────────────────── */
const clock = new THREE.Clock();
let bypass = false, dirty = true, vframe = 0;
function requestRender() { dirty = true; }
function animating() { return media.type === 'video' || (glyphCount > 0 && state.gMotion > 0); }
function renderFrame() {
  if (media.type === 'video' && !dom.video.paused && segmenter && segmenterMode === 'VIDEO') {
    const ts = performance.now();
    if (ts !== lastVideoTs) { lastVideoTs = ts; try { segmenter.segmentForVideo(dom.video, ts, updateMaskFromResult); } catch (e) {} }
  }
  if (!composer) return;
  if (bypass) { renderer.render(scene, camera); return; }
  composer.render();
  if (glyphCount > 0) { glyphMat.uniforms.uTime.value = clock.elapsedTime; renderer.autoClear = false; renderer.render(glyphScene, camera); renderer.autoClear = true; }
  if (media.type === 'video') {
    vframe++;
    if (state.gOn && vframe % 15 === 0) computeGlyphField();
    if (state.trackOn) { if (vframe % 8 === 0) computeBlobs(); drawBlobs(); }
  }
}
function tick() { requestAnimationFrame(tick); if (!media.type) return; if (animating() || dirty) { renderFrame(); dirty = false; } }
tick();

/* ─────────────────────────── State → uniforms ─────────────────────────── */
function applyState() {
  if (bloomPass) {
    bloomPass.strength = state.bloomStrength; bloomPass.radius = state.bloomRadius; bloomPass.threshold = state.bloomThreshold;
    const cu = bloomPass.compQuad.material.uniforms; cu.uTint.value.setHSL(state.bloomTintHue, 0.9, 0.6); cu.uTintAmt.value = state.bloomTintAmt;
  }
  if (dispPass) { const u = dispPass.uniforms; u.uAmount.value = state.dispAmount; u.uSpread.value = state.dispSpread; u.uHue.value = state.dispHue; u.uFocus.value = state.focus; u.uMaskInvert.value = state.maskInvert ? 1 : 0; }
  if (blurPass) { const u = blurPass.uniforms;
    u.uSoft.value = state.soft; u.uZoom.value = state.zoom; u.uMotion.value = state.motion; u.uAngle.value = state.motionAngle; u.uDofBg.value = state.dofBg; u.uMaskInvert.value = state.maskInvert ? 1 : 0;
    u.uFocusPt.value.set(state.focusPtX, state.focusPtY); u.uFocusR.value = state.focusRadius; u.uFeather.value = state.focusFeather; u.uFocusBlur.value = state.focusBlur; u.uFocusDark.value = state.focusDark; }
  glyphMat.uniforms.uSizeMul.value = 0.5 + state.gSize * 1.8;
  glyphMat.uniforms.uGlow.value = state.gGlow;
  glyphMat.uniforms.uMotion.value = state.gMotion;
  updateFocusMarker(); requestRender();
}

/* ── Focus marker ── */
function focusActive() { return state.focusBlur > 0.001 || state.focusDark > 0.001; }
function updateFocusMarker() {
  if (!media.type || bypass || !focusActive()) { dom.focusRing.classList.add('hidden'); return; }
  const gr = dom.canvas.getBoundingClientRect(), sr = dom.stage.getBoundingClientRect();
  const left = (gr.left - sr.left) + state.focusPtX * gr.width, top = (gr.top - sr.top) + (1 - state.focusPtY) * gr.height, diam = 2 * state.focusRadius * gr.height;
  dom.focusRing.style.left = left + 'px'; dom.focusRing.style.top = top + 'px'; dom.focusRing.style.width = diam + 'px'; dom.focusRing.style.height = diam + 'px';
  dom.focusRing.classList.remove('hidden');
}

/* ── Finger-adjustable focus mask (drag = move, pinch = resize) ── */
const fptr = new Map(); let pinch = null, fmoved = false;
function uvFromXY(cx, cy) { const r = dom.canvas.getBoundingClientRect(); return [(cx - r.left) / r.width, (cy - r.top) / r.height]; }
function setCenterXY(cx, cy) { const [u, vt] = uvFromXY(cx, cy); if (u < -0.05 || u > 1.05 || vt < -0.05 || vt > 1.05) return; state.focusPtX = Math.min(1, Math.max(0, u)); state.focusPtY = 1 - Math.min(1, Math.max(0, vt)); applyState(); }
dom.canvas.addEventListener('pointerdown', e => {
  if (!media.type) return; fptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); fmoved = false;
  try { dom.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  if (fptr.size === 2) { const p = [...fptr.values()]; pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), r: state.focusRadius }; }
});
dom.canvas.addEventListener('pointermove', e => {
  if (!fptr.has(e.pointerId)) return; fptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); fmoved = true;
  const p = [...fptr.values()];
  if (p.length >= 2) {
    const cur = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinch) state.focusRadius = Math.min(1.2, Math.max(0.05, pinch.r * (cur / pinch.d)));
    if (sliderEls.focusRadius) { sliderEls.focusRadius.input.value = state.focusRadius; sliderEls.focusRadius.paint(); }
    setCenterXY((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
  } else if (focusActive()) { setCenterXY(e.clientX, e.clientY); }
});
function endPtr(e) { if (!fptr.has(e.pointerId)) return; fptr.delete(e.pointerId); if (fptr.size < 2) pinch = null; if (fptr.size === 0 && !fmoved && !focusActive()) setCenterXY(e.clientX, e.clientY); }
dom.canvas.addEventListener('pointerup', endPtr);
dom.canvas.addEventListener('pointercancel', endPtr);

/* ─────────────────────────── Panel UI ─────────────────────────── */
const sliderEls = {};
function buildPanel() {
  for (const [tab, controls] of Object.entries(CONTROLS)) {
    const pane = document.createElement('div');
    pane.className = 'pane' + (tab === 'bloom' ? ' pane--active' : ''); pane.dataset.pane = tab;
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
  if (GLYPH_PLACEMENT.includes(key)) computeGlyphField();
  if (key.startsWith('track')) { computeBlobs(); drawBlobs(); }
}
function buildSlider(c) {
  const wrap = document.createElement('label'); wrap.className = 'ctrl';
  const row = document.createElement('div'); row.className = 'ctrl__row';
  const lab = document.createElement('span'); lab.className = 'ctrl__label'; lab.textContent = c.label;
  const val = document.createElement('span'); val.className = 'ctrl__val';
  const input = document.createElement('input'); input.type = 'range'; input.min = c.min; input.max = c.max; input.step = c.step; input.value = state[c.key];
  const fmt = v => (c.step >= 1 ? String(Math.round(v)) : c.step < 0.01 ? (+v).toFixed(3) : (+v).toFixed(2));
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
  dom.compare.addEventListener(ev, e => { bypass = (ev === 'pointerdown'); requestRender(); updateFocusMarker(); drawBlobs(); if (ev === 'pointerdown') e.preventDefault(); }));

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
  const octx = out.getContext('2d'); octx.drawImage(dom.canvas, 0, 0);
  if (state.trackOn && blobs.length) octx.drawImage(dom.overlay, 0, 0, out.width, out.height);
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
window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { if (media.w) fitCanvasStyle(media.w, media.h); }); });

/* ── Init ── */
buildPanel(); snapPanel(true);
if (!renderer.getContext()) showError('WebGL is not available in this browser — the effects need it.');
