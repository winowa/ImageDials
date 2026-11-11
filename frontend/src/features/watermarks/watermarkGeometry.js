/**
 * Pure watermark geometry and content rules. Every number comes from the
 * server's `rendering` policy (shared/watermark-policy.json), so previews, the
 * prepared PNG and the Python analysis place the mark identically. Nothing here
 * touches the DOM.
 */

export const WATERMARK_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];
export const DEFAULT_CORNER = 'bottom-left';

/** Same split as Python `str.splitlines()`; the control characters are intentional. */
// oxlint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Fallback limits until the server's `limits` object is read. */
export const DEFAULT_LIMITS = Object.freeze({
  max_lines: 4,
  max_line_length: 16,
  max_svg_bytes: 65536,
});

const codePoints = (text) => [...text].length;

/** A corner name from analysis; anything unknown means the default corner. */
export function normalizeCorner(value) {
  const corner = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return WATERMARK_CORNERS.includes(corner) ? corner : DEFAULT_CORNER;
}

/** Policy value that measures the inset from the image's own edges. */
export const IMAGE_EDGES_FRAME = 'image-edges';

/**
 * Where the square mark goes on an image of `width`×`height` pixels.
 *
 * Size is `sizeFraction` of the short side of the largest reference-aspect
 * rectangle (3:2 landscape, 2:3 portrait and square) inside the image, so a
 * square or very wide image keeps a modest mark. Under the `image-edges` frame
 * the inset is `insetFraction` of the image's short side, measured from the
 * image edges and equal on both axes. Older policies (no `placementFrame`)
 * placed the mark inside that centred rectangle, which left wide gutters on
 * square and wide images; they are kept exactly for compatibility.
 * Sizes and coordinates are rounded like the Python analysis.
 * @param {number} width
 * @param {number} height
 * @param {string} corner
 * @param {object} policy the server's `rendering` object
 * @returns {{corner: string, x: number, y: number, size: number, inset: number}}
 */
export function markGeometry(width, height, corner, policy) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    Math.min(width, height) <= 0
  )
    throw new RangeError('Image dimensions must be positive integer pixels');
  const named = normalizeCorner(corner);
  const edges = policy.placementFrame === IMAGE_EDGES_FRAME;
  const ratios = policy.sizeReferenceAspectRatios ?? policy.safeAspectRatios;
  let shape = 'square';
  if (width > height) shape = 'landscape';
  else if (width < height || !edges) shape = 'portrait';
  const [numerator, denominator] = ratios[shape];
  const ratio = numerator / denominator;
  const referenceWidth = Math.min(width, height * ratio);
  const referenceHeight = referenceWidth / ratio;
  const shorter = Math.min(referenceWidth, referenceHeight);
  const size = Math.min(
    width,
    height,
    Math.max(1, Math.round(shorter * policy.sizeFraction)),
  );
  const inset = Math.round(
    (edges ? Math.min(width, height) : shorter) * policy.insetFraction,
  );
  const frame = edges
    ? { left: 0, top: 0, width, height }
    : {
        left: (width - referenceWidth) / 2,
        top: (height - referenceHeight) / 2,
        width: referenceWidth,
        height: referenceHeight,
      };
  const x = named.endsWith('left')
    ? frame.left + inset
    : frame.left + frame.width - inset - size;
  const y = named.startsWith('top')
    ? frame.top + inset
    : frame.top + frame.height - inset - size;
  return {
    corner: named,
    x: Math.min(width - size, Math.max(0, Math.round(x))),
    y: Math.min(height - size, Math.max(0, Math.round(y))),
    size,
    inset,
  };
}

const colorField = (presentation, snake, camel, fallback) => {
  for (const name of [snake, camel]) {
    const value = presentation?.[name];
    if (typeof value === 'string' && HEX_COLOR.test(value))
      return value.toLowerCase();
  }
  return fallback;
};

/**
 * The four colours of a mark. Analysis may spell fields snake_case or
 * camelCase; anything missing or malformed takes the policy default, and the
 * gradient end defaults to the resolved start. Other analysis declarations
 * (enabled, angle, stroke…) are ignored: the interface owns visibility.
 * @returns {{gradientStart: string, gradientEnd: string, separationColor: string, glowColor: string}}
 */
export function resolvePresentation(presentation, policy) {
  const defaults = policy.defaultPresentation;
  const gradientStart = colorField(
    presentation,
    'gradient_start',
    'gradientStart',
    defaults.gradient_start,
  );
  return {
    gradientStart,
    gradientEnd: colorField(
      presentation,
      'gradient_end',
      'gradientEnd',
      defaults.gradient_end ?? gradientStart,
    ),
    separationColor: colorField(
      presentation,
      'separation_color',
      'separationColor',
      defaults.separation_color,
    ),
    glowColor: colorField(
      presentation,
      'glow_color',
      'glowColor',
      defaults.glow_color,
    ),
  };
}

/** Corner and colours for a record's analysis; defaults when there is none. */
export function placementOf(analysis, policy) {
  return {
    corner: normalizeCorner(analysis?.position?.corner),
    presentation: resolvePresentation(analysis?.presentation, policy),
  };
}

/**
 * The analysis version an analysis declares: full analyses in provenance,
 * compact summaries as `analysis_version`. Null when it declares none.
 */
export const analysisVersionOf = (analysis) =>
  analysis?.provenance?.generator_version ?? analysis?.analysis_version ?? null;

/**
 * False when an analysis declares a version other than the policy's: its
 * corner and colours came from another algorithm and must not be drawn.
 */
export const analysisMatchesPolicy = (analysis, policy) => {
  const version = analysisVersionOf(analysis);
  return !policy?.analysisVersion || version === policy.analysisVersion;
};

/**
 * True when a record carries a per-image analysis a mark can be placed from.
 * With a policy, a stale analysis version is not a placement.
 */
export const hasPlacement = (record, policy) =>
  Boolean(record?.print_watermark?.position?.corner) &&
  analysisMatchesPolicy(record.print_watermark, policy) &&
  (!record.sha256 ||
    !record.print_watermark.provenance?.source_sha256 ||
    record.sha256.toLowerCase() ===
      record.print_watermark.provenance.source_sha256.toLowerCase());

/** Policy value that places text rules a fixed gap from the glyphs. */
export const GLYPH_BOUNDS_PLACEMENT = 'glyph-bounds';
/** Float noise below this is not a pixel of ink. */
const INK_EPSILON = 1e-6;

/** Policy value that draws text against the corner-side edge of the square. */
export const CORNER_CONTENT_ANCHOR = 'corner';

/**
 * Which end of the content area text is drawn against: `start` (top) for top
 * corners, `end` (bottom) for bottom corners, so the visible band sits at the
 * same inset as the square's side edges. Older policies centre it (null).
 */
export function contentAnchor(policy, corner) {
  if (policy?.contentAnchor !== CORNER_CONTENT_ANCHOR) return null;
  return normalizeCorner(corner).startsWith('top') ? 'start' : 'end';
}

/**
 * Rule thickness, the fixed rule-to-content gap, the halo padding kept clear
 * inside the square (so a halo is never cut off at the layer's edge) and the
 * area content must fit in so a rule and its gap still lie inside a mark of
 * `size` pixels. Policies without `haloPaddingFraction` have no padding.
 */
export function markLayout(size, policy) {
  const rule = Math.max(1, Math.round(size * policy.ruleHeightFraction));
  const gap = Math.round(size * policy.contentGapFraction);
  const pad = Math.round(size * (policy.haloPaddingFraction ?? 0));
  const top = pad + rule + gap;
  return {
    rule,
    gap,
    pad,
    content: {
      x: pad,
      y: top,
      width: Math.max(1, size - 2 * pad),
      height: Math.max(1, size - 2 * top),
    },
  };
}

/**
 * The two rule bands as `{y, height}`. Text under a `glyph-bounds` policy puts
 * each rule exactly one gap from the outermost glyph pixels; a policy without
 * that field (legacy), and SVG artwork (no `glyphs`), keep the rules on the
 * square's top and bottom edges.
 * @param {number} size
 * @param {object} policy
 * @param {{top: number, bottom: number}} [glyphs] ink bounds in mark pixels
 */
export function ruleBands(size, policy, glyphs) {
  const { rule, gap, pad } = markLayout(size, policy);
  if (policy.textRulePlacement !== GLYPH_BOUNDS_PLACEMENT || !glyphs)
    return [
      { y: pad, height: rule },
      { y: size - pad - rule, height: rule },
    ];
  const clamp = (y) => Math.min(size - pad - rule, Math.max(pad, y));
  return [
    {
      y: clamp(Math.floor(glyphs.top + INK_EPSILON) - gap - rule),
      height: rule,
    },
    { y: clamp(Math.ceil(glyphs.bottom - INK_EPSILON) + gap), height: rule },
  ];
}

/** Horizontal extent of the rules: the square less its halo padding. */
export function ruleSpan(size, policy) {
  const { pad } = markLayout(size, policy);
  return { x: pad, width: Math.max(1, size - 2 * pad) };
}

/** True when text rules follow the glyphs; false is the original v1 layout. */
export const usesGlyphBounds = (policy) =>
  policy?.textRulePlacement === GLYPH_BOUNDS_PLACEMENT;

/**
 * The original v1 text layout, kept exactly for policies without
 * `textRulePlacement`: the font size is fitted from advance widths and the line
 * pitch alone, and each line is centred on its own pitch with a `middle`
 * baseline. Rules stay on the square's edges.
 * @param {string[]} lines
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {(text: string) => number} measureWidth width at a font size of 1
 * @param {{lineHeight: number, maxFontFraction: number}} style
 * @returns {{fontSize: number, centres: {x: number, y: number, text: string}[]}}
 */
export function fitLegacyText(lines, area, measureWidth, style) {
  const widest = Math.max(...lines.map(measureWidth), Number.EPSILON);
  const fontSize = Math.max(
    1,
    Math.min(
      area.width / widest,
      area.height / (lines.length * style.lineHeight),
      area.width * style.maxFontFraction,
    ),
  );
  const pitch = fontSize * style.lineHeight;
  const first = area.y + area.height / 2 - (pitch * (lines.length - 1)) / 2;
  return {
    fontSize,
    centres: lines.map((text, index) => ({
      text,
      x: area.x + area.width / 2,
      y: first + pitch * index,
    })),
  };
}

/**
 * Text lines as the server will store them: trimmed, blank lines dropped.
 * @param {string} text
 * @param {typeof DEFAULT_LIMITS} [limits]
 * @returns {{ok: true, lines: string[], text: string} | {ok: false, error: string}}
 */
export function normalizeText(text, limits = DEFAULT_LIMITS) {
  if (typeof text !== 'string') return { ok: false, error: 'Enter text.' };
  const lines = text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: false, error: 'Enter at least one line.' };
  if (lines.length > limits.max_lines)
    return { ok: false, error: `Use at most ${limits.max_lines} lines.` };
  const long = lines.findIndex(
    (line) => codePoints(line) > limits.max_line_length,
  );
  if (long >= 0)
    return {
      ok: false,
      error: `Line ${long + 1} is over ${limits.max_line_length} characters.`,
    };
  return { ok: true, lines, text: lines.join('\n') };
}

/**
 * Largest font size at which `lines` fit `area`, with each line's baseline and
 * the block's ink bounds, centred in the area (or drawn against its top for
 * `anchor` `start`, its bottom for `end`). `measure(text)` returns the
 * advance `width` and the ink `ascent`/`descent` of `text` at a font size of 1
 * (ink metrics are what keep accents and descenders inside the area). Ink
 * bounds run from the first line's top to the last line's bottom.
 * @param {string[]} lines
 * @param {{x: number, y: number, width: number, height: number}} area
 * @param {(text: string) => {width: number, ascent: number, descent: number}} measure
 * @param {{lineHeight: number, maxFontFraction: number}} style
 * @param {'start'|'end'|null} [anchor]
 * @returns {{fontSize: number, baselines: {x: number, y: number, text: string}[],
 *   glyphs: {top: number, bottom: number}}}
 */
export function fitText(lines, area, measure, style, anchor = null) {
  const metrics = lines.map(measure);
  const widest = Math.max(...metrics.map((m) => m.width), Number.EPSILON);
  const first = metrics[0];
  const last = metrics[metrics.length - 1];
  const stack = style.lineHeight * (lines.length - 1);
  // Ink height of the block in font-size units.
  const inkUnits = Math.max(
    Number.EPSILON,
    stack + first.ascent + last.descent,
  );
  const fontSize = Math.max(
    1,
    Math.min(
      area.width / widest,
      area.height / inkUnits,
      area.width * style.maxFontFraction,
    ),
  );
  const spare = area.height - fontSize * inkUnits;
  let top = area.y + spare / 2;
  if (anchor === 'start') top = area.y;
  else if (anchor === 'end') top = area.y + spare;
  const firstBaseline = top + fontSize * first.ascent;
  return {
    fontSize,
    baselines: lines.map((text, index) => ({
      text,
      x: area.x + area.width / 2,
      y: firstBaseline + fontSize * style.lineHeight * index,
    })),
    glyphs: { top, bottom: top + fontSize * inkUnits },
  };
}
