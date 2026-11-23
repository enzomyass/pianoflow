// Drift-free playhead.
//
// Song time is never accumulated frame by frame (that drifts and desyncs from
// audio). Instead it is computed from an anchor:
//     songTime = anchorSong + (realNow - anchorReal) * rate
// where realNow is the AudioContext clock while audio is running, so falling
// notes and scheduled synth notes share one clock. When audio is unavailable
// (context suspended), the clock falls back to the requestAnimationFrame
// timestamp, with deltas clamped to 100 ms so a backgrounded tab or a GC
// pause cannot make the song jump.
//
// Every state change (play, pause, seek, rate change, wait-mode hold/release,
// clock-source switch) re-anchors at the current song time, so none of them
// can introduce drift.

const SRC_NONE = 0;
const SRC_AUDIO = 1;
const SRC_FRAME = 2;
const MAX_FRAME_DELTA = 0.1;

export class Transport {
  /** @param {() => (number|null)} audioTimeFn returns AudioContext.currentTime when running, else null */
  constructor(audioTimeFn) {
    this.audioTimeFn = audioTimeFn;
    this.src = SRC_NONE;
    this.frameClock = 0; // accumulated clamped rAF seconds
    this.lastRaf = -1;
    this.real = 0; // current real-clock reading in the active source
    this.anchorReal = 0;
    this.anchorSong = 0;
    this.songTime = 0;
    this.rate = 1;
    this.playing = false;
    this.hold = Infinity; // wait-mode barrier (song seconds)
    this.held = false;
    this.duration = 0;
  }

  /** Fresh reading of the active clock without advancing the frame clock. */
  _realNow() {
    if (this.src === SRC_AUDIO) {
      const t = this.audioTimeFn();
      if (t !== null) return t;
    }
    return this.real;
  }

  _compute(realNow) {
    if (!this.playing) return this.anchorSong;
    const raw = this.anchorSong + (realNow - this.anchorReal) * this.rate;
    if (raw >= this.hold) {
      this.held = true;
      return this.hold;
    }
    this.held = false;
    return raw;
  }

  _reanchor() {
    const now = this._realNow();
    this.anchorSong = this._compute(now);
    this.anchorReal = now;
    this.songTime = this.anchorSong;
  }

  /** Call once per animation frame with the rAF timestamp (ms). */
  tick(rafMs) {
    let dt = this.lastRaf < 0 ? 0 : (rafMs - this.lastRaf) / 1000;
    if (dt < 0) dt = 0;
    if (dt > MAX_FRAME_DELTA) dt = MAX_FRAME_DELTA;
    this.lastRaf = rafMs;
    this.frameClock += dt;

    const audioT = this.audioTimeFn();
    const newSrc = audioT !== null ? SRC_AUDIO : SRC_FRAME;
    const newReal = audioT !== null ? audioT : this.frameClock;
    if (newSrc !== this.src) {
      // Switch clock source without a jump or a lost frame: carry the song
      // forward by this frame's clamped delta, then anchor on the new clock.
      let carried = this.songTime;
      if (this.playing && !this.held && this.src !== SRC_NONE) {
        carried += dt * this.rate;
        if (carried > this.hold) carried = this.hold;
      }
      this.anchorSong = carried;
      this.anchorReal = newReal;
      this.src = newSrc;
    }
    this.real = newReal;
    this.songTime = this._compute(this.real);
    return dt;
  }

  get usingAudioClock() {
    return this.src === SRC_AUDIO;
  }

  /** Real (AudioContext) time at which a given song time will be reached. */
  realTimeFor(songT) {
    return this.anchorReal + (songT - this.anchorSong) / this.rate;
  }

  play() {
    if (this.playing) return;
    this.anchorReal = this._realNow();
    this.anchorSong = this.songTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._reanchor();
    this.playing = false;
    this.held = false;
  }

  seek(t) {
    const clamped = Math.max(-2, Math.min(t, this.duration + 1));
    this.anchorReal = this._realNow();
    this.anchorSong = clamped;
    this.songTime = clamped;
    this.held = false;
  }

  setRate(r) {
    const rate = Math.max(0.25, Math.min(2, r));
    if (rate === this.rate) return;
    this._reanchor();
    this.rate = rate;
  }

  /** Sets the wait-mode barrier. Releasing a hold resumes exactly where it froze. */
  setHold(t) {
    if (t === this.hold) return;
    if (this.held && t > this.songTime) {
      this.anchorSong = this.songTime;
      this.anchorReal = this._realNow();
      this.held = false;
    }
    this.hold = t;
    if (this.playing && this.songTime > t) {
      // A new barrier behind the playhead (e.g. wait mode toggled on mid-note).
      this.anchorSong = t;
      this.anchorReal = this._realNow();
      this.songTime = t;
    }
  }
}
