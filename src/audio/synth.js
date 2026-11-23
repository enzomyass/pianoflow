// Minimal polyphonic Web Audio piano-ish synth.
// - One custom PeriodicWave (built once) per voice + per-voice lowpass for
//   velocity brightness + exponential piano-style decay envelope.
// - Fixed pool of voice records (no per-note record allocation; Web Audio
//   nodes themselves are created per note, which is unavoidable and happens
//   only when a note starts, never per frame).
// - Voice stealing when the pool is full.

const MAX_VOICES = 64;

function mtof(p) {
  return 440 * Math.pow(2, (p - 69) / 12);
}

class Voice {
  constructor() {
    this.osc = null;
    this.gain = null;
    this.filter = null;
    this.pitch = -1;
    this.startTime = 0;
    this.endTime = 0;
    this.live = false; // held by a live key (monitor), released on noteOff
    this.active = false;
  }
}

export class Synth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.wave = null;
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.volume = 0.8;
  }

  /** Must be called from a user gesture the first time (autoplay policy). */
  ensure() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume * 0.5;
      this.master.connect(comp);
      comp.connect(ctx.destination);

      // Piano-like harmonic spectrum: strong fundamental, decaying partials,
      // slightly weakened even partials for a hollow hammer tone.
      const N = 24;
      const real = new Float32Array(N);
      const imag = new Float32Array(N);
      for (let n = 1; n < N; n++) {
        let a = 1 / Math.pow(n, 1.35);
        if (n % 2 === 0) a *= 0.7;
        if (n === 7) a *= 0.3;
        imag[n] = a;
      }
      this.wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  isRunning() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** AudioContext time when running, else null (used as the master clock). */
  clock() {
    return this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.02);
  }

  _allocVoice(now) {
    let free = null;
    let oldest = null;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active || (!v.live && now > v.endTime + 0.05)) {
        free = v;
        break;
      }
      if (!oldest || v.startTime < oldest.startTime) oldest = v;
    }
    if (free) {
      this._dispose(free);
      return free;
    }
    this._kill(oldest, now, 0.015);
    this._dispose(oldest);
    return oldest;
  }

  _dispose(v) {
    if (v.gain) {
      try {
        v.gain.disconnect();
      } catch (_) {
        /* already disconnected */
      }
    }
    v.osc = null;
    v.gain = null;
    v.filter = null;
    v.active = false;
    v.live = false;
  }

  _kill(v, at, fade) {
    if (!v || !v.osc) return;
    try {
      v.gain.gain.cancelScheduledValues(at);
      v.gain.gain.setValueAtTime(v.gain.gain.value, at);
      v.gain.gain.linearRampToValueAtTime(0, at + fade);
      v.osc.stop(at + fade + 0.01);
    } catch (_) {
      /* node already stopped */
    }
    v.endTime = at + fade;
  }

  _start(pitch, velocity, when, duration, live) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = Math.max(when, now);
    const v = this._allocVoice(now);
    const vel = Math.max(1, velocity) / 127;
    const freq = mtof(pitch);

    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave);
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.4;
    const bright = Math.min(16000, freq * (2.5 + vel * 9));
    filter.frequency.setValueAtTime(bright, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 300), t0 + 1.6);
    const gain = ctx.createGain();
    const peak = 0.16 + vel * vel * 0.34;
    // Lower notes ring longer, like a real piano.
    const decay = 0.5 + (108 - Math.min(108, pitch)) * 0.035;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    gain.gain.setTargetAtTime(peak * 0.25, t0 + 0.005, decay);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(t0);

    v.osc = osc;
    v.gain = gain;
    v.filter = filter;
    v.pitch = pitch;
    v.startTime = t0;
    v.active = true;
    v.live = live;
    if (live) {
      v.endTime = Infinity;
    } else {
      const off = t0 + Math.max(0.05, duration);
      gain.gain.setTargetAtTime(0, off, 0.09);
      osc.stop(off + 0.6);
      v.endTime = off + 0.6;
    }
    return v;
  }

  /** Schedules a song note at AudioContext time `when`. */
  playNote(pitch, velocity, when, duration) {
    if (!this.isRunning()) return;
    this._start(pitch, velocity, when, duration, false);
  }

  /** Live monitor note (on-screen keys / computer keyboard / optional piano echo). */
  liveOn(pitch, velocity) {
    if (!this.isRunning()) return;
    this.liveOff(pitch);
    this._start(pitch, velocity, this.ctx.currentTime, 0, true);
  }

  liveOff(pitch) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.active && v.live && v.pitch === pitch) {
        v.live = false;
        try {
          v.gain.gain.cancelScheduledValues(now);
          v.gain.gain.setValueAtTime(v.gain.gain.value, now);
          v.gain.gain.setTargetAtTime(0, now, 0.08);
          v.osc.stop(now + 0.6);
        } catch (_) {
          /* stopped */
        }
        v.endTime = now + 0.6;
      }
    }
  }

  /** Cancels song notes that have not started yet (used on tempo change). */
  cancelPending() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.active && !v.live && v.startTime > now) {
        try {
          v.osc.stop();
        } catch (_) {
          /* not started */
        }
        this._dispose(v);
      }
    }
  }

  /** Fades out every song voice (pause / seek). Live voices are kept. */
  stopAll(fade = 0.06) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active || v.live) continue;
      if (v.startTime > now) {
        try {
          v.osc.stop();
        } catch (_) {
          /* not started */
        }
        this._dispose(v);
      } else if (now < v.endTime) {
        this._kill(v, now, fade);
      }
    }
  }
}
