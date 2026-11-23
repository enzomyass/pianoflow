// Built-in demo: "Ode to Joy" (Beethoven, public domain), two hands, generated
// as a real .mid file so it goes through exactly the same parser as user files.
// Includes a tempo change (ritardando into the last phrase) to exercise the tempo map.

import { writeMidi } from '../core/midi-file.js';

const PPQ = 480;
const C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, G3 = 55;

// [pitch, beats]
const PHRASE_A = [[E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1], [C4, 1], [C4, 1], [D4, 1], [E4, 1], [E4, 1.5], [D4, 0.5], [D4, 2]];
const PHRASE_A2 = [[E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1], [C4, 1], [C4, 1], [D4, 1], [E4, 1], [D4, 1.5], [C4, 0.5], [C4, 2]];
const PHRASE_B = [[D4, 1], [D4, 1], [E4, 1], [C4, 1], [D4, 1], [E4, 0.5], [F4, 0.5], [E4, 1], [C4, 1], [D4, 1], [E4, 0.5], [F4, 0.5], [E4, 1], [D4, 1], [C4, 1], [D4, 1], [G3, 2]];

const C_CHORD = [48, 55];
const G_CHORD = [43, 50];
// One entry per bar: [chord, beats] pairs.
const HARMONY_A = [[[C_CHORD, 4]], [[G_CHORD, 4]], [[C_CHORD, 4]], [[G_CHORD, 4]]];
const HARMONY_A2 = [[[C_CHORD, 4]], [[G_CHORD, 4]], [[C_CHORD, 4]], [[G_CHORD, 2], [C_CHORD, 2]]];
const HARMONY_B = [[[G_CHORD, 4]], [[G_CHORD, 4]], [[G_CHORD, 4]], [[C_CHORD, 2], [G_CHORD, 2]]];

function melody(phrases) {
  const notes = [];
  let tick = 0;
  for (const phrase of phrases) {
    for (const [pitch, beats] of phrase) {
      const dur = Math.round(beats * PPQ);
      notes.push({ pitch, tick, dur: Math.round(dur * 0.92), vel: 92, ch: 0 });
      tick += dur;
    }
  }
  return notes;
}

function harmony(sections) {
  const notes = [];
  let tick = 0;
  for (const bars of sections) {
    for (const bar of bars) {
      for (const [chord, beats] of bar) {
        const dur = beats * PPQ;
        for (const pitch of chord) notes.push({ pitch, tick, dur: Math.round(dur * 0.95), vel: 70, ch: 1 });
        tick += dur;
      }
    }
  }
  return notes;
}

export const DEMO_SONG_NAME = 'Ode to Joy (Demo)';

/** @returns {Uint8Array} */
export function buildDemoMidi() {
  const sections = [PHRASE_A, PHRASE_A2, PHRASE_B, PHRASE_A2];
  const harmonies = [HARMONY_A, HARMONY_A2, HARMONY_B, HARMONY_A2];
  return writeMidi({
    ppq: PPQ,
    tempos: [
      { tick: 0, bpm: 96 },
      { tick: 48 * PPQ, bpm: 84 },
    ],
    runningStatus: true,
    tracks: [
      { name: 'Right Hand', notes: melody(sections) },
      { name: 'Left Hand', notes: harmony(harmonies) },
    ],
  });
}
