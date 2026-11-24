import './styles.css';
import { Capacitor } from '@capacitor/core';
import { parseMidi, writeMidi, MidiFormatError } from './core/midi-file.js';
import { buildSong, buildBeatGrid, buildTakeSong } from './core/song.js';
import { PracticeEngine, KEY_WRONG, KEY_HIT_LEFT, KEY_HIT_RIGHT } from './core/practice.js';
import { Transport } from './core/transport.js';
import { Tutor } from './core/tutor.js';
import { Progress, fmtDuration } from './core/progress.js';
import { transcribeAudio, toMono16k } from './core/transcribe.js';
import { HAND_ACCOMP, inKeyRange, lowerBound } from './core/constants.js';
import { Synth, TONES } from './audio/synth.js';
import { PlaybackScheduler } from './audio/scheduler.js';
import { WaterfallRenderer } from './render/renderer.js';
import { THEMES, getTheme, applyThemeToDocument } from './render/themes.js';
import { MidiInput } from './io/midi-input.js';
import { saveSong, listSongs, loadSong, deleteSong, loadPrefs, savePrefs } from './io/storage.js';
import { buildDemoMidi, DEMO_SONG_NAME } from './demo/demo-song.js';

const $ = (id) => document.getElementById(id);
const DEMO_ID = '__demo__';
const SAMPLE_URL = './samples/piano/';

// ------------------------------------------------------------------ state --

const prefs = Object.assign(
  {
    rate: 1,
    wait: true,
    rightMuted: true,
    leftMuted: true,
    volume: 0.8,
    monitor: false,
    accomp: true,
    visibleSeconds: 3,
    lastSongId: DEMO_ID,
    theme: 'neon',
    tone: 'grand',
    labelMode: 0,
    effects: true,
    metronome: false,
    metroVolume: 0.6,
    countIn: false,
    latencyMode: 'auto',
    latencyMs: 0,
    memorize: 0,
    memorizeAuto: false,
    trainer: false,
    trainerStart: 0.6,
  },
  loadPrefs(),
);

const synth = new Synth();
synth.setTone(prefs.tone);
synth.setLatency(prefs.latencyMode, prefs.latencyMs / 1000);
synth.metroVolume = prefs.metroVolume;
const transport = new Transport(() => synth.clock());
const practice = new PracticeEngine();
const scheduler = new PlaybackScheduler(synth, transport);
scheduler.metronome = prefs.metronome;
const takeScheduler = new PlaybackScheduler(synth, transport);
const renderer = new WaterfallRenderer($('stage'));
const tutor = new Tutor();
const progress = new Progress();
renderer.setPractice(practice);
renderer.setVisibleSeconds(prefs.visibleSeconds);
renderer.setTheme(getTheme(prefs.theme));
renderer.setLabelMode(prefs.labelMode);
renderer.effects = prefs.effects;
renderer.setMemorize(prefs.memorize);
applyThemeToDocument(getTheme(prefs.theme));

let song = null;
let parsedSong = null;
let currentSongId = null;
let leadIn = -2;

const loop = { a: NaN, b: NaN, on: false, snap: { hits: 0, misses: 0, wrong: 0 } };
let tutorPlan = null;
let tutorSaved = null; // user settings restored after a lesson
let tutorTimer = 0;
const recorder = { active: false, notes: [], open: new Map(), take: null, songId: null };
let replay = null; // {saved}
let countInTimers = [];

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

let samplesRequested = false;
function ensureAudio() {
  synth.ensure();
  synth.setVolume(prefs.volume);
  synth.setMetronomeVolume(prefs.metroVolume);
  if (!samplesRequested && synth.ctx) {
    samplesRequested = true;
    synth.loadSamples(SAMPLE_URL, updateSampleState);
  }
}

function updateSampleState() {
  const el = $('sampleState');
  if (!el) return;
  const st = synth.samplesState;
  el.textContent =
    st === 'ready'
      ? 'Grand Piano: real recorded piano ✓'
      : st === 'loading'
        ? 'Grand Piano: loading recorded piano…'
        : st === 'missing'
          ? 'Grand Piano: recorded samples not bundled — using the synthesized piano.'
          : 'Grand Piano: recorded piano loads when you first play.';
}

function bpmAt(t) {
  if (!song || !song.tempos || !song.tempos.length) return 120;
  let bpm = song.tempos[0].bpm;
  for (const tp of song.tempos) if (tp.time <= t) bpm = tp.bpm;
  return bpm;
}

// ------------------------------------------------------------ transport ----

function syncHold() {
  transport.setHold(practice.waitTarget());
}

function updateSchedulerEnd() {
  if (tutorPlan) scheduler.end = tutorPlan.end + 0.3;
  else if (loop.on && loop.b === loop.b) scheduler.end = loop.b;
  else scheduler.end = Infinity;
}

function seekTo(t) {
  transport.seek(t);
  practice.resetFrom(transport.songTime);
  scheduler.reset(transport.songTime);
  takeScheduler.reset(transport.songTime);
  syncHold();
}

function cancelCountIn() {
  for (const id of countInTimers) clearTimeout(id);
  countInTimers = [];
  $('countIn').hidden = true;
}

function play(opts = {}) {
  if (!song) return;
  ensureAudio();
  if (transport.songTime >= song.duration) seekTo(leadIn);
  cancelCountIn();
  const useCountIn = prefs.countIn && !opts.noCountIn && !tutorPlan && !replay && synth.isRunning();
  if (useCountIn) {
    const beat = 60 / bpmAt(Math.max(0, transport.songTime)) / transport.rate;
    const now = synth.ctx.currentTime + 0.12;
    const lat = synth.latency();
    for (let i = 0; i < 4; i++) {
      synth.click(now + i * beat - lat, i === 0);
      countInTimers.push(
        setTimeout(() => {
          const el = $('countIn');
          el.textContent = String(4 - i);
          el.hidden = false;
        }, (0.12 + i * beat) * 1000),
      );
    }
    countInTimers.push(setTimeout(() => ($('countIn').hidden = true), (0.12 + 4 * beat) * 1000));
    transport.playAt(now + 4 * beat);
  } else {
    transport.play();
  }
  if (loop.on) practice.snapshot(loop.snap);
  updatePlayButton();
}

function pause() {
  cancelCountIn();
  transport.pause();
  scheduler.reset(transport.songTime);
  takeScheduler.reset(transport.songTime);
  updatePlayButton();
}

function togglePlay() {
  if (replay) {
    exitReplay();
    return;
  }
  if (transport.playing) pause();
  else play();
}

function setRate(r, persist = true) {
  transport.setRate(r);
  scheduler.retime(transport.songTime);
  takeScheduler.retime(transport.songTime);
  $('tempo').value = String(transport.rate);
  $('tempoOut').textContent = transport.rate.toFixed(2) + '×';
  if (persist) {
    prefs.rate = transport.rate;
    persistPrefs();
  }
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
  if (tutorPlan) stopTutor(false);
  if (replay) exitReplay();
  stopRecording(false);
  pause();
  song = s;
  parsedSong = parsed;
  practice.setSong(s);
  scheduler.setSong(s);
  scheduler.setBeats(buildBeatGrid(parsed, s.duration));
  renderer.setSong(s);
  transport.duration = s.duration;
  clearLoop();
  applyHands();
  practice.setWaitMode(prefs.wait, 0);
  leadIn = -Math.min(2, prefs.visibleSeconds * 0.6);
  seekTo(leadIn);
  practice.resetFrom(leadIn, true);
  $('songTitle').textContent = name;
  lastUi.statsVersion = -1;
  recorder.take = null;
  updateTakeUi();
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
  const isMidi = /\.(mid|midi|kar|rmi)$/i.test(file.name || '') || /midi/.test(file.type || '');
  if (!isMidi && (/^(audio|video)\//.test(file.type || '') || /\.(mp3|mp4|m4a|wav|ogg|aac|webm|flac)$/i.test(file.name || ''))) {
    return importAudio(file);
  }
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

// ---------------------------------------------------- MP3/MP4 → piano ------

let txCancelled = false;

async function decodeToMono16k(arrayBuffer) {
  ensureAudio();
  const ctx = synth.ctx;
  if (!ctx) throw new Error('Audio is not available on this device');
  const audio = await new Promise((resolve, reject) => {
    const pr = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (pr && pr.then) pr.then(resolve, reject);
  }).catch(() => {
    throw new Error('Could not read the audio in this file. Try an MP3 or a regular MP4 video.');
  });
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (OAC) {
    try {
      const len = Math.ceil(audio.duration * 16000);
      const off = new OAC(1, len, 16000);
      const src = off.createBufferSource();
      src.buffer = audio;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return rendered.getChannelData(0);
    } catch (_) {
      /* fall through to JS resampler */
    }
  }
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  return toMono16k(chans, audio.sampleRate);
}

async function importAudio(file) {
  const name = (file.name || 'Audio').replace(/\.[a-z0-9]+$/i, '');
  if (file.size > 300 * 1024 * 1024) {
    toast('That file is too big (over 300 MB). Try a shorter clip or an MP3.', true, 5000);
    return;
  }
  const modal = $('txModal');
  txCancelled = false;
  $('txTitle').textContent = 'Turning “' + name + '” into piano…';
  $('txBar').style.width = '0%';
  $('txInfo').textContent = 'Reading the audio…';
  modal.hidden = false;
  try {
    const buf = await file.arrayBuffer();
    let mono = await decodeToMono16k(buf);
    const maxLen = 16000 * 600;
    if (mono.length > maxLen) {
      mono = mono.subarray(0, maxLen);
      toast('Only the first 10 minutes are used.');
    }
    $('txInfo').textContent = 'Listening to every note. This runs on your tablet — no internet needed.';
    const res = await transcribeAudio(mono, 16000, {
      onProgress: (f) => ($('txBar').style.width = Math.round(f * 100) + '%'),
      isCancelled: () => txCancelled,
    });
    if (res.notes.length < 3) throw new Error('No piano notes were found in this audio.');
    const toTick = (sec) => Math.round(sec * 960); // 480 ppq @ 120 bpm
    const mk = (n) => ({ pitch: n.pitch, tick: toTick(n.start), dur: Math.max(24, toTick(n.end - n.start)), vel: n.velocity });
    const rh = res.notes.filter((n) => n.pitch >= 60).map(mk);
    const lh = res.notes.filter((n) => n.pitch < 60).map(mk);
    const bytes = writeMidi({ ppq: 480, tempos: [{ tick: 0, bpm: 120 }], tracks: [{ name: 'Right Hand', notes: rh }, { name: 'Left Hand', notes: lh }] });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const title = name + ' (from audio)';
    const s = loadBuffer(buffer, title);
    const id = await saveSong(title, buffer, { noteCount: s.count, duration: s.duration });
    currentSongId = id;
    prefs.lastSongId = id;
    persistPrefs();
    await renderSongList();
    modal.hidden = true;
    closeDrawer();
    toast('Done! ' + res.notes.length + ' notes found and saved. Works best on solo piano recordings.', false, 5000);
  } catch (err) {
    modal.hidden = true;
    if (err && err.message === 'cancelled') toast('Cancelled');
    else toast((err && err.message) || String(err), true, 5000);
  }
}

// ------------------------------------------------------------ song list ----

function renderProgressCard() {
  $('pcStreak').textContent = String(progress.streak());
  $('pcToday').textContent = fmtDuration(progress.todaySeconds());
  $('pcTotal').textContent = fmtDuration(progress.data.totalSeconds);
}

async function renderSongList() {
  renderProgressCard();
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
    const ps = progress.data.songs[item.id];
    if (ps && ps.best > 0) {
      const b = document.createElement('span');
      b.className = 'best';
      b.textContent = '★ ' + ps.best + '%';
      sub.append(b);
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

// ----------------------------------------------------------------- loop ----

function loopInfoText() {
  if (!(loop.a === loop.a) && !(loop.b === loop.b)) return 'Pause where the part starts → Set A, where it ends → Set B.';
  const a = loop.a === loop.a ? fmtTime(loop.a) : '—';
  const b = loop.b === loop.b ? fmtTime(loop.b) : '—';
  return 'A ' + a + '  →  B ' + b + (loop.on ? '  · looping' : '');
}

function updateLoopUi() {
  $('loopInfo').textContent = loopInfoText();
  $('btnLoopOn').setAttribute('aria-pressed', String(loop.on));
  renderer.setLoop(loop.a, loop.b);
  const pr = $('progress');
  if (song && loop.a === loop.a && loop.b === loop.b) {
    const pa = Math.max(0, (loop.a / song.duration) * 100);
    const pb = Math.min(100, (loop.b / song.duration) * 100);
    pr.style.background = 'linear-gradient(90deg, transparent ' + pa + '%, rgba(255,209,102,0.35) ' + pa + '%, rgba(255,209,102,0.35) ' + pb + '%, transparent ' + pb + '%)';
    pr.style.borderRadius = '4px';
  } else {
    pr.style.background = '';
  }
  updateSchedulerEnd();
}

function clearLoop() {
  loop.a = NaN;
  loop.b = NaN;
  loop.on = false;
  updateLoopUi();
}

function setLoopPoint(which) {
  if (!song) return;
  const t = Math.max(0, transport.songTime);
  if (which === 'a') {
    loop.a = t;
    if (loop.b === loop.b && loop.b <= t) loop.b = NaN;
  } else {
    if (!(loop.a === loop.a)) loop.a = Math.max(0, t - 8);
    loop.b = Math.max(t, loop.a + 0.5);
  }
  if (loop.a === loop.a && loop.b === loop.b && !loop.on) setLoopOn(true);
  updateLoopUi();
}

function setLoopOn(on) {
  if (on && !(loop.a === loop.a && loop.b === loop.b)) {
    toast('Set A and B first');
    return;
  }
  loop.on = on;
  if (on) {
    if (prefs.trainer) setRate(prefs.trainerStart, false);
    if (transport.songTime < loop.a - 2 || transport.songTime > loop.b) seekTo(loop.a - 1);
    practice.snapshot(loop.snap);
  }
  updateLoopUi();
}

/** Called each time the playhead wraps from B back to A. */
function onLoopPass() {
  const d = {
    hits: practice.hits - loop.snap.hits,
    misses: practice.misses - loop.snap.misses,
    wrong: practice.wrong - loop.snap.wrong,
  };
  const judged = d.hits + d.misses + d.wrong;
  const acc = judged === 0 ? 0 : d.hits / judged;
  const clean = judged > 0 && d.wrong <= 1 && d.misses === 0;
  const msgs = [];
  if (clean && prefs.memorizeAuto && prefs.memorize < 3) {
    setMemorize(prefs.memorize + 1);
    msgs.push(prefs.memorize === 3 ? 'Now from memory!' : 'Hiding more notes');
  }
  if (prefs.trainer) {
    if (clean && transport.rate < 1) {
      setRate(Math.min(1, Math.round((transport.rate + 0.05) * 100) / 100), false);
      msgs.push('Speed ' + Math.round(transport.rate * 100) + '%');
    } else if (judged > 0 && acc < 0.75 && transport.rate > prefs.trainerStart) {
      setRate(Math.max(prefs.trainerStart, Math.round((transport.rate - 0.05) * 100) / 100), false);
      msgs.push('Slowing to ' + Math.round(transport.rate * 100) + '%');
    }
  }
  if (clean) msgs.unshift('Clean loop! ✨');
  if (msgs.length) toast(msgs.join(' · '));
}

function setMemorize(level) {
  prefs.memorize = Math.max(0, Math.min(3, level));
  renderer.setMemorize(prefs.memorize);
  markSeg('segMemorize', String(prefs.memorize));
  persistPrefs();
}

// ---------------------------------------------------------------- tutor ----

function startTutor() {
  if (!song) return;
  if (replay) exitReplay();
  stopRecording(false);
  const useLoop = loop.on && loop.a === loop.a && loop.b === loop.b;
  const from = useLoop ? loop.a : 0;
  const to = useLoop ? loop.b : song.duration + 1;
  const plan = tutor.start(song, from, to);
  if (!plan) {
    toast('Nothing to teach in this part (no right/left-hand notes).', true);
    return;
  }
  tutorSaved = { rightMuted: prefs.rightMuted, leftMuted: prefs.leftMuted, wait: prefs.wait, rate: transport.rate, loopOn: loop.on, memorize: prefs.memorize };
  loop.on = false;
  renderer.setMemorize(0);
  closePanels();
  $('coach').hidden = false;
  runPlan(plan);
}

function runPlan(plan) {
  tutorPlan = plan;
  clearTimeout(tutorTimer);
  pause();
  practice.setPracticeHands(plan.right, plan.left, plan.start);
  scheduler.setMuted(plan.right, plan.left);
  scheduler.muted[HAND_ACCOMP] = prefs.accomp ? 0 : 1;
  practice.setWaitMode(plan.wait, plan.start);
  setRate(plan.rate, false);
  updateSchedulerEnd();
  const lead = Math.min(1.5, prefs.visibleSeconds * 0.5);
  seekTo(plan.start - lead);
  practice.resetFrom(plan.start - lead, true);
  lastUi.statsVersion = -1;
  $('coachStage').textContent = plan.label + (plan.attempt > 1 ? ' · try ' + plan.attempt : '') + ' · ' + Math.round(plan.rate * 100) + '%';
  $('coachStep').textContent = 'Phrase ' + plan.phrase + ' of ' + plan.phraseCount + ' · step ' + plan.stageIndex + ' of ' + plan.stageCount;
  $('coachMsg').textContent = plan.message;
  const total = plan.phraseCount;
  $('coachBar').style.width = Math.round((((plan.phrase - 1) + (plan.stageIndex - 1) / plan.stageCount) / total) * 100) + '%';
  tutorTimer = setTimeout(() => play({ noCountIn: true }), 1100);
}

function tutorPassDone() {
  pause();
  const r = { hits: practice.hits, misses: practice.misses, wrong: practice.wrong, worstPitch: practice.worstPitch() };
  const next = tutor.passComplete(r);
  if (!next) {
    finishTutor();
    return;
  }
  tutorPlan = null;
  $('coachMsg').textContent = next.message;
  tutorTimer = setTimeout(() => runPlan(next), 1600);
}

function finishTutor() {
  $('coachMsg').textContent = 'Lesson complete! You learned the whole part. 🎉';
  $('coachBar').style.width = '100%';
  $('coachStage').textContent = 'All done';
  for (let p = 48; p <= 84; p += 3) renderer.burst(p, 10);
  tutorTimer = setTimeout(() => stopTutor(true), 3500);
}

function stopTutor(restore = true) {
  clearTimeout(tutorTimer);
  tutor.stop();
  tutorPlan = null;
  $('coach').hidden = true;
  pause();
  if (restore && tutorSaved) {
    prefs.rightMuted = tutorSaved.rightMuted;
    prefs.leftMuted = tutorSaved.leftMuted;
    applyHands();
    setWait(tutorSaved.wait);
    setRate(tutorSaved.rate, false);
    loop.on = tutorSaved.loopOn;
    renderer.setMemorize(tutorSaved.memorize);
    updateLoopUi();
  } else if (tutorSaved) {
    renderer.setMemorize(prefs.memorize);
  }
  tutorSaved = null;
  updateSchedulerEnd();
}

// ------------------------------------------------------- record / replay ---

function startRecording() {
  if (!song) return;
  if (replay) exitReplay();
  recorder.active = true;
  recorder.notes = [];
  recorder.open.clear();
  recorder.songId = currentSongId;
  $('btnRecord').setAttribute('aria-pressed', 'true');
  $('recPill').hidden = false;
  if (!transport.playing) play();
  toast('Recording — play along! Tap ● again to stop.');
}

function stopRecording(keep = true) {
  if (!recorder.active) return;
  recorder.active = false;
  $('btnRecord').setAttribute('aria-pressed', 'false');
  $('recPill').hidden = true;
  const t = transport.songTime;
  for (const n of recorder.open.values()) n.end = Math.max(t, n.start + 0.05);
  recorder.open.clear();
  if (keep && recorder.notes.length) {
    recorder.take = buildTakeSong(recorder.notes);
    toast('Recorded ' + recorder.notes.length + ' notes — open Practice to play it back.');
  } else if (keep) {
    toast('Nothing was recorded — no piano notes were played.');
  }
  updateTakeUi();
}

function updateTakeUi() {
  const has = !!recorder.take && recorder.songId === currentSongId;
  $('takeSection').hidden = !has;
  if (has) {
    const tk = recorder.take;
    $('takeInfo').textContent = tk.count + ' notes · ' + fmtTime(tk.start[0]) + ' – ' + fmtTime(tk.end[tk.count - 1]);
  }
}

function startReplay() {
  const tk = recorder.take;
  if (!tk || !tk.count) return;
  if (tutorPlan) stopTutor(true);
  pause();
  replay = { right: prefs.rightMuted, left: prefs.leftMuted };
  practice.setPracticeHands(false, false, 0);
  scheduler.allMuted = true;
  takeScheduler.setSong(tk);
  renderer.setTakeSong(tk);
  renderer.markSongKeys = false;
  closePanels();
  seekTo(tk.start[0] - 1);
  play({ noCountIn: true });
  toast('Playing back your recording');
}

function exitReplay() {
  if (!replay) return;
  const saved = replay;
  replay = null;
  pause();
  scheduler.allMuted = false;
  takeScheduler.setSong(null);
  renderer.setTakeSong(null);
  renderer.markSongKeys = true;
  prefs.rightMuted = saved.right;
  prefs.leftMuted = saved.left;
  applyHands();
}

// ----------------------------------------------------------- note input ----

function handleNoteOn(pitch, velocity, local) {
  if (!inKeyRange(pitch)) return;
  if (replay && !local) exitReplay();
  const kind = practice.noteOn(pitch, transport.songTime, transport.rate);
  syncHold(); // a completed chord releases Wait Mode immediately
  if (kind === KEY_HIT_RIGHT || kind === KEY_HIT_LEFT) renderer.burst(pitch, 9);
  if (local || prefs.monitor) {
    ensureAudio();
    synth.liveOn(pitch, velocity);
  }
  if (recorder.active && transport.playing) {
    const n = { pitch, start: transport.songTime, end: NaN, velocity };
    const prev = recorder.open.get(pitch);
    if (prev) prev.end = Math.max(transport.songTime, prev.start + 0.03);
    recorder.open.set(pitch, n);
    recorder.notes.push(n);
  }
  return kind;
}

function handleNoteOff(pitch) {
  if (!inKeyRange(pitch)) return;
  practice.noteOff(pitch);
  synth.liveOff(pitch);
  const n = recorder.open.get(pitch);
  if (n) {
    n.end = Math.max(transport.songTime, n.start + 0.03);
    recorder.open.delete(pitch);
  }
}

function handleAllOff() {
  practice.allNotesOff();
  synth.setSustain(false);
  for (let p = 21; p <= 108; p++) synth.liveOff(p);
  $('pedal').classList.remove('on');
}

function handleSustain(on) {
  synth.setSustain(on);
  $('pedal').classList.toggle('on', on);
}

function setConnStatus(text, kind) {
  const btn = $('btnConnect');
  btn.dataset.state = kind;
  $('connLabel').textContent = kind === 'ble' || kind === 'usb' || kind === 'busy' ? text : 'Connect Piano';
  $('btnDisconnect').hidden = !midiInput.bleConnected;
  if (kind === 'error') toast(text, true, 6500);
  else if (kind === 'idle' && text !== 'No piano connected') toast(text);
}

const midiInput = new MidiInput({
  onNoteOn: (p, v) => handleNoteOn(p, v, false),
  onNoteOff: handleNoteOff,
  onAllOff: handleAllOff,
  onSustain: handleSustain,
  onStatus: (t, k) => setConnStatus(t, k),
});

// ------------------------------------------------------------ frame loop ---

const lastUi = { sec: -1, dur: -1, progress: -1, statsVersion: -1, held: false, playing: false };
let uiClock = 0;

function updatePlayButton() {
  const b = $('btnPlay');
  const playing = transport.playing;
  b.classList.toggle('playing', playing);
  b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
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
    $('statCombo').textContent = String(practice.combo);
  }
  const held = transport.held && transport.playing;
  if (held !== lastUi.held) {
    lastUi.held = held;
    $('waitPill').hidden = !held || !$('coach').hidden;
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
  if (replay) takeScheduler.update();
  renderer.draw(transport.songTime, dt, transport.held && transport.playing);
  practice.decay(dt);

  if (transport.playing && song) {
    if (!transport.held) progress.addTime(currentSongId, dt);
    const t = transport.songTime;
    if (tutorPlan) {
      if (t >= tutorPlan.end + 0.25) tutorPassDone();
    } else if (replay) {
      const tk = recorder.take;
      if (!tk || t > tk.end[tk.count - 1] + 0.8) {
        exitReplay();
        toast('Playback finished');
      }
    } else if (loop.on && t >= loop.b) {
      onLoopPass();
      seekTo(loop.a - 0.6 * transport.rate);
      practice.snapshot(loop.snap);
    } else if (t > song.duration + 0.6) {
      pause();
      stopRecording(true);
      const judged = practice.hits + practice.misses + practice.wrong;
      if (judged > 0 && currentSongId) {
        const isBest = progress.finish(currentSongId, practice.accuracy(), practice.bestCombo);
        toast('Finished! Accuracy ' + Math.round(practice.accuracy() * 100) + '% · ' + practice.wrong + ' wrong · best combo ' + practice.bestCombo + (isBest ? ' · NEW BEST ★' : ''), false, 6000);
        if (isBest) for (let p = 40; p <= 90; p += 4) renderer.burst(p, 8);
      }
    }
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

function markSeg(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
}

function bindSeg(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    markSeg(id, b.dataset.v);
    onPick(b.dataset.v);
  });
}

const PANELS = ['connectPanel', 'practicePanel', 'settings'];
function togglePanel(id) {
  const el = $(id);
  const open = el.hidden;
  closePanels();
  el.hidden = !open;
  if (id === 'practicePanel') $('btnPractice').setAttribute('aria-pressed', String(open));
  if (id === 'settings' && open) {
    updateSampleState();
    drawThemePreviews();
  }
}
function closePanels() {
  for (const p of PANELS) $(p).hidden = true;
  $('btnPractice').setAttribute('aria-pressed', 'false');
}

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('scrim').hidden = false;
  closePanels();
  renderSongList();
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('scrim').hidden = true;
}

function setTheme(id) {
  const theme = getTheme(id);
  prefs.theme = theme.id;
  applyThemeToDocument(theme);
  renderer.setTheme(theme);
  for (const c of $('themeGrid').children) c.classList.toggle('on', c.dataset.id === theme.id);
  persistPrefs();
}

function buildThemeGrid() {
  const grid = $('themeGrid');
  grid.textContent = '';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-card' + (t.id === prefs.theme ? ' on' : '');
    b.dataset.id = t.id;
    const c = document.createElement('canvas');
    c.width = 220;
    c.height = 140;
    const label = document.createElement('span');
    label.textContent = t.name;
    b.append(c, label);
    b.addEventListener('click', () => setTheme(t.id));
    grid.append(b);
  }
}

/** Little static preview of each theme: background, two notes, keys. */
function drawThemePreviews() {
  for (const card of $('themeGrid').children) {
    const t = getTheme(card.dataset.id);
    const c = card.querySelector('canvas');
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, t.bgTop);
    bg.addColorStop(1, t.bgBottom);
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const keyTop = H * 0.68;
    const drawNote = (x, y, w, h, n) => {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, Math.min(8, t.radius * 1.5));
      else g.rect(x, y, w, h);
      g.fillStyle = n.fill;
      g.fill();
      if (n.stripe) {
        g.save();
        g.clip();
        g.strokeStyle = n.stripe;
        g.lineWidth = 6;
        for (let k = -4; k < 12; k++) {
          g.beginPath();
          g.moveTo(x + k * 14, y);
          g.lineTo(x + k * 14 - 30, y + 30);
          g.stroke();
        }
        g.restore();
      }
      if (t.outline) {
        g.strokeStyle = t.outline;
        g.lineWidth = 2;
        g.beginPath();
        if (g.roundRect) g.roundRect(x, y, w, h, Math.min(8, t.radius * 1.5));
        else g.rect(x, y, w, h);
        g.stroke();
      }
    };
    drawNote(60, 14, 26, 66, t.notes[0]);
    drawNote(120, 40, 26, 40, t.notes[1]);
    drawNote(160, 6, 26, 50, t.notes[0]);
    g.fillStyle = t.strike;
    g.fillRect(0, keyTop - 3, W, 3);
    g.fillStyle = '#f4f6fa';
    g.fillRect(0, keyTop, W, H - keyTop);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let x = 0; x < W; x += 22) g.fillRect(x, keyTop, 1, H - keyTop);
    g.fillStyle = '#111';
    for (let x = 14; x < W; x += 22) if ((x / 22) % 7 !== 2 && (x / 22) % 7 !== 6) g.fillRect(x, keyTop, 12, (H - keyTop) * 0.6);
    g.fillStyle = t.keyLit[0];
    g.fillRect(66, keyTop, 21, H - keyTop);
  }
}

function buildToneGrid() {
  const grid = $('toneGrid');
  grid.textContent = '';
  for (const t of TONES) {
    const b = document.createElement('button');
    b.className = 'chip' + (t.id === prefs.tone ? ' on' : '');
    b.dataset.id = t.id;
    b.textContent = t.name;
    b.addEventListener('click', () => {
      prefs.tone = t.id;
      synth.setTone(t.id);
      ensureAudio();
      for (const c of grid.children) c.classList.toggle('on', c.dataset.id === t.id);
      persistPrefs();
      // audition
      synth.liveOn(60, 90);
      synth.liveOn(64, 80);
      synth.liveOn(67, 80);
      setTimeout(() => {
        synth.liveOff(60);
        synth.liveOff(64);
        synth.liveOff(67);
      }, 450);
    });
    grid.append(b);
  }
}

function updateLatencyUi() {
  const manual = prefs.latencyMode === 'manual';
  markSeg('segLatency', prefs.latencyMode);
  const el = $('latency');
  el.disabled = !manual;
  el.value = String(prefs.latencyMs);
  $('latencyLabel').textContent = manual ? 'Delay ' + prefs.latencyMs + ' ms' : 'Auto (' + Math.round(synth.latency() * 1000) + ' ms)';
}

function applyLatency() {
  synth.setLatency(prefs.latencyMode, prefs.latencyMs / 1000);
  scheduler.retime(transport.songTime);
  updateLatencyUi();
  persistPrefs();
}

function bindUi() {
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnRestart').addEventListener('click', () => {
    ensureAudio();
    if (replay) exitReplay();
    const to = loop.on ? loop.a - 1 : leadIn;
    seekTo(to);
    practice.resetFrom(to, true);
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

  // Imports
  const fileInput = $('fileInput');
  const audioInput = $('audioInput');
  if (Capacitor.isNativePlatform()) fileInput.removeAttribute('accept'); // Android pickers grey out .mid by MIME
  $('btnImport').addEventListener('click', () => fileInput.click());
  $('btnImportAudio').addEventListener('click', () => audioInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    importFile(f);
  });
  audioInput.addEventListener('change', () => {
    const f = audioInput.files && audioInput.files[0];
    audioInput.value = '';
    if (f) importAudio(f);
  });
  $('txCancel').addEventListener('click', () => (txCancelled = true));

  // Connect menu
  $('btnConnect').addEventListener('click', () => {
    ensureAudio();
    $('btnDisconnect').hidden = !midiInput.bleConnected;
    togglePanel('connectPanel');
  });
  const connectBle = async (scanAll) => {
    closePanels();
    try {
      setConnStatus(scanAll ? 'Searching all devices…' : 'Searching…', 'busy');
      await midiInput.connectBluetooth({ scanAll });
      toast('Piano connected via Bluetooth — try playing a key!');
    } catch (err) {
      const name = err && err.name;
      const msg = (err && err.message) || String(err);
      if (name === 'NotFoundError' || /cancel/i.test(msg)) setConnStatus('No piano selected', 'idle');
      else setConnStatus(msg, 'error');
    }
  };
  $('btnBle').addEventListener('click', () => connectBle(false));
  $('btnBleAll').addEventListener('click', () => connectBle(true));
  $('btnUsb').addEventListener('click', async () => {
    closePanels();
    const ok = await midiInput.startWired({ interactive: true });
    if (ok) toast('Listening for USB MIDI — plug your piano’s USB port into the tablet');
  });
  $('btnDisconnect').addEventListener('click', async () => {
    closePanels();
    await midiInput.disconnectBluetooth();
  });

  // Practice panel
  $('btnPractice').addEventListener('click', () => togglePanel('practicePanel'));
  $('btnLoopA').addEventListener('click', () => setLoopPoint('a'));
  $('btnLoopB').addEventListener('click', () => setLoopPoint('b'));
  $('btnLoopOn').addEventListener('click', () => setLoopOn(!loop.on));
  $('btnLoopClear').addEventListener('click', clearLoop);
  bindSeg('segMemorize', (v) => setMemorize(parseInt(v, 10)));
  markSeg('segMemorize', String(prefs.memorize));
  $('memAuto').checked = prefs.memorizeAuto;
  $('memAuto').addEventListener('change', (e) => {
    prefs.memorizeAuto = e.target.checked;
    persistPrefs();
  });
  $('trainerOn').checked = prefs.trainer;
  $('trainerOn').addEventListener('change', (e) => {
    prefs.trainer = e.target.checked;
    if (prefs.trainer && loop.on) setRate(prefs.trainerStart, false);
    if (prefs.trainer && !loop.on) toast('Set a loop (A and B) — the speed goes up each time you play it cleanly.');
    persistPrefs();
  });
  bindSeg('segTrainerStart', (v) => {
    prefs.trainerStart = parseFloat(v);
    if (prefs.trainer && loop.on) setRate(prefs.trainerStart, false);
    persistPrefs();
  });
  markSeg('segTrainerStart', String(prefs.trainerStart));
  const metroBtn = $('btnMetro');
  metroBtn.setAttribute('aria-pressed', String(prefs.metronome));
  metroBtn.addEventListener('click', () => {
    prefs.metronome = !prefs.metronome;
    scheduler.metronome = prefs.metronome;
    metroBtn.setAttribute('aria-pressed', String(prefs.metronome));
    ensureAudio();
    persistPrefs();
  });
  const ciBtn = $('btnCountIn');
  ciBtn.setAttribute('aria-pressed', String(prefs.countIn));
  ciBtn.addEventListener('click', () => {
    prefs.countIn = !prefs.countIn;
    ciBtn.setAttribute('aria-pressed', String(prefs.countIn));
    persistPrefs();
  });
  $('metroVol').value = String(prefs.metroVolume);
  $('metroVol').addEventListener('input', (e) => {
    prefs.metroVolume = parseFloat(e.target.value);
    synth.setMetronomeVolume(prefs.metroVolume);
    persistPrefs();
  });
  $('btnTutor').addEventListener('click', () => {
    ensureAudio();
    startTutor();
  });
  $('coachStop').addEventListener('click', () => stopTutor(true));
  $('coachSkip').addEventListener('click', () => {
    if (!tutor.active) return;
    clearTimeout(tutorTimer);
    const next = tutor.skip();
    if (next) runPlan(next);
    else finishTutor();
  });
  $('coachRetry').addEventListener('click', () => {
    if (tutor.active && tutor.plan) runPlan(tutor.plan);
  });
  $('btnRecord').addEventListener('click', () => {
    ensureAudio();
    if (recorder.active) stopRecording(true);
    else startRecording();
  });
  $('btnPlayTake').addEventListener('click', () => {
    ensureAudio();
    startReplay();
  });
  $('btnDeleteTake').addEventListener('click', () => {
    recorder.take = null;
    updateTakeUi();
  });

  // Settings
  $('btnSettings').addEventListener('click', () => togglePanel('settings'));
  buildThemeGrid();
  buildToneGrid();
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
    renderer.setMemorize(tutorPlan ? 0 : prefs.memorize);
    persistPrefs();
  });
  bindSeg('segLabels', (v) => {
    prefs.labelMode = parseInt(v, 10);
    renderer.setLabelMode(prefs.labelMode);
    persistPrefs();
  });
  markSeg('segLabels', String(prefs.labelMode));
  $('effects').checked = prefs.effects;
  $('effects').addEventListener('change', (e) => {
    prefs.effects = e.target.checked;
    renderer.effects = prefs.effects;
    persistPrefs();
  });
  bindSeg('segLatency', (v) => {
    prefs.latencyMode = v;
    applyLatency();
  });
  $('latency').addEventListener('input', (e) => {
    prefs.latencyMs = parseInt(e.target.value, 10);
    applyLatency();
  });
  updateLatencyUi();
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
  const progressEl = $('progress');
  progressEl.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  const endScrub = () => {
    scrubbing = false;
  };
  progressEl.addEventListener('pointerup', endScrub);
  progressEl.addEventListener('pointercancel', endScrub);
  progressEl.addEventListener('input', () => {
    if (!song) return;
    seekTo((parseInt(progressEl.value, 10) / 1000) * song.duration);
  });

  // Canvas: key bed = play notes by touch; waterfall = drag to scrub.
  const canvas = $('stage');
  const pointerNote = new Map();
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    closePanels();
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
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
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
    if (document.hidden) {
      handleAllOff();
      progress.save();
    }
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
  updateSampleState();

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

// Test/diagnostic hook (state access + simulated MIDI input).
window.__pianoflow = {
  transport,
  practice,
  renderer,
  synth,
  scheduler,
  midiInput,
  tutor,
  progress,
  loop,
  recorder,
  get song() {
    return song;
  },
  get tutorPlan() {
    return tutorPlan;
  },
  get replaying() {
    return !!replay;
  },
  noteOn: (p, v = 100) => handleNoteOn(p, v, false),
  noteOff: handleNoteOff,
  bleBytes: (arr) => midiInput.bleParser.parse(new Uint8Array(arr)),
  seek: seekTo,
  play,
  pause,
  setRate,
  setWait,
  setTheme,
  setMemorize,
  setLoopPoint,
  setLoopOn,
  startTutor,
  stopTutor,
  startRecording,
  stopRecording,
  startReplay,
  importAudio,
  openSongById,
  listSongs,
  lowerBound,
  KEY_WRONG,
};

start();
