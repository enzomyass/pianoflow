import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, writeMidi, MidiFormatError } from '../../src/core/midi-file.js';
import { buildSong } from '../../src/core/song.js';
import { buildDemoMidi } from '../../src/demo/demo-song.js';
import { HAND_LEFT, HAND_RIGHT } from '../../src/core/constants.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' !≈ ' + b);

test('roundtrip with tempo change converts ticks to seconds correctly', () => {
  const bytes = writeMidi({
    ppq: 480,
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 960, bpm: 60 },
    ],
    tracks: [
      {
        name: 'Right Hand',
        notes: [
          { pitch: 60, tick: 0, dur: 480 },
          { pitch: 64, tick: 960, dur: 480 },
          { pitch: 67, tick: 1440, dur: 240 },
        ],
      },
    ],
  });
  const m = parseMidi(bytes.buffer);
  assert.equal(m.ppq, 480);
  const notes = m.tracks[1].notes;
  assert.equal(notes.length, 3);
  close(notes[0].start, 0);
  close(notes[0].end, 0.5); // 480 ticks @120bpm
  close(notes[1].start, 1.0); // 960 ticks @120bpm
  close(notes[1].end, 2.0); // +480 ticks @60bpm
  close(notes[2].start, 2.0);
  close(notes[2].end, 2.5);
  assert.equal(m.tracks[1].name, 'Right Hand');
});

test('running status and velocity-0 NoteOff', () => {
  const bytes = writeMidi({
    runningStatus: true,
    noteOffAsZeroVelocity: true,
    tracks: [{ notes: [{ pitch: 60, tick: 0, dur: 100 }, { pitch: 62, tick: 0, dur: 200 }, { pitch: 64, tick: 50, dur: 50 }] }],
  });
  const m = parseMidi(bytes);
  const notes = m.tracks[1].notes;
  assert.equal(notes.length, 3);
  assert.deepEqual(notes.map((n) => n.pitch), [60, 62, 64]);
});

test('overlapping same-pitch notes pair FIFO', () => {
  // Hand-built track: On60 @0, On60 @100, Off60 @200, Off60 @300
  const track = [0x00, 0x90, 60, 100, 0x64, 0x90, 60, 90, 0x64, 0x80, 60, 0, 0x64, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00];
  const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
  const m = parseMidi(bytes);
  const n = m.tracks[0].notes;
  assert.equal(n.length, 2);
  assert.equal(n[0].velocity, 100);
  close(n[0].end - n[0].start, (200 / 480) * 0.5);
});

test('SMPTE division', () => {
  // -25 fps (0xE7), 40 ticks/frame → 1000 ticks/second
  const track = [0x00, 0x90, 60, 100, 0x87, 0x68, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00]; // delta 1000
  const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 40, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
  const m = parseMidi(bytes);
  close(m.tracks[0].notes[0].end, 1.0);
});

test('rejects non-MIDI data', () => {
  assert.throws(() => parseMidi(new Uint8Array(64)), MidiFormatError);
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3])), MidiFormatError);
});

test('truncated file keeps notes parsed so far', () => {
  const full = writeMidi({ tracks: [{ notes: [{ pitch: 60, tick: 0, dur: 480 }, { pitch: 62, tick: 480, dur: 480 }] }] });
  const cut = full.slice(0, full.length - 6);
  const m = parseMidi(cut);
  assert.ok(m.tracks[1].notes.length >= 1);
});

test('demo song: two hands, tempo change, all notes in range', () => {
  const song = buildSong(parseMidi(buildDemoMidi()), 'demo');
  assert.ok(song.count > 60);
  assert.ok(song.handCounts[HAND_RIGHT] > 0 && song.handCounts[HAND_LEFT] > 0);
  assert.equal(song.outOfRange, 0);
  assert.equal(song.tempos.length, 2);
  for (let i = 1; i < song.count; i++) assert.ok(song.start[i] >= song.start[i - 1], 'sorted');
});

test('single-track file splits hands at middle C', () => {
  const bytes = writeMidi({ tracks: [{ notes: [{ pitch: 72, tick: 0, dur: 100 }, { pitch: 48, tick: 0, dur: 100 }] }] });
  const song = buildSong(parseMidi(bytes), 'x');
  const hands = {};
  for (let i = 0; i < song.count; i++) hands[song.pitch[i]] = song.hand[i];
  assert.equal(hands[72], HAND_RIGHT);
  assert.equal(hands[48], HAND_LEFT);
});
