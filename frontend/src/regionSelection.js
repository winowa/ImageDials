/**
 * Region selections for the generated-image compositing edit
 * (`region-selection-v1`). Everything here is pure: capability and base
 * checks, display-to-source coordinate mapping, bounded brush sampling, local
 * undo/redo and the one API value the editor commits.
 *
 * Coordinates are integer pixels of the EXIF-oriented base image. A rectangle
 * includes its x/y origin and excludes x + width / y + height. A brush stroke is
 * a circle of `radius` at every point joined along the path, clipped to the
 * image. The server's rasterization is authoritative; the browser only paints
 * an outline of the same shapes for orientation.
 */

export const REGION_PROTOCOL = 'region-selection-v1';
export const REGION_METHOD = 'generated-image-composite';
export const REGION_VERSION = 1;
/** Bound in-memory undo snapshots even when the user draws for a long session. */
export const REGION_HISTORY_LIMIT = 32;

/** The client never accepts more than the backend's own published maximums. */
export const REGION_HARD_LIMITS = Object.freeze({
  max_shapes: 64,
  max_points: 4096,
  max_radius: 2048,
  max_feather: 32,
  max_edge: 32768,
  max_pixels: 32_000_000,
});

const REQUIRED = Object.freeze({
  protocol: REGION_PROTOCOL,
  method: REGION_METHOD,
  coordinates: 'oriented-base-pixels',
  output_geometry: 'oriented-base',
  provider_fit: 'cover-center',
  outside_selection: 'exact-rgba8',
});
const KNOWN_TOOLS = ['rectangle', 'brush'];
const SHA256 = /^[a-f0-9]{64}$/;

const isInt = (value) => Number.isSafeInteger(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Whether the server's `region_editing` capability describes exactly the
 * implemented software composite. Anything else (native masks, another
 * protocol or fit policy, unknown tools, missing limits) is refused rather than
 * guessed at.
 *
 * @returns {{ok: true, tools: string[], limits: typeof REGION_HARD_LIMITS} |
 *   {ok: false, reason: string}}
 */
export function readRegionCapability(capability) {
  if (!capability || typeof capability !== 'object')
    return { ok: false, reason: 'This server does not offer region editing.' };
  if (capability.enabled !== true)
    return {
      ok: false,
      reason: 'Region editing needs an image provider that supports editing.',
    };
  if (capability.native_mask !== false)
    return {
      ok: false,
      reason:
        'This server reports a masking method this editor does not support.',
    };
  for (const [key, value] of Object.entries(REQUIRED)) {
    if (capability[key] !== value)
      return {
        ok: false,
        reason:
          'This server uses a region-editing method this editor does not support.',
      };
  }
  const tools = Array.isArray(capability.tools) ? capability.tools : [];
  if (
    !tools.length ||
    tools.some((tool) => !KNOWN_TOOLS.includes(tool)) ||
    new Set(tools).size !== tools.length
  )
    return {
      ok: false,
      reason:
        'This server offers selection tools this editor does not support.',
    };
  const limits = {};
  for (const [key, hard] of Object.entries(REGION_HARD_LIMITS)) {
    const value = capability[key];
    if (!isInt(value) || value < 1)
      return {
        ok: false,
        reason: 'This server did not publish usable region-editing limits.',
      };
    limits[key] = Math.min(value, hard);
  }
  return {
    ok: true,
    tools: KNOWN_TOOLS.filter((tool) => tools.includes(tool)),
    limits,
  };
}

/** The base's oriented pixel size, or null. */
export function baseSize(base) {
  const width = base?.dimensions?.width;
  const height = base?.dimensions?.height;
  return isInt(width) && isInt(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/** Why `base` cannot carry a selection under `limits`, or null. */
export function baseProblem(base, limits) {
  if (!base) return 'Add a reference image to edit a region.';
  if (typeof base.sha256 !== 'string' || !SHA256.test(base.sha256))
    return 'The base image has not finished checking. Try again when it is ready.';
  const size = baseSize(base);
  if (!size)
    return 'The base image size is not known yet. Try again when it is ready.';
  if (size.width > limits.max_edge || size.height > limits.max_edge)
    return `The base image is wider or taller than ${limits.max_edge} pixels.`;
  if (size.width * size.height > limits.max_pixels)
    return 'The base image has more pixels than region editing allows.';
  return null;
}

/**
 * Whether the region tool can open for `base`: the parent shows the contextual
 * action only when `available`, and can show `reason` otherwise.
 */
export function regionToolAvailability(capability, base) {
  const cap = readRegionCapability(capability);
  if (!cap.ok) return { available: false, reason: cap.reason };
  const problem = baseProblem(base, cap.limits);
  return problem
    ? { available: false, reason: problem }
    : { available: true, reason: null };
}

/** Radius bound for `size`: the published limit and never wider than the image. */
export const maxBrushRadius = (size, limits) =>
  Math.max(1, Math.min(limits.max_radius, Math.max(size.width, size.height)));

/** A comfortable starting brush: about 3% of the longer edge. */
export const defaultBrushRadius = (size, limits) =>
  clamp(
    Math.round(Math.max(size.width, size.height) * 0.03),
    1,
    maxBrushRadius(size, limits),
  );

/**
 * The box the image content occupies inside `rect` when shown with
 * `object-fit: contain`: letterbox bars are excluded.
 */
export function containBox(rect, size) {
  const width = Math.max(0, rect?.width ?? 0);
  const height = Math.max(0, rect?.height ?? 0);
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  if (!size || !width || !height) return { left, top, width: 0, height: 0 };
  const scale = Math.min(width / size.width, height / size.height);
  const w = size.width * scale;
  const h = size.height * scale;
  return {
    left: left + (width - w) / 2,
    top: top + (height - h) / 2,
    width: w,
    height: h,
  };
}

/**
 * Map a viewport point to continuous source-pixel coordinates.
 *
 * @param {{x: number, y: number}} point client coordinates
 * @param {{left: number, top: number, width: number, height: number}} rect the
 *   displayed image element's bounding box (may include letterbox padding)
 * @param {{width: number, height: number}} size oriented source size
 * @returns {{x: number, y: number, inside: boolean} | null} null when nothing
 *   is displayed
 */
export function clientToSource(point, rect, size) {
  const box = containBox(rect, size);
  if (!box.width || !box.height) return null;
  const x = ((point.x - box.left) / box.width) * size.width;
  const y = ((point.y - box.top) / box.height) * size.height;
  return {
    x,
    y,
    inside: x >= 0 && y >= 0 && x < size.width && y < size.height,
  };
}

/** The integer pixel containing a continuous point, clamped into the image. */
export const pixelAt = (point, size) => ({
  x: clamp(Math.floor(point.x), 0, size.width - 1),
  y: clamp(Math.floor(point.y), 0, size.height - 1),
});

/**
 * The rectangle covering every pixel from the pixel under `a` to the pixel
 * under `b`, both included, clipped to the image.
 */
export function rectFromDrag(a, b, size) {
  const p = pixelAt(a, size);
  const q = pixelAt(b, size);
  const x = Math.min(p.x, q.x);
  const y = Math.min(p.y, q.y);
  return {
    kind: 'rectangle',
    x,
    y,
    width: Math.max(p.x, q.x) - x + 1,
    height: Math.max(p.y, q.y) - y + 1,
  };
}

/** The whole image as one rectangle. */
export const fullRectangle = (size) => ({
  kind: 'rectangle',
  x: 0,
  y: 0,
  width: size.width,
  height: size.height,
});

/** Brush points already used by `shapes`. */
export const pointsUsed = (shapes) =>
  shapes.reduce(
    (sum, shape) =>
      sum +
      (shape?.kind === 'brush' && Array.isArray(shape.points)
        ? shape.points.length
        : 0),
    0,
  );

/**
 * Source-pixel spacing between sampled brush points. The server joins
 * consecutive points with a line as wide as the brush, so wider spacing leaves
 * no gaps; it only bends curves into short straight runs.
 */
export const brushSpacing = (radius) => Math.max(1, Math.round(radius / 3));

/** Begin a stroke at a continuous source point (clamped into the image). */
export function startStroke(point, radius, size) {
  const p = pixelAt(point, size);
  return { kind: 'brush', radius, points: [[p.x, p.y]] };
}

/**
 * Extend `stroke` toward `point`, sampling at the brush spacing, within
 * `budget` total points for this stroke. Never drops or moves earlier points.
 *
 * @param {{final?: boolean}} [options] `final` always keeps the release point
 *   when the budget allows, however close it is
 * @returns {{stroke: object, limited: boolean}} `limited` once a point had to
 *   be refused for lack of budget
 */
export function extendStroke(stroke, point, size, budget, options = {}) {
  const p = pixelAt(point, size);
  const points = stroke.points;
  const last = points[points.length - 1];
  if (last[0] === p.x && last[1] === p.y) return { stroke, limited: false };
  const far =
    Math.hypot(p.x - last[0], p.y - last[1]) >= brushSpacing(stroke.radius);
  if (!far && !options.final) return { stroke, limited: false };
  if (points.length >= budget) return { stroke, limited: true };
  return {
    stroke: { ...stroke, points: [...points, [p.x, p.y]] },
    limited: false,
  };
}

/** Local selection history: shapes only; feather is a setting, not an edit. */
export const createHistory = (shapes = []) => ({
  past: [],
  present: shapes,
  future: [],
});

/** Record `shapes` as the new present, dropping anything redoable. */
export function commitShapes(history, shapes) {
  if (shapes === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-REGION_HISTORY_LIMIT),
    present: shapes,
    future: [],
  };
}

export function undoShapes(history) {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redoShapes(history) {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

/**
 * Validate one shape against the image and limits.
 * @returns {string | null} a reason, or null when valid
 */
export function shapeProblem(shape, size, limits) {
  if (!shape || typeof shape !== 'object')
    return 'A selection shape is malformed.';
  if (shape.kind === 'rectangle') {
    const { x, y, width, height } = shape;
    if (![x, y, width, height].every(isInt)) return 'A rectangle is malformed.';
    if (x < 0 || y < 0 || width < 1 || height < 1)
      return 'A rectangle is empty or negative.';
    if (x + width > size.width || y + height > size.height)
      return 'A rectangle extends outside the base image.';
    return null;
  }
  if (shape.kind === 'brush') {
    if (!isInt(shape.radius) || shape.radius < 1)
      return 'A brush stroke is malformed.';
    if (shape.radius > maxBrushRadius(size, limits))
      return 'A brush stroke is wider than allowed.';
    if (!Array.isArray(shape.points) || !shape.points.length)
      return 'A brush stroke has no points.';
    for (const point of shape.points) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(isInt))
        return 'A brush stroke is malformed.';
      if (
        point[0] < 0 ||
        point[1] < 0 ||
        point[0] >= size.width ||
        point[1] >= size.height
      )
        return 'A brush stroke extends outside the base image.';
    }
    return null;
  }
  return 'A selection shape has an unsupported kind.';
}

/** Copy a shape with exactly the API keys, in API order. */
function wireShape(shape) {
  return shape.kind === 'rectangle'
    ? {
        kind: 'rectangle',
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
      }
    : {
        kind: 'brush',
        radius: shape.radius,
        points: shape.points.map(([x, y]) => [x, y]),
      };
}

/**
 * Build the one value the editor commits for `base`.
 *
 * @returns {{ok: true, value: object | null} | {ok: false, error: string}}
 *   `value` is null when nothing is selected (never an empty-shapes object)
 */
export function buildSelection(base, shapes, feather, limits) {
  const problem = baseProblem(base, limits);
  if (problem) return { ok: false, error: problem };
  const size = baseSize(base);
  if (!Array.isArray(shapes))
    return { ok: false, error: 'The selection is malformed.' };
  if (!shapes.length) return { ok: true, value: null };
  if (shapes.length > limits.max_shapes)
    return {
      ok: false,
      error: `Use at most ${limits.max_shapes} selection shapes.`,
    };
  if (pointsUsed(shapes) > limits.max_points)
    return {
      ok: false,
      error: `Use at most ${limits.max_points} brush points in total.`,
    };
  if (!isInt(feather) || feather < 0 || feather > limits.max_feather)
    return {
      ok: false,
      error: `Edge softening must be 0–${limits.max_feather} pixels.`,
    };
  for (const shape of shapes) {
    const reason = shapeProblem(shape, size, limits);
    if (reason) return { ok: false, error: reason };
  }
  return {
    ok: true,
    value: {
      version: REGION_VERSION,
      source_sha256: base.sha256,
      width: size.width,
      height: size.height,
      shapes: shapes.map(wireShape),
      feather,
    },
  };
}

/** Whether a stored selection was made on exactly this base file and size. */
export function selectionMatchesBase(selection, base) {
  const size = baseSize(base);
  return Boolean(
    selection &&
    size &&
    selection.source_sha256 === base.sha256 &&
    selection.width === size.width &&
    selection.height === size.height,
  );
}

/**
 * Read an incoming selection for editing on `base`. A selection made on another
 * file or size is never loaded: its coordinates mean nothing here.
 *
 * @returns {{shapes: object[], feather: number, notice: string | null}}
 */
export function loadSelection(selection, base, limits) {
  if (selection == null) return { shapes: [], feather: 0, notice: null };
  if (!selectionMatchesBase(selection, base))
    return {
      shapes: [],
      feather: 0,
      notice:
        'The previous selection was made on a different image and was not loaded.',
    };
  const keys = Object.keys(selection).sort().join(',');
  const built =
    selection.version === REGION_VERSION &&
    keys === 'feather,height,shapes,source_sha256,version,width'
      ? buildSelection(base, selection.shapes, selection.feather, limits)
      : { ok: false };
  if (!built.ok || !built.value)
    return {
      shapes: [],
      feather: 0,
      notice: 'The previous selection is invalid and was not loaded.',
    };
  return {
    shapes: built.value.shapes,
    feather: built.value.feather,
    notice: null,
  };
}

/** Bounding box of the shapes in source pixels (brush circles clipped). */
export function shapesBounds(shapes, size) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const shape of shapes) {
    if (shape.kind === 'rectangle') {
      x0 = Math.min(x0, shape.x);
      y0 = Math.min(y0, shape.y);
      x1 = Math.max(x1, shape.x + shape.width);
      y1 = Math.max(y1, shape.y + shape.height);
    } else {
      for (const [x, y] of shape.points) {
        x0 = Math.min(x0, x - shape.radius);
        y0 = Math.min(y0, y - shape.radius);
        x1 = Math.max(x1, x + shape.radius + 1);
        y1 = Math.max(y1, y + shape.radius + 1);
      }
    }
  }
  if (x0 === Infinity) return null;
  x0 = clamp(x0, 0, size.width);
  y0 = clamp(y0, 0, size.height);
  x1 = clamp(x1, 0, size.width);
  y1 = clamp(y1, 0, size.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Parse the keyboard rectangle fields (strings) into a rectangle shape.
 * @returns {{shape: object} | {error: string, field: string}}
 */
export function parseRectangleFields(fields, size) {
  const read = (name) => {
    const text = String(fields[name] ?? '').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  };
  const x = read('x');
  const y = read('y');
  const width = read('width');
  const height = read('height');
  for (const [name, value] of [
    ['x', x],
    ['y', y],
    ['width', width],
    ['height', height],
  ]) {
    if (value === null || !isInt(value))
      return { error: 'Enter whole pixel numbers.', field: name };
  }
  if (width < 1) return { error: 'Width must be at least 1.', field: 'width' };
  if (height < 1)
    return { error: 'Height must be at least 1.', field: 'height' };
  if (x >= size.width || x + width > size.width)
    return {
      error: `X + width must be at most ${size.width}.`,
      field: x >= size.width ? 'x' : 'width',
    };
  if (y >= size.height || y + height > size.height)
    return {
      error: `Y + height must be at most ${size.height}.`,
      field: y >= size.height ? 'y' : 'height',
    };
  return { shape: { kind: 'rectangle', x, y, width, height } };
}

/** A centred rectangle covering half of each dimension, as field strings. */
export function defaultRectangleFields(size) {
  const width = Math.max(1, Math.round(size.width / 2));
  const height = Math.max(1, Math.round(size.height / 2));
  return {
    x: String(Math.floor((size.width - width) / 2)),
    y: String(Math.floor((size.height - height) / 2)),
    width: String(width),
    height: String(height),
  };
}

/**
 * Step one keyboard field by `delta`, keeping the rectangle inside the image.
 * @returns {object} the new field strings
 */
export function stepRectangleField(fields, name, delta, size) {
  const value = Number.parseInt(fields[name], 10);
  const current = Number.isFinite(value) ? value : 0;
  const x = Number.parseInt(fields.x, 10) || 0;
  const y = Number.parseInt(fields.y, 10) || 0;
  const bound = {
    x: [0, size.width - Math.max(1, Number.parseInt(fields.width, 10) || 1)],
    y: [0, size.height - Math.max(1, Number.parseInt(fields.height, 10) || 1)],
    width: [1, size.width - clamp(x, 0, size.width - 1)],
    height: [1, size.height - clamp(y, 0, size.height - 1)],
  }[name];
  return {
    ...fields,
    [name]: String(
      clamp(current + delta, bound[0], Math.max(bound[0], bound[1])),
    ),
  };
}
