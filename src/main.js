import './styles.css';
import { Capacitor } from '@capacitor/core';
import { parseMidi, MidiFormatError } from './core/midi-file.js';
import { buildSong } from './core/song.js';
import { PracticeEngine, KEY_WRONG } from './core/practice.js';
import { Transport } from './core/transport.js';
import { HAND_ACCOMP, inKeyRange } from './core/constants.js';
import { Synth } from './audio/synth.js';
import { PlaybackScheduler } from './audio/scheduler.js';
import { WaterfallRenderer } from './render/renderer.js';
import { MidiInput } from './io/midi-input.js';
import { saveSong, listSongs, loadSong, deleteSong, loadPrefs, savePrefs } from './io/storage.js';
import { buildDemoMidi, DEMO_SONG_NAME } from './demo/demo-song.js';

const $ = (id) => document.getElementById(id);
const DEMO_ID = '__demo__';

// ------------------------------------------------------------------ state --

const prefs = Object.assign(
  { rate: 1, wait: true, rightMuted: true, leftMuted: true, volume: 0.8, monitor: false, accomp: true, visibleSeconds: 3, lastSongId: DEMO_ID },
  loadPrefs(),
);

const synth = new Synth();
const transport = new Transport(() => synth.clock());
const practice = new PracticeEngine();
const scheduler = new PlaybackScheduler(synth, transport);
const renderer = new WaterfallRenderer($('stage'));
renderer.setPractice(practice);
renderer.setVisibleSeconds(prefs.visibleSeconds);

let song = null;
let currentSongId = null;
let leadIn = -2;

// -------------------------------------------------------------- helpers ----

let toastTimer = 0;
function toast(msg, isError = false, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function persistPrefs() {
  savePrefs(prefs);
}

function ensureAudio() {
  synth.ensure();
  synth.setVolume(prefs.volume);
}

// ------------------------------------------------------------ transport ----

function syncHold() {
  transport.setHold(practice.waitTarget());
}

function seekTo(t) {
  transport.seek(t);
  practice.resetFrom(transport.songTime);
  scheduler.reset(transport.songTime);
  syncHold();
}

function play() {
  if (!song) return;
  ensureAudio();
  if (transport.songTime >= song.duration) seekTo(leadIn);
  transport.play();
  updatePlayButton();
}

function pause() {
  transport.pause();
  scheduler.reset(transport.songTime);
  updatePlayButton();
}

function togglePlay() {
  if (transport.playing) pause();
  else play();
}

function setRate(r) {
  transport.setRate(r);
  scheduler.retime(transport.songTime);
  prefs.rate = transport.rate;
  $('tempo').value = String(transport.rate);
  $('tempoOut').textContent = transport.rate.toFixed(2) + '×';
  persistPrefs();
}

function setWait(on) {
  prefs.wait = !!on;
  practice.setWaitMode(prefs.wait, transport.songTime);
  syncHold();
  $('btnWait').setAttribute('aria-pressed', String(prefs.wait));
  persistPrefs();
}

function applyHands() {
  practice.setPracticeHands(prefs.rightMuted, prefs.leftMuted, transport.songTime);
  scheduler.setMuted(prefs.rightMuted, prefs.leftMuted);
  scheduler.muted[HAND_ACCOMP] = prefs.accomp ? 0 : 1;
  syncHold();
  const r = $('btnRight');
  const l = $('btnLeft');
  r.setAttribute('aria-pressed', String(prefs.rightMuted));
  l.setAttribute('aria-pressed', String(prefs.leftMuted));
  r.title = prefs.rightMuted ? 'Right hand muted — you play it (tap to let the tablet play it)' : 'Right hand played by the tablet (tap to mute and play it yourself)';
  l.title = prefs.leftMuted ? 'Left hand muted — you play it (tap to let the tablet play it)' : 'Left hand played by the tablet (tap to mute and play it yourself)';
  persistPrefs();
}

// ---------------------------------------------------------------- songs ----

function loadBuffer(buffer, name) {
  let parsed;
  try {
    parsed = parseMidi(buffer);
  } catch (err) {
    const msg = err instanceof MidiFormatError ? err.message : 'Could not read this MIDI file';
    throw new Error(msg);
  }
  const s = buildSong(parsed, name);
  if (s.count === 0) throw new Error('This MIDI file has no playable notes');
  pause();
  song = s;
  practice.setSong(s);
  scheduler.setSong(s);
  renderer.setSong(s);
  transport.duration = s.duration;
  applyHands();
  practice.setWaitMode(prefs.wait, 0);
  leadIn = -Math.min(2, prefs.visibleSeconds * 0.6);
  seekTo(leadIn);
  practice.resetFrom(leadIn, true);
  $('songTitle').textContent = name;
  lastUi.statsVersion = -1;
  if (s.outOfRange > 0) toast(s.outOfRange + (s.outOfRange === 1 ? ' note is' : ' notes are') + ' outside the 88-key range and will only be heard.');
  return s;
}

async function openSongById(id) {
  if (id === DEMO_ID) {
    loadBuffer(buildDemoMidi().buffer, DEMO_SONG_NAME);
  } else {
    const rec = await loadSong(id);
    if (!rec) throw new Error('Song not found in storage');
    loadBuffer(rec.data, rec.meta.name);
  }
  currentSongId = id;
  prefs.lastSongId = id;
  persistPrefs();
  renderSongList();
}

async function importFile(file) {
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const name = (file.name || 'Imported song').replace(/\.(mid|midi|kar|rmi)$/i, '');
    const s = loadBuffer(buffer, name);
    const id = await saveSong(name, buffer, { noteCount: s.count, duration: s.duration });
    currentSongId = id;
    prefs.lastSongId = id;
    persistPrefs();
    await renderSongList();
    toast('Saved "' + name + '" — available offline');
    closeDrawer();
  } catch (err) {
    toast(err.message || String(err), true, 5000);
  }
}

async function renderSongList() {
  const ul = $('songList');
  let songs = [];
  try {
    songs = await listSongs();
  } catch (err) {
    toast('Storage unavailable: ' + err.message, true);
  }
  ul.textContent = '';
  const items = [{ id: DEMO_ID, name: DEMO_SONG_NAME, demo: true }].concat(songs);
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'song-item' + (item.id === currentSongId ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    if (item.demo) {
      sub.innerHTML = '<span class="badge">Built-in</span> · two hands · tempo change';
    } else {
      sub.textContent = fmtTime(item.duration) + ' · ' + item.noteCount + ' notes · ' + new Date(item.addedAt).toLocaleDateString();
    }
    info.append(nm, sub);
    li.append(info);
    if (!item.demo) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.textContent = 'Delete';
          setTimeout(() => {
            del.classList.remove('confirm');
            del.textContent = '✕';
          }, 2500);
          return;
        }
        await deleteSong(item.id);
        if (currentSongId === item.id) await openSongById(DEMO_ID);
        await renderSongList();
      });
      li.append(del);
    }
    li.addEventListener('click', async () => {
      try {
        await openSongById(item.id);
        closeDrawer();
      } catch (err) {
        toast(err.message, true);
      }
    });
    ul.append(li);
  }
}

// ----------------------------------------------------------- note input ----

function handleNoteOn(pitch, velocity, local) {
  if (!inKeyRange(pitch)) return;
  const kind = practice.noteOn(pitch, transport.songTime, transport.rate);
  syncHold(); // a completed chord releases Wait Mode immediately
  if (local || prefs.monitor) {
    ensureAudio();
    synth.liveOn(pitch, velocity);
  }
  return kind;
}

function handleNoteOff(pitch) {
  if (!inKeyRange(pitch)) return;
  practice.noteOff(pitch);
  synth.liveOff(pitch);
}

function handleAllOff() {
  practice.allNotesOff();
  for (let p = 21; p <= 108; p++) synth.liveOff(p);
}

function setConnStatus(text, kind) {
  const btn = $('btnConnect');
  btn.dataset.state = kind;
  $('connLabel').textContent = kind === 'ble' || kind === 'usb' ? text : kind === 'busy' ? text : 'Connect Piano';
  if (kind === 'error') toast(text, true, 4500);
  else if (kind === 'idle' && text !== 'No piano connected') toast(text);
}

const midiInput = new MidiInput({
  onNoteOn: (p, v) => handleNoteOn(p, v, false),
  onNoteOff: handleNoteOff,
  onAllOff: handleAllOff,
  onStatus: setConnStatus,
});

// ------------------------------------------------------------ frame loop ---

const lastUi = { sec: -1, dur: -1, progress: -1, statsVersion: -1, held: false, playing: false, acc: 0 };
let uiClock = 0;

function updatePlayButton() {
  const b = $('btnPlay');
  b.classList.toggle('playing', transport.playing);
  b.setAttribute('aria-label', transport.playing ? 'Pause' : 'Play');
}

let scrubbing = false;

function uiTick(dt) {
  uiClock += dt;
  if (uiClock < 0.1) return;
  uiClock = 0;
  if (!song) return;
  const sec = Math.floor(Math.max(0, transport.songTime));
  const dur = Math.floor(song.duration);
  if (sec !== lastUi.sec || dur !== lastUi.dur) {
    lastUi.sec = sec;
    lastUi.dur = dur;
    $('songTime').textContent = fmtTime(sec) + ' / ' + fmtTime(song.duration);
  }
  if (!scrubbing) {
    const prog = Math.round((Math.max(0, transport.songTime) / song.duration) * 1000);
    if (prog !== lastUi.progress) {
      lastUi.progress = prog;
      $('progress').value = String(prog);
    }
  }
  if (practice.version !== lastUi.statsVersion) {
    lastUi.statsVersion = practice.version;
    const judged = practice.hits + practice.misses + practice.wrong;
    $('statAcc').textContent = judged === 0 ? '—' : Math.round(practice.accuracy() * 100) + '%';
    $('statWrong').textContent = String(practice.wrong);
  }
  const held = transport.held && transport.playing;
  if (held !== lastUi.held) {
    lastUi.held = held;
    $('waitPill').hidden = !held;
  }
  if (transport.playing !== lastUi.playing) {
    lastUi.playing = transport.playing;
    updatePlayButton();
  }
}

function frame(ts) {
  syncHold();
  const dt = transport.tick(ts);
  practice.update(transport.songTime, transport.rate);
  syncHold();
  scheduler.update();
  renderer.draw(transport.songTime, dt, transport.held && transport.playing);
  practice.decay(dt);
  if (transport.playing && song && transport.songTime > song.duration + 0.6) {
    pause();
    const judged = practice.hits + practice.misses + practice.wrong;
    if (judged > 0) toast('Finished! Accuracy ' + Math.round(practice.accuracy() * 100) + '% · ' + practice.wrong + ' wrong notes', false, 5000);
  }
  uiTick(dt);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ UI -----

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  document.documentElement.style.setProperty('--bed', renderer.bedH + 'px');
}

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;
  $('settings').hidden = true;
  renderSongList();
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
}

function bindUi() {
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnRestart').addEventListener('click', () => {
    ensureAudio();
    seekTo(leadIn);
    practice.resetFrom(leadIn, true);
    lastUi.statsVersion = -1;
  });
  $('tempo').addEventListener('input', (e) => setRate(parseFloat(e.target.value)));
  $('btnWait').addEventListener('click', () => setWait(!prefs.wait));
  $('btnRight').addEventListener('click', () => {
    prefs.rightMuted = !prefs.rightMuted;
    applyHands();
  });
  $('btnLeft').addEventListener('click', () => {
    prefs.leftMuted = !prefs.leftMuted;
    applyHands();
  });
  $('btnSongs').addEventListener('click', openDrawer);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  const fileInput = $('fileInput');
  if (Capacitor.isNativePlatform()) fileInput.removeAttribute('accept'); // Android pickers grey out .mid by MIME
  $('btnImport').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    importFile(f);
  });

  $('btnConnect').addEventListener('click', async () => {
    ensureAudio();
    if (midiInput.bleConnected) {
      await midiInput.disconnectBluetooth();
      return;
    }
    try {
      setConnStatus('Searching…', 'busy');
      await midiInput.connectBluetooth();
      toast('Piano connected via Bluetooth');
    } catch (err) {
      const name = err && err.name;
      const msg = (err && err.message) || String(err);
      if (name === 'NotFoundError' || /cancel/i.test(msg)) setConnStatus('No piano selected', 'idle');
      else setConnStatus(msg, 'error');
    }
  });
  $('btnUsb').addEventListener('click', async () => {
    ensureAudio();
    const ok = await midiInput.startWired({ interactive: true });
    if (ok) toast('Listening for USB MIDI — plug in your piano with a USB-C cable');
  });

  // Settings
  const settings = $('settings');
  $('btnSettings').addEventListener('click', () => {
    settings.hidden = !settings.hidden;
  });
  $('volume').value = String(prefs.volume);
  $('volume').addEventListener('input', (e) => {
    prefs.volume = parseFloat(e.target.value);
    synth.setVolume(prefs.volume);
    persistPrefs();
  });
  $('speed').value = String(prefs.visibleSeconds);
  $('speed').addEventListener('input', (e) => {
    prefs.visibleSeconds = parseFloat(e.target.value);
    renderer.setVisibleSeconds(prefs.visibleSeconds);
    persistPrefs();
  });
  $('monitor').checked = prefs.monitor;
  $('monitor').addEventListener('change', (e) => {
    prefs.monitor = e.target.checked;
    persistPrefs();
  });
  $('accomp').checked = prefs.accomp;
  $('accomp').addEventListener('change', (e) => {
    prefs.accomp = e.target.checked;
    applyHands();
  });

  // Progress bar scrubbing
  const progress = $('progress');
  progress.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  const endScrub = () => {
    scrubbing = false;
  };
  progress.addEventListener('pointerup', endScrub);
  progress.addEventListener('pointercancel', endScrub);
  progress.addEventListener('input', () => {
    if (!song) return;
    seekTo((parseInt(progress.value, 10) / 1000) * song.duration);
  });

  // Canvas: key bed = play notes by touch; waterfall = drag to scrub.
  const canvas = $('stage');
  const pointerNote = new Map();
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    $('settings').hidden = true;
    const pitch = renderer.geo.hitTest(e.clientX, e.clientY);
    if (pitch >= 0) {
      canvas.setPointerCapture(e.pointerId);
      pointerNote.set(e.pointerId, pitch);
      handleNoteOn(pitch, 96, true);
      return;
    }
    if (song && e.clientY < renderer.strikeY) {
      canvas.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, y: e.clientY, t: transport.songTime, wasPlaying: transport.playing, moved: false };
      if (transport.playing) pause();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointerNote.has(e.pointerId)) {
      const pitch = renderer.geo.hitTest(e.clientX, e.clientY);
      const prev = pointerNote.get(e.pointerId);
      if (pitch >= 0 && pitch !== prev) {
        handleNoteOff(prev);
        pointerNote.set(e.pointerId, pitch);
        handleNoteOn(pitch, 90, true);
      }
      return;
    }
    if (drag && drag.id === e.pointerId) {
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) seekTo(drag.t + renderer.pixelsToSeconds(dy));
    }
  });
  const release = (e) => {
    if (pointerNote.has(e.pointerId)) {
      handleNoteOff(pointerNote.get(e.pointerId));
      pointerNote.delete(e.pointerId);
    }
    if (drag && drag.id === e.pointerId) {
      // Drag = scrub (resume if it was playing). Tap = toggle play/pause.
      if (drag.moved ? drag.wasPlaying : !drag.wasPlaying) play();
      drag = null;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Computer keyboard (testing without a piano)
  const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
  let octave = 60;
  const held = new Map();
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.target.type !== 'range') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.repeat) return;
    if (e.code === 'ArrowLeft') return seekTo(transport.songTime - 5);
    if (e.code === 'ArrowRight') return seekTo(transport.songTime + 5);
    if (e.code === 'KeyZ') return void (octave = Math.max(24, octave - 12));
    if (e.code === 'KeyX') return void (octave = Math.min(96, octave + 12));
    if (e.code === 'KeyQ') return setWait(!prefs.wait);
    const off = KEYMAP[e.code];
    if (off === undefined || held.has(e.code)) return;
    const p = octave + off;
    held.set(e.code, p);
    handleNoteOn(p, 100, true);
  });
  window.addEventListener('keyup', (e) => {
    const p = held.get(e.code);
    if (p === undefined) return;
    held.delete(e.code);
    handleNoteOff(p);
  });

  // Drag & drop import
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('drop').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop').hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    importFile(f);
  });

  // Auto-pause when the app goes to background (Android home button, screen off)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && transport.playing) pause();
    if (document.hidden) handleAllOff();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));
  window.addEventListener('error', (e) => toast('Error: ' + (e.message || 'unexpected'), true));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    toast('Error: ' + ((r && r.message) || r), true);
  });
}

// --------------------------------------------------------------- startup ---

async function start() {
  bindUi();
  resize();
  $('tempo').value = String(prefs.rate);
  transport.setRate(prefs.rate);
  $('tempoOut').textContent = transport.rate.toFixed(2) + '×';
  $('btnWait').setAttribute('aria-pressed', String(prefs.wait));
  practice.setWaitMode(prefs.wait, 0);

  try {
    await openSongById(prefs.lastSongId || DEMO_ID);
  } catch (_) {
    await openSongById(DEMO_ID);
  }
  requestAnimationFrame(frame);

  if (Capacitor.isNativePlatform()) {
    midiInput.startWired({ interactive: false });
    midiInput.reconnectLast();
  }
}

// Test/diagnostic hook (read-only state access + simulated MIDI input).
window.__pianoflow = {
  transport,
  practice,
  renderer,
  synth,
  scheduler,
  midiInput,
  get song() {
    return song;
  },
  noteOn: (p, v = 100) => handleNoteOn(p, v, false),
  noteOff: handleNoteOff,
  bleBytes: (arr) => midiInput.bleParser.parse(new Uint8Array(arr)),
  seek: seekTo,
  play,
  pause,
  setRate,
  setWait,
  openSongById,
  listSongs,
  KEY_WRONG,
};

start();
