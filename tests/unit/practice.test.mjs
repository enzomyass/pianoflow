// Audit vector 4: Note detection, chords, red flash, wait-mode playhead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMidi, parseMidi } from '../../src/core/midi-file.js';
import { buildSong } from '../../src/core/song.js';
import { Transport } from '../../src/core/transport.js';
import { PracticeEngine, KEY_WRONG, KEY_HIT_RIGHT, KEY_HIT_LEFT, KEY_NEUTRAL, NOTE_HIT, NOTE_MISSED } from '../../src/core/practice.js';

// 120 bpm, ppq 480 → 480 ticks = 0.5 s
function makeSong() {
  return buildSong(
    parseMidi(
      writeMidi({
        tempos: [{ tick: 0, bpm: 120 }],
        tracks: [
          {
            name: 'Right Hand',
            notes: [
              { pitch: 64, tick: 960, dur: 400 }, // t=1.0 chord step 1 (RH part)
              { pitch: 67, tick: 960, dur: 400 },
              { pitch: 72, tick: 1920, dur: 400 }, // t=2.0
              { pitch: 60, tick: 2880, dur: 400 }, // t=3.0 C4 in both hands
            ],
          },
          {
            name: 'Left Hand',
            notes: [
              { pitch: 48, tick: 960, dur: 800 }, // t=1.0 (LH part of chord)
              { pitch: 60, tick: 2880, dur: 400 }, // t=3.0 duplicate C4
              { pitch: 10, tick: 1920, dur: 200 }, // out of 88-key range: must never block
            ],
          },
        ],
      }),
    ),
    'test',
  );
}

function setup(wait = true) {
  const song = makeSong();
  const clock = { t: 0 };
  const tr = new Transport(() => clock.t);
  tr.duration = song.duration;
  const pr = new PracticeEngine();
  pr.setSong(song);
  pr.setPracticeHands(true, true, 0);
  pr.setWaitMode(wait, 0);
  let raf = 0;
  const frame = (dt) => {
    clock.t += dt;
    raf += dt * 1000;
    tr.setHold(pr.waitTarget());
    tr.tick(raf);
    pr.update(tr.songTime, tr.rate);
    tr.setHold(pr.waitTarget());
  };
  tr.tick(0);
  return { song, tr, pr, frame, press: (p) => {
    const k = pr.noteOn(p, tr.songTime, tr.rate);
    tr.setHold(pr.waitTarget());
    pr.noteOff(p);
    return k;
  } };
}

test('chord groups: same-time notes across hands form one step; out-of-range note excluded', () => {
  const { pr } = setup();
  assert.equal(pr.groupCount, 3); // t=1 (64,67,48), t=2 (72), t=3 (60,60)
  assert.equal(pr.groupOffset[1] - pr.groupOffset[0], 3);
});

test('wait mode freezes at the chord until every key is pressed', () => {
  const { tr, pr, frame, press } = setup();
  tr.play();
  for (let i = 0; i < 180; i++) frame(1 / 60); // 3 s of wall time
  assert.equal(tr.held, true);
  assert.equal(tr.songTime, 1.0);
  assert.equal(press(64), KEY_HIT_RIGHT);
  frame(0.5);
  assert.equal(tr.songTime, 1.0, 'still waiting after partial chord');
  assert.equal(press(48), KEY_HIT_LEFT);
  frame(0.5);
  assert.equal(tr.songTime, 1.0);
  press(67);
  frame(0.25);
  assert.ok(Math.abs(tr.songTime - 1.25) < 1e-9, 'resumes exactly from the chord: ' + tr.songTime);
});

test('wrong key flashes red, counts, and never advances or crashes the wait playhead', () => {
  const { tr, pr, frame, press } = setup();
  tr.play();
  for (let i = 0; i < 90; i++) frame(1 / 60);
  assert.equal(tr.songTime, 1.0);
  const waitIdx = pr.waitIdx;
  assert.equal(press(61), KEY_WRONG);
  assert.equal(pr.flashKind[61], KEY_WRONG);
  assert.equal(pr.flashLevel[61], 1);
  assert.equal(pr.wrong, 1);
  // Mash 80 wrong keys (everything except the chord's 48/64/67).
  for (let p = 21; p <= 108; p++) if (p !== 48 && p !== 64 && p !== 67) assert.equal(press(p), KEY_WRONG);
  frame(1);
  assert.equal(pr.waitIdx, waitIdx);
  assert.equal(tr.songTime, 1.0);
  press(64);
  press(67);
  press(48);
  frame(0.1);
  assert.ok(tr.songTime > 1.0);
});

test('red flash decays to zero after release', () => {
  const { pr, press } = setup();
  press(30);
  assert.equal(pr.flashKind[30], KEY_WRONG);
  pr.decay(0.2);
  assert.ok(pr.flashLevel[30] > 0 && pr.flashLevel[30] < 1);
  pr.decay(1);
  assert.equal(pr.flashLevel[30], 0);
});

test('early hits inside the window count before the chord arrives (no freeze)', () => {
  const { tr, pr, frame, press } = setup();
  tr.play();
  for (let i = 0; i < 54; i++) frame(1 / 60); // t = 0.9
  press(64);
  press(67);
  press(48);
  frame(0.2);
  assert.equal(tr.held, false);
  assert.ok(tr.songTime > 1.05);
});

test('duplicate pitch in a chord (both hands on C4) is satisfied by one press', () => {
  const { tr, pr, frame, press } = setup();
  pr.resetFrom(2.5);
  tr.seek(2.5);
  tr.play();
  press(72); // ignore; past
  for (let i = 0; i < 60; i++) frame(1 / 60);
  assert.equal(tr.songTime, 3.0);
  press(60);
  frame(0.1);
  assert.ok(tr.songTime > 3.0, 'single press of C4 releases a C4+C4 chord');
});

test('re-striking a note while it is still sounding is neutral, not wrong', () => {
  const { tr, pr, frame, press } = setup(false);
  tr.play();
  for (let i = 0; i < 60; i++) frame(1 / 60); // t=1.0
  assert.equal(press(48), KEY_HIT_LEFT);
  frame(0.4); // LH 48 lasts 0.833 s
  assert.equal(press(48), KEY_NEUTRAL);
  assert.equal(pr.wrong, 0);
});

test('without wait mode, unplayed notes become misses', () => {
  const { tr, pr, frame } = setup(false);
  tr.play();
  for (let i = 0; i < 120; i++) frame(1 / 60);
  assert.equal(pr.misses, 3);
  assert.equal(pr.state[0], NOTE_MISSED);
});

test('seek resets note states and wait cursor', () => {
  const { tr, pr, frame, press } = setup();
  tr.play();
  for (let i = 0; i < 70; i++) frame(1 / 60);
  press(64);
  press(67);
  press(48);
  frame(1.2);
  assert.ok(pr.waitIdx >= 1);
  pr.resetFrom(0);
  tr.seek(0);
  assert.equal(pr.waitIdx, 0);
  for (let i = 0; i < pr.song.count; i++) assert.notEqual(pr.state[i], NOTE_HIT);
});

test('tempo scales the hit window in song time', () => {
  const { tr, pr, frame, press } = setup(false);
  tr.setRate(0.25);
  tr.play();
  // 0.15 song-seconds early is 0.6 real seconds early at 0.25x → outside the 0.2 s window
  for (let i = 0; i < 205; i++) frame(1 / 60); // ≈0.854 song s
  assert.equal(press(64), KEY_WRONG);
});

test('hands not muted are played by the tablet and not required', () => {
  const { pr } = setup();
  pr.setPracticeHands(true, false, 0); // you play right only
  assert.equal(pr.groupCount, 3);
  assert.equal(pr.groupOffset[1] - pr.groupOffset[0], 2); // 64 + 67 only
  pr.setPracticeHands(false, false, 0);
  assert.equal(pr.waitTarget(), Infinity);
});
