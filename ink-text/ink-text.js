(function () {
  'use strict';

  function buildShell(mount, opts) {
    mount.classList.add('ink-text');
    mount.innerHTML = `
      <div class="ink-text__controls">
        ${opts.showBackLink ? `<a class="ink-text__back" href="${opts.backHref}">&larr; Lab</a>` : ''}
        <input class="ink-text__input" type="text" placeholder="Type your text… use | for new line" />
        <button class="ink-text__update">Update</button>
        <span class="ink-text__hint">Enter / | = new line</span>
      </div>
      <div class="ink-text__sliders">
        <label><span class="sl">Metaball</span><input type="range" data-sl="metaball" min="0.3" max="6" step="0.1" value="2.0" /><span class="sv" data-sv="metaball">2.0</span></label>
        <label><span class="sl">Spread</span><input type="range" data-sl="spread" min="0" max="1" step="0.01" value="0.20" /><span class="sv" data-sv="spread">0.20</span></label>
        <label><span class="sl">Memory</span><input type="range" data-sl="recall" min="0" max="0.025" step="0.001" value="0.014" /><span class="sv" data-sv="recall">0.014</span></label>
      </div>
      <div class="ink-text__stage">
        <canvas class="ink-text__bg-noise"></canvas>
        <div class="ink-text__root"></div>
      </div>
    `;
    return {
      input:    mount.querySelector('.ink-text__input'),
      update:   mount.querySelector('.ink-text__update'),
      bgNoise:  mount.querySelector('.ink-text__bg-noise'),
      stage:    mount.querySelector('.ink-text__stage'),
      root:     mount.querySelector('.ink-text__root'),
      slMeta:   mount.querySelector('[data-sl="metaball"]'),
      svMeta:   mount.querySelector('[data-sv="metaball"]'),
      slSpread: mount.querySelector('[data-sl="spread"]'),
      svSpread: mount.querySelector('[data-sv="spread"]'),
      slRecall: mount.querySelector('[data-sl="recall"]'),
      svRecall: mount.querySelector('[data-sv="recall"]'),
    };
  }

  window.initInkText = function initInkText(options) {
    const opts = Object.assign({
      mount: null,
      defaultLines: ["Feeling isn't accidental.", "It's designed."],
      showBackLink: true,
      backHref: '../',
    }, options || {});

    if (!opts.mount) throw new Error('initInkText: `mount` is required');

    const els = buildShell(opts.mount, opts);

    const cssRoot = getComputedStyle(document.documentElement);
    const INK  = cssRoot.getPropertyValue('--color-on-background').trim() || '#393A3F';
    const BG   = cssRoot.getPropertyValue('--color-background').trim()    || '#ffffff';
    const FONT = 'Google Sans Flex';

    let currentLines = opts.defaultLines.slice();
    const _ctrl = { metaball: 2.0, spread: 0.20, recall: 0.014 };

    els.slMeta.addEventListener('input', e => {
      _ctrl.metaball = +e.target.value;
      els.svMeta.textContent = _ctrl.metaball.toFixed(1);
      wrapDiv.style.filter = 'blur(' + _ctrl.metaball + 'px) contrast(30)';
    });
    els.slSpread.addEventListener('input', e => {
      _ctrl.spread = +e.target.value;
      els.svSpread.textContent = _ctrl.spread.toFixed(2);
    });
    els.slRecall.addEventListener('input', e => {
      _ctrl.recall = +e.target.value;
      els.svRecall.textContent = _ctrl.recall.toFixed(3);
    });

    function applyText() {
      const val = els.input.value.trim();
      currentLines = val ? val.split(/[|\n]/).map(s => s.trim()).filter(Boolean)
                         : opts.defaultLines.slice();
      buildText();
    }
    els.update.addEventListener('click', applyText);
    els.input.addEventListener('keydown', e => { if (e.key === 'Enter') applyText(); });

    // ── White-noise background ───────────────────────────────────────
    const bgNoise = els.bgNoise;
    let bgNoiseCtx, bgNW, bgNH;
    function initBgNoise() {
      bgNW = Math.ceil(els.stage.clientWidth / 3);
      bgNH = Math.ceil(els.stage.clientHeight / 3);
      bgNoise.width = bgNW;
      bgNoise.height = bgNH;
      bgNoiseCtx = bgNoise.getContext('2d');
    }
    function drawBgNoise() {
      if (!bgNoiseCtx || !bgNW || !bgNH) return;
      const img = bgNoiseCtx.createImageData(bgNW, bgNH);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = 255; img.data[i+1] = 255; img.data[i+2] = 255;
        img.data[i+3] = Math.random() < 0.10 ? (20 + Math.random() * 30 | 0) : 0;
      }
      bgNoiseCtx.putImageData(img, 0, 0);
    }

    // ── Main hero ────────────────────────────────────────────────────
    const S = 7;
    let buf = new Float32Array(0), count = 0;
    let mx = -9999, my = -9999, pmx = -9999, pmy = -9999;
    let vars = {}, dirty = true;
    const MAX_DOTS = 25000;
    const container = els.root;

    const patternCanvas = document.createElement('canvas');
    patternCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
    container.appendChild(patternCanvas);

    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;image-rendering:pixelated;';
    container.appendChild(noiseCanvas);

    const wrapDiv = document.createElement('div');
    wrapDiv.style.cssText = 'position:absolute;inset:0;z-index:2;mix-blend-mode:multiply;';
    container.appendChild(wrapDiv);

    const mainCanvas = document.createElement('canvas');
    mainCanvas.style.display = 'block';
    wrapDiv.appendChild(mainCanvas);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;z-index:3;background-color:' + INK + ';mix-blend-mode:lighten;pointer-events:none;';
    container.appendChild(overlay);

    container.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:linear-gradient(180deg,' + BG + ' 0%,#fff 100%);isolation:isolate;';

    const ctx  = mainCanvas.getContext('2d');
    const nctx = noiseCanvas.getContext('2d');
    const pctx = patternCanvas.getContext('2d');

    function getSize() { return { w: container.clientWidth, h: container.clientHeight }; }

    function computeVars() {
      const W = getSize().w, t = Math.max(0, Math.min(1, (W - 320) / (1600 - 320)));
      const ss = [[320, 1.4], [700, 1.6], [1000, 1.85], [1200, 2.1], [1600, 2.4]];
      let spacing = ss[ss.length - 1][1];
      for (let i = 0; i < ss.length - 1; i++) {
        const [w0, s0] = ss[i], [w1, s1] = ss[i+1];
        if (W <= w0) { spacing = s0; break; }
        if (W <  w1) { spacing = s0 + (s1 - s0) * (W - w0) / (w1 - w0); break; }
      }
      const baseR = spacing * 1.05;
      vars = { baseR, spacing, blur: Math.max(baseR * 0.65, 0.3 + (2.0 - 0.3) * t), rippleR: Math.round(60 + (140 - 60) * t) };
      wrapDiv.style.filter = 'blur(' + _ctrl.metaball + 'px) contrast(30)';
    }

    function resize() {
      const { w, h } = getSize();
      mainCanvas.width = w; mainCanvas.height = h;
      patternCanvas.width = w; patternCanvas.height = h;
      computeVars();
      dirty = true;
    }

    function buildText() {
      const { baseR, spacing } = vars;
      const W = mainCanvas.width, H = mainCanvas.height;
      if (!W || !H) return;
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d');
      const fs = [[320, 28], [500, 36], [720, 48], [944, 58], [1200, 68], [1400, 76], [1600, 82]];
      let fontSize = fs[fs.length - 1][1];
      for (let i = 0; i < fs.length - 1; i++) {
        const [w0, s0] = fs[i], [w1, s1] = fs[i+1];
        if (W <= w0) { fontSize = s0; break; }
        if (W <  w1) { fontSize = Math.round(s0 + (s1 - s0) * (W - w0) / (w1 - w0)); break; }
      }
      octx.fillStyle = '#000';
      octx.font = "500 " + fontSize + "px '" + FONT + "', sans-serif";
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      const lineH = fontSize * 1.2, totalH = currentLines.length * lineH;
      const startY = H / 2 - totalH / 2 + lineH / 2;
      currentLines.forEach((line, i) => { octx.fillText(line, W / 2, startY + i * lineH); });
      const data = octx.getImageData(0, 0, W, H).data, step = Math.max(spacing, 1);
      let n = 0;
      for (let py = 0; py < H && n < MAX_DOTS; py += step)
        for (let px = 0; px < W && n < MAX_DOTS; px += step)
          if (data[((py|0) * W + (px|0)) * 4 + 3] >= 70) n++;
      buf = new Float32Array(n * S); count = n; let idx = 0;
      for (let py = 0; py < H && idx < n; py += step) {
        for (let px = 0; px < W && idx < n; px += step) {
          if (data[((py|0) * W + (px|0)) * 4 + 3] < 70) continue;
          const o = idx * S;
          buf[o] = px; buf[o+1] = py; buf[o+2] = px; buf[o+3] = py;
          buf[o+4] = 0; buf[o+5] = 0; buf[o+6] = baseR * (0.85 + Math.random() * 0.3);
          idx++;
        }
      }
      dirty = true;
    }

    // ── Warped field-line grid ───────────────────────────────────────
    function drawPattern(W, H) {
      pctx.clearRect(0, 0, W, H);
      const inkRgba = hexToRgba(INK, 0.07);
      pctx.strokeStyle = inkRgba;
      pctx.lineWidth = 1;
      const cx = W / 2, cy = H / 2;
      const lensR = Math.min(W, H) * 0.38, lensR2 = lensR * lensR;
      const aspect = 2.5;

      function warp(x, y) {
        const dx = x - cx, dy = y - cy;
        const ex = dx / aspect, ey = dy, ed2 = ex * ex + ey * ey;
        if (ed2 < 1) return [x, y];
        const ed = Math.sqrt(ed2);
        const strength = lensR2 / (ed2 + lensR2 * 0.15);
        return [x + (ex/ed) * strength * 1.2, y + (ey/ed) * strength * 0.7];
      }

      const STEPS = 150;
      const cellSize = Math.max(W, H) / 5;
      const hCount = Math.ceil(H / cellSize) + 2;
      const vCount = Math.ceil(W / cellSize) + 2;
      const hStart = cy - Math.floor(hCount / 2) * cellSize;
      const vStart = cx - Math.floor(vCount / 2) * cellSize;

      for (let i = 0; i < hCount; i++) {
        const y0 = hStart + i * cellSize;
        pctx.beginPath();
        for (let s = 0; s <= STEPS; s++) {
          const [wx, wy] = warp(-W * 0.1 + W * 1.2 * (s / STEPS), y0);
          s === 0 ? pctx.moveTo(wx, wy) : pctx.lineTo(wx, wy);
        }
        pctx.stroke();
      }
      for (let i = 0; i < vCount; i++) {
        const x0 = vStart + i * cellSize;
        pctx.beginPath();
        for (let s = 0; s <= STEPS; s++) {
          const [wx, wy] = warp(x0, -H * 0.1 + H * 1.2 * (s / STEPS));
          s === 0 ? pctx.moveTo(wx, wy) : pctx.lineTo(wx, wy);
        }
        pctx.stroke();
      }
    }

    function hexToRgba(hex, a) {
      const h = hex.replace('#', '');
      const v = h.length === 3
        ? h.split('').map(c => c + c).join('')
        : h;
      const r = parseInt(v.slice(0, 2), 16);
      const g = parseInt(v.slice(2, 4), 16);
      const b = parseInt(v.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function initNoise() {
      const { w, h } = getSize(), NS = 2;
      const nW = Math.ceil(w / NS), nH = Math.ceil(h / NS);
      noiseCanvas.width = nW; noiseCanvas.height = nH;
      noiseCanvas.style.width = '100%';
      noiseCanvas.style.height = '100%';
      const img = nctx.createImageData(nW, nH);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = img.data[i+1] = img.data[i+2] = 255;
        img.data[i+3] = Math.random() * 20 | 0;
      }
      nctx.putImageData(img, 0, 0);
    }

    resize(); initNoise(); initBgNoise();
    document.fonts.ready.then(() => buildText());
    drawPattern(patternCanvas.width, patternCanvas.height);
    setInterval(drawBgNoise, 120);

    const ro = new ResizeObserver(() => {
      resize();
      drawPattern(patternCanvas.width, patternCanvas.height);
      initBgNoise();
      document.fonts.ready.then(() => buildText());
    });
    ro.observe(container);

    opts.mount.addEventListener('mousemove', e => {
      const r = container.getBoundingClientRect();
      pmx = mx; pmy = my;
      mx = e.clientX - r.left; my = e.clientY - r.top;
      dirty = true;
    });
    opts.mount.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0], r = container.getBoundingClientRect();
      pmx = mx; pmy = my;
      mx = t.clientX - r.left; my = t.clientY - r.top;
      dirty = true;
    }, { passive: false });
    opts.mount.addEventListener('touchstart', e => {
      const t = e.touches[0], r = container.getBoundingClientRect();
      mx = pmx = t.clientX - r.left;
      my = pmy = t.clientY - r.top;
      dirty = true;
    }, { passive: true });

    function loop() {
      const { rippleR } = vars, rr2 = rippleR * rippleR;
      const W = mainCanvas.width, H = mainCanvas.height;
      const dvx = mx - pmx, dvy = my - pmy;
      const spring = _ctrl.recall, spread = _ctrl.spread;
      const dragAmt = spread * 0.5, damping = 0.76 + spread * 0.20;
      const pushStr = 22 * (1 - spread * 0.6);
      let moving = false;

      for (let i = 0, o = 0; i < count; i++, o += S) {
        let x = buf[o+2], y = buf[o+3], vx = buf[o+4], vy = buf[o+5];
        const dx = x - mx, dy = y - my, d2 = dx*dx + dy*dy;
        if (d2 < rr2 && d2 > 0.01) {
          const d = Math.sqrt(d2), falloff = 1 - d / rippleR, f2 = falloff * falloff;
          vx += dx * (f2 * pushStr / d) * 0.12; vy += dy * (f2 * pushStr / d) * 0.12;
          vx += dvx * f2 * dragAmt; vy += dvy * f2 * dragAmt;
        }
        if (spring > 0) { vx += (buf[o] - x) * spring; vy += (buf[o+1] - y) * spring; }
        vx *= damping; vy *= damping; x += vx; y += vy;
        buf[o+2] = x; buf[o+3] = y; buf[o+4] = vx; buf[o+5] = vy;
        if (vx*vx + vy*vy > 0.0005) moving = true;
      }

      if (moving || dirty) {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#000'; ctx.beginPath();
        for (let i = 0, o = 0; i < count; i++, o += S) {
          const x = buf[o+2], y = buf[o+3], r = buf[o+6];
          ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832);
        }
        ctx.fill();
        dirty = moving;
      }
      requestAnimationFrame(loop);
    }
    loop();
  };
})();
