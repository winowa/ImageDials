/**
 * Prompt similarity for generated controls. Controls belong to the ORIGINAL
 * prompt they were generated for (the anchor): edits that stay similar to it
 * keep them, however many small steps led there.
 */
/** Unicode-normalized, case-folded text with single spaces and no edge space. */
export function normalizePrompt(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Edit distance over code point arrays. A shared prefix and suffix cost nothing,
 * so only the differing middle is compared (two rolling rows, no matrix).
 */
function editDistance(left, right) {
  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  )
    start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (
    endLeft > start &&
    endRight > start &&
    left[endLeft - 1] === right[endRight - 1]
  ) {
    endLeft -= 1;
    endRight -= 1;
  }
  const a = left.slice(start, endLeft);
  const b = right.slice(start, endRight);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [previous, row] = [row, previous];
  }
  return previous[b.length];
}

/** 1 for identical normalized text; edit distance over the longer text otherwise. */
export function promptSimilarity(a, b) {
  const left = Array.from(normalizePrompt(a));
  const right = Array.from(normalizePrompt(b));
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

/** Absorbs binary rounding so a similarity at the minimum ratio still resets. */
const RATIO_TOLERANCE = 1e-9;

const SEPARATOR = '\u0000';

/**
 * Whether a prompt in a mode still belongs to the episode of an anchor made by
 * `promptKey` (submission.js). Identical normalized text always does. Otherwise
 * the similarity must be strictly above the minimum ratio, so an edit distance
 * of exactly half the longer text starts a new prompt. A different mode never
 * matches.
 */
export function isNearAnchor(anchor, prompt, mode, minimumRatio) {
  if (typeof anchor !== 'string') return false;
  const split = anchor.indexOf(SEPARATOR);
  if (split < 0 || anchor.slice(0, split) !== mode) return false;
  const original = anchor.slice(split + 1);
  if (normalizePrompt(original) === normalizePrompt(prompt)) return true;
  return promptSimilarity(original, prompt) > minimumRatio + RATIO_TOLERANCE;
}
