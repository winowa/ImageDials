import { useEffect, useRef, useState } from 'react';

import { classifyOrientation, describeImage } from './imageRecord.js';

/**
 * Pixel sizes measured from loaded originals, for records whose wire data has
 * none. The wire record is never modified: measured sizes live beside it.
 *
 * @param {object[]} images wire records
 * @returns {Map<string, {width: number, height: number}>} by image key
 */
export function useMeasuredSizes(images) {
  const [sizes, setSizes] = useState(() => new Map());
  const probed = useRef(new Set());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    for (const image of images) {
      const view = describeImage(image);
      if (view.size || !view.originalUrl || probed.current.has(view.key))
        continue;
      probed.current.add(view.key);
      const probe = new Image();
      probe.onload = () => {
        const { naturalWidth: width, naturalHeight: height } = probe;
        if (!alive.current || !(width > 0 && height > 0)) return;
        setSizes((prev) => new Map(prev).set(view.key, { width, height }));
      };
      // An original that cannot load stays `unknown`; the page shows its own error.
      probe.src = view.originalUrl;
    }
  }, [images]);

  return sizes;
}

/** Orientation using the wire size first, then a size measured from the file. */
export function orientationOf(image, measured) {
  const view = describeImage(image);
  return view.size
    ? view.orientation
    : classifyOrientation(measured?.get(view.key) ?? null);
}
