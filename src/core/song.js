// Song model: flattens a parsed MIDI file into sorted typed arrays so the
// render loop and hit detection can binary-search without allocating.

import { HAND_RIGHT, HAND_LEFT, HAND_ACCOMP, inKeyRange } from './constants.js';

const DRUM_CHANNEL = 9;

function handFromName(name) {
  const n = (name || '').toLowerCase();
  if (/\b(left|lh|l\.h\.|bass)\b/.test(n) || /left hand/.test(n)) return HAND_LEFT;
  if (/\b(right|rh|r\.h\.|treble|melody)\b/.test(n) || /right hand/.test(n)) return HAND_RIGHT;
  return -1;
}

/**
 * Assigns each note to right hand, left hand or accompaniment.
 * Track 1 = right hand (cyan), Track 2 = left hand (mint), others = accompaniment.
 * Single-track files are split by channel, or by pitch around middle C.
 */
function assignHands(noteTracks) {
  const result = [];
  if (noteTracks.length === 0) return result;

  if (noteTracks.length >= 2) {
    let named = noteTracks.map((t) => handFromName(t.name));
    const hasR = named.includes(HAND_RIGHT);
    const hasL = named.includes(HAND_LEFT);
    if (!(hasR && hasL)) named = noteTracks.map(() => -1);
    let order = 0;
    noteTracks.forEach((t, i) => {
      let hand = named[i];
      if (hand === -1) {
        // In files with explicit "Right"/"Left" track names, unnamed tracks
        // are accompaniment; otherwise track order decides.
        hand = hasR && hasL ? HAND_ACCOMP : order === 0 ? HAND_RIGHT : order === 1 ? HAND_LEFT : HAND_ACCOMP;
        order++;
      }
      for (const n of t.notes) result.push({ ...n, hand, track: t.index });
    });
    return result;
  }

  const t = noteTracks[0];
  const channels = [...t.channels].filter((c) => c !== DRUM_CHANNEL).sort((a, b) => a - b);
  if (channels.length >= 2) {
    const map = new Map();
    channels.forEach((c, i) => map.set(c, i === 0 ? HAND_RIGHT : i === 1 ? HAND_LEFT : HAND_ACCOMP));
    for (const n of t.notes) result.push({ ...n, hand: map.get(n.channel) ?? HAND_ACCOMP, track: t.index });
    return result;
  }
  for (const n of t.notes) result.push({ ...n, hand: n.pitch < 60 ? HAND_LEFT : HAND_RIGHT, track: t.index });
  return result;
}

/**
 * @param {ReturnType<import('./midi-file.js').parseMidi>} parsed
 * @param {string} name
 */
export function buildSong(parsed, name) {
  const noteTracks = parsed.tracks
    .map((t) => ({ ...t, notes: t.notes.filter((n) => n.channel !== DRUM_CHANNEL) }))
    .filter((t) => t.notes.length > 0);
  const flat = assignHands(noteTracks);
  flat.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  const count = flat.length;
  const song = {
    name: name || 'Untitled',
    count,
    start: new Float64Array(count),
    end: new Float64Array(count),
    pitch: new Uint8Array(count),
    velocity: new Uint8Array(count),
    hand: new Uint8Array(count),
    inRange: new Uint8Array(count),
    maxDur: 0,
    duration: parsed.duration,
    tempos: parsed.tempos,
    handCounts: [0, 0, 0],
    outOfRange: 0,
  };
  for (let i = 0; i < count; i++) {
    const n = flat[i];
    song.start[i] = n.start;
    song.end[i] = n.end;
    song.pitch[i] = n.pitch;
    song.velocity[i] = n.velocity;
    song.hand[i] = n.hand;
    const ok = inKeyRange(n.pitch) ? 1 : 0;
    song.inRange[i] = ok;
    if (!ok) song.outOfRange++;
    song.handCounts[n.hand]++;
    const d = n.end - n.start;
    if (d > song.maxDur) song.maxDur = d;
    if (n.end > song.duration) song.duration = n.end;
  }
  return song;
}
