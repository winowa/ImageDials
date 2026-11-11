/**
 * Split stored text into display segments for syntax highlighting. The
 * segments always join back to the exact input, byte for byte: nothing is
 * parsed into values, re-serialised, trimmed or re-indented, and no markup is
 * built (callers render each segment as a text node). Text that is not
 * well-formed JSON is not highlighted at all, so colour never suggests that a
 * malformed or clipped reply is valid.
 *
 * Segment kinds: 'key', 'str', 'num', 'bool', 'null' and 'punct'. Whitespace
 * and structural characters share 'punct' runs.
 */

/** Past this length the text is shown plain rather than split into spans. */
export const MAX_HIGHLIGHT_CHARS = 262144;

const WHITESPACE = /[ \t\n\r]+/y;
// Control characters are exactly what JSON forbids unescaped in a string.
const STRING =
  // oxlint-disable-next-line no-control-regex
  /"[^"\\\u0000-\u001f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\u0000-\u001f]*)*"/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL = /true|false|null/y;

function match(pattern, text, at) {
  pattern.lastIndex = at;
  const found = pattern.exec(text);
  return found ? found[0] : null;
}

/**
 * Tokenise one JSON document (leading and trailing whitespace allowed).
 * Iterative, so deeply nested input cannot exhaust the call stack.
 * @returns {{kind: string, text: string}[] | null} null when not valid JSON
 */
function scan(text) {
  const out = [];
  const push = (kind, piece) => {
    const last = out[out.length - 1];
    if (kind === 'punct' && last?.kind === 'punct') last.text += piece;
    else out.push({ kind, text: piece });
  };
  const stack = [];
  // value | valueOrEnd | keyOrEnd | key | colon | next | done
  let expect = 'value';
  let at = 0;
  const end = text.length;
  while (at < end) {
    const space = match(WHITESPACE, text, at);
    if (space) {
      push('punct', space);
      at += space.length;
      continue;
    }
    const ch = text[at];
    if (expect === 'done') return null;
    if (expect === 'colon') {
      if (ch !== ':') return null;
      push('punct', ch);
      at += 1;
      expect = 'value';
      continue;
    }
    if (expect === 'next') {
      const top = stack[stack.length - 1];
      if (ch === ',') {
        expect = top === 'object' ? 'key' : 'value';
      } else if (ch === (top === 'object' ? '}' : ']')) {
        stack.pop();
        expect = stack.length ? 'next' : 'done';
      } else return null;
      push('punct', ch);
      at += 1;
      continue;
    }
    if (expect === 'keyOrEnd' && ch === '}') {
      stack.pop();
      expect = stack.length ? 'next' : 'done';
      push('punct', ch);
      at += 1;
      continue;
    }
    if (expect === 'valueOrEnd' && ch === ']') {
      stack.pop();
      expect = stack.length ? 'next' : 'done';
      push('punct', ch);
      at += 1;
      continue;
    }
    if (expect === 'key' || expect === 'keyOrEnd') {
      const key = match(STRING, text, at);
      if (key === null) return null;
      push('key', key);
      at += key.length;
      expect = 'colon';
      continue;
    }
    // A value (possibly the first of an array).
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? 'object' : 'array');
      expect = ch === '{' ? 'keyOrEnd' : 'valueOrEnd';
      push('punct', ch);
      at += 1;
      continue;
    }
    let piece = null;
    let kind = 'str';
    if (ch === '"') piece = match(STRING, text, at);
    else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      piece = match(NUMBER, text, at);
      kind = 'num';
    } else {
      piece = match(LITERAL, text, at);
      kind = piece === 'null' ? 'null' : 'bool';
    }
    if (piece === null) return null;
    push(kind, piece);
    at += piece.length;
    expect = stack.length ? 'next' : 'done';
  }
  return expect === 'done' ? out : null;
}

/** Opening fence line, as the reply reader accepts: ```json then a newline. */
const FENCE_OPEN = /^\s*```[^\n]*\n/;
const FENCE_CLOSE = /```\s*$/;

/**
 * @param {string} text exact stored text
 * @returns {{kind: string, text: string}[] | null} segments whose texts join
 *   to `text`, or null when the text should be shown without highlighting
 */
export function tokenizeJson(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_HIGHLIGHT_CHARS)
    return null;
  const whole = scan(text);
  if (whole) return whole;
  // A reply wrapped in a code fence: the fence stays plain, the JSON inside
  // it is highlighted when, and only when, it is valid.
  const open = FENCE_OPEN.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = FENCE_CLOSE.exec(rest);
  if (!close) return null;
  const inner = scan(rest.slice(0, close.index));
  if (!inner) return null;
  return [
    { kind: 'plain', text: open[0] },
    ...inner,
    { kind: 'plain', text: rest.slice(close.index) },
  ];
}
