import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { readOriginalBytes } from '../../data/media/originalBytes.js';
import { saveBlob } from '../watermarks/printing.js';

/**
 * Download the ORIGINAL file under `filename`. The bytes are read first, so a
 * failed read is reported here instead of being lost by a silent link; leaving
 * the owner cancels a read in progress.
 */
export function useOriginalDownload(
  image,
  filename,
  { media = null, readLocal = null, fetchBlob, save = saveBlob } = {},
) {
  const [state, setState] = useState({ busy: false, error: null });
  const controller = useRef(null);
  const latest = useRef({});
  useLayoutEffect(() => {
    latest.current = { image, filename, media, readLocal, fetchBlob, save };
  });

  useEffect(() => () => controller.current?.abort(), []);

  const download = useCallback(async () => {
    if (controller.current) return;
    const mine = new AbortController();
    controller.current = mine;
    setState({ busy: true, error: null });
    try {
      const now = latest.current;
      const blob = await readOriginalBytes(now.image, {
        signal: mine.signal,
        media: now.media,
        readLocal: now.readLocal,
        fetchBlob: now.fetchBlob,
      });
      if (mine.signal.aborted) return;
      now.save(blob, now.filename);
      setState({ busy: false, error: null });
    } catch (error) {
      if (mine.signal.aborted || error?.name === 'AbortError') return;
      setState({ busy: false, error });
    } finally {
      if (controller.current === mine) controller.current = null;
    }
  }, []);

  return { ...state, download };
}
