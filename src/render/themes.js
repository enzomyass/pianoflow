// Visual themes. Every colour the renderer and the DOM chrome use comes from
// here, so switching theme only rebuilds cached canvases/gradients (never
// per frame). Wrong-note red is fixed at #ff2a4d in every theme by spec.

export const WRONG_RED = '#ff2a4d';

/**
 * notes[hand] (0 right, 1 left, 2 accompaniment):
 *   fill / fillBlack : note body for white-key / black-key pitches
 *   hit              : body after a correct hit
 *   missed / skipped : body after a miss / for passed notes
 *   stripe           : optional stripe colour (candy-cane pattern over `fill`)
 *   glow, edge       : halo and top highlight (null = none)
 *   label            : pitch label colour on the body
 * keyLit: [right, left] colours for correctly hit keys and tablet-played keys.
 * particles: style 'confetti' | 'spark' | 'bubble' | 'petal', colours list.
 */
export const THEMES = [
  {
    id: 'neon',
    name: 'Neon Night',
    light: false,
    bgTop: '#0c0e14',
    bgBottom: '#0c0e14',
    vignette: 'rgba(40,70,110,0.20)',
    laneC: 'rgba(255,255,255,0.055)',
    laneF: 'rgba(255,255,255,0.025)',
    notes: [
      { fill: '#1fc8f5', fillBlack: '#0f8fc0', hit: '#8cf0ff', missed: '#3a4252', skipped: '#1f6f86', stripe: null, glow: 'rgba(34,211,255,0.16)', edge: 'rgba(220,250,255,0.75)', label: '#03141c' },
      { fill: '#27e6a0', fillBlack: '#139a6c', hit: '#9dffd8', missed: '#3a4a45', skipped: '#1c7a5a', stripe: null, glow: 'rgba(44,245,168,0.16)', edge: 'rgba(225,255,240,0.75)', label: '#03140d' },
      { fill: 'rgba(155,123,255,0.55)', fillBlack: 'rgba(110,85,210,0.55)', hit: 'rgba(190,170,255,0.7)', missed: 'rgba(90,80,120,0.45)', skipped: 'rgba(110,95,170,0.35)', stripe: null, glow: null, edge: null, label: '#f0ecff' },
    ],
    outline: null,
    outlineBlack: 'rgba(0,0,0,0.55)',
    labelMuted: '#c9ced8',
    radius: 4,
    strike: 'rgba(160,240,255,0.85)',
    strikeGlow: 'rgba(34,211,255,0.28)',
    strikeWait: '#ffd166',
    loop: '#ffd166',
    keyLit: ['#22d3ff', '#2cf5a8', '#9b7bff'],
    neutral: '#cfe9ff',
    particles: { style: 'spark', colors: ['#22d3ff', '#8cf0ff', '#2cf5a8', '#ffffff'] },
    keyLabel: 'rgba(40,60,80,0.55)',
    ui: { bg: '#0c0e14', glass: 'rgba(22,26,38,0.62)', glassStrong: 'rgba(18,21,31,0.94)', line: 'rgba(255,255,255,0.08)', lineStrong: 'rgba(255,255,255,0.16)', text: '#e8ecf4', muted: '#8b93a7', accent: '#22d3ff', accent2: '#2cf5a8' },
  },
  {
    id: 'candy',
    name: 'Candy Cane',
    light: true,
    bgTop: '#f7f5f0',
    bgBottom: '#f1eee7',
    vignette: null,
    laneC: 'rgba(60,40,40,0.10)',
    laneF: 'rgba(60,40,40,0.05)',
    notes: [
      { fill: '#ffffff', fillBlack: '#fbf7f2', hit: '#ffffff', missed: '#d9d4cc', skipped: '#ece7df', stripe: '#d4233a', glow: null, edge: null, label: '#a3172a' },
      { fill: '#ffffff', fillBlack: '#f7fbf8', hit: '#ffffff', missed: '#d9d4cc', skipped: '#ece7df', stripe: '#1f8a4c', glow: null, edge: null, label: '#16683a' },
      { fill: '#fff3d6', fillBlack: '#f7e7c0', hit: '#fff9ea', missed: '#ddd6c8', skipped: '#eee8dc', stripe: '#d9a21b', glow: null, edge: null, label: '#8a6408' },
    ],
    outline: '#5b1d24',
    outlineBlack: '#5b1d24',
    labelBadge: '#ffffff',
    labelMuted: '#8d867c',
    radius: 7,
    strike: 'rgba(212,35,58,0.55)',
    strikeGlow: 'rgba(212,35,58,0.10)',
    strikeWait: '#1f8a4c',
    loop: '#1f8a4c',
    keyLit: ['#e0566a', '#3fb27a', '#e2b33a'],
    neutral: '#c9c2b8',
    particles: { style: 'confetti', colors: ['#d4233a', '#1f8a4c', '#e8b923', '#ffffff', '#f06d80'] },
    keyLabel: 'rgba(60,40,40,0.55)',
    ui: { bg: '#f4f1ea', glass: 'rgba(255,255,255,0.72)', glassStrong: 'rgba(252,250,246,0.96)', line: 'rgba(60,30,30,0.10)', lineStrong: 'rgba(60,30,30,0.20)', text: '#3a1d20', muted: '#8a7d78', accent: '#d4233a', accent2: '#1f8a4c' },
  },
  {
    id: 'gold',
    name: 'Midnight Gold',
    light: false,
    bgTop: '#07070a',
    bgBottom: '#111014',
    vignette: 'rgba(120,95,40,0.16)',
    laneC: 'rgba(230,200,140,0.07)',
    laneF: 'rgba(230,200,140,0.03)',
    notes: [
      { fill: '#e9c46a', fillBlack: '#c9a14a', hit: '#fff1c4', missed: '#3b3528', skipped: '#7a6533', stripe: null, glow: 'rgba(233,196,106,0.18)', edge: 'rgba(255,248,220,0.8)', label: '#2a1e05' },
      { fill: '#e8e1d3', fillBlack: '#bdb4a3', hit: '#ffffff', missed: '#38352f', skipped: '#6d675c', stripe: null, glow: 'rgba(232,225,211,0.14)', edge: 'rgba(255,255,255,0.8)', label: '#1f1b14' },
      { fill: 'rgba(150,120,80,0.5)', fillBlack: 'rgba(120,95,60,0.5)', hit: 'rgba(190,160,110,0.7)', missed: 'rgba(70,60,45,0.45)', skipped: 'rgba(100,85,60,0.35)', stripe: null, glow: null, edge: null, label: '#f5ead2' },
    ],
    outline: null,
    outlineBlack: 'rgba(0,0,0,0.6)',
    labelMuted: '#a69c88',
    radius: 3,
    strike: 'rgba(233,196,106,0.85)',
    strikeGlow: 'rgba(233,196,106,0.22)',
    strikeWait: '#ffffff',
    loop: '#ffffff',
    keyLit: ['#e9c46a', '#f3eee2', '#a68a5b'],
    neutral: '#d8cfbd',
    particles: { style: 'spark', colors: ['#e9c46a', '#fff1c4', '#ffffff'] },
    keyLabel: 'rgba(80,60,30,0.55)',
    ui: { bg: '#09090c', glass: 'rgba(24,22,18,0.66)', glassStrong: 'rgba(20,18,15,0.95)', line: 'rgba(233,196,106,0.12)', lineStrong: 'rgba(233,196,106,0.25)', text: '#f3ead6', muted: '#a39883', accent: '#e9c46a', accent2: '#f3eee2' },
  },
  {
    id: 'sakura',
    name: 'Sakura Dusk',
    light: false,
    bgTop: '#2a1530',
    bgBottom: '#4a2240',
    vignette: 'rgba(255,170,200,0.12)',
    laneC: 'rgba(255,220,235,0.08)',
    laneF: 'rgba(255,220,235,0.035)',
    notes: [
      { fill: '#ff9ec4', fillBlack: '#e9729f', hit: '#ffd6e7', missed: '#5a3b4c', skipped: '#9a5577', stripe: null, glow: 'rgba(255,158,196,0.2)', edge: 'rgba(255,240,246,0.8)', label: '#3d0c22' },
      { fill: '#b9a3ff', fillBlack: '#9178e8', hit: '#e1d8ff', missed: '#463f5c', skipped: '#6e5ea8', stripe: null, glow: 'rgba(185,163,255,0.18)', edge: 'rgba(245,240,255,0.8)', label: '#1d1340' },
      { fill: 'rgba(255,214,140,0.45)', fillBlack: 'rgba(230,180,110,0.45)', hit: 'rgba(255,230,180,0.6)', missed: 'rgba(100,80,70,0.4)', skipped: 'rgba(150,120,90,0.3)', stripe: null, glow: null, edge: null, label: '#fff4e0' },
    ],
    outline: null,
    outlineBlack: 'rgba(40,0,20,0.5)',
    labelMuted: '#d8bccb',
    radius: 8,
    strike: 'rgba(255,190,215,0.85)',
    strikeGlow: 'rgba(255,158,196,0.25)',
    strikeWait: '#fff3a8',
    loop: '#fff3a8',
    keyLit: ['#ff9ec4', '#b9a3ff', '#ffd68c'],
    neutral: '#f3dbe6',
    particles: { style: 'petal', colors: ['#ffc2d9', '#ff9ec4', '#ffe4ee', '#ffffff'] },
    keyLabel: 'rgba(80,30,60,0.5)',
    ui: { bg: '#2a1530', glass: 'rgba(60,28,58,0.6)', glassStrong: 'rgba(48,22,46,0.95)', line: 'rgba(255,200,225,0.12)', lineStrong: 'rgba(255,200,225,0.24)', text: '#fbeef4', muted: '#cfa9bd', accent: '#ff9ec4', accent2: '#b9a3ff' },
  },
  {
    id: 'ocean',
    name: 'Ocean Deep',
    light: false,
    bgTop: '#021627',
    bgBottom: '#04314a',
    vignette: 'rgba(90,200,255,0.12)',
    laneC: 'rgba(160,230,255,0.07)',
    laneF: 'rgba(160,230,255,0.03)',
    notes: [
      { fill: '#4fd8ff', fillBlack: '#24a9d6', hit: '#c4f3ff', missed: '#2a4152', skipped: '#1d6a88', stripe: null, glow: 'rgba(79,216,255,0.18)', edge: 'rgba(230,250,255,0.8)', label: '#01202e' },
      { fill: '#3ee8c4', fillBlack: '#1fb595', hit: '#b8fff0', missed: '#294a45', skipped: '#1b7a68', stripe: null, glow: 'rgba(62,232,196,0.16)', edge: 'rgba(225,255,248,0.8)', label: '#012a20' },
      { fill: 'rgba(120,160,255,0.45)', fillBlack: 'rgba(90,130,220,0.45)', hit: 'rgba(170,200,255,0.6)', missed: 'rgba(60,80,110,0.4)', skipped: 'rgba(80,110,160,0.3)', stripe: null, glow: null, edge: null, label: '#eef4ff' },
    ],
    outline: null,
    outlineBlack: 'rgba(0,10,25,0.55)',
    labelMuted: '#a9c6d6',
    radius: 10,
    strike: 'rgba(140,235,255,0.85)',
    strikeGlow: 'rgba(79,216,255,0.25)',
    strikeWait: '#ffe28a',
    loop: '#ffe28a',
    keyLit: ['#4fd8ff', '#3ee8c4', '#7aa0ff'],
    neutral: '#cdeefa',
    particles: { style: 'bubble', colors: ['#bff3ff', '#7fe3ff', '#ffffff'] },
    keyLabel: 'rgba(20,60,90,0.55)',
    ui: { bg: '#021627', glass: 'rgba(8,40,64,0.6)', glassStrong: 'rgba(5,32,52,0.95)', line: 'rgba(140,220,255,0.12)', lineStrong: 'rgba(140,220,255,0.24)', text: '#e6f7ff', muted: '#8fb6c9', accent: '#4fd8ff', accent2: '#3ee8c4' },
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    light: false,
    bgTop: '#12002a',
    bgBottom: '#3a0a4a',
    vignette: 'rgba(255,60,180,0.16)',
    laneC: 'rgba(255,90,210,0.12)',
    laneF: 'rgba(255,90,210,0.05)',
    notes: [
      { fill: '#ff3fb4', fillBlack: '#d01f8c', hit: '#ffb3e3', missed: '#4b2440', skipped: '#8a2a6e', stripe: null, glow: 'rgba(255,63,180,0.25)', edge: 'rgba(255,230,246,0.85)', label: '#2a0019' },
      { fill: '#ff9a3c', fillBlack: '#e0731a', hit: '#ffd3a8', missed: '#4b3424', skipped: '#8a5a2a', stripe: null, glow: 'rgba(255,154,60,0.22)', edge: 'rgba(255,240,225,0.85)', label: '#2a1200' },
      { fill: 'rgba(80,220,255,0.45)', fillBlack: 'rgba(50,180,220,0.45)', hit: 'rgba(150,240,255,0.6)', missed: 'rgba(60,70,100,0.4)', skipped: 'rgba(60,120,150,0.3)', stripe: null, glow: null, edge: null, label: '#eafcff' },
    ],
    outline: null,
    outlineBlack: 'rgba(20,0,30,0.6)',
    labelMuted: '#c7a6c9',
    radius: 2,
    strike: 'rgba(80,230,255,0.9)',
    strikeGlow: 'rgba(255,63,180,0.3)',
    strikeWait: '#fff35c',
    loop: '#fff35c',
    keyLit: ['#ff3fb4', '#ff9a3c', '#50dcff'],
    neutral: '#f3d6f0',
    particles: { style: 'spark', colors: ['#ff3fb4', '#ff9a3c', '#50dcff', '#fff35c'] },
    keyLabel: 'rgba(80,0,60,0.55)',
    ui: { bg: '#12002a', glass: 'rgba(40,6,60,0.6)', glassStrong: 'rgba(30,4,48,0.95)', line: 'rgba(255,90,210,0.16)', lineStrong: 'rgba(255,90,210,0.3)', text: '#fde9ff', muted: '#c39ad0', accent: '#ff3fb4', accent2: '#ff9a3c' },
  },
  {
    id: 'paper',
    name: 'Paper Classic',
    light: true,
    bgTop: '#ffffff',
    bgBottom: '#f3f4f7',
    vignette: null,
    laneC: 'rgba(20,30,60,0.09)',
    laneF: 'rgba(20,30,60,0.04)',
    notes: [
      { fill: '#3d6ef5', fillBlack: '#2a51c4', hit: '#8fb0ff', missed: '#c9ccd4', skipped: '#9fb4ea', stripe: null, glow: null, edge: 'rgba(255,255,255,0.6)', label: '#ffffff' },
      { fill: '#f2665a', fillBlack: '#cf4a3f', hit: '#ffb0a8', missed: '#d0c9c8', skipped: '#eaa9a2', stripe: null, glow: null, edge: 'rgba(255,255,255,0.6)', label: '#ffffff' },
      { fill: 'rgba(120,120,140,0.35)', fillBlack: 'rgba(100,100,120,0.35)', hit: 'rgba(150,150,170,0.5)', missed: 'rgba(200,200,205,0.4)', skipped: 'rgba(170,170,180,0.3)', stripe: null, glow: null, edge: null, label: '#2a2a35' },
    ],
    outline: 'rgba(20,30,60,0.35)',
    outlineBlack: 'rgba(20,30,60,0.5)',
    labelMuted: '#6c7280',
    radius: 5,
    strike: 'rgba(20,30,60,0.45)',
    strikeGlow: 'rgba(61,110,245,0.10)',
    strikeWait: '#f59e0b',
    loop: '#f59e0b',
    keyLit: ['#3d6ef5', '#f2665a', '#8a8aa0'],
    neutral: '#c8ccd6',
    particles: { style: 'confetti', colors: ['#3d6ef5', '#f2665a', '#f5b400', '#22b07d'] },
    keyLabel: 'rgba(20,30,60,0.5)',
    ui: { bg: '#f3f4f7', glass: 'rgba(255,255,255,0.75)', glassStrong: 'rgba(255,255,255,0.97)', line: 'rgba(20,30,60,0.10)', lineStrong: 'rgba(20,30,60,0.2)', text: '#1d2333', muted: '#6c7280', accent: '#3d6ef5', accent2: '#f2665a' },
  },
];

export function getTheme(id) {
  for (const t of THEMES) if (t.id === id) return t;
  return THEMES[0];
}

/** Applies a theme's chrome colours to CSS variables. */
export function applyThemeToDocument(theme, root = document.documentElement) {
  const u = theme.ui;
  root.style.setProperty('--bg', u.bg);
  root.style.setProperty('--glass', u.glass);
  root.style.setProperty('--glass-strong', u.glassStrong);
  root.style.setProperty('--line', u.line);
  root.style.setProperty('--line-strong', u.lineStrong);
  root.style.setProperty('--text', u.text);
  root.style.setProperty('--muted', u.muted);
  root.style.setProperty('--cyan', u.accent);
  root.style.setProperty('--mint', u.accent2);
  root.dataset.theme = theme.light ? 'light' : 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', u.bg);
}
