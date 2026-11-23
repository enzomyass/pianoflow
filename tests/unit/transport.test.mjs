// Audit vector 1: Timing & desync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../../src/core/transport.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' !≈ ' + b);

function harness() {
  const clock = { t: 0, running: true };
  const tr = new Transport(() => (clock.running ? clock.t : null));
  tr.duration = 1000;
  let raf = 0;
  const frame = (dtSec) => {
    clock.t += dtSec;
    raf += dtSec * 1000;
    tr.tick(raf);
  };
  return { clock, tr, frame };
}

test('no drift over 10 minutes of jittery frames', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.play();
  let total = 0;
  let seed = 7;
  for (let i = 0; i < 36000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const dt = 1 / 60 + ((seed % 1000) / 1000 - 0.5) * 0.008; // ±4 ms jitter
    total += dt;
    frame(dt);
  }
  close(tr.songTime, total, 1e-6);
});

test('tempo changes re-anchor: song time is the exact integral of rate', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.play();
  for (let i = 0; i < 60; i++) frame(1 / 60); // 1 s @1x
  tr.setRate(0.5);
  for (let i = 0; i < 120; i++) frame(1 / 60); // 2 s @0.5x
  tr.setRate(2);
  for (let i = 0; i < 30; i++) frame(1 / 60); // 0.5 s @2x
  close(tr.songTime, 1 + 1 + 1, 1e-9);
});

test('pause freezes time; resume continues without a jump', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.play();
  for (let i = 0; i < 60; i++) frame(1 / 60);
  tr.pause();
  const frozen = tr.songTime;
  for (let i = 0; i < 300; i++) frame(1 / 60);
  close(tr.songTime, frozen);
  tr.play();
  frame(0.25);
  close(tr.songTime, frozen + 0.25);
});

test('scrubbing while playing lands exactly on the target', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.play();
  frame(0.5);
  tr.seek(42);
  close(tr.songTime, 42);
  frame(0.1);
  close(tr.songTime, 42.1);
  tr.seek(3);
  frame(0.2);
  close(tr.songTime, 3.2);
});

test('wait-mode hold freezes exactly at the barrier and resumes from it', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.setHold(1.0);
  tr.play();
  for (let i = 0; i < 120; i++) frame(1 / 60); // 2 s wall clock
  close(tr.songTime, 1.0);
  assert.equal(tr.held, true);
  frame(5); // long wait
  close(tr.songTime, 1.0);
  tr.setHold(Infinity); // chord played
  frame(0.25);
  close(tr.songTime, 1.25);
  assert.equal(tr.held, false);
});

test('tempo change while held does not jump on release', () => {
  const { tr, frame } = harness();
  tr.tick(0);
  tr.setHold(0.5);
  tr.play();
  frame(1);
  close(tr.songTime, 0.5);
  tr.setRate(0.25);
  frame(1);
  tr.setHold(Infinity);
  frame(1);
  close(tr.songTime, 0.75);
});

test('audio clock suspended → frame clock fallback with no jump, 100 ms clamp', () => {
  const { clock, tr, frame } = harness();
  tr.tick(0);
  tr.play();
  frame(1);
  close(tr.songTime, 1);
  clock.running = false; // AudioContext suspended
  frame(1 / 60);
  frame(1 / 60);
  close(tr.songTime, 1 + 2 / 60, 1e-6);
  frame(3); // 3 s stall (tab in background) clamps to 0.1 s
  close(tr.songTime, 1 + 2 / 60 + 0.1, 1e-6);
  clock.running = true;
  clock.t += 50; // audio clock moved on meanwhile
  frame(1 / 60);
  const t = tr.songTime;
  frame(0.5);
  close(tr.songTime, t + 0.5, 1e-6);
  assert.ok(t < 1.2, 'switching back to audio must not jump: ' + t);
});

test('realTimeFor maps song time to the audio clock exactly', () => {
  const { tr, frame, clock } = harness();
  tr.tick(0);
  tr.play();
  tr.setRate(0.5);
  frame(2);
  const target = tr.songTime + 1; // 1 song second ahead at 0.5x = 2 real s
  close(tr.realTimeFor(target), clock.t + 2, 1e-9);
});
