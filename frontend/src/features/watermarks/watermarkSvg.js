/**
 * Local SVG checks for the settings preview. The server stays the authority
 * when saving; these rules mirror its allow-list so artwork that would be
 * rejected is flagged before it is ever decoded. Accepted artwork is only ever
 * decoded as an image (never inserted into the page), and browsers neither run
 * script nor fetch external resources inside an image.
 */
import { DEFAULT_LIMITS } from './watermarkGeometry.js';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Mirrors SVG_ALLOWED_ELEMENTS in backend/app/watermark_settings.py. */
export const SVG_ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'symbol',
  'title',
  'desc',
]);

/** Mirrors MAX_SVG_GEOMETRY_UNITS in the server. */
const MAX_GEOMETRY_UNITS = 1_000_000;
const LOCAL_REFERENCE = /^#[A-Za-z_][\w:.-]*$/;
const ACTIVE_CONTENT =
  /expression\s*\(|@import|javascript:|data:|https?:|\/\//i;
const URL_FUNCTION = /url\s*\((.*?)\)/gi;
/** Namespace declarations the artwork may carry (not real attributes on the server). */
const DECLARABLE_NAMESPACES = new Set([
  SVG_NAMESPACE,
  'http://www.w3.org/1999/xlink',
]);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const fail = (error) => ({ ok: false, error });

function viewBoxSize(value) {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    parts.length !== 4 ||
    !parts.every((part) => Number.isFinite(part) && Math.abs(part) <= 1e6) ||
    Math.min(parts[2], parts[3]) <= 0
  )
    return null;
  return { width: parts[2], height: parts[3] };
}

function lengthSize(root) {
  const read = (name) => {
    const value = (root.getAttribute(name) ?? '').trim().replace(/px$/i, '');
    return NUMBER.test(value) ? Number(value) : NaN;
  };
  const width = read('width');
  const height = read('height');
  return [width, height].every((v) => v > 0 && v <= MAX_GEOMETRY_UNITS)
    ? { width, height }
    : null;
}

function attributeProblem(element) {
  for (const { name, value } of element.attributes) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) {
      if (DECLARABLE_NAMESPACES.has(value)) continue;
      return 'Artwork elements must use the SVG namespace.';
    }
    const attribute = name.split(':').pop().toLowerCase();
    if (attribute === 'base' || value.includes('\\'))
      return 'SVG base paths and escaped resources are not allowed.';
    if (attribute.startsWith('on'))
      return 'SVG event handlers are not allowed.';
    if (attribute === 'href' && !LOCAL_REFERENCE.test(value.trim()))
      return 'SVG references must stay inside the artwork.';
    if (ACTIVE_CONTENT.test(value))
      return 'Active or external SVG content is not allowed.';
    for (const [, reference] of value.matchAll(URL_FUNCTION))
      if (!LOCAL_REFERENCE.test(reference.trim().replace(/^["']|["']$/g, '')))
        return 'SVG resources must stay inside the artwork.';
  }
  return null;
}

/**
 * Check SVG markup and prepare it for decoding.
 * @param {string} markup
 * @param {{max_svg_bytes: number}} [limits]
 * @returns {{ok: true, markup: string, aspect: {width: number, height: number}}
 *   | {ok: false, error: string}}
 */
export function inspectSvg(markup, limits = DEFAULT_LIMITS) {
  if (typeof markup !== 'string' || !markup.trim())
    return fail('Provide SVG artwork.');
  if (new TextEncoder().encode(markup).length > limits.max_svg_bytes)
    return fail(`SVG is over ${limits.max_svg_bytes} bytes.`);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(markup))
    return fail('SVG document declarations are not supported.');
  const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || document.getElementsByTagName('parsererror').length)
    return fail('SVG markup is invalid.');
  if (root.localName !== 'svg') return fail('Artwork must have an SVG root.');
  const viewBox = root.getAttribute('viewBox');
  const aspect = viewBox ? viewBoxSize(viewBox) : lengthSize(root);
  if (!aspect) return fail('SVG needs a valid viewBox or width and height.');
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI && element.namespaceURI !== SVG_NAMESPACE)
      return fail('Artwork elements must use the SVG namespace.');
    if (!SVG_ALLOWED_ELEMENTS.has(element.localName))
      return fail(`Unsupported SVG element: ${element.localName}.`);
    const problem = attributeProblem(element);
    if (problem) return fail(problem);
  }
  // The image decoder needs a size; the viewBox supplies it when none is given.
  if (!lengthSize(root)) {
    root.setAttribute('width', String(aspect.width));
    root.setAttribute('height', String(aspect.height));
  }
  let normalized = new XMLSerializer().serializeToString(root);
  if (!root.namespaceURI)
    normalized = normalized.replace(/^<svg\b/, `<svg xmlns="${SVG_NAMESPACE}"`);
  return { ok: true, markup: normalized, aspect };
}

/**
 * Decode checked markup as an image. Resolves when it can be drawn.
 * @param {string} markup the `markup` of an `inspectSvg` success
 * @returns {Promise<HTMLImageElement>}
 */
export function decodeSvg(markup) {
  const url = URL.createObjectURL(
    new Blob([markup], { type: 'image/svg+xml' }),
  );
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The browser could not draw this SVG.'));
    };
    image.src = url;
  });
}
