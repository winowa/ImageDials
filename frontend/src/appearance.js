/**
 * Appearance: the colour mode (dark / light / system) and the accent colour.
 *
 * This module is the single owner of both. The page boot script in index.html
 * only replays the `paint` snapshot written here, so the first frame already
 * matches. Accent colours are measured, not assumed: every candidate is
 * rendered to 8-bit sRGB and its WCAG contrast is computed from those bytes.
 */

/** localStorage key for the mode; kept from the original theme toggle. */
export const MODE_KEY = 'imagedials-theme';
/** localStorage key for the accent settings. */
export const ACCENT_KEY = 'imagedials-accent';
/** Version of the stored accent record; any other version is discarded. */
export const ACCENT_VERSION = 1;

export const MODES = ['dark', 'light', 'system'];
/** Mode used when nothing valid is stored. */
export const DEFAULT_MODE = 'dark';

/** Saturation scales a swatch's chroma. Unit: percent. */
export const SATURATION = { min: 50, max: 150, step: 5, initial: 100 };
/** Luminance scales a swatch's OKLCH lightness. Unit: percent. */
export const LUMINANCE = { min: 70, max: 160, step: 5, initial: 100 };

/** Minimum WCAG contrast ratios (unitless, ratio to 1). */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_FOCUS_CONTRAST = 3;
/** Lightness search step while moving an accent toward legibility. */
const LIGHTNESS_STEP = 0.005;
/** Upper bound on search steps (0.005 each) across the lightness range. */
const MAX_SEARCH_STEPS = 200;
/** Base accent lightness in OKLCH (0-1) per theme at 100% luminance. */
const BASE_LIGHTNESS = { dark: 0.77, light: 0.5 };
/** Opacity of the selected-state tint, per theme (0-1). */
const TINT_ALPHA = { dark: 0.16, light: 0.12 };
/** Focus ring lightness offset from the accent (OKLCH, 0-1). */
const FOCUS_SHIFT = { dark: 0.04, light: -0.05 };

/**
 * Neutral surfaces as [L, C, hue] in OKLCH. These mirror the `:root` tokens in
 * index.css (a test compares them) so contrast is measured on real colours.
 */
export const NEUTRALS = {
  dark: {
    background: [0.145, 0.008, 250],
    surface: [0.185, 0.006, 250],
    surface2: [0.235, 0.008, 250],
    foreground: [0.96, 0.003, 250],
    muted: [0.72, 0.005, 250],
  },
  light: {
    background: [0.965, 0.004, 250],
    surface: [0.99, 0.002, 250],
    surface2: [0.935, 0.005, 250],
    foreground: [0.22, 0.008, 250],
    muted: [0.44, 0.006, 250],
  },
};

/** Ink used on accent fills: dark ink in the dark theme, light in the light. */
const INK = { dark: [0.17, 0.015], light: [0.99, 0.002, 250] };

/** Accent swatches: stable id, label, OKLCH hue (degrees) and chroma. */
export const SWATCHES = [
  { id: 'bronze', label: 'Bronze', hue: 78, chroma: 0.075 },
  { id: 'gold', label: 'Gold', hue: 92, chroma: 0.1 },
  { id: 'olive', label: 'Olive', hue: 118, chroma: 0.085 },
  { id: 'moss', label: 'Moss', hue: 148, chroma: 0.085 },
  { id: 'teal', label: 'Teal', hue: 188, chroma: 0.08 },
  { id: 'slate', label: 'Slate', hue: 228, chroma: 0.06 },
  { id: 'blue', label: 'Blue', hue: 256, chroma: 0.11 },
  { id: 'indigo', label: 'Indigo', hue: 282, chroma: 0.11 },
  { id: 'violet', label: 'Violet', hue: 312, chroma: 0.1 },
  { id: 'plum', label: 'Plum', hue: 340, chroma: 0.09 },
  { id: 'rose', label: 'Rose', hue: 10, chroma: 0.1 },
  { id: 'copper', label: 'Copper', hue: 48, chroma: 0.1 },
  // Named anchors at 100% saturation and luminance; 150% is oversaturation.
  // Theme-specific readability adjustments are reported separately.
  {
    id: 'rebecca',
    label: 'Rebecca',
    hue: 303.3729902183438,
    chroma: 0.1602959833287913,
    lightness: 0.4402717939570897,
  },
  {
    id: 'lagoon',
    label: 'Lagoon',
    hue: 204.55356526995678,
    chroma: 0.11386717386594027,
    lightness: 0.6672953464925647,
  },
];
export const DEFAULT_SWATCH = 'bronze';

export const DEFAULT_ACCENT = {
  swatch: DEFAULT_SWATCH,
  saturation: SATURATION.initial,
  luminance: LUMINANCE.initial,
};

// ---------------------------------------------------------------- colour math

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Linear-light sRGB (unclamped) for an OKLCH colour. */
function oklchToLinear(l, c, hueDegrees) {
  const h = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const encode = (v) =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const GAMUT_EPSILON = 1e-6;
const inGamut = (rgb) =>
  rgb.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);

/** 8-bit sRGB bytes; chroma is reduced until the colour fits the gamut. */
export function oklchToBytes(l, c, hue) {
  let rgb = oklchToLinear(l, c, hue);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear(l, mid, hue))) low = mid;
      else high = mid;
    }
    rgb = oklchToLinear(l, low, hue);
  }
  return rgb.map((v) => Math.round(clamp(encode(clamp(v, 0, 1)), 0, 1) * 255));
}

export const toHex = (bytes) =>
  `#${bytes.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export function parseHex(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null;
}

/** WCAG relative luminance of 8-bit sRGB bytes. */
export const relativeLuminance = ([r, g, b]) =>
  0.2126 * decode(r / 255) +
  0.7152 * decode(g / 255) +
  0.0722 * decode(b / 255);

/** WCAG contrast ratio between two byte triples. */
export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Composite `top` at `alpha` over `base`, rounded to bytes. */
export const blend = (top, base, alpha) =>
  top.map((v, i) => Math.round(v * alpha + base[i] * (1 - alpha)));

const neutralBytes = (theme) =>
  Object.fromEntries(
    Object.entries(NEUTRALS[theme]).map(([name, [l, c, h]]) => [
      name,
      oklchToBytes(l, c, h),
    ]),
  );

// -------------------------------------------------------------- accent tokens

export const swatchById = (id) =>
  SWATCHES.find((s) => s.id === id) ?? SWATCHES[0];

/** One accent in one theme, with every required contrast measured. */
function build(theme, swatch, chroma, lightness) {
  const n = neutralBytes(theme);
  const accent = oklchToBytes(lightness, chroma, swatch.hue);
  const [inkL, inkC, inkH = swatch.hue] = INK[theme];
  const ink = oklchToBytes(inkL, inkC, inkH);
  const focus = oklchToBytes(
    clamp(lightness + FOCUS_SHIFT[theme], 0, 1),
    chroma,
    swatch.hue,
  );
  const alpha = Math.round(TINT_ALPHA[theme] * 255);
  const soft = [...accent, alpha];
  const tintOn = (base) => blend(accent, base, alpha / 255);
  const surfaces = [n.background, n.surface, n.surface2];
  const lowest = (pairs) =>
    Math.min(...pairs.map(([a, b]) => contrastRatio(a, b)));
  const measured = {
    accentText: lowest(surfaces.map((s) => [accent, s])),
    buttonText: contrastRatio(ink, accent),
    focusRing: lowest(surfaces.map((s) => [focus, s])),
    selectedText: lowest(
      [n.surface, n.surface2].flatMap((base) => [
        [n.foreground, tintOn(base)],
        [n.muted, tintOn(base)],
      ]),
    ),
  };
  return { accent, ink, focus, soft, measured };
}

const passes = (m) =>
  m.accentText >= MIN_TEXT_CONTRAST &&
  m.buttonText >= MIN_TEXT_CONTRAST &&
  m.focusRing >= MIN_FOCUS_CONTRAST &&
  m.selectedText >= MIN_TEXT_CONTRAST;

/** Required measurements, in display order. */
export const CONTRAST_ROWS = [
  { key: 'accentText', label: 'Accent text', min: MIN_TEXT_CONTRAST },
  { key: 'buttonText', label: 'Button label', min: MIN_TEXT_CONTRAST },
  { key: 'selectedText', label: 'Selected text', min: MIN_TEXT_CONTRAST },
  { key: 'focusRing', label: 'Focus ring', min: MIN_FOCUS_CONTRAST },
];

/** WCAG AA normal-text threshold plus a 0.5:1 early-warning margin.
 * The margin is a design choice, not a separate WCAG requirement. Always
 * classify the original number, never a rounded display value.
 */
export function requestedContrastStatus(value) {
  if (value < MIN_TEXT_CONTRAST)
    return {
      level: 'error',
      grade: 'Below AA',
      message:
        value < MIN_FOCUS_CONTRAST
          ? 'Below 4.5:1 for text and 3:1 for controls.'
          : 'Below 4.5:1 for normal text.',
    };
  if (value < MIN_TEXT_CONTRAST + 0.5)
    return {
      level: 'warning',
      grade: 'Near limit',
      message: 'Near the 4.5:1 text minimum.',
    };
  return { level: 'pass', grade: value >= 7 ? 'AAA' : 'AA', message: '' };
}

/**
 * Accent tokens for a theme. Lightness starts at the requested luminance and
 * moves toward legibility only as far as needed to meet every minimum.
 * @returns {{tokens: Record<string,string>, measured: Record<string,number>,
 *   limited: boolean, hex: string}}
 */
export function resolveAccent(theme, accent = DEFAULT_ACCENT) {
  const swatch = swatchById(accent.swatch);
  const chroma = swatch.chroma * (accent.saturation / 100);
  const wanted = clamp(
    (swatch.lightness ?? BASE_LIGHTNESS[theme]) * (accent.luminance / 100),
    0.05,
    0.98,
  );
  // Nearest passing lightness to the request, searching both directions.
  let lightness = wanted;
  let result = build(theme, swatch, chroma, lightness);
  const requestedBytes = result.accent;
  const backgrounds = Object.entries(neutralBytes(theme)).filter(([name]) =>
    ['background', 'surface', 'surface2'].includes(name),
  );
  const [backgroundName, background] = backgrounds.reduce((best, next) =>
    (
      theme === 'dark'
        ? relativeLuminance(next[1]) < relativeLuminance(best[1])
        : relativeLuminance(next[1]) > relativeLuminance(best[1])
    )
      ? next
      : best,
  );
  const requestedRatio = contrastRatio(requestedBytes, background);
  for (let i = 1; i <= MAX_SEARCH_STEPS && !passes(result.measured); i += 1) {
    const candidates = [
      wanted + i * LIGHTNESS_STEP,
      wanted - i * LIGHTNESS_STEP,
    ]
      .filter((l) => l >= 0.02 && l <= 0.99)
      .sort((x, y) => (theme === 'dark' ? y - x : x - y));
    for (const candidate of candidates) {
      const next = build(theme, swatch, chroma, candidate);
      if (passes(next.measured)) {
        lightness = candidate;
        result = next;
        break;
      }
    }
  }
  const hex = toHex(result.accent);
  return {
    tokens: {
      '--accent': hex,
      '--accent-ink': toHex(result.ink),
      '--accent-soft':
        toHex(result.soft.slice(0, 3)) +
        result.soft[3].toString(16).padStart(2, '0'),
      '--focus': toHex(result.focus),
    },
    measured: result.measured,
    requested: {
      hex: toHex(requestedBytes),
      background: {
        name: backgroundName,
        hex: toHex(background),
        label: theme === 'dark' ? 'Darkest background' : 'Lightest background',
      },
      ratio: requestedRatio,
      ...requestedContrastStatus(requestedRatio),
    },
    limited: Math.abs(lightness - wanted) > 1e-9,
    hex,
  };
}

/** Both themes' tokens, for the first-paint snapshot. */
export const paintSnapshot = (accent) => ({
  dark: resolveAccent('dark', accent).tokens,
  light: resolveAccent('light', accent).tokens,
});

// ------------------------------------------------------------------- sanitize

export const sanitizeMode = (value) =>
  value === 'light' || value === 'system' ? value : DEFAULT_MODE;

function sanitizeRange(value, range) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return range.initial;
  const snapped =
    Math.round((value - range.min) / range.step) * range.step + range.min;
  return clamp(snapped, range.min, range.max);
}

/** A valid accent setting for any stored input. */
export function sanitizeAccent(value) {
  if (!value || typeof value !== 'object' || value.v !== ACCENT_VERSION)
    return { ...DEFAULT_ACCENT };
  return {
    swatch: SWATCHES.some((s) => s.id === value.swatch)
      ? value.swatch
      : DEFAULT_SWATCH,
    saturation: sanitizeRange(value.saturation, SATURATION),
    luminance: sanitizeRange(value.luminance, LUMINANCE),
  };
}

// -------------------------------------------------------------------- storage

/** Values that could not be stored, held for the page's lifetime. */
const memory = new Map();
export const resetAppearanceMemory = () => memory.clear();

function readRaw(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store or clear a key; `false` means it only lives in memory. */
function writeRaw(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
    return true;
  } catch {
    memory.set(key, value);
    return false;
  }
}

export const loadMode = () => sanitizeMode(readRaw(MODE_KEY));

export function loadAccent() {
  try {
    const raw = readRaw(ACCENT_KEY);
    return sanitizeAccent(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ACCENT };
  }
}

export const saveMode = (mode) => writeRaw(MODE_KEY, mode);

/** Persist an accent with the snapshot the boot script replays. */
export const saveAccent = (accent) =>
  writeRaw(
    ACCENT_KEY,
    JSON.stringify({
      v: ACCENT_VERSION,
      ...accent,
      paint: paintSnapshot(accent),
    }),
  );

// ---------------------------------------------------------------------- apply

export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Whether the system currently asks for a light scheme. */
export const systemPrefersLight = () =>
  window.matchMedia?.(LIGHT_QUERY).matches ?? false;

export const resolveTheme = (mode, systemLight) =>
  mode === 'light' || (mode === 'system' && systemLight) ? 'light' : 'dark';

/** Light is always `only light` so forced-dark engines leave it alone. */
export const colorSchemeFor = (theme) =>
  theme === 'light' ? 'only light' : 'dark';

/** Write the theme and accent onto the document. */
export function applyAppearance(mode, theme, tokens) {
  const root = document.documentElement;
  const scheme = colorSchemeFor(theme);
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  root.style.colorScheme = scheme;
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute('content', scheme);
  for (const [name, value] of Object.entries(tokens))
    root.style.setProperty(name, value);
}
