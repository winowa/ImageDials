import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { describeImage, isBakedWatermark } from './imageRecord.js';
import { markFor, PREVIEW_MARK_MAX_PIXELS } from './watermarkRenderer.js';
import {
  hasPlacement,
  markGeometry,
  placementOf,
} from './watermarkGeometry.js';

/**
 * Where an image drawn with `object-fit: contain` actually lies inside its box.
 * @returns {{x: number, y: number, scale: number}} offset and display scale
 */
export function containedImage(box, natural) {
  const scale = Math.min(
    box.width / natural.width,
    box.height / natural.height,
  );
  return {
    scale,
    x: (box.width - natural.width * scale) / 2,
    y: (box.height - natural.height * scale) / 2,
  };
}

/** Rectangle of the mark over a displayed `<img>`, in its offset parent's pixels. */
function markBox(img, size, corner, policy) {
  const natural = size ?? {
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
  if (
    !img.offsetWidth ||
    !img.offsetHeight ||
    !natural.width ||
    !natural.height
  )
    return null;
  const geometry = markGeometry(natural.width, natural.height, corner, policy);
  const fit = containedImage(
    { width: img.offsetWidth, height: img.offsetHeight },
    natural,
  );
  return {
    geometry,
    left: img.offsetLeft + fit.x + geometry.x * fit.scale,
    top: img.offsetTop + fit.y + geometry.y * fit.scale,
    size: geometry.size * fit.scale,
  };
}

/**
 * The shared watermark drawn over a displayed image. It is a sibling of the
 * `<img>` and follows its box, so the image itself (lazy loading, alt text,
 * original bytes) is untouched. Nothing is drawn without a per-image analysis
 * or with invalid content.
 * @param {object} props
 * @param {object} props.image library record
 * @param {{current: HTMLImageElement|null}} props.imgRef the displayed image
 * @param {object} props.settings server settings with `rendering` and `limits`
 * @param {{corner: string, presentation: object}|null} [props.placement]
 *   used when the record has no analysis (editor previews only)
 */
export default function WatermarkMark({ image, imgRef, settings, placement }) {
  const canvas = useRef(null);
  const [box, setBox] = useState(null);
  const policy = settings?.rendering;
  const usable =
    Boolean(policy) &&
    !isBakedWatermark(image) &&
    (hasPlacement(image, policy) || Boolean(placement));
  const view = describeImage(image);
  const analysis = image.print_watermark;
  const { corner, presentation } = useMemo(() => {
    if (!policy) return {};
    return hasPlacement(image, policy) || !placement
      ? placementOf(analysis, policy)
      : placement;
  }, [image, analysis, placement, policy]);

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img || !usable) {
      setBox(null);
      return undefined;
    }
    const update = () =>
      setBox(img.complete ? markBox(img, view.size, corner, policy) : null);
    update();
    img.addEventListener('load', update);
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(img);
    return () => {
      img.removeEventListener('load', update);
      observer?.disconnect();
    };
  }, [imgRef, usable, view.size, corner, policy]);

  // `box` can outlive the settings for one render (it is cleared in a layout
  // effect), so everything below keys off the current settings as well.
  const shown = usable && box !== null;
  const pixelSize = shown
    ? Math.min(box.geometry.size, PREVIEW_MARK_MAX_PIXELS)
    : 0;
  useEffect(() => {
    if (!shown || !settings || !canvas.current) return undefined;
    let current = true;
    const paint = (result) => {
      const target = canvas.current;
      if (!current || !target) return;
      target.width = pixelSize;
      target.height = pixelSize;
      const context = target.getContext?.('2d');
      if (!context) return;
      context.clearRect(0, 0, pixelSize, pixelSize);
      if (result?.mark) context.drawImage(result.mark, 0, 0);
    };
    markFor({
      settings,
      limits: settings.limits,
      presentation,
      policy,
      pixelSize,
      corner,
    }).then(paint, () => paint(null));
    return () => {
      current = false;
    };
  }, [shown, pixelSize, settings, presentation, policy, corner]);

  if (!shown) return null;
  return (
    <canvas
      ref={canvas}
      className="wm-mark"
      aria-hidden="true"
      style={{
        left: box.left,
        top: box.top,
        width: box.size,
        height: box.size,
      }}
    />
  );
}
