import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  effectById,
  effectChosen,
  effectMoves,
  effectsLabel,
  GALLERY_EFFECTS,
  INSTANT_EFFECT,
  toggleEffect,
} from './galleryEffects.js';
import { placePopover } from '../../shared/ui/popoverPlacement.js';
import { Icon } from '../../shared/ui/ui.jsx';
import { SavedImg } from '../../data/media/SavedImg.jsx';

import './GalleryTransitions.css';

/** Gap between the trigger and the panel, and the least gap to the viewport. */
const POPOVER_EDGE_PX = 8;
/** Pause before a hover-opened panel closes, so the pointer can cross into it. */
const POPOVER_LEAVE_GRACE_MS = 160;
/** Rest between two runs of a preview's looping demonstration. */
const PREVIEW_REST_MS = 900;

/**
 * One nested ring per effect, outermost first. Each chosen effect animates its
 * own ring, so several effects on the same change compose (nested transforms
 * multiply, opacities multiply, filters and clips stack) instead of the last
 * `animation` overriding the others. The nesting must not change while a
 * layer is mounted, or its picture would be remounted and reloaded: the stage
 * always renders a ring for every animated effect and lets CSS choose.
 */
export function TransitionRings({ ids, children }) {
  return ids.reduceRight(
    (inner, id) => (
      <span
        className="fx-ring"
        data-fx={id}
        style={{ '--fx-ms': `${effectById(id).durationMs}ms` }}
      >
        {inner}
      </span>
    ),
    children,
  );
}

/** One picture in a preview: a small thumbnail, or a plain swatch. */
function PreviewPicture({ record, tone }) {
  return record ? (
    <SavedImg image={record} className="effect-preview-img" loading="eager" />
  ) : (
    <span className="effect-swatch" data-tone={tone} />
  );
}

/**
 * A small demonstration of one effect between two library thumbnails (plain
 * swatches when the library has fewer than two). Only the active preview
 * moves; it runs the real effect CSS, so what it shows is what the stage does.
 * Reduced motion keeps every preview still.
 */
export function EffectPreview({ effectId, pictures, active, reducedMotion }) {
  const effect = effectById(effectId);
  const moves = active && effectMoves(effectId, reducedMotion);
  // Instant demonstrates itself as a plain hard cut between the pictures.
  const cuts = active && !effect.animated && !reducedMotion;
  const rings = effect.animated ? [effect.id] : [];
  // Which picture is in front, and whether a change is running.
  const [front, setFront] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!cuts) return undefined;
    let timer;
    const cut = () => {
      setFront((f) => 1 - f);
      timer = setTimeout(cut, PREVIEW_REST_MS);
    };
    timer = setTimeout(cut, PREVIEW_REST_MS / 3);
    return () => clearTimeout(timer);
  }, [cuts]);

  useEffect(() => {
    if (!moves) return undefined;
    let timer;
    const run = () => {
      setRunning(true);
      timer = setTimeout(() => {
        setFront((f) => 1 - f);
        setRunning(false);
        timer = setTimeout(run, PREVIEW_REST_MS);
      }, effect.durationMs);
    };
    timer = setTimeout(run, PREVIEW_REST_MS / 3);
    return () => {
      clearTimeout(timer);
      setRunning(false);
    };
  }, [moves, effect.durationMs]);

  const role = (index) => {
    if (!moves || !running) return index === front ? 'shown' : 'idle';
    return index === front ? 'exiting' : 'entering';
  };
  return (
    <span
      className="effect-preview"
      data-effects={rings.join(' ') || undefined}
      data-direction="1"
      aria-hidden="true"
    >
      {[0, 1].map((index) => (
        <span key={index} className="stage-layer" data-role={role(index)}>
          <TransitionRings ids={rings}>
            <PreviewPicture
              record={pictures.length > 1 ? pictures[index] : null}
              tone={index === 0 ? 'a' : 'b'}
            />
          </TransitionRings>
        </span>
      ))}
    </span>
  );
}

/** The chosen-state mark: round for the exclusive Instant, square for animations. */
function ChoiceMark({ exclusive }) {
  return (
    <span
      className="effect-mark"
      data-shape={exclusive ? 'round' : 'square'}
      aria-hidden="true"
    >
      {exclusive ? null : <Icon name="check" size={14} />}
    </span>
  );
}

/**
 * The transition chooser: a button that opens a structured panel listing every
 * effect with a live preview. Animations are checkboxes that combine; Instant
 * is exclusive and clears them (and is what remains when the last animation is
 * unchecked). The panel stays open while choosing. It opens on hover and
 * keyboard focus and stays open when pressed or tapped; Escape, an outside
 * press, focus leaving, or pressing the button again closes it. It is a
 * sibling of its button (so it is reachable in tab order) and fixed-positioned
 * inside the viewport.
 *
 * @param {object} props
 * @param {string[]} props.value chosen animated effect ids (empty: Instant)
 * @param {(ids: string[]) => void} props.onChange
 * @param {object[]} props.pictures up to two records for the previews
 * @param {boolean} props.reducedMotion
 */
export function EffectPicker({ value, onChange, pictures, reducedMotion }) {
  const [state, setState] = useState('closed');
  const [pos, setPos] = useState(null);
  const [probe, setProbe] = useState(null);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const leaveTimer = useRef(null);
  // Returning focus to the button after closing must not open the panel again.
  const returningFocus = useRef(false);
  const id = useId();
  const instantHint = useId();
  const open = state !== 'closed';
  // The option being inspected, else the first chosen one.
  const previewing = probe ?? value[0] ?? INSTANT_EFFECT;

  const place = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    setPos(
      placePopover(
        trigger.current.getBoundingClientRect(),
        {
          width: panel.current.offsetWidth,
          height: panel.current.scrollHeight,
        },
        { width: window.innerWidth, height: window.innerHeight },
        POPOVER_EDGE_PX,
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!wrap.current?.contains(event.target)) setState('closed');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const close = () => {
    clearTimeout(leaveTimer.current);
    setState('closed');
    setPos(null);
    setProbe(null);
  };
  const returnFocus = () => {
    returningFocus.current = true;
    trigger.current?.focus();
    returningFocus.current = false;
  };
  const hoverOpen = () => {
    if (returningFocus.current) return;
    clearTimeout(leaveTimer.current);
    setState((s) => (s === 'closed' ? 'hover' : s));
  };
  const hoverLeave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setState((s) => (s === 'hover' ? 'closed' : s));
      setProbe(null);
    }, POPOVER_LEAVE_GRACE_MS);
  };

  const options = useMemo(() => GALLERY_EFFECTS, []);
  const onGroupKeyDown = (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[
      event.key
    ];
    if (!step) return;
    const boxes = [...panel.current.querySelectorAll('[role="checkbox"]')];
    const at = boxes.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    boxes[(at + step + boxes.length) % boxes.length].focus();
  };

  return (
    <span
      ref={wrap}
      className="effect-picker"
      onMouseEnter={hoverOpen}
      onMouseLeave={hoverLeave}
      onFocus={hoverOpen}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        close();
        returnFocus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="btn effect-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-open={open}
        data-pinned={state === 'pinned'}
        onClick={() => (state === 'pinned' ? close() : setState('pinned'))}
      >
        <span className="effect-trigger-text">
          <span className="effect-trigger-label">Transition</span>
          <strong>{effectsLabel(value)}</strong>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Transitions"
          className="popover effect-panel"
          style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
        >
          {reducedMotion ? (
            <p className="effect-note">
              Reduced motion is on; images change instantly.
            </p>
          ) : null}
          <div
            role="group"
            aria-label="Transitions"
            className="effect-options"
            onKeyDown={onGroupKeyDown}
          >
            {options.map((effect) => {
              const exclusive = effect.id === INSTANT_EFFECT;
              const chosen = effectChosen(value, effect.id);
              return (
                <React.Fragment key={effect.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={chosen}
                    aria-describedby={exclusive ? instantHint : undefined}
                    className="effect-option"
                    data-exclusive={exclusive || undefined}
                    onClick={() => onChange(toggleEffect(value, effect.id))}
                    onMouseEnter={() => setProbe(effect.id)}
                    onFocus={() => setProbe(effect.id)}
                  >
                    <EffectPreview
                      effectId={effect.id}
                      pictures={pictures}
                      active={effect.id === previewing}
                      reducedMotion={reducedMotion}
                    />
                    <span className="effect-option-label">
                      {effect.label}
                      {exclusive ? (
                        <small
                          id={instantHint}
                          className="effect-option-hint"
                          aria-hidden="true"
                        >
                          No animation
                        </small>
                      ) : null}
                    </span>
                    <ChoiceMark exclusive={exclusive} />
                  </button>
                  {exclusive ? (
                    <span className="effect-divider" aria-hidden="true" />
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </span>
  );
}
