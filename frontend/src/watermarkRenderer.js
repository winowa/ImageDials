/**
 * The one watermark drawing algorithm. A mark is a square layer (two gradient
 * rules around text or artwork) drawn at any pixel size: previews draw it small
 * and scale it into place, the prepared PNG draws it at the geometry's size
 * onto the full-resolution source. Geometry comes from watermarkGeometry.js.
 * Needs real canvas APIs; the jsdom tests cover the pure modules instead.
 */
import {
  contentAnchor,
  fitLegacyText,
  fitText,
  markGeometry,
  markLayout,
  normalizeText,
  ruleBands,
  ruleSpan,
  usesGlyphBounds,
} from './watermarkGeometry.js';
import { decodeSvg, inspectSvg } from './watermarkSvg.js';

/** Bundled, licensed face (public/fonts); the rest is the system fallback. */
export const WATERMARK_FONT_STACK =
  "'JetBrains Mono', ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace";
const FONT_WEIGHT = 700;
/** Line pitch as a multiple of the font size. */
const TEXT_LINE_HEIGHT = 1.25;
/** Largest text size as a share of the mark, so a single short word stays modest. */
const TEXT_MAX_FONT_FRACTION = 0.22;
/** Reference size at which text is measured; widths scale linearly. */
const MEASURE_FONT_PX = 100;
/** Ink extents assumed (in font sizes) when the browser reports no metrics. */
const FALLBACK_ASCENT = 0.75;
const FALLBACK_DESCENT = 0.25;
/** Blur radii as shares of the mark. */
const GLOW_BLUR_FRACTION = 0.07;
const SEPARATION_BLUR_FRACTION = 0.025;
/** Largest mark drawn for a preview; geometry scales it into place. */
export const PREVIEW_MARK_MAX_PIXELS = 256;
const MARK_CACHE_LIMIT = 24;

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas) {
  const context = canvas.getContext('2d');
  if (!context) throw new RenderError('The browser has no 2D canvas.');
  return context;
}

/** Wait until the bundled watermark face can draw `text`. */
async function loadFont(text) {
  if (!document.fonts?.load) return;
  try {
    await document.fonts.load(
      `${FONT_WEIGHT} ${MEASURE_FONT_PX}px ${WATERMARK_FONT_STACK}`,
      text,
    );
  } catch {
    /* The fallback face draws instead. */
  }
}

const rgba = (hex, alpha) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/** The fixed diagonal gradient, held at its start colour first. */
function gradientFor(context, size, presentation, policy) {
  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, presentation.gradientStart);
  gradient.addColorStop(
    policy.gradientStartHoldFraction,
    presentation.gradientStart,
  );
  gradient.addColorStop(1, presentation.gradientEnd);
  return gradient;
}

/** Width and ink extents of `text` at a font size of 1, with fallbacks. */
function measureInk(context, text) {
  const m = context.measureText(text);
  const finite = (value) => Number.isFinite(value) && value >= 0;
  const ink = (value, fallback) =>
    (finite(value) ? value : fallback * MEASURE_FONT_PX) / MEASURE_FONT_PX;
  const advance = finite(m.width) ? m.width / MEASURE_FONT_PX : 0;
  const sideways =
    ink(m.actualBoundingBoxLeft, 0) + ink(m.actualBoundingBoxRight, 0);
  let ascent = ink(m.actualBoundingBoxAscent, FALLBACK_ASCENT);
  let descent = ink(m.actualBoundingBoxDescent, FALLBACK_DESCENT);
  if (ascent + descent <= 0) {
    ascent = FALLBACK_ASCENT;
    descent = FALLBACK_DESCENT;
  }
  return { width: Math.max(advance, sideways), ascent, descent };
}

/** The original v1 text drawing, for policies without `textRulePlacement`. */
function drawLegacyText(context, lines, area) {
  const font = (px) => `${FONT_WEIGHT} ${px}px ${WATERMARK_FONT_STACK}`;
  context.font = font(MEASURE_FONT_PX);
  const { fontSize, centres } = fitLegacyText(
    lines,
    area,
    (text) => context.measureText(text).width / MEASURE_FONT_PX,
    { lineHeight: TEXT_LINE_HEIGHT, maxFontFraction: TEXT_MAX_FONT_FRACTION },
  );
  context.font = font(fontSize);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const { text, x, y } of centres) context.fillText(text, x, y);
}

/** Draw `lines` fitted and centred in `area`; returns their ink bounds. */
function drawText(context, lines, area, anchor) {
  const font = (px) => `${FONT_WEIGHT} ${px}px ${WATERMARK_FONT_STACK}`;
  context.font = font(MEASURE_FONT_PX);
  context.textBaseline = 'alphabetic';
  const { fontSize, baselines, glyphs } = fitText(
    lines,
    area,
    (text) => measureInk(context, text),
    { lineHeight: TEXT_LINE_HEIGHT, maxFontFraction: TEXT_MAX_FONT_FRACTION },
    anchor,
  );
  context.font = font(fontSize);
  context.textAlign = 'center';
  for (const { text, x, y } of baselines) context.fillText(text, x, y);
  return glyphs;
}

/** SVG artwork fitted inside `area`, keeping its aspect ratio. */
function drawArtwork(context, artwork, area) {
  const scale = Math.min(
    area.width / artwork.aspect.width,
    area.height / artwork.aspect.height,
  );
  const width = artwork.aspect.width * scale;
  const height = artwork.aspect.height * scale;
  context.drawImage(
    artwork.image,
    area.x + (area.width - width) / 2,
    area.y + (area.height - height) / 2,
    width,
    height,
  );
}

/**
 * Validate settings and prepare their content for drawing (fonts loaded, SVG
 * decoded). Invalid content gives `{error}` and draws nothing.
 * @param {{type: string, text?: string, svg_markup?: string, svg_recolor?: boolean}} settings
 * @param {object} limits the server's `limits`
 * @returns {Promise<{content: object} | {error: string}>}
 */
export async function prepareContent(settings, limits) {
  if (settings?.type === 'svg') {
    const checked = inspectSvg(settings.svg_markup, limits);
    if (!checked.ok) return { error: checked.error };
    try {
      return {
        content: {
          type: 'svg',
          image: await decodeSvg(checked.markup),
          aspect: checked.aspect,
          recolor: settings.svg_recolor !== false,
        },
      };
    } catch (error) {
      return { error: error.message };
    }
  }
  const text = normalizeText(settings?.text, limits);
  if (!text.ok) return { error: text.error };
  await loadFont(text.lines.join(''));
  return { content: { type: 'text', lines: text.lines } };
}

/**
 * Draw one mark layer: `pixelSize` square, transparent outside the artwork,
 * its glow and its separation halo. Nothing is drawn beyond the square.
 * @param {{content: object, presentation: object, policy: object, pixelSize: number}} options
 * @returns {HTMLCanvasElement}
 */
export function drawMark({ content, presentation, policy, pixelSize, corner }) {
  const size = Math.max(1, Math.round(pixelSize));
  const layout = markLayout(size, policy);
  const art = createCanvas(size, size);
  const artContext = context2d(art);
  let glyphs;
  if (content.type === 'text') {
    artContext.fillStyle = '#000';
    if (usesGlyphBounds(policy))
      glyphs = drawText(
        artContext,
        content.lines,
        layout.content,
        contentAnchor(policy, corner),
      );
    else drawLegacyText(artContext, content.lines, layout.content);
  } else {
    drawArtwork(artContext, content, layout.content);
  }
  // Text and recoloured artwork keep only their shape; the gradient fills it.
  if (content.type === 'text' || content.recolor) {
    artContext.globalCompositeOperation = 'source-in';
    artContext.fillStyle = gradientFor(artContext, size, presentation, policy);
    artContext.fillRect(0, 0, size, size);
    artContext.globalCompositeOperation = 'source-over';
  }
  artContext.fillStyle = gradientFor(artContext, size, presentation, policy);
  const span = ruleSpan(size, policy);
  for (const band of ruleBands(size, policy, glyphs))
    artContext.fillRect(span.x, band.y, span.width, band.height);

  const mark = createCanvas(size, size);
  const context = context2d(mark);
  const halo = [
    [
      presentation.glowColor,
      policy.glowOpacity,
      policy.glowBlurFraction ?? GLOW_BLUR_FRACTION,
    ],
    [
      presentation.separationColor,
      policy.separationOpacity,
      policy.separationBlurFraction ?? SEPARATION_BLUR_FRACTION,
    ],
  ];
  for (const [color, opacity, blur] of halo) {
    context.shadowColor = rgba(color, opacity);
    context.shadowBlur = size * blur;
    context.drawImage(art, 0, 0);
  }
  context.shadowColor = 'transparent';
  context.drawImage(art, 0, 0);
  return mark;
}

const markCache = new Map();

/**
 * A cached mark layer for settings, placement colours and pixel size.
 * @returns {Promise<{mark: HTMLCanvasElement} | {error: string}>}
 */
export async function markFor({
  settings,
  limits,
  presentation,
  policy,
  pixelSize,
  corner,
}) {
  const identity = JSON.stringify([
    settings?.type,
    settings?.text,
    settings?.svg_markup,
    settings?.svg_recolor,
    presentation,
    policy,
    Math.round(pixelSize),
    contentAnchor(policy, corner),
  ]);
  const cached = markCache.get(identity);
  if (cached) {
    markCache.delete(identity);
    markCache.set(identity, cached);
    return { mark: cached };
  }
  const prepared = await prepareContent(settings, limits);
  if (!prepared.content) return { error: prepared.error };
  const mark = drawMark({
    content: prepared.content,
    presentation,
    policy,
    pixelSize,
    corner,
  });
  markCache.set(identity, mark);
  if (markCache.size > MARK_CACHE_LIMIT)
    markCache.delete(markCache.keys().next().value);
  return { mark };
}

/** Pixel size of a decoded image: bitmaps and image elements differ in names. */
const sizeOf = (image) => ({
  width: image.naturalWidth ?? image.width,
  height: image.naturalHeight ?? image.height,
});

/**
 * The prepared derivative: the decoded source at its own size with the mark on
 * top. Pixels outside the mark's square are the source's, untouched.
 * @param {{source: ImageBitmap|HTMLImageElement, settings: object, limits: object,
 *   placement: {corner: string, presentation: object}, policy: object}} options
 * @returns {Promise<{blob: Blob, width: number, height: number, geometry: object}>}
 */
export async function renderPrepared({
  source,
  settings,
  limits,
  placement,
  policy,
}) {
  const { width, height } = sizeOf(source);
  const geometry = markGeometry(width, height, placement.corner, policy);
  const rendered = await markFor({
    settings,
    limits,
    presentation: placement.presentation,
    policy,
    pixelSize: geometry.size,
    corner: geometry.corner,
  });
  if (!rendered.mark) throw new RenderError(rendered.error);
  const canvas = createCanvas(width, height);
  const context = context2d(canvas);
  context.drawImage(source, 0, 0);
  context.drawImage(rendered.mark, geometry.x, geometry.y);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob)
    throw new RenderError(
      `The browser could not create a ${width}×${height} PNG.`,
    );
  return { blob, width, height, geometry };
}

/**
 * Decode a file to a drawable image with its real pixel size.
 * @param {Blob} blob
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* Fall back to an image element. */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new RenderError('The browser could not decode the image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Pixel size of an image file, probed by decoding it. */
export async function probeSize(blob) {
  const image = await decodeImage(blob);
  const size = sizeOf(image);
  image.close?.();
  return size;
}
