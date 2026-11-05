import React, { useLayoutEffect, useRef, useState } from 'react';

import { Icon, InfoPopover } from './ui.jsx';
import './ModelPills.css';

const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function safeResourceUrl(value) {
  const candidate = text(value);
  if (
    !candidate ||
    [...candidate].some(
      (character) =>
        /\s/.test(character) ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(candidate);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function displayName(descriptor, fallback) {
  return text(descriptor?.name) ?? text(descriptor?.id) ?? text(fallback);
}

function descriptorSection(title, descriptor, fallback) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const name = displayName(descriptor, fallback);
  const identifier = text(descriptor.id);
  const reportedRole = text(descriptor.role);
  // Canonical roles are already named by the section heading.
  const role = ['base', 'lora', 'llm'].includes(reportedRole)
    ? null
    : reportedRole;
  const publisher = text(descriptor.publisher);
  const detail = text(descriptor.detail);
  const href = safeResourceUrl(descriptor.url);
  if (!name && !role && !publisher && !detail && !href) return null;

  return (
    <section
      className="model-resource"
      key={`${title}-${name ?? role ?? 'model'}`}
    >
      <h3>{title}</h3>
      {name ? <p className="model-resource-name">{name}</p> : null}
      {identifier && identifier !== name ? (
        <p className="model-resource-role">
          Model ID: <code>{identifier}</code>
        </p>
      ) : null}
      {role ? <p className="model-resource-role">Role: {role}</p> : null}
      {publisher ? (
        <p className="model-resource-publisher">Publisher: {publisher}</p>
      ) : null}
      {detail ? <p className="model-resource-detail">{detail}</p> : null}
      {href ? (
        <a
          href={href}
          aria-label={`${name ?? title} resource page`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Resource page <span aria-hidden="true">↗</span>
        </a>
      ) : null}
    </section>
  );
}

const canMeasure = () => typeof ResizeObserver !== 'undefined';

const hasLink = (...descriptors) =>
  descriptors.some(
    (descriptor) =>
      descriptor &&
      typeof descriptor === 'object' &&
      safeResourceUrl(descriptor.url),
  );

const loraText = (count) =>
  count ? `+${count} LoRA${count === 1 ? '' : 's'}` : '';

function ModelPill({
  label,
  name,
  count,
  sections,
  linked,
  combined = false,
  llmName,
  showNames = true,
}) {
  if (!name) return null;
  const loraLabel = loraText(count);
  const accessibleName = combined
    ? `Models: Image ${name}${loraLabel ? ` ${loraLabel}` : ''}, Language ${llmName}`
    : `${label} ${name}${loraLabel ? ` ${loraLabel}` : ''}`;
  const trigger = (
    <>
      <span className="model-pill-role">{label}</span>
      {showNames ? (
        <span className="model-pill-name">
          {combined ? `${name} · ${llmName}` : name}
        </span>
      ) : null}
      {showNames && loraLabel ? (
        <span className="model-pill-count">{loraLabel}</span>
      ) : null}
      {sections.length ? <Icon name="chevron" size={14} /> : null}
    </>
  );
  if (!sections.length)
    return (
      <li className="pill model-pill" aria-label={accessibleName}>
        {trigger}
      </li>
    );

  return (
    <li className="model-pill-item" data-combined={combined || undefined}>
      <InfoPopover
        label={combined ? 'Model details' : `${label} model details`}
        triggerLabel={`${accessibleName} details`}
        className="model-pill-anchor"
        triggerClassName="pill model-pill model-pill-trigger"
        panelClassName="model-resource-popover"
        align="end"
        informational={!linked}
        triggerContent={trigger}
      >
        <div className="model-resource-list">{sections}</div>
      </InfoPopover>
    </li>
  );
}

/** Below this slot width the capsule drops the names and keeps "Models". */
const NAMES_MIN_REM = 13;

/**
 * How the model identities are shown: `full` (two pills), `compact` (one
 * capsule with the names) or `bare` (one capsule without them, for a very
 * narrow slot). The width the full pills need is measured while they are shown
 * and remembered, so they return as soon as the slot is wide enough. Without
 * ResizeObserver the full pills are always used.
 */
function useDisplayMode(enabled, resetKey) {
  const slot = useRef(null);
  const natural = useRef({ key: resetKey, width: 0 });
  const focused = useRef(null);
  const [mode, setMode] = useState('full');

  useLayoutEffect(() => {
    const element = slot.current;
    if (!enabled || !element || !canMeasure()) return undefined;
    if (natural.current.key !== resetKey) {
      natural.current = { key: resetKey, width: 0 };
      // A zero natural width restores the full pills for a fresh measurement.
    }
    const check = () => {
      const list = element.querySelector('[data-fit]');
      if (list) natural.current.width = list.offsetWidth;
      const room = element.clientWidth;
      const rem =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const next =
        natural.current.width <= room + 1
          ? 'full'
          : room < NAMES_MIN_REM * rem
            ? 'bare'
            : 'compact';
      if (next === mode) return;
      focused.current = element.contains(document.activeElement)
        ? document.activeElement
        : null;
      setMode(next);
    };
    check();
    // Defer observer-driven updates to the next frame. Changing the disclosure
    // width inside delivery can otherwise cause a ResizeObserver loop error.
    let frame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    });
    observer.observe(element);
    const list = element.querySelector('[data-fit]');
    if (list) observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [enabled, mode, resetKey]);

  useLayoutEffect(() => {
    // If the Language pill disappears on rotation, keep its keyboard position
    // at the surviving Models capsule. Existing focused content stays put.
    if (focused.current && !focused.current.isConnected)
      slot.current?.querySelector('button')?.focus();
    focused.current = null;
  }, [mode]);

  return [slot, enabled ? mode : 'full'];
}

/** Read-only model identity and public-resource disclosures from /api/models. */
export default function ModelPills({ models }) {
  const data = models && typeof models === 'object' ? models : {};
  const nested =
    data.models && typeof data.models === 'object' ? data.models : {};
  const image =
    nested.image && typeof nested.image === 'object' ? nested.image : null;
  const llm = nested.llm && typeof nested.llm === 'object' ? nested.llm : null;
  const loras = Array.isArray(nested.image_loras)
    ? nested.image_loras.filter((item) => item && typeof item === 'object')
    : [];
  const imageName = displayName(image, data.image_model);
  const llmName = displayName(llm, data.llm_model);

  const loraSections = loras
    .map((lora, index) => descriptorSection(`LoRA ${index + 1}`, lora, null))
    .filter(Boolean);
  const imageSections = [
    descriptorSection('Base image model', image, imageName),
    ...loraSections,
  ].filter(Boolean);
  const llmSections = [
    descriptorSection('Language model', llm, llmName),
  ].filter(Boolean);

  // The capsule needs both identities and somewhere to show their details.
  const combinable = Boolean(imageName && llmName);
  const [slot, mode] = useDisplayMode(combinable, `${imageName}|${llmName}`);

  if (!imageName && !llmName) return null;
  const linkedImage = hasLink(image, ...loras);
  const linkedLlm = hasLink(llm);
  const named = (title, name, sections) =>
    sections.length
      ? sections
      : [
          <section className="model-resource" key={title}>
            <h3>{title}</h3>
            <p className="model-resource-name">{name}</p>
          </section>,
        ];
  const combined = mode !== 'full';
  const sections = combined
    ? [
        ...named('Base image model', imageName, imageSections),
        ...named('Language model', llmName, llmSections),
      ]
    : imageSections;
  return (
    <div className="model-pills-slot" ref={slot}>
      <ul
        className="model-pills"
        aria-label="Configured models"
        data-fit={(!combined && combinable && canMeasure()) || undefined}
      >
        <ModelPill
          label={combined ? 'Models' : 'Image'}
          combined={combined}
          llmName={llmName}
          showNames={mode !== 'bare'}
          name={imageName}
          count={loraSections.length}
          sections={sections}
          linked={linkedImage || (combined && linkedLlm)}
        />
        {!combined ? (
          <ModelPill
            label="Language"
            name={llmName}
            sections={llmSections}
            linked={linkedLlm}
          />
        ) : null}
      </ul>
    </div>
  );
}

export { safeResourceUrl };
