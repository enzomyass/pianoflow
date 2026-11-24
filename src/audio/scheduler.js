// Look-ahead scheduler: turns song notes (and metronome beats) into synth
// events on the AudioContext clock. The song→audio mapping comes from the
// Transport anchor, so scheduled audio and drawn notes share one clock.
//
// Output-latency compensation: Bluetooth speakers (e.g. a piano used as a
// Bluetooth speaker) play sound 150–300 ms after it is scheduled. Every event
// is scheduled `latency` seconds early so it is HEARD when the note reaches
// the strike line.

import { HAND_LEFT, HAND_RIGHT, lowerBound, upperBound } from '../core/constants.js';

const LOOKAHEAD_REAL = 0.12; // seconds of audio scheduled ahead (beyond latency)
const LATE_TOLERANCE = 0.06; // song notes later than this are dropped, not bunched

export class PlaybackScheduler {
  constructor(synth, transport) {
    this.synth = synth;
    this.transport = transport;
    this.song = null;
    this.idx = 0;
    this.muted = new Uint8Array(3); // per hand: 1 = synth does not play it
    this.allMuted = false;
    this.beats = null; // {time, accent, count}
    this.beatIdx = 0;
    this.metronome = false;
    this.end = Infinity; // do not schedule at/after this song time (loop end)
  }

  setSong(song) {
    this.song = song;
    this.idx = 0;
  }

  setBeats(beats) {
    this.beats = beats;
    this.beatIdx = 0;
  }

  setMuted(rightMuted, leftMuted) {
    this.muted[HAND_RIGHT] = rightMuted ? 1 : 0;
    this.muted[HAND_LEFT] = leftMuted ? 1 : 0;
  }

  _seekIdx(t, inclusive) {
    const s = this.song;
    this.idx = s ? (inclusive ? lowerBound(s.start, s.count, t) : upperBound(s.start, s.count, t)) : 0;
    const b = this.beats;
    this.beatIdx = b ? (inclusive ? lowerBound(b.time, b.count, t) : upperBound(b.time, b.count, t)) : 0;
  }

  /** Hard reset (seek, pause, song change): silence and restart at t, inclusive. */
  reset(t) {
    this.synth.stopAll();
    this._seekIdx(t, true);
  }

  /** Tempo/latency change: drop not-yet-started notes and reschedule them. */
  retime(t) {
    this.synth.cancelPending();
    this._seekIdx(t, false);
  }

  update() {
    const tr = this.transport;
    if (!tr.playing || !tr.usingAudioClock || !this.synth.isRunning()) return;
    const lat = this.synth.latency();
    const songTime = tr.songTime;
    const now = this.synth.ctx.currentTime;
    // Never schedule at or past a wait-mode barrier or the loop end.
    let horizon = songTime + (LOOKAHEAD_REAL + lat) * tr.rate;
    if (tr.hold < horizon) horizon = tr.hold;
    if (this.end < horizon) horizon = this.end;

    const s = this.song;
    if (s && !this.allMuted) {
      while (this.idx < s.count && s.start[this.idx] < horizon) {
        const i = this.idx++;
        if (this.muted[s.hand[i]]) continue;
        const when = tr.realTimeFor(s.start[i]) - lat;
        if (when < now - LATE_TOLERANCE) continue;
        this.synth.playNote(s.pitch[i], s.velocity[i], when, (s.end[i] - s.start[i]) / tr.rate);
      }
    } else if (s) {
      while (this.idx < s.count && s.start[this.idx] < horizon) this.idx++;
    }

    const b = this.beats;
    if (b) {
      while (this.beatIdx < b.count && b.time[this.beatIdx] < horizon) {
        const i = this.beatIdx++;
        if (!this.metronome) continue;
        const when = tr.realTimeFor(b.time[i]) - lat;
        if (when < now - LATE_TOLERANCE) continue;
        this.synth.click(when, b.accent[i] === 1);
      }
    }
  }
}
