import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  imageKey,
  isBakedWatermark,
  isLocalOnly,
} from '../../data/records/imageRecord.js';
import { hasPlacement } from './watermarkGeometry.js';
import { stableJson } from './privateWatermark.js';

/** Recover only this settled page, serially. Failed rows wait for an explicit retry. */
export function useVisibleWatermarks({ images, watermark, scope, enabled }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({
    binding: null,
    records: new Map(),
    pending: 0,
    failed: 0,
  });
  const kept = useRef({ binding: null, records: new Map() });
  const live = useRef({ images, watermark });
  useLayoutEffect(() => {
    live.current = { images, watermark };
  });
  const binding = stableJson([
    scope,
    images.map((image) => [
      imageKey(image),
      image.sha256,
      image.local_added_at,
    ]),
    watermark.settings,
  ]);
  const active = enabled && watermark.visible && Boolean(watermark.settings);
  const localAvailable = watermark.localAvailable;
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const { images: rows, watermark: owner } = live.current;
    const records =
      kept.current.binding === binding
        ? new Map(kept.current.records)
        : new Map();
    kept.current = { binding, records };
    const needed = rows.filter(
      (image) =>
        !isBakedWatermark(image) &&
        !hasPlacement(
          records.get(imageKey(image)) ?? image,
          owner.settings.rendering,
        ) &&
        (!isLocalOnly(image) || localAvailable),
    );
    let failed = 0;
    setState({ binding, records, pending: needed.length, failed });
    const run = async () => {
      for (let index = 0; index < needed.length; index += 1) {
        if (controller.signal.aborted) return;
        const image = needed[index];
        try {
          const response = await owner.analyze(image, {
            force: false,
            publish: false,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          const analysis = response?.analysis?.analysis;
          const record =
            response?.image ?? (analysis ? { ...image, ...analysis } : null);
          if (!record || !hasPlacement(record, owner.settings.rendering))
            throw new Error('Current watermark analysis is unavailable.');
          records.set(imageKey(image), record);
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') return;
          failed += 1;
        }
        setState({
          binding,
          records: new Map(records),
          pending: needed.length - index - 1,
          failed,
        });
      }
    };
    void run();
    return () => controller.abort();
  }, [active, binding, attempt, localAvailable]);
  const current = state.binding === binding ? state : null;
  return {
    images: images.map((image) =>
      hasPlacement(image, watermark.settings?.rendering)
        ? image
        : (current?.records.get(imageKey(image)) ?? image),
    ),
    pending: active ? (current?.pending ?? 0) : 0,
    failed: active ? (current?.failed ?? 0) : 0,
    retry: () => setAttempt((value) => value + 1),
  };
}
