// Waterfall + key bed renderer (HTML5 Canvas 2D), theme-aware.
//
// GC discipline (verified by heap measurement in headless Chrome):
//  * Everything the frame loop needs (colour strings, gradients, stripe
//    patterns, labels, label widths, key geometry, key-bed bitmaps) is built
//    in resize()/setTheme(). draw() only reads typed arrays and cached values.
//  * The frame is drawn in DEVICE pixels with an identity transform, and every
//    coordinate is an integer when it reaches the canvas API. Blink boxes
//    fractional doubles into V8 HeapNumbers (~12-14 bytes per call); small
//    integers (Smis) are allocation-free.
//  * globalAlpha values come from a pre-boxed lookup table (ALPHA).

import { IS_BLACK, NOTE_NAMES, lowerBound } from '../core/constants.js';
import { KeyboardGeometry, WHITE_COUNT } from './keyboard-geometry.js';
import { KEY_WRONG, NOTE_PENDING, NOTE_HIT } from '../core/practice.js';
import { THEMES, WRONG_RED } from './themes.js';
import { Particles } from './particles.js';

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const LABEL_FULL = 0; // "F#5"
export const LABEL_LETTER = 1; // "F#"
export const LABEL_OFF = 2;

// Two-line labels for narrow (black-key) notes: "F#" over "5".
const LABEL_TOP = NOTE_NAMES.map((n) => n.replace(/-?\d+$/, ''));
const LABEL_BOTTOM = NOTE_NAMES.map((n) => n.match(/-?\d+$/)[0]);

// Pre-boxed alpha steps (0..1 in 1/32). The trailing string forces generic
// (non-double) element storage so reads return the existing HeapNumber.
const ALPHA_STEPS = 32;
const ALPHA = (() => {
  const a = [];
  for (let i = 0; i <= ALPHA_STEPS; i++) a.push(i / ALPHA_STEPS);
  a.push('pad');
  return a;
})();
function alphaIndex(v) {
  if (v <= 0) return 0;
  if (v >= 1) return ALPHA_STEPS;
  return (v * ALPHA_STEPS + 0.5) | 0;
}

/** Parses '#rgb', '#rrggbb' or 'rgba(...)' into [r,g,b,a]. */
function parseColor(c) {
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 1];
  }
  const m = c.match(/[\d.]+/g) || [0, 0, 0, 1];
  return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]];
}
function withAlpha(c, a) {
  const [r, g, b, a0] = parseColor(c);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + +(a * a0).toFixed(3) + ')';
}

/** Rounded-rect path with integer arguments (allocation-free). */
function roundRectPath(ctx, x, y, w, h, r) {
  if (r * 2 > w) r = w >> 1;
  if (r * 2 > h) r = h >> 1;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Float version, used only when building cached layers. */
function roundRectPathF(ctx, x, y, w, h, r) {
  if (r > w * 0.5) r = w * 0.5;
  if (r > h * 0.5) r = h * 0.5;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLayer(wd, hd, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, wd);
  c.height = Math.max(1, hd);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // layers are authored in CSS px
  return { canvas: c, ctx };
}

export class WaterfallRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.geo = new KeyboardGeometry(); // CSS px (hit testing)
    this.song = null;
    this.takeSong = null; // recorded performance being replayed
    this.practice = null;
    this.theme = THEMES[0];
    this.labelMode = LABEL_FULL;
    this.particles = new Particles();
    this.effects = true;
    this.memorizeFrac = 1; // fraction of the waterfall where notes are visible
    this.showHints = true;
    this.loopA = NaN;
    this.loopB = NaN;
    this.markSongKeys = true; // false while replaying a recording
    this.activeKey = new Uint8Array(128); // hand+1 of a tablet-played note sounding now
    this.prevT = NaN;

    // Integer device-pixel geometry used by draw()
    this.kx = new Int32Array(128);
    this.kw = new Int32Array(128);
    this.Wd = 1;
    this.Hd = 1;
    this.strikeYd = 0;
    this.bedHd = 0;
    this.blackHd = 0;
    this.colHd = 0;
    this.ppsd = 100; // device px per song second
    this.fontPx = 16;
    this.labelW = new Int32Array(128);
    this.labelTopW = new Int32Array(128);
    this.stripeP = 16;
    this.radius = 6;
    this.badge = null;
    this.badgePad = 3;
    this.badgeR = 4;
    this.outlineW = 1;

    this.visibleSeconds = 3;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.strikeY = 0; // CSS px (input handling)
    this.bedH = 0;
    this.pps = 100; // CSS px per song second (drag scrubbing)
    this.time = 0;
    this.font = '700 16px ' + FONT_STACK;
    this.fontSmall = '700 11px ' + FONT_STACK;

    this.bg = null;
    this.whiteLayer = null;
    this.blackLayer = null;
    this.noteFill = new Array(24).fill('#fff'); // [hand*8 + black*4 + state]
    this.stripes = [null, null, null, null, null, null]; // [hand*2 + black]
    this.litWhite = [null, null, null, null, null];
    this.litBlack = [null, null, null, null, null];
    this.column = [null, null, null, null, null];
    this.handTintWhite = [null, null, null];
    this.handTintBlack = [null, null, null];
    this.strikeGlow = null;
    this.strikeGlowH = 26;
    this.fadeBand = null;
    this.fadeBandH = 0;
    this.frames = 0;
  }

  setSong(song) {
    this.song = song;
    this.prevT = NaN;
  }

  setTakeSong(song) {
    this.takeSong = song;
    this.prevT = NaN;
  }

  setPractice(practice) {
    this.practice = practice;
  }

  setVisibleSeconds(s) {
    this.visibleSeconds = s;
    this.pps = this.strikeY / s;
    this.ppsd = this.strikeYd / s;
  }

  setTheme(theme) {
    this.theme = theme;
    if (this.cssW > 1) this.resize(this.cssW, this.cssH, this.dpr);
  }

  setLabelMode(mode) {
    this.labelMode = mode;
  }

  /** level 0 = all notes visible … 3 = notes hidden (and key hints off). */
  setMemorize(level) {
    const fr = [1, 0.55, 0.25, 0];
    this.memorizeFrac = fr[Math.max(0, Math.min(3, level | 0))];
    this.showHints = level < 3;
    this._buildFadeBand();
  }

  setLoop(a, b) {
    this.loopA = a;
    this.loopB = b;
  }

  resize(cssW, cssH, dpr) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const Wd = Math.max(1, Math.round(cssW * dpr));
    const Hd = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = Wd;
    this.canvas.height = Hd;
    this.Wd = Wd;
    this.Hd = Hd;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); // main canvas always draws in device px

    const ww = cssW / WHITE_COUNT;
    // Real white keys are ~6.4x longer than wide; cap so the waterfall keeps room.
    this.bedH = Math.round(Math.max(70, Math.min(ww * 6.2, cssH * 0.27)));
    this.strikeY = cssH - this.bedH;
    this.geo.layout(cssW, this.strikeY, this.bedH);
    this.pps = this.strikeY / this.visibleSeconds;

    this.bedHd = Math.round(this.bedH * dpr);
    this.strikeYd = Hd - this.bedHd;
    this.blackHd = Math.round(this.geo.blackH * dpr);
    this.colHd = Math.round(Math.min(140 * dpr, this.strikeYd * 0.35));
    this.ppsd = this.strikeYd / this.visibleSeconds;
    for (let p = 0; p < 128; p++) {
      const x0 = Math.round(this.geo.x[p] * dpr);
      const x1 = Math.round((this.geo.x[p] + this.geo.w[p]) * dpr);
      this.kx[p] = x0;
      this.kw[p] = Math.max(1, x1 - x0);
    }

    const cssFont = Math.max(8, Math.min(13, Math.floor(ww * 0.44)));
    this.fontPx = Math.max(8, Math.round(cssFont * dpr));
    this.font = '700 ' + this.fontPx + 'px ' + FONT_STACK;
    this.fontSmall = '600 ' + Math.max(7, Math.round(Math.min(10, ww * 0.34) * dpr)) + 'px ' + FONT_STACK;
    ctx.font = this.font;
    for (let p = 0; p < 128; p++) {
      this.labelW[p] = Math.ceil(ctx.measureText(NOTE_NAMES[p]).width);
      this.labelTopW[p] = Math.ceil(ctx.measureText(LABEL_TOP[p]).width);
    }
    this.radius = Math.max(1, Math.round(this.theme.radius * dpr));
    this.badge = this.theme.labelBadge || null;
    this.badgePad = Math.max(2, Math.round(3 * dpr));
    this.badgeR = Math.max(2, Math.round(4 * dpr));
    this.outlineW = Math.max(1, Math.round(1.5 * dpr));
    this.stripeP = Math.max(8, Math.round(15 * dpr));
    this.particles.configure(this.theme.particles.style, this.theme.particles.colors, dpr);
    this._buildColors();
    this._buildGradients();
    this._buildLayers();
    this._buildFadeBand();
  }

  _buildColors() {
    const t = this.theme;
    for (let h = 0; h < 3; h++) {
      const n = t.notes[h];
      for (let b = 0; b < 2; b++) {
        const base = h * 8 + b * 4;
        this.noteFill[base] = b ? n.fillBlack : n.fill;
        this.noteFill[base + 1] = n.hit;
        this.noteFill[base + 2] = n.missed;
        this.noteFill[base + 3] = n.skipped;
        this.stripes[h * 2 + b] = n.stripe ? this._stripePattern(b ? n.fillBlack : n.fill, n.stripe) : null;
      }
    }
  }

  _stripePattern(base, stripe) {
    const P = this.stripeP;
    const c = document.createElement('canvas');
    c.width = P;
    c.height = P;
    const g = c.getContext('2d');
    g.fillStyle = base;
    g.fillRect(0, 0, P, P);
    g.strokeStyle = stripe;
    g.lineWidth = P * 0.36;
    g.lineCap = 'square';
    g.beginPath();
    for (let k = -1; k <= 2; k++) {
      g.moveTo(k * P, 0);
      g.lineTo(k * P - P, P);
    }
    g.stroke();
    return this.ctx.createPattern(c, 'repeat');
  }

  _buildGradients() {
    const ctx = this.ctx;
    const t = this.theme;
    const top = this.strikeYd;
    const bh = this.blackHd;
    const wh = this.bedHd;
    const colH = this.colHd;
    const kinds = ['', t.keyLit[0], t.keyLit[1], WRONG_RED, t.neutral];
    for (let k = 1; k <= 4; k++) {
      const c = kinds[k];
      let g = ctx.createLinearGradient(0, top, 0, top + wh);
      g.addColorStop(0, withAlpha(c, 0.95));
      g.addColorStop(0.6, withAlpha(c, 0.72));
      g.addColorStop(1, withAlpha(c, 0.5));
      this.litWhite[k] = g;
      g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, withAlpha(c, 1));
      g.addColorStop(1, withAlpha(c, 0.7));
      this.litBlack[k] = g;
      g = ctx.createLinearGradient(0, top - colH, 0, top);
      g.addColorStop(0, withAlpha(c, 0));
      g.addColorStop(1, withAlpha(c, k === KEY_WRONG ? 0.8 : t.light ? 0.4 : 0.5));
      this.column[k] = g;
    }
    for (let h = 0; h < 3; h++) {
      const c = t.keyLit[h];
      let g = ctx.createLinearGradient(0, top, 0, top + wh);
      g.addColorStop(0, withAlpha(c, 0.8));
      g.addColorStop(1, withAlpha(c, 0.35));
      this.handTintWhite[h] = g;
      g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, withAlpha(c, 0.9));
      g.addColorStop(1, withAlpha(c, 0.5));
      this.handTintBlack[h] = g;
    }
    const gh = Math.round(26 * this.dpr);
    const sg = ctx.createLinearGradient(0, top - gh, 0, top);
    sg.addColorStop(0, withAlpha(t.strikeGlow, 0));
    sg.addColorStop(1, t.strikeGlow);
    this.strikeGlow = sg;
    this.strikeGlowH = gh;
  }

  _buildFadeBand() {
    if (!this.strikeYd) return;
    const band = Math.round(70 * this.dpr);
    const y0 = Math.round(this.strikeYd * (1 - this.memorizeFrac));
    const g = this.ctx.createLinearGradient(0, y0, 0, y0 + band);
    const c = this.theme.bgBottom;
    g.addColorStop(0, withAlpha(c, 1));
    g.addColorStop(1, withAlpha(c, 0));
    this.fadeBand = g;
    this.fadeBandH = band;
    this.fadeY = y0;
  }

  _buildLayers() {
    const t = this.theme;
    const W = this.cssW;
    const dpr = this.dpr;
    const geo = this.geo;
    const strikeY = this.strikeYd / dpr;
    const bedH = this.bedHd / dpr;

    // Background
    const bg = makeLayer(this.Wd, this.strikeYd, dpr);
    let c = bg.ctx;
    const bgg = c.createLinearGradient(0, 0, 0, strikeY);
    bgg.addColorStop(0, t.bgTop);
    bgg.addColorStop(1, t.bgBottom);
    c.fillStyle = bgg;
    c.fillRect(0, 0, W, strikeY);
    if (t.vignette) {
      const vg = c.createRadialGradient(W / 2, strikeY, 10, W / 2, strikeY, Math.max(W, this.cssH) * 0.8);
      vg.addColorStop(0, t.vignette);
      vg.addColorStop(1, withAlpha(t.vignette, 0));
      c.fillStyle = vg;
      c.fillRect(0, 0, W, strikeY);
    }
    if (t.id === 'synthwave') {
      // retro horizon grid in the lower third
      c.strokeStyle = 'rgba(255,90,210,0.10)';
      c.lineWidth = 1;
      for (let y = strikeY * 0.55; y < strikeY; y += (y - strikeY * 0.5) * 0.18 + 6) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(W, y);
        c.stroke();
      }
    }
    for (let p = 24; p <= 108; p += 12) {
      c.fillStyle = t.laneC; // C lanes
      c.fillRect(Math.round(geo.x[p]), 0, 1, strikeY);
      if (p + 5 <= 108) {
        c.fillStyle = t.laneF; // F lanes
        c.fillRect(Math.round(geo.x[p + 5]), 0, 1, strikeY);
      }
    }
    this.bg = bg.canvas;

    // White keys
    const wl = makeLayer(this.Wd, this.bedHd, dpr);
    c = wl.ctx;
    const wg = c.createLinearGradient(0, 0, 0, bedH);
    wg.addColorStop(0, '#c9ced8');
    wg.addColorStop(0.08, '#eef1f6');
    wg.addColorStop(0.92, '#fbfcfe');
    wg.addColorStop(1, '#d9dde5');
    c.fillStyle = t.light ? '#8f8a84' : '#0a0b10';
    c.fillRect(0, 0, W, bedH);
    for (let i = 0; i < WHITE_COUNT; i++) {
      const p = geo.whitePitches[i];
      c.fillStyle = wg;
      roundRectPathF(c, geo.x[p] + 0.5, -4, geo.w[p] - 1, bedH + 2, Math.min(5, geo.w[p] * 0.2));
      c.fill();
    }
    const shade = c.createLinearGradient(0, 0, 0, 14);
    shade.addColorStop(0, 'rgba(0,0,0,0.45)');
    shade.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = shade;
    c.fillRect(0, 0, W, 14);
    // C labels on the keys (C1 … C8)
    c.font = this.fontSmall.replace(/(\d+)px/, (m, n) => Math.round(n / dpr) + 'px');
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = t.keyLabel;
    for (let p = 24; p <= 108; p += 12) c.fillText(NOTE_NAMES[p], geo.x[p] + geo.w[p] / 2, bedH - 6);
    this.whiteLayer = wl.canvas;

    // Black keys
    const bl = makeLayer(this.Wd, this.bedHd, dpr);
    c = bl.ctx;
    const bh = geo.blackH;
    const bgGrad = c.createLinearGradient(0, 0, 0, bh);
    bgGrad.addColorStop(0, '#05060a');
    bgGrad.addColorStop(0.85, '#1c1f2a');
    bgGrad.addColorStop(1, '#2a2e3b');
    for (let i = 0; i < 36; i++) {
      const p = geo.blackPitches[i];
      c.fillStyle = 'rgba(0,0,0,0.35)';
      roundRectPathF(c, geo.x[p] - 1, -2, geo.w[p] + 2, bh + 4, 3);
      c.fill();
      c.fillStyle = bgGrad;
      roundRectPathF(c, geo.x[p], -3, geo.w[p], bh + 3, Math.min(3, geo.w[p] * 0.2));
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(geo.x[p] + geo.w[p] * 0.18, 2, geo.w[p] * 0.64, bh * 0.75);
    }
    this.blackLayer = bl.canvas;
  }

  /** Particle burst above a key (correct hit or tablet-played note). */
  burst(pitch, strength) {
    if (!this.effects) return;
    const x = this.kx[pitch] + (this.kw[pitch] >> 1);
    this.particles.emit(x, this.strikeYd - 2, strength, this.kw[pitch]);
  }

  /**
   * Draws one frame.
   * @param {number} songTime song seconds at the strike line
   * @param {number} dt real seconds since last frame
   * @param {boolean} held true while Wait Mode is holding the playhead
   */
  draw(songTime, dt, held) {
    const ctx = this.ctx;
    const t = this.theme;
    const Wd = this.Wd;
    const strikeYd = this.strikeYd;
    const pr = this.practice;
    this.time += dt;
    this.frames++;

    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0);
    this.activeKey.fill(0);

    // Loop markers (behind notes)
    if (this.loopA === this.loopA) this._loopLine(this.loopA, songTime, 'A');
    if (this.loopB === this.loopB) this._loopLine(this.loopB, songTime, 'B');

    const s = this.song;
    if (s && s.count > 0 && pr) {
      const first = lowerBound(s.start, s.count, songTime - s.maxDur);
      if (this.markSongKeys) this._markActive(s, pr, songTime, first);
      if (this.memorizeFrac > 0) {
        const clipped = this.memorizeFrac < 1;
        if (clipped) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, this.fadeY, Wd, strikeYd - this.fadeY);
          ctx.clip();
        }
        ctx.font = this.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = this.outlineW;
        this._drawNotes(s, pr, songTime, first, 0);
        this._drawNotes(s, pr, songTime, first, 1);
        if (clipped) {
          ctx.restore();
          ctx.fillStyle = this.fadeBand;
          ctx.fillRect(0, this.fadeY, Wd, this.fadeBandH);
        }
      }
      if (this.markSongKeys) this._emitAutoplay(s, pr, songTime);
    }
    const take = this.takeSong;
    if (take && take.count > 0) this._markTake(take, songTime);
    this.prevT = songTime;

    // Strike line
    ctx.fillStyle = this.strikeGlow;
    ctx.fillRect(0, strikeYd - this.strikeGlowH, Wd, this.strikeGlowH);
    if (held) {
      ctx.globalAlpha = ALPHA[alphaIndex(0.55 + 0.45 * Math.sin(this.time * 6.5))];
      ctx.fillStyle = t.strikeWait;
      ctx.fillRect(0, strikeYd - 4, Wd, 4);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = t.strike;
      ctx.fillRect(0, strikeYd - 3, Wd, 3);
    }

    // Particles
    if (this.effects) {
      this.particles.update(dt);
      this.particles.draw(ctx, ALPHA, ALPHA_STEPS);
      ctx.globalAlpha = 1;
    }

    // Key bed
    ctx.drawImage(this.whiteLayer, 0, strikeYd);
    if (pr) {
      const whites = this.geo.whitePitches;
      for (let i = 0; i < WHITE_COUNT; i++) this._keyOverlay(whites[i], 0, pr);
    }
    ctx.drawImage(this.blackLayer, 0, strikeYd);
    if (pr) {
      const blacks = this.geo.blackPitches;
      for (let i = 0; i < 36; i++) this._keyOverlay(blacks[i], 1, pr);
      // Glow columns above struck keys (red for wrong notes)
      const colH = this.colHd;
      for (let p = 21; p <= 108; p++) {
        const kind = pr.flashKind[p];
        if (kind === 0) continue;
        const ai = alphaIndex(pr.flashLevel[p]);
        if (ai === 0) continue;
        ctx.globalAlpha = ALPHA[ai];
        ctx.fillStyle = this.column[kind];
        ctx.fillRect(this.kx[p], strikeYd - colH, this.kw[p], colH);
        if (kind === KEY_WRONG) {
          ctx.fillStyle = WRONG_RED;
          ctx.fillRect(this.kx[p] - 4, strikeYd - 6, this.kw[p] + 8, 6);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  _loopLine(at, t, label) {
    const y = (this.strikeYd - (at - t) * this.ppsd + 0.5) | 0;
    if (y < 0 || y > this.strikeYd) return;
    const ctx = this.ctx;
    const h = Math.max(2, this.outlineW);
    ctx.fillStyle = this.theme.loop;
    ctx.globalAlpha = ALPHA[20];
    ctx.fillRect(0, y - (h >> 1), this.Wd, h);
    ctx.globalAlpha = 1;
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, this.fontPx >> 1, y - h);
  }

  /** Sets activeKey for tablet-played notes currently sounding. */
  _markActive(s, pr, t, first) {
    const required = pr.required;
    for (let i = first; i < s.count; i++) {
      const st = s.start[i];
      if (st > t) break;
      if (s.end[i] < t || s.inRange[i] === 0) continue;
      const hand = s.hand[i];
      if (required[hand] === 0 || !pr.practiceActive) this.activeKey[s.pitch[i]] = hand + 1;
    }
  }

  _markTake(take, t) {
    const first = lowerBound(take.start, take.count, t - take.maxDur);
    const prev = this.prevT;
    const emit = prev === prev && t > prev && t - prev < 0.5;
    for (let i = first; i < take.count; i++) {
      const st = take.start[i];
      if (st > t) break;
      if (take.end[i] < t) continue;
      this.activeKey[take.pitch[i]] = 1;
      if (emit && st > prev) this.burst(take.pitch[i], 5);
    }
  }

  /** Sparkles where tablet-played notes reach the strike line. */
  _emitAutoplay(s, pr, t) {
    if (!this.effects) return;
    const prev = this.prevT;
    if (!(prev === prev) || t <= prev || t - prev > 0.5) return;
    const required = pr.required;
    for (let i = lowerBound(s.start, s.count, prev + 1e-9); i < s.count && s.start[i] <= t; i++) {
      if (s.inRange[i] === 0) continue;
      if (required[s.hand[i]] === 1 && pr.practiceActive) continue;
      this.burst(s.pitch[i], s.hand[i] === 2 ? 2 : 5);
    }
  }

  _drawNotes(s, pr, t, first, blackPass) {
    const ctx = this.ctx;
    const theme = this.theme;
    const kx = this.kx;
    const kw = this.kw;
    const ppsd = this.ppsd;
    const strikeYd = this.strikeYd;
    const tTop = t + strikeYd / ppsd;
    const state = pr.state;
    const fs = this.fontPx;
    const half = (fs * 0.55 + 0.5) | 0;
    const radius = this.radius;
    const inset = blackPass === 1 ? 1 : (2 * this.dpr + 0.5) | 0;
    const P = this.stripeP;
    const outline = blackPass === 1 ? theme.outlineBlack : theme.outline;
    const labelMode = this.labelMode;
    for (let i = first; i < s.count; i++) {
      const st = s.start[i];
      if (st > tTop) break;
      const en = s.end[i];
      if (en < t || s.inRange[i] === 0) continue;
      const p = s.pitch[i];
      if (IS_BLACK[p] !== blackPass) continue;
      const hand = s.hand[i];
      const nt = theme.notes[hand];

      // Snap to integer device pixels (allocation-free canvas calls).
      let yB = (strikeYd - (st - t) * ppsd + 0.5) | 0;
      let yT = (strikeYd - (en - t) * ppsd + 0.5) | 0;
      if (yB > strikeYd) yB = strikeYd;
      if (yT < -64) yT = -64;
      let h = yB - yT;
      if (h < 4) {
        h = 4;
        yT = yB - 4;
      }
      const x = kx[p] + inset;
      const w = kw[p] - inset * 2;
      const ns = state[i];
      const live = ns === NOTE_PENDING || ns === NOTE_HIT;

      if (live && nt.glow !== null) {
        ctx.fillStyle = nt.glow;
        roundRectPath(ctx, x - 3, yT - 3, w + 6, h + 6, radius + 3);
        ctx.fill();
      }
      const pattern = live ? this.stripes[hand * 2 + blackPass] : null;
      if (pattern !== null) {
        // Shift the pattern origin so stripes travel with the note.
        let off = yT % P;
        if (off < 0) off += P;
        ctx.translate(0, off);
        roundRectPath(ctx, x, yT - off, w, h, radius);
        ctx.fillStyle = pattern;
        ctx.fill();
        ctx.translate(0, -off);
        roundRectPath(ctx, x, yT, w, h, radius);
      } else {
        roundRectPath(ctx, x, yT, w, h, radius);
        ctx.fillStyle = this.noteFill[hand * 8 + blackPass * 4 + ns];
        ctx.fill();
      }
      if (outline !== null) {
        ctx.strokeStyle = outline;
        ctx.stroke();
      }
      if (live && nt.edge !== null && h > 8) {
        ctx.fillStyle = nt.edge;
        ctx.fillRect(x + 3, yT + 1, w - 6, 2);
      }

      if (labelMode === LABEL_OFF) continue;
      // Pitch label centred in the visible part of the block.
      const visT = yT < 0 ? 0 : yT;
      const visH = yB - visT;
      const cx = x + (w >> 1);
      const cy = (visT + yB) >> 1;
      const labelColor = live ? nt.label : theme.labelMuted;
      const badge = live ? this.badge : null;
      if (labelMode === LABEL_LETTER) {
        if (visH >= fs + 4 && this.labelTopW[p] <= w - 1) this._label(LABEL_TOP[p], cx, cy, this.labelTopW[p], w, labelColor, badge);
      } else if (visH >= fs + 6 && this.labelW[p] <= w - 2) {
        this._label(NOTE_NAMES[p], cx, cy, this.labelW[p], w, labelColor, badge);
      } else if (visH >= fs * 2 + 8 && this.labelTopW[p] <= w - 1) {
        if (badge !== null) {
          const bw = w - 4;
          ctx.fillStyle = badge;
          roundRectPath(ctx, cx - (bw >> 1), cy - half - (fs >> 1) - 2, bw, half * 2 + fs + 4, this.badgeR);
          ctx.fill();
        }
        ctx.fillStyle = labelColor;
        ctx.fillText(LABEL_TOP[p], cx, cy - half);
        ctx.fillText(LABEL_BOTTOM[p], cx, cy + half);
      }
    }
  }

  /** Draws a label, on a rounded badge when the theme asks for one. Integer args only. */
  _label(text, cx, cy, tw, w, color, badge) {
    const ctx = this.ctx;
    if (badge !== null) {
      let bw = tw + this.badgePad * 2;
      if (bw > w - 2) bw = w - 2;
      const bh = this.fontPx + this.badgePad + 2;
      ctx.fillStyle = badge;
      roundRectPath(ctx, cx - (bw >> 1), cy - (bh >> 1), bw, bh, this.badgeR);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy + 1);
  }

  _keyOverlay(p, black, pr) {
    const ctx = this.ctx;
    const inset = black === 1 ? 0 : 1;
    const x = this.kx[p] + inset;
    const w = this.kw[p] - inset * 2;
    const top = this.strikeYd;
    const h = (black === 1 ? this.blackHd : this.bedHd) - 2;

    const active = this.activeKey[p];
    if (active !== 0) {
      ctx.globalAlpha = ALPHA[22];
      ctx.fillStyle = black === 1 ? this.handTintBlack[active - 1] : this.handTintWhite[active - 1];
      ctx.fillRect(x, top, w, h);
    }
    const lvlIdx = alphaIndex(pr.flashLevel[p]);
    const exp = pr.expected[p];
    if (exp !== 0 && lvlIdx === 0 && this.showHints) {
      ctx.globalAlpha = ALPHA[alphaIndex(0.28 + 0.18 * Math.sin(this.time * 7))];
      ctx.fillStyle = black === 1 ? this.handTintBlack[exp - 1] : this.handTintWhite[exp - 1];
      ctx.fillRect(x, top, w, h);
    }
    const kind = pr.flashKind[p];
    if (lvlIdx !== 0 && kind !== 0) {
      ctx.globalAlpha = ALPHA[lvlIdx];
      ctx.fillStyle = black === 1 ? this.litBlack[kind] : this.litWhite[kind];
      ctx.fillRect(x, top, w, h);
    }
    ctx.globalAlpha = 1;
  }

  /** Converts a vertical drag distance (CSS px) on the waterfall into song seconds. */
  pixelsToSeconds(dy) {
    return dy / this.pps;
  }
}
