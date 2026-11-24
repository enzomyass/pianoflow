// Practice progress: per-song bests, practice time and a daily streak.
// Small JSON in localStorage (safe to lose; never blocks the app).

const KEY = 'pianoflow.progress';

function today(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export class Progress {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.data = { songs: {}, days: {}, totalSeconds: 0 };
    try {
      const raw = storage && storage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (_) {
      /* corrupt or unavailable */
    }
    this.pending = 0;
  }

  save() {
    try {
      if (this.storage) this.storage.setItem(KEY, JSON.stringify(this.data));
    } catch (_) {
      /* quota */
    }
  }

  song(id) {
    let s = this.data.songs[id];
    if (!s) {
      s = { best: 0, bestCombo: 0, plays: 0, seconds: 0, last: 0 };
      this.data.songs[id] = s;
    }
    return s;
  }

  /** Adds practice time (real seconds). Persists at most every ~15 s. */
  addTime(id, seconds, now = new Date()) {
    if (!(seconds > 0) || !id) return;
    const s = this.song(id);
    s.seconds += seconds;
    s.last = now.getTime();
    this.data.totalSeconds += seconds;
    const d = today(now);
    this.data.days[d] = (this.data.days[d] || 0) + seconds;
    this.pending += seconds;
    if (this.pending > 15) {
      this.pending = 0;
      this.save();
    }
  }

  /** Records a finished play-through. Returns true for a new best. */
  finish(id, accuracy, combo) {
    const s = this.song(id);
    s.plays++;
    const pct = Math.round(accuracy * 100);
    const isBest = pct > s.best;
    if (isBest) s.best = pct;
    if (combo > s.bestCombo) s.bestCombo = combo;
    this.save();
    return isBest;
  }

  /** Consecutive days (ending today or yesterday) with ≥ 60 s of practice. */
  streak(now = new Date()) {
    let n = 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!((this.data.days[today(d)] || 0) >= 60)) d.setDate(d.getDate() - 1);
    while ((this.data.days[today(d)] || 0) >= 60) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  todaySeconds(now = new Date()) {
    return this.data.days[today(now)] || 0;
  }
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
