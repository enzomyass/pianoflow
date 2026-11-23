// Practice engine: hit detection, mistake detection and Wait Mode chord gating.
// All per-note and per-key state lives in typed arrays sized once per song.

import { HAND_LEFT, HAND_RIGHT, lowerBound } from './constants.js';

export const NOTE_PENDING = 0;
export const NOTE_HIT = 1;
export const NOTE_MISSED = 2;
export const NOTE_SKIPPED = 3;

export const KEY_NONE = 0;
export const KEY_HIT_RIGHT = 1;
export const KEY_HIT_LEFT = 2;
export const KEY_WRONG = 3;
export const KEY_NEUTRAL = 4;

/** Notes starting within this many song-seconds form one chord step. */
export const CHORD_EPSILON = 0.04;
/** Hit tolerance in real seconds (scaled by tempo into song time). */
export const HIT_WINDOW_REAL = 0.2;

const FLASH_DECAY_HIT = 0.32;
const FLASH_DECAY_WRONG = 0.5;

export class PracticeEngine {
  constructor() {
    this.song = null;
    this.state = new Uint8Array(0);
    this.required = new Uint8Array(3); // per hand: 1 = you play this hand
    this.required[0] = 1;
    this.required[1] = 1;
    this.practiceActive = true;
    this.waitMode = false;

    this.groupTime = new Float64Array(0);
    this.groupOffset = new Uint32Array(1);
    this.groupNotes = new Uint32Array(0);
    this.groupCount = 0;
    this.waitIdx = 0;
    this.missCursor = 0;

    this.keyDown = new Uint8Array(128);
    this.flashKind = new Uint8Array(128);
    this.flashLevel = new Float32Array(128);
    this.expected = new Uint8Array(128); // 0 none, 1 right, 2 left

    this.hits = 0;
    this.misses = 0;
    this.wrong = 0;
    this.version = 0; // bumps whenever stats change (cheap DOM dirty check)
  }

  setSong(song) {
    this.song = song;
    this.state = new Uint8Array(song ? song.count : 0);
    this.rebuildGroups();
    this.resetFrom(-Infinity, true);
  }

  /** Muted hands are the hands YOU play: they are required and not played by the synth. */
  setPracticeHands(rightRequired, leftRequired, songTime = 0) {
    this.required[HAND_RIGHT] = rightRequired ? 1 : 0;
    this.required[HAND_LEFT] = leftRequired ? 1 : 0;
    this.practiceActive = !!(rightRequired || leftRequired);
    this.rebuildGroups();
    this.waitIdx = lowerBound(this.groupTime, this.groupCount, songTime - 1e-6);
  }

  setWaitMode(on, songTime) {
    this.waitMode = !!on;
    this.waitIdx = lowerBound(this.groupTime, this.groupCount, songTime - 1e-6);
  }

  isRequired(i) {
    const s = this.song;
    return s.inRange[i] === 1 && this.required[s.hand[i]] === 1;
  }

  rebuildGroups() {
    const s = this.song;
    if (!s) {
      this.groupCount = 0;
      return;
    }
    let n = 0;
    for (let i = 0; i < s.count; i++) if (this.isRequired(i)) n++;
    this.groupNotes = new Uint32Array(n);
    this.groupOffset = new Uint32Array(n + 1);
    this.groupTime = new Float64Array(n);
    let g = -1;
    let k = 0;
    for (let i = 0; i < s.count; i++) {
      if (!this.isRequired(i)) continue;
      if (g < 0 || s.start[i] - this.groupTime[g] > CHORD_EPSILON) {
        g++;
        this.groupTime[g] = s.start[i];
        this.groupOffset[g] = k;
      }
      this.groupNotes[k++] = i;
    }
    this.groupCount = g + 1;
    this.groupOffset[this.groupCount] = k;
  }

  /** Resets note states for a seek/restart to time t. */
  resetFrom(t, resetStats = false) {
    const s = this.song;
    if (s) {
      for (let i = 0; i < s.count; i++) this.state[i] = s.start[i] >= t - 1e-6 ? NOTE_PENDING : NOTE_SKIPPED;
      this.missCursor = lowerBound(s.start, s.count, t);
    }
    this.waitIdx = lowerBound(this.groupTime, this.groupCount, t - 1e-6);
    this.expected.fill(0);
    if (resetStats) {
      this.hits = 0;
      this.misses = 0;
      this.wrong = 0;
    }
    this.version++;
  }

  groupComplete(g) {
    const end = this.groupOffset[g + 1];
    for (let k = this.groupOffset[g]; k < end; k++) {
      if (this.state[this.groupNotes[k]] !== NOTE_HIT) return false;
    }
    return true;
  }

  /** Song time the playhead must not pass (Infinity when not waiting). */
  waitTarget() {
    if (!this.waitMode || !this.practiceActive || this.waitIdx >= this.groupCount) return Infinity;
    return this.groupTime[this.waitIdx];
  }

  /** Per-frame bookkeeping. Allocation-free. */
  update(songTime, rate) {
    const s = this.song;
    if (!s) return;
    while (this.waitIdx < this.groupCount && this.groupComplete(this.waitIdx)) this.waitIdx++;

    const win = HIT_WINDOW_REAL * rate;
    const missLimit = songTime - win;
    while (this.missCursor < s.count && s.start[this.missCursor] < missLimit) {
      const i = this.missCursor;
      if (this.state[i] === NOTE_PENDING && this.isRequired(i) && !this.waitMode) {
        this.state[i] = NOTE_MISSED;
        this.misses++;
        this.version++;
      }
      this.missCursor++;
    }

    this.expected.fill(0);
    if (!this.practiceActive) return;
    const hi = songTime + win;
    for (let i = lowerBound(s.start, s.count, songTime - win); i < s.count && s.start[i] <= hi; i++) {
      if (this.state[i] === NOTE_PENDING && this.isRequired(i)) {
        this.expected[s.pitch[i]] = s.hand[i] === HAND_LEFT ? 2 : 1;
      }
    }
  }

  /**
   * Handles a physical key press. Returns the key feedback kind.
   * Wrong notes never touch the wait cursor, so the playhead cannot be corrupted.
   */
  noteOn(pitch, songTime, rate) {
    this.keyDown[pitch] = 1;
    const s = this.song;
    let kind = KEY_NEUTRAL;
    if (s && s.count > 0) {
      const win = HIT_WINDOW_REAL * rate;
      let best = -1;
      let bestDist = Infinity;
      if (this.practiceActive) {
        const hi = songTime + win;
        for (let i = lowerBound(s.start, s.count, songTime - win); i < s.count && s.start[i] <= hi; i++) {
          if (s.pitch[i] !== pitch || this.state[i] !== NOTE_PENDING || !this.isRequired(i)) continue;
          const d = Math.abs(s.start[i] - songTime);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
      }
      if (best >= 0) {
        // Mark the note, plus any duplicate of the same pitch in the same chord
        // step (e.g. both hands on C4), so a chord can never deadlock.
        const t0 = s.start[best];
        for (let i = lowerBound(s.start, s.count, t0 - CHORD_EPSILON); i < s.count && s.start[i] <= t0 + CHORD_EPSILON; i++) {
          if (s.pitch[i] === pitch && this.state[i] === NOTE_PENDING && this.isRequired(i)) {
            this.state[i] = NOTE_HIT;
            this.hits++;
          }
        }
        kind = s.hand[best] === HAND_LEFT ? KEY_HIT_LEFT : KEY_HIT_RIGHT;
        while (this.waitIdx < this.groupCount && this.groupComplete(this.waitIdx)) this.waitIdx++;
      } else if (this._isSounding(pitch, songTime, win)) {
        kind = KEY_NEUTRAL; // re-striking a note that is part of the music right now
      } else {
        kind = KEY_WRONG;
        this.wrong++;
      }
      this.version++;
    }
    this.flashKind[pitch] = kind;
    this.flashLevel[pitch] = 1;
    return kind;
  }

  _isSounding(pitch, songTime, win) {
    const s = this.song;
    const hi = songTime + win;
    for (let i = lowerBound(s.start, s.count, songTime - s.maxDur - win); i < s.count && s.start[i] <= hi; i++) {
      if (s.pitch[i] === pitch && s.end[i] >= songTime - win) return true;
    }
    return false;
  }

  noteOff(pitch) {
    this.keyDown[pitch] = 0;
  }

  allNotesOff() {
    this.keyDown.fill(0);
  }

  /** Fades key flashes after release. dt in real seconds. */
  decay(dt) {
    for (let p = 21; p <= 108; p++) {
      if (this.keyDown[p] || this.flashLevel[p] <= 0) continue;
      const rate = this.flashKind[p] === KEY_WRONG ? FLASH_DECAY_WRONG : FLASH_DECAY_HIT;
      const v = this.flashLevel[p] - dt / rate;
      if (v <= 0) {
        this.flashLevel[p] = 0;
        this.flashKind[p] = KEY_NONE;
      } else {
        this.flashLevel[p] = v;
      }
    }
  }

  accuracy() {
    const total = this.hits + this.misses + this.wrong;
    return total === 0 ? 1 : this.hits / total;
  }
}
