import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { usePreference } from './preferences.js';
import { Icon } from './ui.jsx';
import './Walkthrough.css';

const STEPS = [
  {
    target: '[data-tour="prompt"]',
    title: 'Describe the image',
    body: 'Write a short description of the image you want.',
  },
  {
    target: '[data-tour="mode"]',
    title: 'Choose a mode',
    body: 'Text to image creates from words. Edit uses reference images and an editing-capable model. Asset image prepares one isolated object for image-to-3D tools, not a mesh.',
  },
  {
    target: '[data-tour="aspect"]',
    title: 'Choose its shape',
    body: 'Pick portrait, landscape, or square for the result.',
  },
  {
    target: '[data-tour="options"] .panel-head',
    title: 'Adjust the details',
    body: 'Options for your idea appear here and can be changed before you generate.',
  },
  {
    target: '[data-tour="generate"]',
    title: 'Create the image',
    body: 'Generate uses your prompt, selected options, and aspect ratio.',
  },
  {
    target: '#result .stage',
    title: 'Review the result',
    body: 'Review the image here. Reuse settings restores its draft; Edit image attaches it as a reference when available.',
  },
  {
    target: '.app-nav',
    global: true,
    title: 'Create, Gallery and Library',
    body: 'Create makes and edits images. Gallery plays saved images. Library finds, downloads and prints saved images.',
  },
];

const EDGE = 12;
const FOCUSABLE = 'button:not(:disabled)';
const calm = () =>
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

function placeCard(anchor, card, viewport) {
  const width = card.width || 392;
  const height = card.height || 250;
  const left = Math.max(
    EDGE,
    Math.min(
      anchor.left + anchor.width / 2 - width / 2,
      viewport.width - width - EDGE,
    ),
  );
  const below = anchor.bottom + EDGE;
  const top =
    below + height <= viewport.height - EDGE
      ? below
      : anchor.top - height - EDGE >= EDGE
        ? anchor.top - height - EDGE
        : Math.max(EDGE, Math.min(anchor.top, viewport.height - height - EDGE));
  return {
    left,
    top: Math.max(EDGE, Math.min(top, viewport.height - height - EDGE)),
  };
}

export { placeCard };

/** A replayable, anchored walkthrough of controls that exist on this page. */
export default function Walkthrough({ rootRef }) {
  const [enabled] = usePreference(
    'show-tour',
    false,
    (value) => value === true,
  );
  const [step, setStep] = useState(null);
  const [previouslyEnabled, setPreviouslyEnabled] = useState(enabled);
  if (enabled !== previouslyEnabled) {
    setPreviouslyEnabled(enabled);
    if (!enabled) setStep(null);
  }
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const next = useRef(null);
  const card = useRef(null);
  const target = useRef(null);
  const wasOpen = useRef(false);
  const frame = useRef(null);

  const dismiss = () => setStep(null);
  const move = (direction) =>
    setStep((current) => {
      if (current === null) return null;
      const nextStep = current + direction;
      return nextStep < 0 || nextStep >= STEPS.length ? null : nextStep;
    });

  useLayoutEffect(() => {
    if (!enabled || step === null) {
      if (wasOpen.current) {
        wasOpen.current = false;
        (
          trigger.current ??
          rootRef.current?.querySelector('[data-tour="prompt"]')
        )?.focus();
      }
      return undefined;
    }

    wasOpen.current = true;
    const node = (
      STEPS[step].global ? document : rootRef.current
    )?.querySelector(STEPS[step].target);
    if (!node) {
      setStep(null);
      return undefined;
    }
    target.current = node;
    node.classList.add('walkthrough-target');
    const rect = node.getBoundingClientRect();
    if (
      rect.top < EDGE ||
      rect.bottom > window.innerHeight - EDGE ||
      rect.left < EDGE ||
      rect.right > window.innerWidth - EDGE
    )
      node.scrollIntoView?.({
        behavior: calm() ? 'auto' : 'smooth',
        block: 'center',
        inline: 'nearest',
      });

    const place = () => {
      if (!target.current || !card.current) return;
      const bounds = target.current.getBoundingClientRect();
      const nextPosition = placeCard(
        bounds,
        { width: card.current.offsetWidth, height: card.current.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      const nextSpotlight = {
        '--spot-x': `${bounds.left + bounds.width / 2}px`,
        '--spot-y': `${bounds.top + bounds.height / 2}px`,
        '--spot-radius': `${Math.max(bounds.width, bounds.height) / 2 + 16}px`,
      };
      const nextState = { ...nextPosition, ...nextSpotlight };
      setPosition((previous) =>
        previous?.left === nextState.left &&
        previous?.top === nextState.top &&
        previous?.['--spot-x'] === nextState['--spot-x'] &&
        previous?.['--spot-y'] === nextState['--spot-y'] &&
        previous?.['--spot-radius'] === nextState['--spot-radius']
          ? previous
          : nextState,
      );
    };
    const schedule = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        place();
      });
    };
    place();
    next.current?.focus();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(node);
    if (card.current) observer?.observe(card.current);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('orientationchange', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      node.classList.remove('walkthrough-target');
      target.current = null;
    };
  }, [rootRef, step, enabled]);

  useEffect(() => {
    if (step === null) return undefined;
    const escape = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key !== 'Tab' || !card.current) return;
      const buttons = [...card.current.querySelectorAll(FOCUSABLE)];
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
        event.preventDefault();
        buttons[0].focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [step]);

  const active = enabled && step !== null ? STEPS[step] : null;
  const spotlight = position
    ? {
        '--spot-x': position['--spot-x'],
        '--spot-y': position['--spot-y'],
        '--spot-radius': position['--spot-radius'],
      }
    : undefined;

  if (!enabled) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="pill-btn walkthrough-launch"
        aria-label="Start guided walkthrough"
        onClick={() => setStep(0)}
      >
        <Icon name="bulb" size={18} />
        Tour
      </button>
      {active
        ? createPortal(
            <>
              <div
                className="walkthrough-shade"
                style={spotlight}
                aria-hidden="true"
              />
              <section
                ref={card}
                className="walkthrough-card"
                role="dialog"
                aria-label="Guided walkthrough"
                aria-describedby="walkthrough-body"
                style={
                  position ?? { left: EDGE, top: EDGE, visibility: 'hidden' }
                }
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    dismiss();
                  }
                }}
              >
                <header className="walkthrough-head">
                  <p className="walkthrough-count">
                    Step {step + 1} of {STEPS.length}
                  </p>
                  <button
                    type="button"
                    className="icon-btn quiet"
                    aria-label="Dismiss walkthrough"
                    onClick={dismiss}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </header>
                <h2>{active.title}</h2>
                <p id="walkthrough-body">{active.body}</p>
                <nav
                  className="walkthrough-actions"
                  aria-label="Walkthrough steps"
                >
                  <button type="button" className="btn" onClick={dismiss}>
                    Skip tour
                  </button>
                  <span />
                  <button
                    type="button"
                    className="btn"
                    disabled={step === 0}
                    onClick={() => move(-1)}
                  >
                    <Icon name="prev" size={16} />
                    Back
                  </button>
                  <button
                    ref={next}
                    type="button"
                    className="btn primary"
                    onClick={() => move(1)}
                  >
                    {step === STEPS.length - 1 ? 'Finish' : 'Next'}
                    {step < STEPS.length - 1 ? (
                      <Icon name="next" size={16} />
                    ) : null}
                  </button>
                </nav>
              </section>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
