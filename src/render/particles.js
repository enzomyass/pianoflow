// Fixed-size particle pool (struct-of-arrays). emit/update/draw never allocate:
// all coordinates handed to the canvas are integers, alphas come from the
// renderer's pre-boxed alpha table.

const MAX = 480;
const GRAVITY = { confetti: 900, spark: 300, bubble: -160, petal: 120 };

export class Particles {
  constructor() {
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.vx = new Float32Array(MAX);
    this.vy = new Float32Array(MAX);
    this.life = new Float32Array(MAX); // remaining seconds
    this.max = new Float32Array(MAX);
    this.size = new Uint8Array(MAX);
    this.color = new Uint8Array(MAX);
    this.alive = 0; // count of live particles (packed at the front)
    this.style = 'spark';
    this.styleId = 0;
    this.colors = ['#ffffff'];
    this.gravity = 300;
    this.scale = 1;
  }

  configure(style, colors, scale) {
    this.style = style;
    this.styleId = style === 'confetti' ? 1 : style === 'bubble' ? 2 : style === 'petal' ? 3 : 0;
    this.colors = colors.slice();
    this.gravity = (GRAVITY[style] || 300) * scale;
    this.scale = scale;
    this.alive = 0;
  }

  /** Emits `count` particles at (x, y) device px. */
  emit(x, y, count, spread) {
    // Numeric style id + number-initialised locals keep every double unboxed
    // in optimised code (an `undefined`-initialised local boxes each value).
    const st = this.styleId;
    const s = this.scale;
    const nColors = this.colors.length;
    for (let k = 0; k < count; k++) {
      if (this.alive >= MAX) return;
      const i = this.alive++;
      let vx = 0;
      let vy = 0;
      let life = 0.5;
      let size = 1;
      const r1 = Math.random() - 0.5;
      const r2 = Math.random();
      const r3 = Math.random();
      if (st === 1) {
        // confetti
        vx = r1 * 260 * s;
        vy = -(160 + r2 * 260) * s;
        life = 0.55 + r3 * 0.45;
        size = (2 + r3 * 3) * s;
      } else if (st === 2) {
        // bubble
        vx = r1 * 40 * s;
        vy = -(40 + r2 * 80) * s;
        life = 0.8 + r3 * 0.8;
        size = (2 + r3 * 4) * s;
      } else if (st === 3) {
        // petal
        vx = r1 * 160 * s;
        vy = -(80 + r2 * 140) * s;
        life = 0.9 + r3 * 0.7;
        size = (3 + r3 * 3) * s;
      } else {
        // spark
        vx = r1 * 200 * s;
        vy = -(120 + r2 * 280) * s;
        life = 0.35 + r3 * 0.4;
        size = (1 + r3 * 2.5) * s;
      }
      this.x[i] = x + (Math.random() - 0.5) * spread;
      this.y[i] = y;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.life[i] = life;
      this.max[i] = life;
      this.size[i] = size < 1 ? 1 : size | 0;
      this.color[i] = (Math.random() * nColors) | 0;
    }
  }

  update(dt) {
    if (dt <= 0) return;
    const g = this.gravity * dt;
    const drag = this.styleId === 3 || this.styleId === 2 ? 1 - 1.2 * dt : 1 - 0.6 * dt;
    let i = 0;
    while (i < this.alive) {
      const l = this.life[i] - dt;
      if (l <= 0) {
        // swap-remove with last live particle
        const j = --this.alive;
        this.x[i] = this.x[j];
        this.y[i] = this.y[j];
        this.vx[i] = this.vx[j];
        this.vy[i] = this.vy[j];
        this.life[i] = this.life[j];
        this.max[i] = this.max[j];
        this.size[i] = this.size[j];
        this.color[i] = this.color[j];
        continue;
      }
      this.life[i] = l;
      this.vy[i] += g;
      this.vx[i] *= drag;
      if (this.styleId === 3) this.vx[i] += Math.sin(l * 9 + i) * 30 * dt * this.scale;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      i++;
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} alphaTable pre-boxed alphas, index 0..steps
   * @param {number} steps
   */
  draw(ctx, alphaTable, steps) {
    const colors = this.colors;
    const style = this.style;
    for (let i = 0; i < this.alive; i++) {
      const a = this.life[i] / this.max[i];
      const ai = (a * steps + 0.5) | 0;
      if (ai <= 0) continue;
      ctx.globalAlpha = alphaTable[ai];
      ctx.fillStyle = colors[this.color[i]];
      const x = this.x[i] | 0;
      const y = this.y[i] | 0;
      const s = this.size[i];
      if (style === 'spark') {
        // little four-point star: two crossed bars
        ctx.fillRect(x - s, y, s * 2 + 1, 1 + (s >> 1));
        ctx.fillRect(x, y - s, 1 + (s >> 1), s * 2 + 1);
      } else if (style === 'bubble') {
        ctx.fillRect(x - s, y - s, s * 2, 1);
        ctx.fillRect(x - s, y + s, s * 2, 1);
        ctx.fillRect(x - s, y - s, 1, s * 2);
        ctx.fillRect(x + s, y - s, 1, s * 2 + 1);
      } else if (style === 'petal') {
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s + (s >> 1));
        ctx.lineTo(x - s, y);
        ctx.closePath();
        ctx.fill();
      } else {
        // confetti: alternating squares and thin strips
        if ((i & 1) === 0) ctx.fillRect(x, y, s * 2, s * 2);
        else ctx.fillRect(x, y, s * 3, s);
      }
    }
  }
}
