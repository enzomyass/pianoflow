// Step-by-step tutor ("coach"). Pure logic, no DOM, so it is unit-tested.
//
// The song (or the looped section) is cut into short phrases. Each phrase is
// taught in stages, no rush:
//   listen   → the tablet plays the phrase for you
//   right    → right hand only, Wait Mode on, slow (left played by tablet)
//   left     → left hand only, Wait Mode on, slow
//   together → both hands, Wait Mode on
//   tempo    → both hands without waiting, speed steps up to 100%
//   link     → previous phrase + this phrase together, so they connect
// A stage passes when it is played cleanly; otherwise it repeats with a hint
// about the note that caused the most trouble, slowing down after repeated
// struggles.

import { HAND_LEFT, HAND_RIGHT, NOTE_NAMES, lowerBound } from './constants.js';

const CHORD_EPS = 0.04;
const MAX_STEPS = 6;
const GAP_SPLIT = 1.2;

export const STAGE_LABEL = {
  listen: 'Listen',
  right: 'Right hand',
  left: 'Left hand',
  together: 'Both hands',
  tempo: 'Up to speed',
  link: 'Connect phrases',
};

/** Splits [from, to) of a song into phrases of up to MAX_STEPS chord steps. */
export function buildPhrases(song, from, to) {
  const steps = []; // {t, hasR, hasL, end}
  const i0 = lowerBound(song.start, song.count, from - 1e-6);
  for (let i = i0; i < song.count && song.start[i] < to; i++) {
    if (!song.inRange[i]) continue;
    const h = song.hand[i];
    if (h !== HAND_RIGHT && h !== HAND_LEFT) continue;
    const t = song.start[i];
    let st = steps.length ? steps[steps.length - 1] : null;
    if (!st || t - st.t > CHORD_EPS) {
      st = { t, hasR: false, hasL: false, end: t };
      steps.push(st);
    }
    if (h === HAND_RIGHT) st.hasR = true;
    else st.hasL = true;
    if (song.end[i] > st.end) st.end = song.end[i];
  }
  const phrases = [];
  let cur = null;
  for (let k = 0; k < steps.length; k++) {
    const st = steps[k];
    const prev = k > 0 ? steps[k - 1] : null;
    const split = !cur || cur.steps >= MAX_STEPS || (prev && st.t - prev.t > GAP_SPLIT);
    if (split) {
      if (cur) phrases.push(cur);
      cur = { start: st.t, end: st.end, lastStep: st.t, steps: 0, hasR: false, hasL: false };
    }
    cur.steps++;
    cur.lastStep = st.t;
    if (st.end > cur.end) cur.end = st.end;
    cur.hasR = cur.hasR || st.hasR;
    cur.hasL = cur.hasL || st.hasL;
  }
  if (cur) phrases.push(cur);
  // A phrase ends just after its last chord step (not at the end of long held
  // notes), capped before the next phrase begins.
  for (let k = 0; k < phrases.length; k++) {
    const ph = phrases[k];
    let end = Math.min(ph.end, ph.lastStep + 1.0);
    if (end < ph.lastStep + 0.25) end = ph.lastStep + 0.25;
    if (k + 1 < phrases.length && end > phrases[k + 1].start - 0.02) end = phrases[k + 1].start - 0.02;
    ph.end = Math.max(end, ph.lastStep + 0.05);
  }
  return phrases;
}

export class Tutor {
  constructor() {
    this.active = false;
    this.phrases = [];
    this.pi = 0;
    this.stages = [];
    this.si = 0;
    this.attempts = 0;
    this.rate = 1;
    this.tempoRate = 0.8;
    this.plan = null;
  }

  /** @returns {object|null} first plan, or null when there is nothing to teach */
  start(song, from, to) {
    this.phrases = buildPhrases(song, from, to);
    this.active = this.phrases.length > 0;
    if (!this.active) return null;
    this.pi = 0;
    this._enterPhrase();
    return this._makePlan('Let’s learn this step by step. First, just listen.');
  }

  stop() {
    this.active = false;
    this.plan = null;
  }

  _enterPhrase() {
    const ph = this.phrases[this.pi];
    const st = ['listen'];
    if (ph.hasR && ph.hasL) st.push('right', 'left');
    st.push('together', 'tempo');
    if (this.pi > 0) st.push('link');
    this.stages = st;
    this.si = 0;
    this.attempts = 0;
    this.tempoRate = 0.8;
  }

  _baseRate(stage) {
    switch (stage) {
      case 'listen':
        return 0.85;
      case 'right':
      case 'left':
        return 0.7;
      case 'together':
        return 0.75;
      case 'tempo':
        return this.tempoRate;
      default:
        return 0.85;
    }
  }

  _makePlan(message) {
    const ph = this.phrases[this.pi];
    const stage = this.stages[this.si];
    let start = ph.start;
    let hasR = ph.hasR;
    let hasL = ph.hasL;
    if (stage === 'link') {
      const prev = this.phrases[this.pi - 1];
      start = prev.start;
      hasR = hasR || prev.hasR;
      hasL = hasL || prev.hasL;
    }
    const slow = Math.max(0, this.attempts - 2) * 0.1; // slow down after repeated struggles
    let rate = Math.max(0.4, this._baseRate(stage) - (stage === 'tempo' ? 0 : slow));
    rate = Math.round(rate * 100) / 100;
    this.rate = rate;
    this.plan = {
      stage,
      label: STAGE_LABEL[stage],
      phrase: this.pi + 1,
      phraseCount: this.phrases.length,
      stageIndex: this.si + 1,
      stageCount: this.stages.length,
      start,
      end: ph.end,
      listen: stage === 'listen',
      right: stage === 'listen' ? false : stage === 'left' ? false : hasR,
      left: stage === 'listen' ? false : stage === 'right' ? false : hasL,
      wait: stage !== 'listen' && stage !== 'tempo',
      rate,
      attempt: this.attempts + 1,
      message,
    };
    return this.plan;
  }

  _stageIntro(stage) {
    switch (stage) {
      case 'right':
        return 'Your turn — right hand only. Take your time, the music waits for you.';
      case 'left':
        return 'Now the left hand. I’ll play the right hand for you.';
      case 'together':
        return 'Both hands together now. No rush.';
      case 'tempo':
        return 'Nice! Now keep going without waiting, at ' + Math.round(this.tempoRate * 100) + '% speed.';
      case 'link':
        return 'Let’s connect it with the previous phrase.';
      default:
        return 'Listen to the next phrase.';
    }
  }

  /**
   * Reports the result of the pass that just finished.
   * @param {{hits:number, misses:number, wrong:number, worstPitch:number}} r
   * @returns {object|null} next plan, or null when the lesson is finished
   */
  passComplete(r) {
    if (!this.active) return null;
    const stage = this.stages[this.si];
    const judged = r.hits + r.misses + r.wrong;
    const acc = judged === 0 ? 1 : r.hits / judged;
    let passed;
    if (stage === 'listen') passed = true;
    else if (stage === 'tempo') passed = acc >= 0.9 && r.misses + r.wrong <= 2;
    else passed = r.wrong <= 1 && r.misses === 0;

    if (!passed) {
      this.attempts++;
      const name = r.worstPitch >= 0 ? NOTE_NAMES[r.worstPitch] : null;
      let msg = name ? 'Almost! Watch out for ' + name + '. Let’s try that again.' : 'Almost! Let’s try that again.';
      if (stage === 'tempo' && this.tempoRate > 0.6 && this.attempts >= 2) {
        this.tempoRate = Math.round((this.tempoRate - 0.1) * 100) / 100;
        msg = 'Let’s slow it down a little (' + Math.round(this.tempoRate * 100) + '%) and try again.';
      } else if (this.attempts >= 3 && stage !== 'tempo') {
        msg += ' I slowed it down for you.';
      }
      return this._makePlan(msg);
    }

    if (stage === 'tempo' && this.tempoRate < 1) {
      this.tempoRate = Math.min(1, Math.round((this.tempoRate + 0.1) * 100) / 100);
      this.attempts = 0;
      return this._makePlan('Clean! Speeding up to ' + Math.round(this.tempoRate * 100) + '%.');
    }

    this.si++;
    this.attempts = 0;
    if (this.si < this.stages.length) {
      const praise = stage === 'listen' ? '' : 'Great job! ';
      return this._makePlan(praise + this._stageIntro(this.stages[this.si]));
    }
    this.pi++;
    if (this.pi >= this.phrases.length) {
      this.active = false;
      this.plan = null;
      return null;
    }
    this._enterPhrase();
    return this._makePlan('Phrase ' + this.pi + ' done! 🎉 On to phrase ' + (this.pi + 1) + ' — listen first.');
  }

  /** Skips the current stage. */
  skip() {
    if (this.active && this.stages[this.si] === 'tempo') this.tempoRate = 1;
    return this.passComplete({ hits: 1, misses: 0, wrong: 0, worstPitch: -1, skip: true }) || null;
  }
}
