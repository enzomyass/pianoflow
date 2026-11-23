// Waterfall + key bed renderer (HTML5 Canvas 2D).
//
// GC discipline (verified by heap measurement in headless Chrome):
//  * Everything the frame loop needs (colour strings, gradients, labels,
//    label widths, key geometry, cached key-bed bitmaps) is built in resize().
//  * The frame is drawn in DEVICE pixels with an identity transform, and every
//    coordinate is snapped to an integer before it reaches the canvas API.
//    Blink boxes each fractional double argument into a V8 HeapNumber
//    (~12-14 bytes per call); small integers (Smis) are allocation-free.
//  * globalAlpha values come from a pre-boxed lookup table (ALPHA), so the
//    setter never receives a freshly allocated double.
// Result: draw() performs effectively zero JS heap allocation per frame.

import { IS_BLACK, NOTE_NAMES, lowerBound, COLOR_BG, COLOR_WRONG, COLOR_RIGHT, COLOR_LEFT, COLOR_ACCOMP } from '../core/constants.js';
import { KeyboardGeometry, WHITE_COUNT } from './keyboard-geometry.js';
import { KEY_WRONG, NOTE_PENDING, NOTE_HIT } from '../core/practice.js';

// Note fill colours indexed [hand*8 + black*4 + state] (state: pending, hit, missed, skipped).
const NOTE_FILL = [
  // right hand: white / black
  '#1fc8f5', '#8cf0ff', '#3a4252', '#1f6f86',
  '#0f8fc0', '#5fd6f2', '#2c3340', '#17566a',
  // left hand
  '#27e6a0', '#9dffd8', '#3a4a45', '#1c7a5a',
  '#139a6c', '#62e8b8', '#2c3a35', '#135a43',
  // accompaniment
  'rgba(155,123,255,0.55)', 'rgba(190,170,255,0.7)', 'rgba(90,80,120,0.45)', 'rgba(110,95,170,0.35)',
  'rgba(110,85,210,0.55)', 'rgba(150,130,240,0.7)', 'rgba(70,62,100,0.45)', 'rgba(85,72,140,0.35)',
];
const NOTE_GLOW = ['rgba(34,211,255,0.16)', 'rgba(44,245,168,0.16)', 'rgba(155,123,255,0.08)'];
const NOTE_EDGE = ['rgba(220,250,255,0.75)', 'rgba(225,255,240,0.75)', 'rgba(230,220,255,0.35)'];
const BLACK_OUTLINE = 'rgba(0,0,0,0.55)';
const LABEL_DARK = '#03141c';
const LABEL_LIGHT = '#c9ced8';
const STRIKE_IDLE = 'rgba(160,240,255,0.85)';
const STRIKE_WAIT = '#ffd166';
const KIND_COLOR = ['', COLOR_RIGHT, COLOR_LEFT, COLOR_WRONG, '#cfe9ff'];
const HAND_COLOR = [COLOR_RIGHT, COLOR_LEFT, COLOR_ACCOMP];
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

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

function hexToRgba(hex, a) {
  const v = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
}

/** Rounded-rect path. Integer-safe: keeps every argument a Smi when inputs are ints. */
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

/** Same as roundRectPath but for float CSS coordinates (layer building only). */
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
    this.practice = null;
    this.activeKey = new Uint8Array(128); // hand+1 of a tablet-played note sounding now

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
    this.fontPx = 16; // device px
    this.labelW = new Int32Array(128);
    this.labelTopW = new Int32Array(128);

    this.visibleSeconds = 3;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.strikeY = 0; // CSS px (input handling)
    this.bedH = 0;
    this.pps = 100; // CSS px per song second (drag scrubbing)
    this.time = 0;
    this.font = '700 16px ' + FONT_STACK;

    this.bg = null;
    this.whiteLayer = null;
    this.blackLayer = null;
    this.litWhite = [null, null, null, null, null];
    this.litBlack = [null, null, null, null, null];
    this.column = [null, null, null, null, null];
    this.handTintWhite = [null, null, null];
    this.handTintBlack = [null, null, null];
    this.strikeGlow = null;
    this.frames = 0;
  }

  setSong(song) {
    this.song = song;
  }

  setPractice(practice) {
    this.practice = practice;
  }

  setVisibleSeconds(s) {
    this.visibleSeconds = s;
    this.pps = this.strikeY / s;
    this.ppsd = this.strikeYd / s;
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
    ctx.font = this.font;
    for (let p = 0; p < 128; p++) {
      this.labelW[p] = Math.ceil(ctx.measureText(NOTE_NAMES[p]).width);
      this.labelTopW[p] = Math.ceil(ctx.measureText(LABEL_TOP[p]).width);
    }
    this._buildGradients();
    this._buildLayers();
  }

  _buildGradients() {
    // Device-px gradients; all vertical so they are valid for any x.
    const ctx = this.ctx;
    const top = this.strikeYd;
    const bh = this.blackHd;
    const wh = this.bedHd;
    const colH = this.colHd;
    for (let k = 1; k <= 4; k++) {
      const c = KIND_COLOR[k];
      let g = ctx.createLinearGradient(0, top, 0, top + wh);
      g.addColorStop(0, hexToRgba(c, 0.95));
      g.addColorStop(0.6, hexToRgba(c, 0.7));
      g.addColorStop(1, hexToRgba(c, 0.45));
      this.litWhite[k] = g;
      g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, hexToRgba(c, 1));
      g.addColorStop(1, hexToRgba(c, 0.65));
      this.litBlack[k] = g;
      g = ctx.createLinearGradient(0, top - colH, 0, top);
      g.addColorStop(0, hexToRgba(c, 0));
      g.addColorStop(1, hexToRgba(c, k === KEY_WRONG ? 0.75 : 0.5));
      this.column[k] = g;
    }
    for (let h = 0; h < 3; h++) {
      const c = HAND_COLOR[h];
      let g = ctx.createLinearGradient(0, top, 0, top + wh);
      g.addColorStop(0, hexToRgba(c, 0.75));
      g.addColorStop(1, hexToRgba(c, 0.3));
      this.handTintWhite[h] = g;
      g = ctx.createLinearGradient(0, top, 0, top + bh);
      g.addColorStop(0, hexToRgba(c, 0.85));
      g.addColorStop(1, hexToRgba(c, 0.45));
      this.handTintBlack[h] = g;
    }
    const gh = Math.round(26 * this.dpr);
    const sg = ctx.createLinearGradient(0, top - gh, 0, top);
    sg.addColorStop(0, 'rgba(34,211,255,0)');
    sg.addColorStop(1, 'rgba(34,211,255,0.28)');
    this.strikeGlow = sg;
    this.strikeGlowH = gh;
  }

  _buildLayers() {
    const W = this.cssW;
    const dpr = this.dpr;
    const geo = this.geo;
    const strikeY = this.strikeYd / dpr; // CSS y matching the device strike line
    const bedH = this.bedHd / dpr;

    // Background: charcoal with octave lanes and a soft vignette.
    const bg = makeLayer(this.Wd, this.strikeYd, dpr);
    let c = bg.ctx;
    c.fillStyle = COLOR_BG;
    c.fillRect(0, 0, W, strikeY);
    const vg = c.createRadialGradient(W / 2, strikeY, 10, W / 2, strikeY, Math.max(W, this.cssH) * 0.8);
    vg.addColorStop(0, 'rgba(40,70,110,0.20)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, strikeY);
    for (let p = 24; p <= 108; p += 12) {
      c.fillStyle = 'rgba(255,255,255,0.055)'; // C lanes
      c.fillRect(Math.round(geo.x[p]), 0, 1, strikeY);
      if (p + 5 <= 108) {
        c.fillStyle = 'rgba(255,255,255,0.025)'; // F lanes
        c.fillRect(Math.round(geo.x[p + 5]), 0, 1, strikeY);
      }
    }
    this.bg = bg.canvas;

    // White keys.
    const wl = makeLayer(this.Wd, this.bedHd, dpr);
    c = wl.ctx;
    const wg = c.createLinearGradient(0, 0, 0, bedH);
    wg.addColorStop(0, '#c9ced8');
    wg.addColorStop(0.08, '#eef1f6');
    wg.addColorStop(0.92, '#fbfcfe');
    wg.addColorStop(1, '#d9dde5');
    c.fillStyle = '#0a0b10';
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
    c.fillStyle = 'rgba(34,211,255,0.55)'; // middle C marker
    c.beginPath();
    c.arc(geo.x[60] + geo.w[60] / 2, bedH - 10, Math.max(2, geo.whiteW * 0.12), 0, Math.PI * 2);
    c.fill();
    this.whiteLayer = wl.canvas;

    // Black keys (transparent layer drawn over white-key highlights).
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

  /**
   * Draws one frame.
   * @param {number} songTime song seconds at the strike line
   * @param {number} dt real seconds since last frame
   * @param {boolean} held true while Wait Mode is holding the playhead
   */
  draw(songTime, dt, held) {
    const ctx = this.ctx;
    const Wd = this.Wd;
    const strikeYd = this.strikeYd;
    const pr = this.practice;
    this.time += dt;
    this.frames++;

    ctx.globalAlpha = 1;
    ctx.drawImage(this.bg, 0, 0);
    this.activeKey.fill(0);

    const s = this.song;
    if (s && s.count > 0 && pr) {
      ctx.font = this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      const first = lowerBound(s.start, s.count, songTime - s.maxDur);
      this._drawNotes(s, pr, songTime, first, 0);
      this._drawNotes(s, pr, songTime, first, 1);
    }

    // Strike line
    ctx.fillStyle = this.strikeGlow;
    ctx.fillRect(0, strikeYd - this.strikeGlowH, Wd, this.strikeGlowH);
    if (held) {
      ctx.globalAlpha = ALPHA[alphaIndex(0.55 + 0.45 * Math.sin(this.time * 6.5))];
      ctx.fillStyle = STRIKE_WAIT;
      ctx.fillRect(0, strikeYd - 4, Wd, 4);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = STRIKE_IDLE;
      ctx.fillRect(0, strikeYd - 3, Wd, 3);
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
          ctx.fillStyle = COLOR_WRONG;
          ctx.fillRect(this.kx[p] - 4, strikeYd - 6, this.kw[p] + 8, 6);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  _drawNotes(s, pr, t, first, blackPass) {
    const ctx = this.ctx;
    const kx = this.kx;
    const kw = this.kw;
    const ppsd = this.ppsd;
    const strikeYd = this.strikeYd;
    const tTop = t + strikeYd / ppsd;
    const state = pr.state;
    const required = pr.required;
    const fs = this.fontPx;
    const half = (fs * 0.55 + 0.5) | 0;
    const radius = (4 * this.dpr + 0.5) | 0;
    const inset = blackPass === 1 ? 1 : (2 * this.dpr + 0.5) | 0;
    for (let i = first; i < s.count; i++) {
      const st = s.start[i];
      if (st > tTop) break;
      const en = s.end[i];
      if (en < t || s.inRange[i] === 0) continue;
      const p = s.pitch[i];
      if (IS_BLACK[p] !== blackPass) continue;
      const hand = s.hand[i];
      if (st <= t && required[hand] === 0) this.activeKey[p] = hand + 1;

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

      if (ns === NOTE_PENDING || ns === NOTE_HIT) {
        ctx.fillStyle = NOTE_GLOW[hand];
        ctx.fillRect(x - 3, yT - 3, w + 6, h + 6);
      }
      ctx.fillStyle = NOTE_FILL[hand * 8 + blackPass * 4 + ns];
      roundRectPath(ctx, x, yT, w, h, radius);
      ctx.fill();
      if (blackPass === 1) {
        ctx.strokeStyle = BLACK_OUTLINE;
        ctx.stroke();
      }
      if (ns <= NOTE_HIT && h > 8) {
        ctx.fillStyle = NOTE_EDGE[hand];
        ctx.fillRect(x + 3, yT + 1, w - 6, 2);
      }

      // Pitch label centred in the visible part of the block.
      const visT = yT < 0 ? 0 : yT;
      const visH = yB - visT;
      const cx = x + (w >> 1);
      const cy = (visT + yB) >> 1;
      ctx.fillStyle = ns === NOTE_PENDING || ns === NOTE_HIT ? LABEL_DARK : LABEL_LIGHT;
      if (visH >= fs + 6 && this.labelW[p] <= w - 2) {
        ctx.fillText(NOTE_NAMES[p], cx, cy);
      } else if (visH >= fs * 2 + 8 && this.labelTopW[p] <= w - 1) {
        ctx.fillText(LABEL_TOP[p], cx, cy - half);
        ctx.fillText(LABEL_BOTTOM[p], cx, cy + half);
      }
    }
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
    if (exp !== 0 && lvlIdx === 0) {
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
