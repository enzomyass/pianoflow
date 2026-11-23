// Look-ahead scheduler: turns song notes into synth notes on the AudioContext
// clock. Song→audio time mapping comes from the Transport anchor, so scheduled
// audio and drawn notes share one clock and cannot drift apart.

import { HAND_LEFT, HAND_RIGHT, lowerBound, upperBound } from '../core/constants.js';

const LOOKAHEAD_REAL = 0.12; // seconds of audio scheduled ahead
const LATE_TOLERANCE = 0.06; // song notes later than this are dropped, not bunched

export class PlaybackScheduler {
  constructor(synth, transport) {
    this.synth = synth;
    this.transport = transport;
    this.song = null;
    this.idx = 0;
    this.muted = new Uint8Array(3); // per hand: 1 = synth does not play it
  }

  setSong(song) {
    this.song = song;
    this.idx = 0;
  }

  setMuted(rightMuted, leftMuted) {
    this.muted[HAND_RIGHT] = rightMuted ? 1 : 0;
    this.muted[HAND_LEFT] = leftMuted ? 1 : 0;
  }

  /** Hard reset (seek, pause, song change): silence and restart at t, inclusive. */
  reset(t) {
    this.synth.stopAll();
    this.idx = this.song ? lowerBound(this.song.start, this.song.count, t) : 0;
  }

  /** Tempo change: drop not-yet-started notes and reschedule them with the new rate. */
  retime(t) {
    this.synth.cancelPending();
    this.idx = this.song ? upperBound(this.song.start, this.song.count, t) : 0;
  }

  update() {
    const s = this.song;
    const tr = this.transport;
    if (!s || !tr.playing || !tr.usingAudioClock || !this.synth.isRunning()) return;
    const songTime = tr.songTime;
    // Never schedule at or past a wait-mode barrier.
    let horizon = songTime + LOOKAHEAD_REAL * tr.rate;
    if (tr.hold < horizon) horizon = tr.hold;
    while (this.idx < s.count && s.start[this.idx] < horizon) {
      const i = this.idx++;
      if (this.muted[s.hand[i]]) continue;
      if (s.start[i] < songTime - LATE_TOLERANCE * tr.rate) continue;
      const when = tr.realTimeFor(s.start[i]);
      this.synth.playNote(s.pitch[i], s.velocity[i], when, (s.end[i] - s.start[i]) / tr.rate);
    }
  }
}
