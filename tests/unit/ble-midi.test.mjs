// Audit vector 2: Bluetooth & latency — BLE-MIDI packet parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BleMidiParser } from '../../src/core/ble-midi.js';
import { MidiStreamParser } from '../../src/core/midi-stream.js';

function collect() {
  const out = [];
  const p = new BleMidiParser((s, a, b) => out.push([s, a, b]));
  return { p, out, parse: (bytes) => p.parse(new DataView(new Uint8Array(bytes).buffer)) };
}

test('single NoteOn after header + timestamp', () => {
  const { out, parse } = collect();
  parse([0x80, 0x80, 0x90, 60, 100]);
  assert.deepEqual(out, [[0x90, 60, 100]]);
});

test('timestamp byte equal to 0x90 is NOT read as NoteOn (ghost-note guard)', () => {
  const { out, parse } = collect();
  // header, timestamp=0x90 (looks like NoteOn status), real status NoteOff
  parse([0x80, 0x90, 0x80, 60, 64]);
  assert.deepEqual(out, [[0x80, 60, 64]]);
});

test('header with high timestamp bits set (0xBF) is stripped', () => {
  const { out, parse, p } = collect();
  parse([0xbf, 0xff, 0x90, 64, 90]);
  assert.deepEqual(out, [[0x90, 64, 90]]);
  assert.equal(p.lastTimestamp, (0x3f << 7) | 0x7f);
});

test('running status without timestamp (chord in one packet)', () => {
  const { out, parse } = collect();
  parse([0x80, 0x81, 0x90, 60, 100, 64, 101, 67, 102]);
  assert.deepEqual(out, [
    [0x90, 60, 100],
    [0x90, 64, 101],
    [0x90, 67, 102],
  ]);
});

test('running status with fresh timestamp bytes', () => {
  const { out, parse } = collect();
  parse([0x80, 0x81, 0x90, 60, 100, 0x82, 62, 0, 0x83, 64, 80]);
  assert.deepEqual(out, [
    [0x90, 60, 100],
    [0x90, 62, 0],
    [0x90, 64, 80],
  ]);
});

test('mixed statuses, each with its own timestamp', () => {
  const { out, parse } = collect();
  parse([0x80, 0x81, 0x90, 60, 100, 0x82, 0x80, 60, 0, 0x83, 0xb0, 64, 127, 0x84, 0xc0, 5]);
  assert.deepEqual(out, [
    [0x90, 60, 100],
    [0x80, 60, 0],
    [0xb0, 64, 127],
    [0xc0, 5, 0],
  ]);
});

test('realtime byte interleaved does not break running status', () => {
  const { out, parse } = collect();
  parse([0x80, 0x81, 0x90, 60, 100, 0x82, 0xf8, 0x83, 0x90, 61, 99]);
  assert.deepEqual(out, [
    [0x90, 60, 100],
    [0x90, 61, 99],
  ]);
});

test('SysEx spanning two packets is skipped, following note parsed', () => {
  const { out, parse } = collect();
  parse([0x80, 0x81, 0xf0, 0x41, 0x10, 0x42]);
  parse([0x80, 0x12, 0x40, 0x00, 0x82, 0xf7, 0x83, 0x90, 70, 80]);
  assert.deepEqual(out, [[0x90, 70, 80]]);
});

test('packet with invalid header is dropped entirely', () => {
  const { out, parse, p } = collect();
  parse([0x10, 0x90, 60, 100]);
  parse([0x90]); // too short
  assert.deepEqual(out, []);
  assert.equal(p.dropped, 2);
});

test('stray data bytes with no status never create notes', () => {
  const { out, parse } = collect();
  parse([0x80, 60, 100, 62]);
  assert.deepEqual(out, []);
});

test('accepts Uint8Array as well as DataView', () => {
  const out = [];
  const p = new BleMidiParser((s, a, b) => out.push([s, a, b]));
  p.parse(new Uint8Array([0x80, 0x80, 0x90, 48, 70]));
  assert.deepEqual(out, [[0x90, 48, 70]]);
});

test('USB stream parser: running status and realtime interleave', () => {
  const out = [];
  const p = new MidiStreamParser((s, a, b) => out.push([s, a, b]));
  p.feed([0x90, 60, 100, 0xf8, 62, 101, 0x80, 60, 0, 0xfe, 62, 0]);
  assert.deepEqual(out, [
    [0x90, 60, 100],
    [0x90, 62, 101],
    [0x80, 60, 0],
    [0x80, 62, 0],
  ]);
});

test('USB stream parser: message split across feeds', () => {
  const out = [];
  const p = new MidiStreamParser((s, a, b) => out.push([s, a, b]));
  p.feed([0x91]);
  p.feed([65]);
  p.feed([90, 0xf0, 1, 2, 3, 0xf7, 0x81, 65, 0]);
  assert.deepEqual(out, [
    [0x91, 65, 90],
    [0x81, 65, 0],
  ]);
});
