import React, { useEffect, useId, useMemo, useRef } from 'react';

import {
  CONTRAST_ROWS,
  LUMINANCE,
  resolveAccent,
  SATURATION,
  SWATCHES,
} from './appearance.js';
import { InfoPopover, Segmented } from '../../shared/ui/ui.jsx';
import {
  ErrorDetails,
  WarningDetails,
} from '../../shared/diagnostics/ErrorDetails.jsx';
import { localDiagnostic } from '../../shared/diagnostics/diagnostics.js';

const MODE_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const ratio = (value) => `${value.toFixed(2)}:1`;

function Slider({ label, range, value, onChange }) {
  const id = useId();
  return (
    <div className="al-slider">
      <div className="al-slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{value}%</output>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        aria-valuetext={`${value} percent`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/** Accent Lab: colour mode, accent swatches, measured contrast, reset. */
export default function AppearanceMenu({ appearance }) {
  const { mode, theme, accent, resolved, saved } = appearance;
  const hexes = useMemo(
    () =>
      Object.fromEntries(
        SWATCHES.map((s) => [
          s.id,
          resolveAccent(theme, { ...accent, swatch: s.id }).requested.hex,
        ]),
      ),
    [theme, accent],
  );

  const diagnosticOwner = useRef(null);
  // The shared details dialog is portaled outside this popover. Keep Escape
  // scoped to that inner dialog before the owner's document handler runs.
  useEffect(() => {
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      const owner = diagnosticOwner.current;
      const trigger = owner?.querySelector(
        '.diagnostic-trigger[aria-expanded="true"]',
      );
      const popup = trigger
        ? document.getElementById(trigger.getAttribute('aria-controls'))
        : null;
      const close = popup?.querySelector('button[aria-label="Close details"]');
      if (!close) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close.click();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, []);
  const contrastDiagnostic = useMemo(
    () =>
      localDiagnostic({
        category: 'contrast',
        reason: [
          resolved.requested.message
            ? `Requested color: ${resolved.requested.message}`
            : 'The requested color passes this background comparison.',
          resolved.limited
            ? 'The applied accent was adjusted to preserve readable text and focus contrast.'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        facts: Object.fromEntries([
          ['Contrast', `${resolved.requested.ratio}:1`],
          ['Threshold', '4.5:1 normal text'],
          ['Compared with', resolved.requested.background.label],
          ['Applied color', resolved.hex],
          ['Applied text contrast', `${resolved.measured.accentText}:1`],
        ]),
        data: {
          requestedColor: resolved.requested.hex,
          appliedColor: resolved.hex,
          background: resolved.requested.background,
          requestedRatio: resolved.requested.ratio,
          minimumTextRatio: 4.5,
          minimumControlRatio: 3,
          enhancedTextRatio: 7,
          warningMargin: 0.5,
          adjusted: resolved.limited,
          appliedMeasurements: resolved.measured,
          settings: accent,
          guidance:
            'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
        },
      }),
    [resolved, accent],
  );

  return (
    <InfoPopover
      label="Accent Lab"
      icon="palette"
      align="end"
      iconSize={22}
      className="appearance-anchor"
      triggerClassName="theme-toggle appearance-toggle"
      panelClassName="appearance-panel"
    >
      <div
        ref={diagnosticOwner}
        className="al-content"
        onBlurCapture={(event) => {
          if (event.relatedTarget?.closest?.('.diagnostic-popover'))
            event.stopPropagation();
        }}
        onPointerDown={(event) => {
          // Let the inner control handle the event, then stop the owner's
          // outside-click handler from treating its portal as an outside tap.
          if (event.target?.closest?.('.diagnostic-popover'))
            event.stopPropagation();
        }}
      >
        <div className="al-head">
          <h2>Accent Lab</h2>
          <span
            className="al-preview"
            style={{ background: resolved.hex }}
            aria-hidden="true"
          />
        </div>
        <Segmented
          legend="Theme"
          name="appearance-mode"
          value={mode}
          options={MODE_OPTIONS}
          onChange={appearance.setMode}
        />
        <fieldset className="al-swatches">
          <legend>Accent</legend>
          <div className="al-grid">
            {SWATCHES.map((s) => (
              <button
                key={s.id}
                type="button"
                className="al-swatch"
                aria-pressed={accent.swatch === s.id}
                onClick={() => appearance.setAccent({ swatch: s.id })}
              >
                <span className="al-dot" style={{ background: hexes[s.id] }} />
                <span className="al-name">{s.label}</span>
                <code>{hexes[s.id]}</code>
              </button>
            ))}
          </div>
        </fieldset>
        <Slider
          label="Saturation"
          range={SATURATION}
          value={accent.saturation}
          onChange={(saturation) => appearance.setAccent({ saturation })}
        />
        <Slider
          label="Luminance"
          range={LUMINANCE}
          value={accent.luminance}
          onChange={(luminance) => appearance.setAccent({ luminance })}
        />
        <section
          className="al-requested"
          aria-label="Requested contrast"
          data-level={resolved.requested.level}
        >
          <div className="al-requested-head">
            <span>Requested accent</span>
            <code>{resolved.requested.hex}</code>
            <span
              className="al-dot"
              style={{ background: resolved.requested.hex }}
              aria-hidden="true"
            />
          </div>
          <div className="al-requested-ratio">
            <span>{resolved.requested.background.label}</span>
            <strong className="al-ratio">
              {(Math.floor(resolved.requested.ratio * 100) / 100).toFixed(2)}:1
            </strong>
            <span className="al-grade">{resolved.requested.grade}</span>
          </div>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="al-feedback"
          >
            {resolved.requested.message ? (
              <p className="al-contrast-message">
                <span>{resolved.requested.message}</span>
                {resolved.requested.level === 'error' ? (
                  <ErrorDetails
                    diagnostic={contrastDiagnostic}
                    label="Requested contrast error details"
                  />
                ) : (
                  <WarningDetails
                    diagnostic={contrastDiagnostic}
                    label="Requested contrast warning details"
                  />
                )}
              </p>
            ) : null}
          </div>
          {resolved.limited ? (
            <p className="al-note" role="status">
              Luminance limited to keep text readable. Applied{' '}
              <code>{resolved.hex}</code>.
              <WarningDetails
                diagnostic={contrastDiagnostic}
                label="Applied accent adjustment details"
              />
            </p>
          ) : null}
          <details className="al-thresholds">
            <summary>Contrast thresholds</summary>
            <p>
              WCAG 2.2: normal text 4.5:1; large text and meaningful controls
              3:1; AAA normal text 7:1.
            </p>
            <p>
              <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html">
                WCAG 2.2 contrast guidelines
              </a>
            </p>
            <p>
              Warning margin: 4.5–5:1. Grades use the unrounded ratio against{' '}
              <code>{resolved.requested.background.hex}</code>.
            </p>
            {accent.swatch === 'rebecca' || accent.swatch === 'lagoon' ? (
              <p>Named color at 100% saturation and 100% luminance.</p>
            ) : null}
          </details>
        </section>
        <details className="al-contrast" aria-label="Measured contrast">
          <summary>Applied contrast</summary>
          <ul>
            {CONTRAST_ROWS.map((row) => {
              const value = resolved.measured[row.key];
              const ok = value >= row.min;
              return (
                <li key={row.key} data-ok={ok}>
                  <span>{row.label}</span>
                  <span className="al-ratio">{ratio(value)}</span>
                  <span className="al-verdict">
                    {ok ? 'Pass' : 'Low'} {row.min}
                    {!ok ? (
                      <ErrorDetails
                        diagnostic={localDiagnostic({
                          category: 'contrast',
                          reason: `Applied ${row.label.toLowerCase()} is below its contrast threshold.`,
                          facts: {
                            Contrast: `${value}:1`,
                            Threshold: `${row.min}:1`,
                          },
                          data: {
                            appliedColor: resolved.hex,
                            measurement: row.key,
                            value,
                            threshold: row.min,
                          },
                        })}
                        label={`${row.label} contrast details`}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
        <div className="al-foot">
          {saved ? null : (
            <p className="al-note" role="status">
              Not saved: browser storage is unavailable.
              <WarningDetails
                diagnostic={localDiagnostic({
                  category: 'storage',
                  reason:
                    'The accent preference remains in memory because browser storage is unavailable.',
                  data: { settings: accent, theme },
                })}
                label="Accent storage warning details"
              />
            </p>
          )}
          <button
            type="button"
            className="btn al-reset"
            onClick={appearance.resetAccent}
          >
            Reset accent
          </button>
        </div>
      </div>
    </InfoPopover>
  );
}
