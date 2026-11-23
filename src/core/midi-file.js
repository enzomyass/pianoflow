// Standalone Standard MIDI File (SMF) parser and writer.
// - Formats 0, 1 and 2, PPQ and SMPTE time division, RIFF/RMID wrappers.
// - Running status, meta events, SysEx (F0/F7) skipping.
// - Full tempo map: ticks are converted to absolute seconds across tempo changes.
// - NoteOn velocity 0 is treated as NoteOff; overlapping same-pitch notes pair FIFO.

export class MidiFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MidiFormatError';
  }
}

function readStr(b, p, n) {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}
function u32(b, p) {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}
function u16(b, p) {
  return (b[p] << 8) | b[p + 1];
}
function u32le(b, p) {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

/** Resolves an RMID (RIFF) wrapper; returns offset of the MThd chunk. */
function findHeaderOffset(b) {
  if (readStr(b, 0, 4) === 'MThd') return 0;
  if (readStr(b, 0, 4) === 'RIFF' && readStr(b, 8, 4) === 'RMID') {
    let p = 12;
    while (p + 8 <= b.length) {
      const id = readStr(b, p, 4);
      const size = u32le(b, p + 4);
      if (id === 'data') return p + 8;
      p += 8 + size + (size & 1);
    }
  }
  // Some files have junk before the header; scan the first 4 KB.
  const limit = Math.min(b.length - 4, 4096);
  for (let p = 0; p < limit; p++) {
    if (b[p] === 0x4d && b[p + 1] === 0x54 && b[p + 2] === 0x68 && b[p + 3] === 0x64) return p;
  }
  throw new MidiFormatError('Not a MIDI file (missing MThd header)');
}

function parseTrack(b, start, end, index) {
  const notes = [];
  const tempos = [];
  const open = new Map(); // (channel << 7 | pitch) -> array of {tick, vel}
  let name = '';
  let p = start;
  let tick = 0;
  let running = 0;
  let endTick = 0;

  const readVLQ = () => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (p >= end) throw new MidiFormatError('Truncated variable-length value');
      const c = b[p++];
      value = (value << 7) | (c & 0x7f);
      if (!(c & 0x80)) return value;
    }
    throw new MidiFormatError('Variable-length value longer than 4 bytes');
  };

  const closeNote = (ch, pitch, atTick) => {
    const key = (ch << 7) | pitch;
    const stack = open.get(key);
    if (!stack || stack.length === 0) return;
    const on = stack.shift();
    notes.push({ channel: ch, pitch, velocity: on.vel, startTick: on.tick, endTick: Math.max(atTick, on.tick) });
  };

  try {
    while (p < end) {
      tick += readVLQ();
      if (p >= end) break;
      let status = b[p];
      if (status & 0x80) {
        p++;
      } else {
        if (!running) throw new MidiFormatError('Data byte without running status');
        status = running;
      }

      if (status === 0xff) {
        const type = b[p++];
        const len = readVLQ();
        const dataStart = p;
        p += len;
        if (p > end) break;
        if (type === 0x51 && len === 3) {
          const uspq = (b[dataStart] << 16) | (b[dataStart + 1] << 8) | b[dataStart + 2];
          if (uspq > 0) tempos.push({ tick, uspq });
        } else if ((type === 0x03 || type === 0x04) && !name) {
          name = readStr(b, dataStart, len).replace(/\0/g, '').trim();
        } else if (type === 0x2f) {
          endTick = tick;
          break;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const len = readVLQ();
        p += len;
      } else if (status >= 0xf1) {
        // System common/realtime should not appear in files; skip known lengths.
        if (status === 0xf2) p += 2;
        else if (status === 0xf1 || status === 0xf3) p += 1;
      } else {
        running = status;
        const hi = status & 0xf0;
        const ch = status & 0x0f;
        const d1 = b[p++] & 0x7f;
        let d2 = 0;
        if (hi !== 0xc0 && hi !== 0xd0) d2 = b[p++] & 0x7f;
        if (p > end) break;
        if (hi === 0x90 && d2 > 0) {
          const key = (ch << 7) | d1;
          let stack = open.get(key);
          if (!stack) {
            stack = [];
            open.set(key, stack);
          }
          stack.push({ tick, vel: d2 });
        } else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
          closeNote(ch, d1, tick);
        }
      }
    }
  } catch (err) {
    // A corrupt tail should not discard everything already parsed.
    if (notes.length === 0 && open.size === 0) throw err;
  }

  if (tick > endTick) endTick = tick;
  // Close notes left hanging at end of track.
  for (const [key, stack] of open) {
    for (const on of stack) {
      notes.push({ channel: key >> 7, pitch: key & 0x7f, velocity: on.vel, startTick: on.tick, endTick: Math.max(endTick, on.tick + 1) });
    }
  }
  return { index, name, notes, tempos, endTick };
}

/** Converts ticks to seconds across a tempo map. */
export class TempoMap {
  constructor(division, tempos) {
    this.smpte = (division & 0x8000) !== 0;
    if (this.smpte) {
      let fps = 256 - (division >> 8);
      if (fps === 29) fps = 29.97;
      const tpf = division & 0xff || 1;
      this.ppq = 0;
      this.secPerTickSmpte = 1 / (fps * tpf);
      this.ticks = [0];
      this.secs = [0];
      this.spt = [this.secPerTickSmpte];
      this.bpm = [120];
      return;
    }
    this.ppq = division || 480;
    const sorted = tempos.slice().sort((a, b) => a.tick - b.tick);
    const merged = [];
    for (const t of sorted) {
      if (merged.length && merged[merged.length - 1].tick === t.tick) merged[merged.length - 1] = t;
      else merged.push(t);
    }
    if (!merged.length || merged[0].tick !== 0) merged.unshift({ tick: 0, uspq: 500000 });
    this.ticks = [];
    this.secs = [];
    this.spt = [];
    this.bpm = [];
    let sec = 0;
    for (let i = 0; i < merged.length; i++) {
      const t = merged[i];
      if (i > 0) {
        const prev = merged[i - 1];
        sec += (t.tick - prev.tick) * (prev.uspq / 1e6 / this.ppq);
      }
      this.ticks.push(t.tick);
      this.secs.push(sec);
      this.spt.push(t.uspq / 1e6 / this.ppq);
      this.bpm.push(60e6 / t.uspq);
    }
  }

  toSeconds(tick) {
    const ticks = this.ticks;
    let lo = 0;
    let hi = ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (ticks[mid] <= tick) lo = mid;
      else hi = mid - 1;
    }
    return this.secs[lo] + (tick - ticks[lo]) * this.spt[lo];
  }
}

/**
 * Parses a Standard MIDI File.
 * @param {ArrayBuffer|Uint8Array} input
 */
export function parseMidi(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 14) throw new MidiFormatError('File is too small to be a MIDI file');
  const h = findHeaderOffset(b);
  const hdrLen = u32(b, h + 4);
  if (hdrLen < 6) throw new MidiFormatError('Invalid MIDI header length');
  const format = u16(b, h + 8);
  const division = u16(b, h + 12);

  const rawTracks = [];
  let p = h + 8 + hdrLen;
  while (p + 8 <= b.length) {
    const id = readStr(b, p, 4);
    const len = u32(b, p + 4);
    const dataStart = p + 8;
    const dataEnd = Math.min(dataStart + len, b.length);
    if (id === 'MTrk') rawTracks.push(parseTrack(b, dataStart, dataEnd, rawTracks.length));
    p = dataStart + len;
  }
  if (!rawTracks.length) throw new MidiFormatError('MIDI file contains no tracks');

  const allTempos = [];
  for (const t of rawTracks) for (const tp of t.tempos) allTempos.push(tp);
  const tempoMap = new TempoMap(division, allTempos);

  let duration = 0;
  const tracks = rawTracks.map((t) => {
    const channels = new Set();
    const notes = t.notes.map((n) => {
      channels.add(n.channel);
      const start = tempoMap.toSeconds(n.startTick);
      let end = tempoMap.toSeconds(n.endTick);
      if (end - start < 0.03) end = start + 0.03; // keep zero-length notes visible/playable
      if (end > duration) duration = end;
      return { pitch: n.pitch, velocity: n.velocity, channel: n.channel, start, end };
    });
    notes.sort((a, c) => a.start - c.start || a.pitch - c.pitch);
    const endSec = tempoMap.toSeconds(t.endTick);
    if (endSec > duration) duration = endSec;
    return { index: t.index, name: t.name, notes, channels };
  });

  const tempos = tempoMap.ticks.map((tick, i) => ({ time: tempoMap.secs[i], bpm: tempoMap.bpm[i] }));
  return { format, division, ppq: tempoMap.ppq, tracks, tempos, duration, tempoMap };
}

// ---------------------------------------------------------------------------
// Writer (used for the built-in demo song and for tests)
// ---------------------------------------------------------------------------

function pushVLQ(out, value) {
  const stack = [value & 0x7f];
  value >>>= 7;
  while (value > 0) {
    stack.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
}

function pushTrack(out, events) {
  const body = [];
  let lastTick = 0;
  let running = 0;
  for (const ev of events) {
    pushVLQ(body, ev.tick - lastTick);
    lastTick = ev.tick;
    if (ev.meta !== undefined) {
      body.push(0xff, ev.meta);
      pushVLQ(body, ev.data.length);
      for (const x of ev.data) body.push(x);
      running = 0;
    } else {
      if (!(ev.runningStatus && ev.status === running)) body.push(ev.status);
      running = ev.status;
      for (const x of ev.data) body.push(x);
    }
  }
  pushVLQ(body, 0);
  body.push(0xff, 0x2f, 0x00);
  out.push(0x4d, 0x54, 0x72, 0x6b);
  const len = body.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  for (const x of body) out.push(x);
}

function textBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

/**
 * Writes a format-1 SMF.
 * @param {{ppq?:number, tempos?:{tick:number,bpm:number}[], runningStatus?:boolean, noteOffAsZeroVelocity?:boolean,
 *          tracks:{name?:string, notes:{pitch:number,tick:number,dur:number,vel?:number,ch?:number}[]}[]}} song
 * @returns {Uint8Array}
 */
export function writeMidi(song) {
  const ppq = song.ppq || 480;
  const out = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1];
  const ntrks = song.tracks.length + 1;
  out.push((ntrks >> 8) & 0xff, ntrks & 0xff, (ppq >> 8) & 0xff, ppq & 0xff);

  const conductor = [{ tick: 0, meta: 0x03, data: textBytes('Conductor') }];
  for (const t of song.tempos || [{ tick: 0, bpm: 120 }]) {
    const uspq = Math.round(60e6 / t.bpm);
    conductor.push({ tick: t.tick, meta: 0x51, data: [(uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff] });
  }
  conductor.sort((a, b) => a.tick - b.tick);
  pushTrack(out, conductor);

  for (const track of song.tracks) {
    const events = [];
    if (track.name) events.push({ tick: 0, order: -1, meta: 0x03, data: textBytes(track.name) });
    for (const n of track.notes) {
      const ch = (n.ch || 0) & 0x0f;
      const vel = n.vel === undefined ? 90 : n.vel;
      events.push({ tick: n.tick, order: 1, status: 0x90 | ch, data: [n.pitch, vel], runningStatus: song.runningStatus });
      if (song.noteOffAsZeroVelocity) {
        events.push({ tick: n.tick + n.dur, order: 0, status: 0x90 | ch, data: [n.pitch, 0], runningStatus: song.runningStatus });
      } else {
        events.push({ tick: n.tick + n.dur, order: 0, status: 0x80 | ch, data: [n.pitch, 64], runningStatus: song.runningStatus });
      }
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    pushTrack(out, events);
  }
  return new Uint8Array(out);
}
