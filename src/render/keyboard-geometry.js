// Proportional 88-key layout (A0..C8): 52 white keys, 36 black keys.
// Real-piano proportions: black key width ≈ 0.58 × white key width,
// black key length ≈ 0.64 × white key length, and black keys are offset
// within their gap (C#/F# lean left, D#/A# lean right, G# centred).

import { A0, C8, IS_BLACK } from '../core/constants.js';

export const WHITE_COUNT = 52;
const BLACK_WIDTH_RATIO = 0.58;
const BLACK_LENGTH_RATIO = 0.64;
// Offset of the black key centre from the boundary between its white neighbours,
// as a fraction of white key width, by pitch class.
const BLACK_OFFSET = { 1: -0.1, 3: 0.1, 6: -0.12, 8: 0, 10: 0.12 };

export class KeyboardGeometry {
  constructor() {
    this.x = new Float32Array(128);
    this.w = new Float32Array(128);
    this.whitePitches = new Uint8Array(WHITE_COUNT);
    this.blackPitches = new Uint8Array(36);
    let wi = 0;
    let bi = 0;
    for (let p = A0; p <= C8; p++) {
      if (IS_BLACK[p]) this.blackPitches[bi++] = p;
      else this.whitePitches[wi++] = p;
    }
    this.whiteW = 0;
    this.blackW = 0;
    this.whiteH = 0;
    this.blackH = 0;
    this.top = 0;
  }

  /** Lays out keys across `width` px with the bed starting at `top` and `height` tall. */
  layout(width, top, height) {
    const ww = width / WHITE_COUNT;
    this.whiteW = ww;
    this.blackW = ww * BLACK_WIDTH_RATIO;
    this.whiteH = height;
    this.blackH = height * BLACK_LENGTH_RATIO;
    this.top = top;
    for (let i = 0; i < WHITE_COUNT; i++) {
      const p = this.whitePitches[i];
      this.x[p] = i * ww;
      this.w[p] = ww;
    }
    for (let i = 0; i < 36; i++) {
      const p = this.blackPitches[i];
      const boundary = this.x[p + 1]; // left edge of the white key above
      const centre = boundary + BLACK_OFFSET[p % 12] * ww;
      this.x[p] = centre - this.blackW / 2;
      this.w[p] = this.blackW;
    }
  }

  /** Pitch under a point on the key bed, or -1. */
  hitTest(px, py) {
    const y = py - this.top;
    if (y < 0 || y > this.whiteH) return -1;
    if (y <= this.blackH) {
      for (let i = 0; i < 36; i++) {
        const p = this.blackPitches[i];
        if (px >= this.x[p] && px < this.x[p] + this.w[p]) return p;
      }
    }
    const idx = Math.floor(px / this.whiteW);
    if (idx < 0 || idx >= WHITE_COUNT) return -1;
    return this.whitePitches[idx];
  }
}
