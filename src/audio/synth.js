// Polyphonic Web Audio instrument with selectable tones.
//  - "Grand Piano" plays recorded samples (Salamander Grand Piano, bundled
//    into the APK at build time) and falls back to the synthesized piano if
//    the samples are missing.
//  - The other tones are synthesized (FM electric piano, drawbar organ,
//    strings, harpsichord, music box, vibraphone, synth lead, warm pad).
//  - Fixed pool of voice records; Web Audio nodes are created per note start
//    only (never per frame). Voice stealing when the pool is full.
//  - Sustain pedal holds live notes; metronome clicks; output-latency value
//    used by the schedulers to compensate Bluetooth speakers.

const MAX_VOICES = 72;

export const TONES = [
  { id: 'grand', name: 'Grand Piano' },
  { id: 'bright', name: 'Bright Piano' },
  { id: 'epiano', name: 'Electric Piano' },
  { id: 'organ', name: 'Organ' },
  { id: 'strings', name: 'Strings' },
  { id: 'harpsichord', name: 'Harpsichord' },
  { id: 'musicbox', name: 'Music Box' },
  { id: 'vibes', name: 'Vibraphone' },
  { id: 'synth', name: 'Synth Lead' },
  { id: 'pad', name: 'Warm Pad' },
];

// Salamander samples every minor third: A0, C1, D#1, F#1, A1 … C8
const SAMPLE_PITCHES = [];
for (let p = 21; p <= 108; p += 3) SAMPLE_PITCHES.push(p);
const PC_FILE = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
export function sampleFileName(p) {
  return PC_FILE[p % 12] + (Math.floor(p / 12) - 1) + '.mp3';
}
export { SAMPLE_PITCHES };

function mtof(p) {
  return 440 * Math.pow(2, (p - 69) / 12);
}

class Voice {
  constructor() {
    this.out = null; // envelope GainNode (voice output)
    this.sources = null; // nodes with start/stop
    this.release = 0.1; // release time constant
    this.pitch = -1;
    this.startTime = 0;
    this.endTime = 0;
    this.live = false; // held by a live key, released on noteOff
    this.sustained = false; // key released while the sustain pedal was down
    this.active = false;
  }
}

export class Synth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.metroGain = null;
    this.waves = {};
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.volume = 0.8;
    this.metroVolume = 0.6;
    this.tone = 'grand';
    this.samples = new Map(); // pitch -> AudioBuffer
    this.samplesState = 'none'; // none | loading | ready | missing
    this.sustain = false;
    this.latencyMode = 'auto'; // 'auto' or 'manual'
    this.manualLatency = 0; // seconds
    this.noise = null;
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
      this.metroGain = ctx.createGain();
      this.metroGain.gain.value = this.metroVolume * 0.6;
      this.metroGain.connect(comp);
      this._buildWaves();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  _buildWaves() {
    const ctx = this.ctx;
    const make = (fn, n = 32) => {
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) imag[k] = fn(k);
      return ctx.createPeriodicWave(real, imag);
    };
    // Piano-like: strong fundamental, decaying partials, weakened 7th.
    this.waves.piano = make((n) => (1 / Math.pow(n, 1.35)) * (n % 2 === 0 ? 0.7 : 1) * (n === 7 ? 0.3 : 1), 24);
    // Drawbar organ 8' 4' 2 2/3' 2' 1'
    this.waves.organ = make((n) => ({ 1: 1, 2: 0.8, 3: 0.6, 4: 0.5, 8: 0.35, 6: 0.15 })[n] || 0, 16);
    // Harpsichord: bright, many partials
    this.waves.harpsi = make((n) => (1 / Math.pow(n, 0.75)) * (n % 3 === 0 ? 0.5 : 1), 40);
    // Music box / celesta: fundamental + inharmonic-ish 3rd and 6th partials
    this.waves.musicbox = make((n) => ({ 1: 1, 3: 0.32, 6: 0.12, 9: 0.05 })[n] || 0, 12);
  }

  isRunning() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** AudioContext time when running, else null (used as the master clock). */
  clock() {
    return this.ctx && this.ctx.state === 'running' ? this.ctx.currentTime : null;
  }

  /** Seconds between scheduling a sound and hearing it (Bluetooth speakers add ~0.15–0.3 s). */
  latency() {
    if (this.latencyMode === 'manual') return this.manualLatency;
    if (!this.ctx) return 0;
    const l = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return l > 0 && l < 1 ? l : 0;
  }

  setLatency(mode, seconds) {
    this.latencyMode = mode;
    this.manualLatency = Math.max(0, Math.min(0.6, seconds || 0));
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.02);
  }

  setMetronomeVolume(v) {
    this.metroVolume = v;
    if (this.metroGain) this.metroGain.gain.setTargetAtTime(v * 0.6, this.ctx.currentTime, 0.02);
  }

  setTone(id) {
    this.tone = TONES.some((t) => t.id === id) ? id : 'grand';
  }

  /** True when "Grand Piano" will use real samples. */
  get usingSamples() {
    return this.tone === 'grand' && this.samplesState === 'ready';
  }

  /**
   * Loads the piano samples (bundled with the app, so this works offline).
   * @param {string} baseUrl e.g. './samples/piano/'
   */
  async loadSamples(baseUrl, onState) {
    if (!this.ctx || this.samplesState === 'loading' || this.samplesState === 'ready') return this.samplesState;
    this.samplesState = 'loading';
    if (onState) onState('loading');
    const ctx = this.ctx;
    let ok = 0;
    const queue = SAMPLE_PITCHES.slice();
    const worker = async () => {
      while (queue.length) {
        const p = queue.shift();
        try {
          const res = await fetch(baseUrl + sampleFileName(p));
          if (!res.ok) continue;
          const data = await res.arrayBuffer();
          const buf = await new Promise((resolve, reject) => {
            const pr = ctx.decodeAudioData(data, resolve, reject);
            if (pr && pr.then) pr.then(resolve, reject);
          });
          this.samples.set(p, buf);
          ok++;
        } catch (_) {
          /* missing or undecodable sample */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.samplesState = ok >= 10 ? 'ready' : 'missing';
    if (onState) onState(this.samplesState);
    return this.samplesState;
  }

  _nearestSample(pitch) {
    let best = -1;
    let bd = 99;
    for (const p of this.samples.keys()) {
      const d = Math.abs(p - pitch);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  _allocVoice(now) {
    let free = null;
    let oldest = null;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active || (!v.live && !v.sustained && now > v.endTime + 0.05)) {
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
    if (v.out) {
      try {
        v.out.disconnect();
      } catch (_) {
        /* already disconnected */
      }
    }
    v.out = null;
    v.sources = null;
    v.active = false;
    v.live = false;
    v.sustained = false;
  }

  _stopSources(v, at) {
    if (!v.sources) return;
    for (const s of v.sources) {
      try {
        s.stop(at);
      } catch (_) {
        /* already stopped */
      }
    }
  }

  _kill(v, at, fade) {
    if (!v || !v.out) return;
    try {
      v.out.gain.cancelScheduledValues(at);
      v.out.gain.setValueAtTime(v.out.gain.value, at);
      v.out.gain.linearRampToValueAtTime(0, at + fade);
    } catch (_) {
      /* node gone */
    }
    this._stopSources(v, at + fade + 0.01);
    v.endTime = at + fade;
  }

  /** Builds the node graph for one note. Returns {out, sources, release}. */
  _build(pitch, vel, t0) {
    const ctx = this.ctx;
    const f = mtof(pitch);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    const sources = [];
    let release = 0.12;
    const osc = (type, freq, wave) => {
      const o = ctx.createOscillator();
      if (wave) o.setPeriodicWave(wave);
      else o.type = type;
      o.frequency.value = freq;
      sources.push(o);
      return o;
    };
    const lp = (freq, q = 0.5) => {
      const b = ctx.createBiquadFilter();
      b.type = 'lowpass';
      b.frequency.value = freq;
      b.Q.value = q;
      return b;
    };
    let tone = this.tone;
    if (tone === 'grand' && this.samplesState === 'ready') {
      const sp = this._nearestSample(pitch);
      const src = ctx.createBufferSource();
      src.buffer = this.samples.get(sp);
      src.playbackRate.value = Math.pow(2, (pitch - sp) / 12);
      sources.push(src);
      const filt = lp(Math.min(18000, 1200 + vel * vel * 17000), 0.3);
      src.connect(filt);
      filt.connect(out);
      const peak = 0.25 + Math.pow(vel, 1.4) * 0.85;
      out.gain.linearRampToValueAtTime(peak, t0 + 0.003);
      release = 0.14;
      return { out, sources, release };
    }
    if (tone === 'grand') tone = 'bright';

    switch (tone) {
      case 'epiano': {
        // 2-operator FM (tine) + bell partial
        const car = osc('sine', f);
        const mod = osc('sine', f);
        const modGain = ctx.createGain();
        const idx = f * (1.2 + vel * 3.2);
        modGain.gain.setValueAtTime(idx, t0);
        modGain.gain.setTargetAtTime(f * 0.4, t0, 0.25);
        mod.connect(modGain);
        modGain.connect(car.frequency);
        const bell = osc('sine', f * 14);
        const bellG = ctx.createGain();
        bellG.gain.setValueAtTime(0.06 * vel, t0);
        bellG.gain.setTargetAtTime(0, t0, 0.05);
        bell.connect(bellG);
        bellG.connect(out);
        car.connect(out);
        const peak = 0.2 + vel * 0.32;
        out.gain.linearRampToValueAtTime(peak, t0 + 0.004);
        out.gain.setTargetAtTime(peak * 0.35, t0 + 0.004, 0.9 + (100 - Math.min(100, pitch)) * 0.02);
        release = 0.15;
        break;
      }
      case 'organ': {
        const o = osc(null, f, this.waves.organ);
        const trem = osc('sine', 6.2);
        const tg = ctx.createGain();
        tg.gain.value = f * 0.004;
        trem.connect(tg);
        tg.connect(o.frequency);
        o.connect(out);
        out.gain.linearRampToValueAtTime(0.22, t0 + 0.01);
        release = 0.05;
        break;
      }
      case 'strings': {
        const filt = lp(Math.min(9000, f * 6), 0.7);
        for (const d of [-7, 0, 7]) {
          const o = osc('sawtooth', f);
          o.detune.value = d;
          o.connect(filt);
        }
        filt.connect(out);
        out.gain.linearRampToValueAtTime(0.09 + vel * 0.05, t0 + 0.22);
        release = 0.3;
        break;
      }
      case 'pad': {
        const filt = lp(Math.min(4000, f * 3), 1);
        filt.frequency.setValueAtTime(f, t0);
        filt.frequency.linearRampToValueAtTime(Math.min(5000, f * 4), t0 + 1.2);
        for (const d of [-10, 10]) {
          const o = osc('sawtooth', f);
          o.detune.value = d;
          o.connect(filt);
        }
        const sub = osc('triangle', f / 2);
        sub.connect(filt);
        filt.connect(out);
        out.gain.linearRampToValueAtTime(0.1, t0 + 0.45);
        release = 0.5;
        break;
      }
      case 'harpsichord': {
        const o = osc(null, f, this.waves.harpsi);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = f * 0.8;
        o.connect(hp);
        hp.connect(out);
        out.gain.linearRampToValueAtTime(0.28, t0 + 0.002);
        out.gain.setTargetAtTime(0.04, t0 + 0.002, 0.35 + (108 - Math.min(108, pitch)) * 0.012);
        release = 0.08;
        break;
      }
      case 'musicbox': {
        const o = osc(null, f * 2, this.waves.musicbox);
        o.connect(out);
        out.gain.linearRampToValueAtTime(0.18 + vel * 0.12, t0 + 0.002);
        out.gain.setTargetAtTime(0, t0 + 0.002, 0.5);
        release = 0.3;
        break;
      }
      case 'vibes': {
        const o = osc('sine', f);
        const o4 = osc('sine', f * 4);
        const g4 = ctx.createGain();
        g4.gain.setValueAtTime(0.25, t0);
        g4.gain.setTargetAtTime(0, t0, 0.15);
        o4.connect(g4);
        const trem = ctx.createGain();
        trem.gain.value = 1;
        const lfo = osc('sine', 5.5);
        const lg = ctx.createGain();
        lg.gain.value = 0.25;
        lfo.connect(lg);
        lg.connect(trem.gain);
        o.connect(trem);
        g4.connect(trem);
        trem.connect(out);
        out.gain.linearRampToValueAtTime(0.2 + vel * 0.15, t0 + 0.003);
        out.gain.setTargetAtTime(0.02, t0 + 0.003, 1.4);
        release = 0.4;
        break;
      }
      case 'synth': {
        const filt = lp(Math.min(12000, f * (3 + vel * 6)), 4);
        filt.frequency.setTargetAtTime(f * 2, t0, 0.3);
        const o = osc('square', f);
        const o2 = osc('sawtooth', f);
        o2.detune.value = 8;
        o.connect(filt);
        o2.connect(filt);
        filt.connect(out);
        out.gain.linearRampToValueAtTime(0.1, t0 + 0.006);
        out.gain.setTargetAtTime(0.07, t0 + 0.006, 0.2);
        release = 0.1;
        break;
      }
      default: {
        // bright synthesized piano
        const o = osc(null, f, this.waves.piano);
        const filt = lp(Math.min(16000, f * (2.5 + vel * 9)), 0.4);
        filt.frequency.setValueAtTime(Math.min(16000, f * (2.5 + vel * 9)), t0);
        filt.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, 300), t0 + 1.6);
        o.connect(filt);
        filt.connect(out);
        const peak = 0.16 + vel * vel * 0.34;
        const decay = 0.5 + (108 - Math.min(108, pitch)) * 0.035;
        out.gain.linearRampToValueAtTime(peak, t0 + 0.005);
        out.gain.setTargetAtTime(peak * 0.25, t0 + 0.005, decay);
        release = 0.09;
      }
    }
    return { out, sources, release };
  }

  _start(pitch, velocity, when, duration, live) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = Math.max(when, now);
    const v = this._allocVoice(now);
    const vel = Math.max(1, velocity) / 127;
    const built = this._build(pitch, vel, t0);
    built.out.connect(this.master);
    for (const s of built.sources) s.start(t0);
    v.out = built.out;
    v.sources = built.sources;
    v.release = built.release;
    v.pitch = pitch;
    v.startTime = t0;
    v.active = true;
    v.live = live;
    v.sustained = false;
    if (live) {
      v.endTime = Infinity;
    } else {
      const off = t0 + Math.max(0.05, duration);
      built.out.gain.setTargetAtTime(0, off, v.release);
      const stopAt = off + v.release * 6;
      this._stopSources(v, stopAt);
      v.endTime = stopAt;
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
    this._releaseLive(pitch, true);
    this._start(pitch, velocity, this.ctx.currentTime, 0, true);
  }

  liveOff(pitch) {
    if (!this.ctx) return;
    if (this.sustain) {
      for (let i = 0; i < MAX_VOICES; i++) {
        const v = this.voices[i];
        if (v.active && v.live && v.pitch === pitch) {
          v.live = false;
          v.sustained = true;
        }
      }
      return;
    }
    this._releaseLive(pitch, false);
  }

  _releaseLive(pitch, includeSustained) {
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active || v.pitch !== pitch) continue;
      if (!(v.live || (includeSustained && v.sustained))) continue;
      this._releaseVoice(v, now);
    }
  }

  _releaseVoice(v, now) {
    v.live = false;
    v.sustained = false;
    try {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setValueAtTime(v.out.gain.value, now);
      v.out.gain.setTargetAtTime(0, now, v.release);
    } catch (_) {
      /* stopped */
    }
    this._stopSources(v, now + v.release * 6);
    v.endTime = now + v.release * 6;
  }

  /** Sustain pedal (CC64). Releasing it lets go of every sustained note. */
  setSustain(on) {
    this.sustain = !!on;
    if (on || !this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.active && v.sustained) this._releaseVoice(v, now);
    }
  }

  /** Metronome click at AudioContext time `when`. */
  click(when, accent) {
    if (!this.isRunning()) return;
    const ctx = this.ctx;
    const t0 = Math.max(when, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = accent ? 1760 : 1180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.55, t0 + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    o.connect(g);
    g.connect(this.metroGain);
    o.start(t0);
    o.stop(t0 + 0.06);
    o.onended = () => g.disconnect();
  }

  /** Cancels song notes that have not started yet (used on tempo change). */
  cancelPending() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (v.active && !v.live && !v.sustained && v.startTime > now) {
        this._stopSources(v, 0);
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
      if (!v.active || v.live || v.sustained) continue;
      if (v.startTime > now) {
        this._stopSources(v, 0);
        this._dispose(v);
      } else if (now < v.endTime) {
        this._kill(v, now, fade);
      }
    }
  }
}
