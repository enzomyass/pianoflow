// Audio → piano notes (offline, on-device, no network).
//
// Pipeline (mono audio, any sample rate; 16 kHz recommended):
//  1. STFT: Hann window ~256 ms, hop 16 ms, radix-2 FFT (typed arrays).
//  2. Per frame, iterative multi-pitch estimation over the 88 piano keys:
//     harmonic-sum salience → take the strongest pitch → subtract its
//     harmonics using spectral smoothness → repeat (up to 8 voices).
//     A fundamental-presence gate suppresses sub-octave ghosts.
//  3. Note tracking per pitch with onset (rise) detection, hysteresis and
//     minimum duration; velocity from peak salience.
// Works best on solo piano (covers); dense band mixes give rougher results.

const A0 = 21;
const KEYS = 88;
const MAX_POLY = 8;
const HARMONICS = 10;
const ONSET_BIAS = 0; // onsets are taken at the steepest salience rise

function mtof(p) {
  return 440 * Math.pow(2, (p - 69) / 12);
}

class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** In-place complex FFT. */
  transform(re, im) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k;
          const b = a + half;
          const c = this.cos[k * step];
          const s = this.sin[k * step];
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {Float32Array} samples mono audio
 * @param {number} sampleRate
 * @param {{onProgress?:(f:number)=>void, isCancelled?:()=>boolean}} [opts]
 * @returns {Promise<{notes:{pitch:number,start:number,end:number,velocity:number}[], duration:number}>}
 */
export async function transcribeAudio(samples, sampleRate, opts = {}) {
  const sr = sampleRate;
  let N = 1;
  while (N < sr * 0.256) N <<= 1;
  const hop = Math.max(1, Math.round(sr * 0.016));
  const half = N >> 1;
  const binHz = sr / N;
  const frames = Math.max(0, Math.floor(samples.length / hop) + 1);
  const duration = samples.length / sr;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    wsum += win[i];
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(half);
  const work = new Float64Array(half);

  // Harmonic bin windows per key
  const nyq = sr / 2;
  const hLo = new Int32Array(KEYS * HARMONICS);
  const hHi = new Int32Array(KEYS * HARMONICS);
  const hCount = new Uint8Array(KEYS);
  for (let k = 0; k < KEYS; k++) {
    const f0 = mtof(A0 + k);
    let c = 0;
    for (let h = 1; h <= HARMONICS; h++) {
      const f = f0 * h;
      if (f > nyq * 0.95) break;
      const center = f / binHz;
      const w = Math.max(0.6, center * 0.016);
      hLo[k * HARMONICS + h - 1] = Math.max(1, Math.floor(center - w));
      hHi[k * HARMONICS + h - 1] = Math.min(half - 1, Math.ceil(center + w));
      c = h;
    }
    hCount[k] = c;
  }
  const weight = new Float64Array(HARMONICS);
  for (let h = 0; h < HARMONICS; h++) weight[h] = Math.pow(0.86, h);
  const amp = new Float64Array(HARMONICS);

  const S = new Float32Array(frames * KEYS); // accepted salience per frame/key
  const accepted = new Uint8Array(KEYS);
  const scale = 2 / wsum;

  for (let f = 0; f < frames; f++) {
    // frame centred at f*hop
    const off = f * hop - half;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const j = off + i;
      const x = j >= 0 && j < samples.length ? samples[j] : 0;
      re[i] = x * win[i];
      im[i] = 0;
      energy += x * x;
    }
    if (energy > 1e-9) {
      fft.transform(re, im);
      for (let i = 0; i < half; i++) {
        const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
        mag[i] = m;
        work[i] = m;
      }
      accepted.fill(0);
      let first = 0;
      for (let iter = 0; iter < MAX_POLY; iter++) {
        let best = -1;
        let bestSal = 0;
        for (let k = 0; k < KEYS; k++) {
          if (accepted[k]) continue;
          const hc = hCount[k];
          if (hc === 0) continue;
          // a semitone neighbour already taken in this frame is spectral leakage
          if ((k > 0 && accepted[k - 1]) || (k + 1 < KEYS && accepted[k + 1])) continue;
          let sal = 0;
          let maxH = 0;
          for (let h = 0; h < hc; h++) {
            const base = k * HARMONICS + h;
            let m = 0;
            for (let b = hLo[base]; b <= hHi[base]; b++) if (work[b] > m) m = work[b];
            amp[h] = m;
            if (m > maxH) maxH = m;
            sal += weight[h] * m;
          }
          // Harmonic coverage gate: a real note has most of its first partials
          // (and its fundamental). Sub-octave / sub-twelfth ghosts only have
          // every 2nd / 3rd partial, so they fail here.
          const nCheck = hc < 5 ? hc : 5;
          if (nCheck >= 3) {
            let present = 0;
            for (let h = 0; h < nCheck; h++) if (amp[h] >= 0.12 * maxH) present++;
            if (present < Math.ceil(nCheck * 0.6)) continue;
          }
          const gate = k < 19 ? 0.05 : k < 28 ? 0.14 : 0.3;
          if (amp[0] < gate * maxH) continue;
          if (sal > bestSal) {
            bestSal = sal;
            best = k;
          }
        }
        if (best < 0) break;
        if (iter === 0) first = bestSal;
        else if (bestSal < first * 0.12) break;
        accepted[best] = 1;
        S[f * KEYS + best] = bestSal;
        // subtract harmonics with spectral smoothness
        const hc = hCount[best];
        for (let h = 0; h < hc; h++) {
          const base = best * HARMONICS + h;
          let m = 0;
          for (let b = hLo[base]; b <= hHi[base]; b++) if (work[b] > m) m = work[b];
          amp[h] = m;
        }
        for (let h = 0; h < hc; h++) {
          const prev = h > 0 ? amp[h - 1] : amp[h];
          const next = h + 1 < hc ? amp[h + 1] : amp[h];
          const smooth = Math.min(amp[h], (prev + amp[h] + next) / 3);
          const ratio = amp[h] > 0 ? Math.max(0, 1 - smooth / amp[h]) : 0;
          const base = best * HARMONICS + h;
          const lo = Math.max(1, hLo[base] - 1);
          const hi = Math.min(half - 1, hHi[base] + 1);
          for (let b = lo; b <= hi; b++) work[b] *= ratio;
        }
      }
    }
    if ((f & 127) === 127) {
      if (opts.onProgress) opts.onProgress((f / frames) * 0.95);
      await tick();
      if (opts.isCancelled && opts.isCancelled()) throw new Error('cancelled');
    }
  }

  // Global reference level: 99th percentile of accepted salience
  const vals = [];
  for (let i = 0; i < S.length; i++) if (S[i] > 0) vals.push(S[i]);
  if (!vals.length) return { notes: [], duration };
  vals.sort((a, b) => a - b);
  const gm = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
  const onThr = 0.1 * gm;
  const floorThr = 0.04 * gm;
  const frameT = hop / sr;
  const minFrames = 5;
  const notes = [];

  for (let k = 0; k < KEYS; k++) {
    let active = false;
    let start = 0;
    let peak = 0;
    let low = 0;
    for (let f = 0; f <= frames; f++) {
      const v = f < frames ? S[f * KEYS + k] : 0;
      const v2 = f >= 2 ? S[(f - 2) * KEYS + k] : 0;
      const v3 = f >= 3 ? S[(f - 3) * KEYS + k] : 0;
      const rising = v > onThr && v > Math.max(v2, v3) * 1.6 && v - v3 > 0.15 * gm;
      if (active) {
        const ended = v < Math.max(floorThr, peak * 0.18);
        if (ended) low++;
        else low = 0;
        if (low >= 4 || f === frames || (rising && f - start > 8)) {
          const endF = low >= 4 ? f - 3 : f;
          if (endF - start >= minFrames && peak >= 0.14 * gm) {
            notes.push({ pitch: A0 + k, start: start * frameT + ONSET_BIAS, end: endF * frameT, velocity: Math.max(25, Math.min(127, Math.round(30 + 97 * Math.sqrt(Math.min(1, peak / gm))))) });
          }
          active = false;
          low = 0;
        } else if (v > peak) peak = v;
      }
      if (!active && v > onThr && f < frames) {
        // Onset = steepest rise of salience within the next ~130 ms (a step
        // seen through a Hann window rises fastest when the onset is centred).
        let s = f;
        let best = -1;
        for (let g = f; g < Math.min(frames, f + 8); g++) {
          const d = S[g * KEYS + k] - (g > 0 ? S[(g - 1) * KEYS + k] : 0);
          if (d > best) {
            best = d;
            s = g;
          }
        }
        active = true;
        start = s;
        peak = v;
        low = 0;
        f = Math.max(f, s); // continue tracking from the onset
      }
    }
  }
  // Merge same-pitch fragments separated by a tiny gap.
  notes.sort((a, b) => a.pitch - b.pitch || a.start - b.start);
  const merged = [];
  for (const n of notes) {
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last && last.pitch === n.pitch && n.start - last.end < 0.07 && n.velocity <= last.velocity + 10) {
      if (n.end > last.end) last.end = n.end;
    } else merged.push(n);
  }
  merged.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  if (opts.onProgress) opts.onProgress(1);
  return { notes: merged, duration };
}

/** Linear resampler + downmix (used when OfflineAudioContext is unavailable). */
export function toMono16k(channels, sampleRate, target = 16000) {
  const len = channels[0].length;
  const outLen = Math.floor((len * target) / sampleRate);
  const out = new Float32Array(outLen);
  const ratio = sampleRate / target;
  const nc = channels.length;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const fr = x - j;
    let s = 0;
    for (let c = 0; c < nc; c++) {
      const ch = channels[c];
      const a = ch[j] || 0;
      const b = j + 1 < len ? ch[j + 1] : a;
      s += a + (b - a) * fr;
    }
    out[i] = s / nc;
  }
  return out;
}
