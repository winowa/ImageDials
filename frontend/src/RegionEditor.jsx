import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ErrorDetails, WarningDetails } from './ErrorDetails.jsx';
import { localDiagnostic } from './diagnostics.js';

import {
  baseProblem,
  baseSize,
  buildSelection,
  clientToSource,
  commitShapes,
  containBox,
  createHistory,
  defaultBrushRadius,
  defaultRectangleFields,
  extendStroke,
  fullRectangle,
  loadSelection,
  maxBrushRadius,
  parseRectangleFields,
  pointsUsed,
  readRegionCapability,
  rectFromDrag,
  redoShapes,
  startStroke,
  stepRectangleField,
  undoShapes,
} from './regionSelection.js';
import { Icon, InfoPopover, Tip } from './ui.jsx';
import './RegionEditor.css';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]';
/** Pointer travel (CSS px) below which a rectangle drag counts as a tap. */
const RECT_TAP_PX = 4;
/** Outline drawn around the selection, in CSS pixels. */
const OUTLINE_PX = 1.5;
/** Largest canvas backing edge; beyond this the outline is upscaled. */
const MAX_CANVAS_EDGE = 4096;
const FIELDS = [
  ['x', 'X'],
  ['y', 'Y'],
  ['width', 'Width'],
  ['height', 'Height'],
];

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function ToolGlyph({ tool }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
    >
      {tool === 'rectangle' ? (
        <path d="M5 6.5h14v11H5z" strokeDasharray="3 2.4" />
      ) : (
        <path d="M4 18c2.5 0 3.5-1 3.5-3a2.5 2.5 0 0 1 5 0c0 2-2 4-5 4H4Zm6.8-4.8L19 5" />
      )}
    </svg>
  );
}

/** Trace `shapes` (source pixels) grown by `grow` and fill/stroke them opaque. */
function drawShapes(ctx, shapes, grow) {
  for (const shape of shapes) {
    if (shape.kind === 'rectangle') {
      ctx.fillRect(
        shape.x - grow,
        shape.y - grow,
        shape.width + grow * 2,
        shape.height + grow * 2,
      );
      continue;
    }
    // A brush point covers the pixels within `radius` of its pixel centre.
    const [first, ...rest] = shape.points;
    if (!rest.length) {
      ctx.beginPath();
      ctx.arc(
        first[0] + 0.5,
        first[1] + 0.5,
        shape.radius + 0.5 + grow,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      continue;
    }
    ctx.lineWidth = shape.radius * 2 + 1 + grow * 2;
    ctx.beginPath();
    ctx.moveTo(first[0] + 0.5, first[1] + 0.5);
    for (const [x, y] of rest) ctx.lineTo(x + 0.5, y + 0.5);
    ctx.stroke();
  }
}

function layer(store, key, width, height) {
  let node = store[key];
  if (!node) {
    node = document.createElement('canvas');
    store[key] = node;
  }
  if (node.width !== width) node.width = width;
  if (node.height !== height) node.height = height;
  return node.getContext('2d');
}

/**
 * Paint the selection over the displayed base: outside dimmed, inside lightly
 * tinted and outlined. The base pixels themselves are never altered and no
 * model output is predicted.
 */
function paintSelection(canvas, layers, { shapes, preview, size, frame }) {
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(
    1,
    Math.min(MAX_CANVAS_EDGE, Math.round(frame.width * dpr)),
  );
  const height = Math.max(
    1,
    Math.min(MAX_CANVAS_EDGE, Math.round(frame.height * dpr)),
  );
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  if (!shapes.length && !preview) return;
  const sx = width / size.width;
  const sy = height / size.height;
  const styles = getComputedStyle(canvas);
  const accent = styles.getPropertyValue('--rgn-accent').trim() || '#cfaf7e';
  const veil =
    styles.getPropertyValue('--rgn-veil').trim() || 'rgb(0 0 0 / 0.45)';
  const configure = (c, fill) => {
    c.setTransform(sx, 0, 0, sy, 0, 0);
    c.fillStyle = fill;
    c.strokeStyle = fill;
    c.lineCap = 'round';
    c.lineJoin = 'round';
  };

  if (shapes.length) {
    const maskCtx = layer(layers, 'mask', width, height);
    const ringCtx = layer(layers, 'ring', width, height);
    if (!maskCtx || !ringCtx) return;
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, width, height);
    configure(maskCtx, accent);
    drawShapes(maskCtx, shapes, 0);

    const grow = (OUTLINE_PX * dpr) / Math.min(sx, sy);
    ringCtx.setTransform(1, 0, 0, 1, 0, 0);
    ringCtx.globalCompositeOperation = 'source-over';
    ringCtx.clearRect(0, 0, width, height);
    configure(ringCtx, accent);
    drawShapes(ringCtx, shapes, grow);
    ringCtx.setTransform(1, 0, 0, 1, 0, 0);
    ringCtx.globalCompositeOperation = 'destination-out';
    ringCtx.drawImage(layers.mask, 0, 0);
    ringCtx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(layers.mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.16;
    ctx.drawImage(layers.mask, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(layers.ring, 0, 0);
  }

  if (preview) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeRect(
      preview.x * sx + dpr,
      preview.y * sy + dpr,
      Math.max(0, preview.width * sx - 2 * dpr),
      Math.max(0, preview.height * sy - 2 * dpr),
    );
    ctx.setLineDash([]);
  }
}

function sessionFor(key, base, selection, limits, previous) {
  if (!key) return { key, history: createHistory(), feather: 0, notice: null };
  const loaded = loadSelection(selection, base, limits);
  const lost =
    Boolean(previous?.history.present.length) && !loaded.shapes.length;
  return {
    key,
    history: createHistory(loaded.shapes),
    feather: loaded.feather,
    notice: lost
      ? 'The base image changed, so the selection was cleared.'
      : loaded.notice,
  };
}

/**
 * Region selection for a generated-image composite edit. A controlled,
 * self-contained overlay: it never changes the draft itself. Apply hands the
 * owner one complete selection value (or null when nothing is selected);
 * Cancel, Escape and Close leave the owner's selection untouched.
 *
 * The model still edits the whole image; the server keeps the generated pixels
 * only inside the selection and the base's exact pixels everywhere else.
 *
 * @param {object} props
 * @param {{file: Blob, sha256: string, dimensions: {width: number, height:
 *   number}, label?: string} | null} props.base the first ordered reference:
 *   its original bytes, raw SHA-256 and EXIF-oriented pixel size
 * @param {object | null} props.selection the draft's current `region_edit`
 * @param {object | null} props.capability `models.region_editing` from the API
 * @param {ReturnType<import('./objectUrls.js').createUrlLedger>} [props.urls]
 *   the shared ledger the editor leases its own display URL from
 * @param {(selection: object | null) => void} props.onApply commit one value;
 *   the owner then closes the editor
 * @param {() => void} props.onClose the owner returns focus to its opener
 */
export default function RegionEditor({
  base,
  selection = null,
  capability,
  urls = null,
  onApply,
  onClose,
}) {
  const titleId = useId();
  const leadId = useId();
  const fieldsId = useId();
  const hintId = useId();
  const dialog = useRef(null);
  const stage = useRef(null);
  const surface = useRef(null);
  const canvas = useRef(null);
  const layers = useRef({});
  const closeButton = useRef(null);
  const toolInput = useRef(null);
  const gesture = useRef(null);
  const ownedUrl = useRef(null);

  const cap = readRegionCapability(capability);
  const limits = cap.ok ? cap.limits : null;
  const refusal = cap.ok ? baseProblem(base, limits) : cap.reason;
  const ready = !refusal;
  const size = ready ? baseSize(base) : null;
  const key = ready ? `${base.sha256}:${size.width}x${size.height}` : null;

  const [session, setSession] = useState(() =>
    sessionFor(key, base, selection, limits, null),
  );
  if (session.key !== key)
    setSession(sessionFor(key, base, selection, limits, session));
  const shapes = session.history.present;

  const [tool, setTool] = useState(() => (cap.ok ? cap.tools[0] : 'rectangle'));
  const activeTool =
    cap.ok && cap.tools.includes(tool) ? tool : (cap.tools?.[0] ?? null);
  const [radius, setRadius] = useState(null);
  const radiusMax = size ? maxBrushRadius(size, limits) : 1;
  const brushRadius = size
    ? Math.min(
        radiusMax,
        Math.max(1, radius ?? defaultBrushRadius(size, limits)),
      )
    : 1;
  const [fieldsState, setFieldsState] = useState({ key: null, value: null });
  const fields = fieldsState.key === key ? fieldsState.value : null;
  const setFields = useCallback(
    (next) =>
      setFieldsState((state) => {
        const current = state.key === key ? state.value : null;
        return {
          key,
          value: typeof next === 'function' ? next(current) : next,
        };
      }),
    [key],
  );
  const [fieldsOpenState, setFieldsOpenState] = useState({
    key: null,
    value: false,
  });
  const fieldsOpen =
    fieldsOpenState.key === key ? fieldsOpenState.value : false;
  const setFieldsOpen = useCallback(
    (next) =>
      setFieldsOpenState((state) => {
        const current = state.key === key ? state.value : false;
        return {
          key,
          value: typeof next === 'function' ? next(current) : next,
        };
      }),
    [key],
  );
  const [draft, setDraft] = useState(null);
  const [hoverState, setHoverState] = useState({ key: null, value: null });
  const hover = hoverState.key === key ? hoverState.value : null;
  const setHover = useCallback((value) => setHoverState({ key, value }), [key]);
  const [message, setMessage] = useState({ id: 0, text: '' });
  const [applyErrorState, setApplyErrorState] = useState({
    key: null,
    value: null,
  });
  const applyError = applyErrorState.key === key ? applyErrorState.value : null;
  const setApplyError = useCallback(
    (value) => setApplyErrorState({ key, value }),
    [key],
  );
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [shown, setShown] = useState({
    url: null,
    status: 'idle',
    natural: null,
  });

  const file = ready ? (base.file ?? null) : null;
  const imageStatus = !ready
    ? 'idle'
    : !(file instanceof Blob)
      ? 'missing'
      : shown.file === file
        ? shown.status
        : 'loading';
  const editable = ready && imageStatus === 'ready';
  const frame = containBox({ left: 0, top: 0, ...stageSize }, size);
  const measured = frame.width > 0 && frame.height > 0;

  const announce = useCallback((text) => {
    setMessage((m) => ({ id: m.id + 1, text }));
  }, []);

  const discard = useCallback(
    (text = null) => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      try {
        surface.current?.releasePointerCapture?.(g.id);
      } catch {
        // The capture was already gone.
      }
      setDraft(null);
      if (text) announce(text);
    },
    [announce, setDraft],
  );

  const releaseBaseUrl = useCallback(() => {
    const lease = ownedUrl.current;
    if (!lease) return;
    ownedUrl.current = null;
    if (lease.ledger) lease.ledger.release(lease.url);
    else URL.revokeObjectURL(lease.url);
  }, []);

  const close = useCallback(() => {
    discard(null);
    releaseBaseUrl();
    onClose();
  }, [discard, onClose, releaseBaseUrl]);

  // A source change ends any unfinished pointer capture. All local drawing
  // state is keyed by source identity, so old draft/fields are ignored at once.
  useEffect(() => {
    const g = gesture.current;
    if (!g || g.key === key) return;
    gesture.current = null;
    try {
      surface.current?.releasePointerCapture?.(g.id);
    } catch {
      // The capture was already gone.
    }
  }, [key]);

  // Lease a display URL for the base's own bytes. It is released when the
  // file changes or the editor closes; the draft's URL is never borrowed.
  useEffect(() => {
    if (!(file instanceof Blob)) return undefined;
    let active = true;
    const show = (next) => {
      Promise.resolve().then(() => {
        if (active) setShown(next);
      });
    };
    let url;
    try {
      url = urls ? urls.acquire(file) : URL.createObjectURL(file);
    } catch (cause) {
      show({
        file,
        url: null,
        status: 'error',
        natural: null,
        diagnostic: localDiagnostic({
          category: 'reference-preview',
          reason: 'The browser could not create a region preview URL.',
          cause,
        }),
      });
      return () => {
        active = false;
      };
    }
    const lease = { url, ledger: urls };
    ownedUrl.current = lease;
    show({ file, url, status: 'loading', natural: null });
    return () => {
      active = false;
      if (ownedUrl.current !== lease) return;
      ownedUrl.current = null;
      if (urls) urls.release(url);
      else URL.revokeObjectURL(url);
    };
  }, [file, urls]);

  // Measure the stage now and on every resize or rotation. A change while
  // drawing would move the mapping under the pointer, so it ends the stroke.
  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return undefined;
    let prev = null;
    const measure = () => {
      const next = { width: node.clientWidth, height: node.clientHeight };
      if (prev && prev.width === next.width && prev.height === next.height)
        return;
      if (prev) discard('Drawing stopped because the view changed.');
      prev = next;
      setStageSize(next);
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ready, discard]);

  // Losing the window mid-stroke (app switch) must not leave a stroke open.
  useEffect(() => {
    const blur = () => discard('Unfinished stroke discarded.');
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [discard]);

  useEffect(() => {
    // Tools are disabled until the base image loads. Close is always usable,
    // so focus enters the modal immediately and stays stable during loading.
    (closeButton.current ?? dialog.current)?.focus({ preventScroll: true });
  }, []);

  // When the editor turns into a refusal, keep focus inside the dialog.
  useEffect(() => {
    if (ready) return;
    if (!dialog.current?.contains(document.activeElement))
      (closeButton.current ?? dialog.current)?.focus();
  }, [ready]);

  const keyboardRect =
    editable && fieldsOpen && fields && activeTool === 'rectangle'
      ? parseRectangleFields(fields, size)
      : null;
  const draftShape = draft?.key === key ? draft.shape : null;

  useLayoutEffect(() => {
    if (!canvas.current || !size || !measured || !editable) return;
    paintSelection(canvas.current, layers.current, {
      shapes: draftShape ? [...shapes, draftShape] : shapes,
      preview: keyboardRect?.shape ?? null,
      size,
      frame,
    });
  });

  const update = (fn) =>
    setSession((s) => ({ ...s, history: fn(s.history), notice: null }));
  const addShape = (shape, text) => {
    setApplyError(null);
    update((h) => commitShapes(h, [...h.present, shape]));
    announce(text);
  };

  const pointFor = (event) => {
    const rect = surface.current?.getBoundingClientRect();
    return rect
      ? clientToSource({ x: event.clientX, y: event.clientY }, rect, size)
      : null;
  };

  const onPointerDown = (event) => {
    if (!editable) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (gesture.current) {
      // A second finger means a gesture, not a stroke.
      discard('Unfinished stroke discarded.');
      return;
    }
    const point = pointFor(event);
    if (!point?.inside) return;
    if (shapes.length >= limits.max_shapes) {
      announce(
        `Limit of ${limits.max_shapes} shapes reached. Undo or clear to add more.`,
      );
      return;
    }
    const budget = limits.max_points - pointsUsed(shapes);
    if (activeTool === 'brush' && budget < 1) {
      announce(`Limit of ${limits.max_points} brush points reached.`);
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Not every environment supports capture; strokes still end on up.
    }
    const shape =
      activeTool === 'brush'
        ? startStroke(point, brushRadius, size)
        : rectFromDrag(point, point, size);
    gesture.current = {
      id: event.pointerId,
      key,
      tool: activeTool,
      start: point,
      client: { x: event.clientX, y: event.clientY },
      travel: 0,
      budget,
      limited: false,
      shape,
    };
    setHover(null);
    setDraft({ key, shape });
  };

  const onPointerMove = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) {
      if (
        !gesture.current &&
        editable &&
        activeTool === 'brush' &&
        event.pointerType !== 'touch'
      ) {
        const rect = surface.current?.getBoundingClientRect();
        if (rect)
          setHover({
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
      }
      return;
    }
    const events = event.nativeEvent?.getCoalescedEvents?.() ?? [];
    for (const item of events.length ? events : [event]) {
      const point = pointFor(item);
      if (!point) continue;
      g.travel = Math.max(
        g.travel,
        Math.hypot(item.clientX - g.client.x, item.clientY - g.client.y),
      );
      if (g.tool === 'brush') {
        const next = extendStroke(g.shape, point, size, g.budget);
        g.shape = next.stroke;
        g.limited ||= next.limited;
      } else {
        g.shape = rectFromDrag(g.start, point, size);
      }
    }
    if (g.tool === 'brush' && event.pointerType !== 'touch') {
      const rect = surface.current?.getBoundingClientRect();
      if (rect)
        setHover({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    setDraft({ key: g.key, shape: g.shape });
  };

  const onPointerUp = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    setDraft(null);
    if (g.key !== key) return;
    if (g.tool === 'rectangle') {
      if (g.travel < RECT_TAP_PX) return;
      addShape(
        g.shape,
        `Rectangle added: ${g.shape.width}×${g.shape.height} at ${g.shape.x}, ${g.shape.y}.`,
      );
      return;
    }
    const point = pointFor(event);
    let stroke = g.shape;
    let limited = g.limited;
    if (point) {
      const next = extendStroke(stroke, point, size, g.budget, { final: true });
      stroke = next.stroke;
      limited ||= next.limited;
    }
    if (limited) {
      announce(
        'Brush point limit reached. This stroke was discarded; the existing selection is unchanged.',
      );
      return;
    }
    addShape(stroke, 'Brush stroke added.');
  };

  const onPointerAbort = (event) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    discard('Unfinished stroke discarded.');
  };

  const undo = () => {
    if (!session.history.past.length) return;
    setApplyError(null);
    update(undoShapes);
    announce('Undone.');
  };
  const redo = () => {
    if (!session.history.future.length) return;
    setApplyError(null);
    update(redoShapes);
    announce('Redone.');
  };
  const clear = () => {
    if (!shapes.length) return;
    setApplyError(null);
    update((h) => commitShapes(h, []));
    announce('Selection cleared.');
  };
  const whole = size ? fullRectangle(size) : null;
  const isWhole =
    whole &&
    shapes.length === 1 &&
    shapes[0].kind === 'rectangle' &&
    shapes[0].width === whole.width &&
    shapes[0].height === whole.height;
  const selectAll = () => {
    if (!whole || isWhole) return;
    setApplyError(null);
    update((h) => commitShapes(h, [whole]));
    announce('Whole image selected.');
  };

  const addKeyboardRect = () => {
    if (!keyboardRect?.shape) return;
    if (shapes.length >= limits.max_shapes) {
      announce(
        `Limit of ${limits.max_shapes} shapes reached. Undo or clear to add more.`,
      );
      return;
    }
    const s = keyboardRect.shape;
    addShape(s, `Rectangle added: ${s.width}×${s.height} at ${s.x}, ${s.y}.`);
  };

  const apply = () => {
    if (!editable) return;
    const built = buildSelection(base, shapes, session.feather, limits);
    if (!built.ok) {
      setApplyError(built.error);
      return;
    }
    onApply(built.value);
  };

  const onDialogKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (gesture.current) {
        discard('Unfinished stroke discarded.');
        return;
      }
      close();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    const typing =
      event.target instanceof HTMLInputElement && event.target.type === 'text';
    if (mod && !typing && editable && !event.altKey) {
      const k = event.key.toLowerCase();
      if (k === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((k === 'z' && event.shiftKey) || k === 'y') {
        event.preventDefault();
        redo();
        return;
      }
    }
    if (event.key !== 'Tab') return;
    const nodes = [...dialog.current.querySelectorAll(FOCUSABLE)].filter(
      (node) => !node.closest('[inert]') && !node.closest('[hidden]'),
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onLoad = (event) => {
    const node = event.currentTarget;
    if (node.getAttribute('src') !== shown.url || shown.file !== file) return;
    const natural = { width: node.naturalWidth, height: node.naturalHeight };
    const matches =
      natural.width === size.width && natural.height === size.height;
    setShown((s) =>
      s.url === shown.url
        ? { ...s, status: matches ? 'ready' : 'mismatch', natural }
        : s,
    );
  };
  const onError = (event) => {
    if (event.currentTarget.getAttribute('src') !== shown.url) return;
    setShown((s) => (s.url === shown.url ? { ...s, status: 'error' } : s));
  };

  const openFields = () => {
    if (!fieldsOpen && !fields && size) setFields(defaultRectangleFields(size));
    setFieldsOpen((open) => !open);
  };
  const onFieldKey = (name) => (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      if (event.key === 'Enter') {
        event.preventDefault();
        addKeyboardRect();
      }
      return;
    }
    event.preventDefault();
    const step = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
    setFields((f) => stepRectangleField(f, name, step, size));
  };

  const label = base?.label || 'Base image';
  const sizeText = size ? `${size.width}×${size.height}` : null;
  const count = shapes.length;
  const used = pointsUsed(shapes);
  const status = !ready
    ? null
    : count
      ? plural(count, 'area', 'areas')
      : 'No region selected';
  const ring =
    hover && activeTool === 'brush' && measured && editable
      ? (brushRadius * 2 + 1) * (frame.width / size.width)
      : 0;

  const stateText = {
    loading: 'Loading the base image…',
    error: 'The base image could not be displayed.',
    missing: 'The base image file is not available in this browser.',
    mismatch: shown.natural
      ? `The base image displays at ${shown.natural.width}×${shown.natural.height} but is recorded as ${sizeText}. Region editing is unavailable for it.`
      : 'The base image could not be measured.',
  }[imageStatus];

  return createPortal(
    <div className="rgn-backdrop">
      <section
        ref={dialog}
        className="rgn-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ready ? leadId : `${leadId}-refusal`}
        tabIndex={-1}
        onKeyDown={onDialogKey}
        data-ready={ready}
      >
        <header className="rgn-bar">
          <h2 id={titleId} className="rgn-title">
            Edit region
          </h2>
          {ready ? (
            <span className="rgn-base">
              {[label, sizeText].filter(Boolean).join(' · ')}
            </span>
          ) : null}
          {ready ? (
            <InfoPopover
              label="Region editing details"
              align="end"
              panelClassName="rgn-info"
            >
              <ul>
                <li>
                  The image model receives the whole base image and returns a
                  full new image. It is not a masked model edit.
                </li>
                <li>
                  {`The generated image is scaled to cover ${sizeText}, centred and cropped, then kept only inside the selection.`}
                </li>
                <li>
                  Outside the selection, every pixel keeps the base image’s
                  exact colour and transparency.
                </li>
                <li>
                  Coordinates are pixels of the upright base image. Rectangles
                  include their left and top edges and exclude the right and
                  bottom.
                </li>
                <li>
                  Brush strokes are circles along the path, clipped to the
                  image. The server computes the final mask.
                </li>
                <li>Edge softening fades inward only.</li>
                <li>
                  {`Limits: ${limits.max_shapes} shapes, ${limits.max_points} brush points, ${radiusMax} px brush radius, ${limits.max_feather} px softening.`}
                </li>
              </ul>
            </InfoPopover>
          ) : null}
          <button
            ref={closeButton}
            type="button"
            className="icon-btn rgn-close"
            aria-label="Close region editor"
            onClick={close}
          >
            <Icon name="close" size={20} />
          </button>
        </header>

        {ready ? (
          <>
            <p id={leadId} className="rgn-lead">
              {`The model redraws the whole image; only the selected region is kept and everything outside it stays exactly as in the base. Output ${sizeText}.`}
            </p>
            {session.notice ? (
              <p className="rgn-note" role="status">
                {session.notice}
                <WarningDetails
                  diagnostic={localDiagnostic({
                    category: 'region-validation',
                    reason: session.notice,
                  })}
                  label="Region restoration details"
                />
              </p>
            ) : null}
            <div className="rgn-body">
              <div ref={stage} className="rgn-stage" data-status={imageStatus}>
                <div
                  className="rgn-frame"
                  style={
                    measured
                      ? {
                          width: `${frame.width}px`,
                          height: `${frame.height}px`,
                        }
                      : {
                          width: '100%',
                          aspectRatio: `${size.width} / ${size.height}`,
                        }
                  }
                >
                  {shown.url && shown.file === file ? (
                    <img
                      key={shown.url}
                      src={shown.url}
                      className="rgn-img"
                      alt={`${label}, base image for the region edit`}
                      data-state={imageStatus}
                      draggable={false}
                      onLoad={onLoad}
                      onError={onError}
                    />
                  ) : null}
                  {editable ? (
                    <>
                      <canvas
                        ref={canvas}
                        className="rgn-canvas"
                        aria-hidden="true"
                      />
                      <div
                        ref={surface}
                        className="rgn-surface"
                        data-tool={activeTool}
                        data-drawing={Boolean(draft)}
                        aria-hidden="true"
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerAbort}
                        onLostPointerCapture={onPointerAbort}
                        onPointerLeave={() => setHover(null)}
                      />
                      {ring ? (
                        <span
                          className="rgn-brush-ring"
                          aria-hidden="true"
                          style={{
                            width: `${ring}px`,
                            height: `${ring}px`,
                            left: `${hover.x}px`,
                            top: `${hover.y}px`,
                          }}
                        />
                      ) : null}
                    </>
                  ) : null}
                </div>
                {stateText ? (
                  <p
                    className="rgn-state"
                    role={imageStatus === 'loading' ? 'status' : 'alert'}
                  >
                    {stateText}
                    {imageStatus !== 'loading' ? (
                      <ErrorDetails
                        diagnostic={
                          (shown.file === file ? shown.diagnostic : null) ??
                          localDiagnostic({
                            category:
                              imageStatus === 'missing'
                                ? 'reference-storage'
                                : 'reference-preview',
                            reason: stateText,
                            facts: { recordedSize: sizeText },
                          })
                        }
                        label="Region base image details"
                      />
                    ) : null}
                  </p>
                ) : null}
                {editable ? (
                  <p className="rgn-stage-hint" aria-hidden="true">
                    {activeTool === 'brush'
                      ? 'Brush over areas to edit'
                      : 'Drag to select · Enter coordinates for exact bounds'}
                  </p>
                ) : null}
              </div>

              <div className="rgn-panel">
                <fieldset
                  className="rgn-group rgn-tools"
                  data-tool={activeTool}
                  disabled={!editable}
                >
                  <legend className="rgn-legend">Tool</legend>
                  <div className="rgn-tool-track" data-count={cap.tools.length}>
                    <span className="rgn-tool-thumb" aria-hidden="true" />
                    {cap.tools.map((name) => (
                      <label key={name} className="rgn-tool">
                        <input
                          ref={name === activeTool ? toolInput : undefined}
                          type="radio"
                          name={`${titleId}-tool`}
                          value={name}
                          checked={activeTool === name}
                          onChange={() => {
                            discard(null);
                            setTool(name);
                          }}
                        />
                        <span>
                          <ToolGlyph tool={name} />
                          {name === 'rectangle' ? 'Rectangle' : 'Brush'}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div
                  key={activeTool}
                  className="rgn-group rgn-options"
                  data-dir={activeTool === 'brush' ? 'next' : 'prev'}
                >
                  {activeTool === 'brush' ? (
                    <label className="rgn-range">
                      <span className="rgn-range-head">
                        <span>Brush radius</span>
                        <output>{`${brushRadius} px`}</output>
                      </span>
                      <input
                        type="range"
                        min={1}
                        max={radiusMax}
                        step={1}
                        value={brushRadius}
                        disabled={!editable}
                        onChange={(event) =>
                          setRadius(Number(event.target.value))
                        }
                      />
                    </label>
                  ) : (
                    <div className="rgn-coords" data-open={fieldsOpen}>
                      <button
                        type="button"
                        className="rgn-disclosure"
                        aria-expanded={fieldsOpen}
                        aria-controls={fieldsId}
                        disabled={!editable}
                        onClick={openFields}
                      >
                        <span className="rgn-chevron" aria-hidden="true">
                          <Icon name="chevron" size={18} />
                        </span>
                        Enter coordinates
                      </button>
                      <div
                        id={fieldsId}
                        className="rgn-coords-body"
                        inert={!fieldsOpen}
                      >
                        <div className="rgn-coords-inner">
                          {fields ? (
                            <>
                              <div className="rgn-fields">
                                {FIELDS.map(([name, text]) => (
                                  <label key={name} className="rgn-field">
                                    <span>{text}</span>
                                    <input
                                      className="field"
                                      type="text"
                                      inputMode="numeric"
                                      autoComplete="off"
                                      spellCheck={false}
                                      value={fields[name]}
                                      aria-invalid={
                                        keyboardRect?.field === name ||
                                        undefined
                                      }
                                      aria-describedby={`${hintId} ${hintId}-error`}
                                      onChange={(event) =>
                                        setFields((f) => ({
                                          ...f,
                                          [name]: event.target.value,
                                        }))
                                      }
                                      onKeyDown={onFieldKey(name)}
                                    />
                                  </label>
                                ))}
                              </div>
                              <p id={hintId} className="rgn-hint">
                                {`Pixels of ${sizeText}. Arrow keys step 1, Shift+Arrow 10.`}
                              </p>
                              <p
                                id={`${hintId}-error`}
                                className="rgn-error"
                                aria-live="polite"
                              >
                                {keyboardRect?.error ?? ''}
                                {keyboardRect?.error ? (
                                  <ErrorDetails
                                    diagnostic={localDiagnostic({
                                      category: 'region-validation',
                                      reason: keyboardRect.error,
                                    })}
                                    label="Rectangle validation details"
                                  />
                                ) : null}
                              </p>
                              <button
                                type="button"
                                className="btn"
                                disabled={!keyboardRect?.shape}
                                onClick={addKeyboardRect}
                              >
                                <Icon name="plus" size={18} />
                                Add rectangle
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <label className="rgn-group rgn-range">
                  <span className="rgn-range-head">
                    <span>Soften edge</span>
                    <output>{`${session.feather} px`}</output>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={limits.max_feather}
                    step={1}
                    value={session.feather}
                    disabled={!editable}
                    aria-describedby={`${hintId}-feather`}
                    onChange={(event) => {
                      setApplyError(null);
                      setSession((s) => ({
                        ...s,
                        feather: Number(event.target.value),
                      }));
                    }}
                  />
                  <span id={`${hintId}-feather`} className="rgn-hint">
                    Inside the selection only.
                  </span>
                </label>

                <div
                  className="rgn-group rgn-actions"
                  role="group"
                  aria-label="Selection"
                >
                  <Tip label="Undo">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Undo selection change"
                      disabled={!editable || !session.history.past.length}
                      onClick={undo}
                    >
                      <Icon name="undo" size={18} />
                    </button>
                  </Tip>
                  <Tip label="Redo">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Redo selection change"
                      disabled={!editable || !session.history.future.length}
                      onClick={redo}
                    >
                      <span className="rgn-flip">
                        <Icon name="undo" size={18} />
                      </span>
                    </button>
                  </Tip>
                  <button
                    type="button"
                    className="btn"
                    disabled={!editable || isWhole}
                    onClick={selectAll}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!editable || !count}
                    onClick={clear}
                  >
                    Clear
                  </button>
                </div>
                {used > limits.max_points / 2 ||
                count > limits.max_shapes / 2 ? (
                  <p className="rgn-hint rgn-usage">
                    {`${count} of ${limits.max_shapes} shapes · ${used} of ${limits.max_points} brush points`}
                  </p>
                ) : null}
              </div>
            </div>
            <footer className="rgn-foot">
              <p className="rgn-count">{status}</p>
              <p
                key={message.id}
                className="rgn-message"
                role="status"
                aria-live="polite"
              >
                {message.text}
              </p>
              {applyError ? (
                <p className="rgn-error rgn-apply-error" role="alert">
                  {applyError}
                  <ErrorDetails
                    diagnostic={localDiagnostic({
                      category: 'region-validation',
                      reason: applyError,
                    })}
                    label="Region selection details"
                  />
                </p>
              ) : null}
              <div className="rgn-decide">
                <button type="button" className="btn" onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!editable}
                  onClick={apply}
                >
                  Apply
                </button>
              </div>
            </footer>
          </>
        ) : (
          <>
            <p id={`${leadId}-refusal`} className="rgn-refusal" role="alert">
              {refusal}
              <ErrorDetails
                diagnostic={localDiagnostic({
                  category: 'region-validation',
                  reason: refusal,
                })}
                label="Region editing availability details"
              />
            </p>
            <footer className="rgn-foot">
              <div className="rgn-decide">
                <button type="button" className="btn" onClick={close}>
                  Close
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}
