/* ============================================================================
 * M27CurveEditor — 可复用时间轴曲线编辑器 (0..100% 调制曲线)
 * 支持：波形底图、带声/静音门控保护区可视化、防爆音平滑预览、
 *       点击新增节点、拖拽节点、选中节点高亮、精确数值打点与微调、
 *       键盘方向键微调 (↑↓←→ / Shift 加速 / Delete 删点)、双击删点。
 * ============================================================================ */

const M27CurveEditor = (() => {
  "use strict";
  const MAX_KNOTS = 50;
  const MIN_GAP = 0.001;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function evalKnots(knots, t, interpMode) {
    if (!knots || knots.length === 0) return 0;
    const sorted = knots;
    if (t <= sorted[0].t) return sorted[0].v;
    if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].v;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = Math.max(1e-6, b.t - a.t);
        let u = (t - a.t) / span;
        if (interpMode !== "linear") {
          u = 0.5 - 0.5 * Math.cos(Math.PI * u);
        }
        return a.v + (b.v - a.v) * u;
      }
    }
    return sorted[sorted.length - 1].v;
  }

  function gaussianSmooth1D(arr, sigmaFrames) {
    if (!arr || arr.length <= 2 || sigmaFrames <= 0.05) return arr.slice();
    const radius = Math.min(arr.length - 1, Math.max(1, Math.ceil(3 * sigmaFrames)));
    const kernel = [];
    let ksum = 0;
    for (let k = -radius; k <= radius; k++) {
      const val = Math.exp(-0.5 * (k / sigmaFrames) * (k / sigmaFrames));
      kernel.push(val);
      ksum += val;
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

    const n = arr.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const idx = clamp(i + k, 0, n - 1);
        acc += arr[idx] * kernel[k + radius];
      }
      out[i] = clamp(acc, 0, 1);
    }
    return out;
  }

  class M27CurveEditor {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.canvas.tabIndex = 0; // 允许聚焦以支持方向键微调
      this.ctx = canvas.getContext("2d");
      this.onChange = options.onChange || (() => {});
      this.onSelect = options.onSelect || (() => {});
      this.pad = { left: 42, right: 16, top: 18, bottom: 26 };

      this.knots = [
        { t: 0.0, v: 0.0 },
        { t: 1.0, v: 0.85 },
      ];
      this.interpMode = "smoothstep";
      this.smoothMs = 25;
      this.enableGate = true;
      this.durSec = 3.0;
      this.waveformPeaks = [];
      this.gateSeries = [];
      this.appliedSeries = [];
      this.frameCount = undefined;
      this.bgMode = "waveform";
      this.spectrogramCanvas = null;
      this.alignIntervals = [];
      this.playheadNorm = null;
      this.snappedBoundarySec = null;
      this.dragIndex = -1;
      this.hoverIndex = -1;
      this.selectedIndex = 0;

      this._bindEvents();
      this._resizeObserver = new ResizeObserver(() => this.render());
      this._resizeObserver.observe(this.canvas);
      this.render();
    }

    destroy() {
      this._resizeObserver.disconnect();
      this._events.abort();
    }

    _emitSelect() {
      const idx = clamp(this.selectedIndex, 0, Math.max(0, this.knots.length - 1));
      this.selectedIndex = idx;
      this.onSelect(idx, this.knots[idx] ? { ...this.knots[idx] } : null, this.getKnots());
    }

    setKnots(knots, silent = false) {
      if (!Array.isArray(knots) || knots.length === 0) {
        this.knots = [
          { t: 0.0, v: 0.0 },
          { t: 1.0, v: 0.0 },
        ];
      } else {
        this.knots = knots
          .map((k) => ({ t: clamp(Number(k.t) || 0, 0, 1), v: clamp(Number(k.v) || 0, 0, 1) }))
          .sort((a, b) => a.t - b.t);
      }
      this.selectedIndex = clamp(this.selectedIndex, 0, this.knots.length - 1);
      this.render();
      this._emitSelect();
      if (!silent) this.onChange(this.getKnots());
    }

    getKnots() {
      return this.knots.map(k => ({ ...k }));
    }

    selectKnot(index) {
      if (index < 0 || index >= this.knots.length) return;
      this.selectedIndex = index;
      this.render();
      this._emitSelect();
    }

    /** 精确更新当前选中节点的 (t_norm, v_norm) */
    updateSelectedKnot(tNorm, vNorm) {
      if (!Number.isFinite(tNorm) || !Number.isFinite(vNorm)) return;
      const i = this.selectedIndex;
      if (i < 0 || i >= this.knots.length) return;
      const isFirstPinned = i === 0 && this.knots.length >= 2 && this.knots[0].t === 0;
      const isLastPinned = i === this.knots.length - 1 && this.knots.length >= 2 && this.knots[i].t === 1;
      let newT = clamp(Number(tNorm), 0, 1);
      if (isFirstPinned) newT = 0;
      else if (isLastPinned) newT = 1;
      else {
        const lo = i > 0 ? this.knots[i - 1].t + MIN_GAP : 0;
        const hi = i < this.knots.length - 1 ? this.knots[i + 1].t - MIN_GAP : 1;
        newT = lo <= hi ? clamp(newT, lo, hi) : this.knots[i].t;
      }
      const newV = clamp(Number(vNorm), 0, 1);
      this.knots[i] = { t: newT, v: newV };
      this.render();
      this._emitSelect();
      this.onChange(this.getKnots());
    }

    /** 手动精确打点（插入新节点并自动选中） */
    addKnotAt(tNorm, vNorm) {
      if (!Number.isFinite(tNorm) || !Number.isFinite(vNorm)) return false;
      const t = clamp(tNorm, 0, 1);
      const v = clamp(vNorm, 0, 1);
      // 若已有极接近的点，直接更新并选中
      const near = this.knots.findIndex((k) => Math.abs(k.t - t) < MIN_GAP);
      if (near >= 0) {
        this.knots[near].v = v;
        this.selectedIndex = near;
      } else {
        if (this.knots.length >= MAX_KNOTS) return false;
        this.knots.push({ t, v });
        this.knots.sort((a, b) => a.t - b.t);
        this.selectedIndex = this.knots.findIndex((k) => k.t === t && k.v === v);
      }
      this.render();
      this._emitSelect();
      this.onChange(this.getKnots());
      return true;
    }

    /** 删除当前选中节点（至少保留 2 个端点） */
    deleteSelectedKnot() {
      if (this.knots.length <= 2 || this.selectedIndex <= 0 || this.selectedIndex >= this.knots.length - 1) return false;
      this.knots.splice(this.selectedIndex, 1);
      this.selectedIndex = clamp(this.selectedIndex - 1, 0, this.knots.length - 1);
      this.render();
      this._emitSelect();
      this.onChange(this.getKnots());
      return true;
    }

    setVisualContext({ durSec, waveformPeaks, gateSeries, appliedSeries, frameCount, smoothMs, enableGate, interpMode, playheadNorm, bgMode, spectrogramCanvas, alignIntervals }) {
      if (typeof durSec === "number" && durSec > 0) this.durSec = durSec;
      if (Array.isArray(waveformPeaks)) this.waveformPeaks = waveformPeaks;
      if (Array.isArray(gateSeries)) this.gateSeries = gateSeries;
      if (Array.isArray(appliedSeries)) this.appliedSeries = appliedSeries;
      this.frameCount = frameCount;
      if (typeof smoothMs === "number") this.smoothMs = smoothMs;
      if (typeof enableGate === "boolean") this.enableGate = enableGate;
      if (typeof interpMode === "string") this.interpMode = interpMode;
      if (playheadNorm !== undefined) this.playheadNorm = playheadNorm;
      if (bgMode === "waveform" || bgMode === "spectrogram") this.bgMode = bgMode;
      if (spectrogramCanvas !== undefined) this.spectrogramCanvas = spectrogramCanvas;
      if (Array.isArray(alignIntervals)) this.alignIntervals = alignIntervals;
      this.render();
    }

    setPlayhead(norm) {
      const next = typeof norm === "number" && Number.isFinite(norm) ? clamp(norm, 0, 1) : null;
      if (this.playheadNorm === next) return;
      this.playheadNorm = next;
      this.render();
    }

    applyPresetShape(shapeId) {
      const presets = {
        zero: [
          { t: 0.0, v: 0.0 },
          { t: 1.0, v: 0.0 },
        ],
        const80: [
          { t: 0.0, v: 0.8 },
          { t: 1.0, v: 0.8 },
        ],
        ramp_up: [
          { t: 0.0, v: 0.0 },
          { t: 1.0, v: 0.9 },
        ],
        ramp_down: [
          { t: 0.0, v: 0.9 },
          { t: 1.0, v: 0.0 },
        ],
        arch: [
          { t: 0.0, v: 0.0 },
          { t: 0.35, v: 0.9 },
          { t: 0.65, v: 0.9 },
          { t: 1.0, v: 0.0 },
        ],
        tail: [
          { t: 0.0, v: 0.0 },
          { t: 0.58, v: 0.05 },
          { t: 0.85, v: 0.95 },
          { t: 1.0, v: 0.95 },
        ],
      };
      if (presets[shapeId]) {
        this.selectedIndex = 0;
        this.setKnots(presets[shapeId]);
      }
    }

    _plotRect() {
      const w = this.canvas.clientWidth || 640;
      const h = this.canvas.clientHeight || 230;
      return {
        w,
        h,
        x0: this.pad.left,
        y0: this.pad.top,
        pw: Math.max(40, w - this.pad.left - this.pad.right),
        ph: Math.max(40, h - this.pad.top - this.pad.bottom),
      };
    }

    _toXY(t, v, rect) {
      return {
        x: rect.x0 + clamp(t, 0, 1) * rect.pw,
        y: rect.y0 + (1 - clamp(v, 0, 1)) * rect.ph,
      };
    }

    _fromEvent(ev) {
      const box = this.canvas.getBoundingClientRect();
      const px = ev.clientX - box.left;
      const py = ev.clientY - box.top;
      const rect = this._plotRect();
      const t = clamp((px - rect.x0) / rect.pw, 0, 1);
      const v = clamp(1 - (py - rect.y0) / rect.ph, 0, 1);
      return { px, py, t, v, rect };
    }

    _findKnot(px, py, rect, radius = 13) {
      let best = -1;
      let bestDist = radius;
      for (let i = 0; i < this.knots.length; i++) {
        const pt = this._toXY(this.knots[i].t, this.knots[i].v, rect);
        const d = Math.hypot(pt.x - px, pt.y - py);
        if (d <= bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    }

    _bindEvents() {
      this._events = new AbortController();
      const on = (type, listener) => this.canvas.addEventListener(type, listener, { signal: this._events.signal });
      on("pointerdown", (ev) => {
        if (ev.button !== 0 || !ev.isPrimary) return;
        this.canvas.focus();
        const { px, py, t, v, rect } = this._fromEvent(ev);
        const hit = this._findKnot(px, py, rect);
        if (hit >= 0) {
          this.dragIndex = hit;
          this.selectedIndex = hit;
          this._emitSelect();
        } else if (this.addKnotAt(t, v)) this.dragIndex = this.selectedIndex;
        this.canvas.setPointerCapture(ev.pointerId);
        this.render();
      });

      on("pointermove", (ev) => {
        if (!ev.isPrimary) return;
        const { px, py, t, v, rect } = this._fromEvent(ev);
        if (this.dragIndex >= 0) {
          let snappedT = t;
          this.snappedBoundarySec = null;
          if (!ev.altKey && this.alignIntervals && this.alignIntervals.length > 0 && this.durSec > 0 && this.dragIndex > 0 && this.dragIndex < this.knots.length - 1) {
            const snapTolNorm = 7 / Math.max(40, rect.pw);
            let bestDist = snapTolNorm;
            for (const iv of this.alignIntervals) {
              for (const edge of [iv.xmin, iv.xmax]) {
                const edgeNorm = clamp(edge / this.durSec, 0, 1);
                const d = Math.abs(edgeNorm - t);
                if (d < bestDist) {
                  bestDist = d;
                  snappedT = edgeNorm;
                  this.snappedBoundarySec = edge;
                }
              }
            }
          }
          this.updateSelectedKnot(snappedT, v);
        } else {
          const hit = this._findKnot(px, py, rect);
          if (hit !== this.hoverIndex) {
            this.hoverIndex = hit;
            this.canvas.style.cursor = hit >= 0 ? "grab" : "crosshair";
            this.render();
          }
        }
      });

      const endDrag = () => {
        if (this.dragIndex >= 0) {
          this.dragIndex = -1;
          this.snappedBoundarySec = null;
          this.render();
        }
      };
      on("lostpointercapture", endDrag);

      on("dblclick", (ev) => {
        const { px, py, rect } = this._fromEvent(ev);
        const hit = this._findKnot(px, py, rect);
        if (hit < 0) return;
        this.selectKnot(hit);
        this.deleteSelectedKnot();
      });

      // 键盘方向键微调：↑/↓ 调节权重，←/→ 调节时间，Shift 加速 5 倍，Delete 删点
      on("keydown", (ev) => {
        if (this.selectedIndex < 0 || this.selectedIndex >= this.knots.length) return;
        const k = this.knots[this.selectedIndex];
        const stepV = ev.shiftKey ? 0.05 : 0.01;
        const stepT = ev.shiftKey ? 0.05 : 0.005;
        if (ev.key === "ArrowUp") {
          ev.preventDefault();
          this.updateSelectedKnot(k.t, k.v + stepV);
        } else if (ev.key === "ArrowDown") {
          ev.preventDefault();
          this.updateSelectedKnot(k.t, k.v - stepV);
        } else if (ev.key === "ArrowRight") {
          ev.preventDefault();
          this.updateSelectedKnot(k.t + stepT, k.v);
        } else if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          this.updateSelectedKnot(k.t - stepT, k.v);
        } else if (ev.key === "Delete" || ev.key === "Backspace") {
          ev.preventDefault();
          this.deleteSelectedKnot();
        }
      });
    }

    _cssVar(name, fallback) {
      const style = getComputedStyle(this.canvas);
      const val = style.getPropertyValue(name).trim();
      return val || fallback;
    }

    render() {
      const rect = this._plotRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.round(rect.w * dpr);
      const ch = Math.round(rect.h * dpr);
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }

      const ctx = this.ctx;
      ctx.save();
      ctx.scale(dpr, dpr);

      const bg = this._cssVar("--vm-canvas-bg", "#0a0f17");
      const gridColor = this._cssVar("--vm-grid-line", "rgba(148,163,184,0.14)");
      const muted = this._cssVar("--vm-muted", "#7f91b0");
      const waveColor = this._cssVar("--vm-wave-color", "rgba(148,163,184,0.28)");
      const gateBlock = this._cssVar("--vm-gate-block", "rgba(248,113,113,0.16)");
      const curveRawColor = this._cssVar("--vm-curve-raw", "rgba(167,139,250,0.65)");
      const curveEffColor = this._cssVar("--vm-curve-eff", "#5b9dff");
      const curveFill = this._cssVar("--vm-curve-fill", "rgba(91,157,255,0.16)");
      const knotFill = this._cssVar("--vm-knot-fill", "#eaf0fb");
      const knotStroke = this._cssVar("--vm-knot-stroke", "#5b9dff");
      const knotActive = this._cssVar("--vm-knot-active", "#fbbf24");
      const tooltipBg = this._cssVar("--vm-tooltip-bg", "rgba(15, 23, 42, 0.92)");
      const tooltipFg = this._cssVar("--vm-tooltip-fg", "#ffffff");
      const tooltipBorder = this._cssVar("--vm-tooltip-border", "rgba(255, 255, 255, 0.14)");
      const playheadColor = this._cssVar("--vm-playhead", knotActive);

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, rect.w, rect.h);

      // 0. Optional spectrogram background inside the plot rect (keeps curves legible)
      if (this.bgMode === "spectrogram" && this.spectrogramCanvas && this.spectrogramCanvas.width > 0 && this.spectrogramCanvas.height > 0) {
        ctx.save();
        ctx.globalAlpha = 0.88;
        ctx.drawImage(this.spectrogramCanvas, rect.x0, rect.y0, rect.pw, rect.ph);
        ctx.fillStyle = this._cssVar("--vm-spec-scrim", "rgba(10, 15, 23, 0.22)");
        ctx.fillRect(rect.x0, rect.y0, rect.pw, rect.ph);
        ctx.restore();
      }

      // 1. Grid lines + Y-axis labels (0% .. 100%)
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const v = i / 4;
        const y = rect.y0 + (1 - v) * rect.ph;
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rect.x0, y);
        ctx.lineTo(rect.x0 + rect.pw, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.fillText(`${Math.round(v * 100)}%`, rect.x0 - 6, y);
      }

      // X-axis time ticks
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const nTicks = 5;
      for (let i = 0; i <= nTicks; i++) {
        const u = i / nTicks;
        const x = rect.x0 + u * rect.pw;
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(x, rect.y0);
        ctx.lineTo(x, rect.y0 + rect.ph);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.fillText(`${(u * this.durSec).toFixed(2)}s`, x, rect.y0 + rect.ph + 6);
      }

      // 2. Voicing/Silence gate shading
      if (this.enableGate && this.gateSeries && this.gateSeries.length > 1) {
        const gn = this.gateSeries.length;
        ctx.fillStyle = gateBlock;
        for (let i = 0; i < gn; i++) {
          const g = this.gateSeries[i];
          if (g < 0.5) {
            const x1 = rect.x0 + (i / gn) * rect.pw;
            const bw = Math.max(1.2, rect.pw / gn + 0.5);
            ctx.fillRect(x1, rect.y0, bw, rect.ph * (1 - g));
          }
        }
      }

      // 3. Background waveform envelope (shown in waveform mode, or fallback when spectrogram not ready)
      const showWaveform = this.bgMode !== "spectrogram" || !this.spectrogramCanvas || this.spectrogramCanvas.width === 0;
      if (showWaveform && this.waveformPeaks && this.waveformPeaks.length > 1) {
        const wn = this.waveformPeaks.length;
        const cy = rect.y0 + rect.ph * 0.5;
        const halfH = rect.ph * 0.42;
        ctx.fillStyle = waveColor;
        const barW = Math.max(1.2, rect.pw / wn);
        for (let i = 0; i < wn; i++) {
          const amp = clamp(this.waveformPeaks[i], 0, 1) * halfH;
          const x = rect.x0 + (i / wn) * rect.pw;
          ctx.fillRect(x, cy - amp, barW * 0.85, Math.max(1, amp * 2));
        }
      }

      // 3b. Optional aligned phoneme/syllable intervals along the top of the plot
      if (this.alignIntervals && this.alignIntervals.length > 0 && this.durSec > 0) {
        ctx.save();
        const stripH = 20;
        ctx.fillStyle = this._cssVar("--vm-align-strip-bg", "rgba(15, 23, 42, 0.62)");
        ctx.fillRect(rect.x0, rect.y0, rect.pw, stripH);
        ctx.strokeStyle = this._cssVar("--vm-align-bound", "rgba(148, 163, 184, 0.35)");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rect.x0, rect.y0 + stripH);
        ctx.lineTo(rect.x0 + rect.pw, rect.y0 + stripH);
        ctx.stroke();

        ctx.font = "600 10.5px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const boundColor = this._cssVar("--vm-align-bound", "rgba(148, 163, 184, 0.34)");
        const labelColor = this._cssVar("--vm-align-text", "#e2e8f0");
        const snapColor = this._cssVar("--vm-knot-active", "#fbbf24");
        for (const iv of this.alignIntervals) {
          const x0 = rect.x0 + clamp(iv.xmin / this.durSec, 0, 1) * rect.pw;
          const x1 = rect.x0 + clamp(iv.xmax / this.durSec, 0, 1) * rect.pw;
          const segW = x1 - x0;
          const snappedHere = this.snappedBoundarySec !== null && Math.abs(iv.xmin - this.snappedBoundarySec) < 0.002;
          if (x0 > rect.x0 + 1) {
            ctx.save();
            ctx.strokeStyle = snappedHere ? snapColor : boundColor;
            ctx.lineWidth = snappedHere ? 1.8 : 1;
            if (!snappedHere) ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x0, rect.y0);
            ctx.lineTo(x0, rect.y0 + rect.ph);
            ctx.stroke();
            ctx.restore();
          }
          const txt = String(iv.text || "").trim();
          if (txt && txt !== "sil" && txt !== "sp" && segW >= 14) {
            ctx.fillStyle = labelColor;
            const maxChars = Math.max(1, Math.floor((segW - 4) / 9));
            const shown = txt.length > maxChars ? txt.slice(0, maxChars) : txt;
            ctx.fillText(shown, (x0 + x1) * 0.5, rect.y0 + stripH * 0.5);
          }
        }
        ctx.restore();
      }

      // 4. Sample raw, anti-click smoothed, and gated effective curves
      const nSamp = Math.max(2, this.frameCount ?? Math.round(this.durSec * 50));
      const rawArr = new Array(nSamp);
      for (let i = 0; i < nSamp; i++) {
        const t = i / Math.max(1, nSamp - 1);
        rawArr[i] = evalKnots(this.knots, t, this.interpMode);
      }
      const sigmaFrames = this.smoothMs > 0.5 ? Math.max(0.35, this.smoothMs / 1000 * 50 * 0.5) : 0;
      const smoothArr = gaussianSmooth1D(rawArr, sigmaFrames);

      const effArr = new Array(nSamp);
      for (let i = 0; i < nSamp; i++) {
        let g = 1.0;
        if (this.enableGate && this.gateSeries && this.gateSeries.length > 1) {
          const gi = Math.round((i / Math.max(1, nSamp - 1)) * (this.gateSeries.length - 1));
          g = clamp(this.gateSeries[gi], 0, 1);
        }
        effArr[i] = this.appliedSeries.length === nSamp ? this.appliedSeries[i] : smoothArr[i] * g;
      }

      ctx.beginPath();
      ctx.moveTo(rect.x0, rect.y0 + rect.ph);
      for (let i = 0; i < nSamp; i++) {
        const pt = this._toXY(i / Math.max(1, nSamp - 1), effArr[i], rect);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.lineTo(rect.x0 + rect.pw, rect.y0 + rect.ph);
      ctx.closePath();
      ctx.fillStyle = curveFill;
      ctx.fill();

      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = curveRawColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < nSamp; i++) {
        const pt = this._toXY(i / Math.max(1, nSamp - 1), smoothArr[i], rect);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = curveEffColor;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let i = 0; i < nSamp; i++) {
        const pt = this._toXY(i / Math.max(1, nSamp - 1), effArr[i], rect);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();

      // 5. Draggable & selectable knots
      for (let i = 0; i < this.knots.length; i++) {
        const k = this.knots[i];
        const pt = this._toXY(k.t, k.v, rect);
        const isSelected = i === this.selectedIndex;
        const isActive = i === this.dragIndex || i === this.hoverIndex || isSelected;

        // 选中光环 + 垂直辅助准星线
        if (isSelected) {
          ctx.save();
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = knotActive;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pt.x, rect.y0);
          ctx.lineTo(pt.x, rect.y0 + rect.ph);
          ctx.stroke();
          ctx.restore();

          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 10.5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(251, 191, 36, 0.22)";
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isActive ? 6.8 : 5.2, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? knotActive : isActive ? knotActive : knotFill;
        ctx.fill();
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = isSelected ? "#ffffff" : knotStroke;
        ctx.stroke();

        if (isSelected || i === this.dragIndex || i === this.hoverIndex) {
          const tSec = k.t * this.durSec;
          let segTag = "";
          if (this.alignIntervals && this.alignIntervals.length > 0) {
            const matched = this.alignIntervals.find((iv) => tSec >= iv.xmin - 1e-4 && tSec <= iv.xmax + 1e-4 && String(iv.text || "").trim());
            if (matched) {
              const clean = String(matched.text).trim();
              if (clean && clean !== "sil" && clean !== "sp") segTag = ` [${clean}]`;
            }
          }
          const label = `#${i + 1} ${tSec.toFixed(2)}s${segTag} · ${Math.round(k.v * 100)}%`;
          ctx.font = "600 11px ui-monospace, monospace";
          const tw = ctx.measureText(label).width + 14;
          const bx = clamp(pt.x - tw / 2, rect.x0, rect.x0 + rect.pw - tw);
          const minTop = this.alignIntervals && this.alignIntervals.length > 0 ? rect.y0 + 24 : rect.y0 + 2;
          const by = pt.y > minTop + 28 ? pt.y - 29 : Math.max(minTop, pt.y + 13);
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") ctx.roundRect(bx, by, tw, 20, 5);
          else ctx.rect(bx, by, tw, 20);
          ctx.fillStyle = tooltipBg;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = tooltipBorder;
          ctx.stroke();
          ctx.fillStyle = tooltipFg;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, bx + tw / 2, by + 10);
        }
      }

      // 6. Synchronized live audio playhead cursor
      if (this.playheadNorm !== null && this.playheadNorm >= 0 && this.playheadNorm <= 1) {
        const px = rect.x0 + this.playheadNorm * rect.pw;
        ctx.save();
        ctx.strokeStyle = playheadColor;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(px, rect.y0);
        ctx.lineTo(px, rect.y0 + rect.ph);
        ctx.stroke();
        ctx.fillStyle = playheadColor;
        ctx.beginPath();
        ctx.moveTo(px - 4.5, rect.y0);
        ctx.lineTo(px + 4.5, rect.y0);
        ctx.lineTo(px, rect.y0 + 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.restore();
    }
  }

  return M27CurveEditor;
})();
export { M27CurveEditor };
