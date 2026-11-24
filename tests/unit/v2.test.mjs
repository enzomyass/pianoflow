// v2 logic: tutor, progress, beat grid, take song, transcription, latency scheduling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMidi, parseMidi } from '../../src/core/midi-file.js';
import { buildSong, buildBeatGrid, buildTakeSong } from '../../src/core/song.js';
import { Tutor, buildPhrases } from '../../src/core/tutor.js';
import { Progress } from '../../src/core/progress.js';
import { transcribeAudio } from '../../src/core/transcribe.js';
import { PlaybackScheduler } from '../../src/audio/scheduler.js';
import { Transport } from '../../src/core/transport.js';
import { buildDemoMidi } from '../../src/demo/demo-song.js';

const demo = () => buildSong(parseMidi(buildDemoMidi()), 'demo');

test('phrases: ≤6 chord steps, ordered, non-overlapping, both hands detected', () => {
  const s = demo();
  const ph = buildPhrases(s, 0, s.duration + 1);
  assert.ok(ph.length >= 5);
  for (let i = 0; i < ph.length; i++) {
    assert.ok(ph[i].steps <= 6);
    assert.ok(ph[i].end > ph[i].start);
    if (i) assert.ok(ph[i].start >= ph[i - 1].end);
  }
  assert.ok(ph[0].hasR && ph[0].hasL);
});

test('tutor: perfect passes walk listen → right → left → together → tempo(80→90→100%) → next phrase → link', () => {
  const s = demo();
  const t = new Tutor();
  let plan = t.start(s, 0, s.duration + 1);
  const seq = [];
  const clean = { hits: 10, misses: 0, wrong: 0, worstPitch: -1 };
  for (let i = 0; i < 16 && plan; i++) {
    seq.push(plan.phrase + ':' + plan.stage + '@' + plan.rate);
    plan = t.passComplete(clean);
  }
  assert.deepEqual(seq.slice(0, 13), [
    '1:listen@0.85', '1:right@0.7', '1:left@0.7', '1:together@0.75', '1:tempo@0.8', '1:tempo@0.9', '1:tempo@1',
    '2:listen@0.85', '2:right@0.7', '2:left@0.7', '2:together@0.75', '2:tempo@0.8', '2:tempo@0.9',
  ]);
  assert.ok(seq.includes('2:link@0.85'));
});

test('tutor: hand flags per stage (listen plays all; right/left isolate)', () => {
  const s = demo();
  const t = new Tutor();
  let p = t.start(s, 0, s.duration + 1);
  assert.deepEqual([p.right, p.left, p.wait], [false, false, false]);
  p = t.passComplete({ hits: 0, misses: 0, wrong: 0, worstPitch: -1 });
  assert.deepEqual([p.stage, p.right, p.left, p.wait], ['right', true, false, true]);
  p = t.passComplete({ hits: 5, misses: 0, wrong: 0, worstPitch: -1 });
  assert.deepEqual([p.stage, p.right, p.left], ['left', false, true]);
});

test('tutor: mistakes repeat with a hint naming the trouble note, then slow down', () => {
  const s = demo();
  const t = new Tutor();
  t.start(s, 0, s.duration + 1);
  let p = t.passComplete({ hits: 0, misses: 0, wrong: 0, worstPitch: -1 }); // → right
  const bad = { hits: 3, misses: 0, wrong: 4, worstPitch: 66 };
  p = t.passComplete(bad);
  assert.equal(p.stage, 'right');
  assert.equal(p.attempt, 2);
  assert.match(p.message, /F#4/);
  p = t.passComplete(bad);
  p = t.passComplete(bad); // 4th attempt → slowed
  assert.ok(p.rate < 0.7, 'slowed to ' + p.rate);
  p = t.skip();
  assert.equal(p.stage, 'left');
});

test('tutor: finishes with null after the last phrase', () => {
  const s = demo();
  const t = new Tutor();
  let p = t.start(s, 0, 4);
  let n = 0;
  while (p && n++ < 50) p = t.passComplete({ hits: 5, misses: 0, wrong: 0, worstPitch: -1 });
  assert.equal(p, null);
  assert.equal(t.active, false);
});

test('progress: time, best score, daily streak', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const pr = new Progress(storage);
  const day = (d) => new Date(2026, 10, d, 12);
  pr.addTime('s1', 120, day(20));
  pr.addTime('s1', 90, day(21));
  pr.addTime('s1', 30, day(22)); // under 60 s: not a streak day yet
  assert.equal(pr.streak(day(22)), 2); // counts back from yesterday
  pr.addTime('s1', 40, day(22));
  assert.equal(pr.streak(day(22)), 3);
  assert.equal(pr.finish('s1', 0.8, 10), true);
  assert.equal(pr.finish('s1', 0.7, 12), false);
  assert.equal(pr.song('s1').best, 80);
  assert.equal(pr.song('s1').bestCombo, 12);
  const again = new Progress(storage);
  assert.equal(again.song('s1').best, 80);
});

test('beat grid follows tempo changes and time signature accents', () => {
  const bytes = writeMidi({ ppq: 480, tempos: [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 60 }], tracks: [{ notes: [{ pitch: 60, tick: 0, dur: 3840 }] }] });
  const parsed = parseMidi(bytes);
  const g = buildBeatGrid(parsed, 4);
  assert.deepEqual(Array.from(g.time.slice(0, 7)), [0, 0.5, 1, 1.5, 2, 3, 4]);
  assert.deepEqual(Array.from(g.accent.slice(0, 7)), [1, 0, 0, 0, 1, 0, 0]);
});

test('take song: sorted typed arrays with minimum duration', () => {
  const tk = buildTakeSong([{ pitch: 64, start: 2, end: 2.5, velocity: 80 }, { pitch: 60, start: 1, end: 1.01, velocity: 70 }]);
  assert.equal(tk.count, 2);
  assert.equal(tk.pitch[0], 60);
  assert.ok(tk.end[0] - tk.start[0] >= 0.03);
});

test('transcription: finds a C-major arpeggio + chord in synthetic piano audio', async () => {
  const sr = 16000;
  const ref = [
    { p: 60, t: 0.2 }, { p: 64, t: 0.6 }, { p: 67, t: 1.0 }, { p: 72, t: 1.4 },
    { p: 48, t: 2.0 }, { p: 60, t: 2.0 }, { p: 64, t: 2.0 }, { p: 67, t: 2.0 },
  ];
  const out = new Float32Array(sr * 3.5);
  for (const n of ref) {
    const f0 = 440 * 2 ** ((n.p - 69) / 12);
    const s0 = Math.floor(n.t * sr);
    for (let h = 1; h <= 10; h++) {
      if (f0 * h > 7600) break;
      for (let i = 0; i < sr * 1.2 && s0 + i < out.length; i++) out[s0 + i] += (0.12 / h) * Math.exp(-i / sr / (0.9 / (1 + 0.2 * h))) * Math.sin((2 * Math.PI * f0 * h * i) / sr);
    }
  }
  const res = await transcribeAudio(out, sr);
  let tp = 0;
  for (const n of ref) if (res.notes.some((e) => e.pitch === n.p && Math.abs(e.start - n.t) < 0.07)) tp++;
  assert.ok(tp >= 7, 'found ' + tp + '/8: ' + JSON.stringify(res.notes.map((n) => [n.pitch, +n.start.toFixed(2)])));
  assert.ok(res.notes.length <= 11, 'too many false notes: ' + res.notes.length);
});

test('scheduler: notes and clicks are scheduled `latency` seconds early', () => {
  const calls = [];
  const clock = { t: 10 };
  const synth = {
    ctx: { get currentTime() { return clock.t; } },
    isRunning: () => true,
    latency: () => 0.25,
    playNote: (p, v, when) => calls.push(['n', p, when]),
    click: (when) => calls.push(['c', when]),
    stopAll() {},
    cancelPending() {},
  };
  const tr = new Transport(() => clock.t);
  tr.duration = 100;
  tr.tick(0);
  const sc = new PlaybackScheduler(synth, tr);
  const s = buildTakeSong([{ pitch: 60, start: 1.0, end: 1.5, velocity: 90 }]);
  sc.setSong(s);
  sc.setBeats({ time: Float64Array.from([1.0]), accent: Uint8Array.from([1]), count: 1 });
  sc.metronome = true;
  tr.seek(0.7);
  tr.play();
  tr.tick(16);
  sc.update();
  // song 1.0 is 0.3 s ahead of the playhead; with 0.25 s latency both events are due now
  const n = calls.find((c) => c[0] === 'n');
  const c = calls.find((c) => c[0] === 'c');
  assert.ok(n && c, JSON.stringify(calls));
  assert.ok(Math.abs(n[2] - (tr.realTimeFor(1.0) - 0.25)) < 1e-9);
  assert.ok(Math.abs(c[1] - (tr.realTimeFor(1.0) - 0.25)) < 1e-9);
});
