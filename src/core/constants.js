// Shared constants. Everything here is computed once at module load so the
// render loop never builds strings or arrays.

export const A0 = 21;
export const C8 = 108;
export const KEY_COUNT = 88;

export const HAND_RIGHT = 0;
export const HAND_LEFT = 1;
export const HAND_ACCOMP = 2;

export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-aab5-11ba5b2430c6';
export const BLE_MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

export const COLOR_BG = '#0c0e14';
export const COLOR_WRONG = '#ff2a4d';
export const COLOR_RIGHT = '#22d3ff';
export const COLOR_LEFT = '#2cf5a8';
export const COLOR_ACCOMP = '#9b7bff';

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Note label per MIDI pitch, e.g. NOTE_NAMES[60] === 'C4'. */
export const NOTE_NAMES = (() => {
  const out = new Array(128);
  for (let p = 0; p < 128; p++) out[p] = PITCH_CLASS_NAMES[p % 12] + (Math.floor(p / 12) - 1);
  return out;
})();

/** 1 when the MIDI pitch is a black key. */
export const IS_BLACK = (() => {
  const out = new Uint8Array(128);
  for (let p = 0; p < 128; p++) {
    const pc = p % 12;
    out[p] = pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10 ? 1 : 0;
  }
  return out;
})();

export function inKeyRange(pitch) {
  return pitch >= A0 && pitch <= C8;
}

/** First index i in sorted arr[0..count) with arr[i] >= value. */
export function lowerBound(arr, count, value) {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in sorted arr[0..count) with arr[i] > value. */
export function upperBound(arr, count, value) {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
