import { expect, test } from 'vitest';
import { MAX_HIGHLIGHT_CHARS, tokenizeJson } from './jsonTokens.js';

const joined = (segments) => segments.map((segment) => segment.text).join('');
const kinds = (text) => tokenizeJson(text).map(({ kind }) => kind);

test.each([
  '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
  '  \n{\n\t"a" :  1 ,\r\n   "b":[ 1 , 2.5e-3 ,-0 ]\n}  \n\n',
  '[]',
  '{}',
  '"just a string"',
  '12',
  'null',
  '{"escapes":"\\u00e9\\n\\"quoted\\" \\\\ \\/","emoji":"😀","html":"<img src=x onerror=alert(1)>"}',
  '{"":""}',
  '[1,\n  [2,\n    [3]]]',
])('segments rejoin to the exact input: %j', (text) => {
  const segments = tokenizeJson(text);
  expect(segments).not.toBeNull();
  expect(joined(segments)).toBe(text);
});

test('classifies keys, strings, numbers, literals and structure', () => {
  const segments = tokenizeJson(
    '{"k": "v", "n": -1.5e2, "t": true, "z": null}',
  );
  const by = (kind) =>
    segments.filter((s) => s.kind === kind).map((s) => s.text);
  expect(by('key')).toEqual(['"k"', '"n"', '"t"', '"z"']);
  expect(by('str')).toEqual(['"v"']);
  expect(by('num')).toEqual(['-1.5e2']);
  expect(by('bool')).toEqual(['true']);
  expect(by('null')).toEqual(['null']);
  // Whitespace and structure share runs instead of one span per character.
  expect(by('punct')).toContain(': ');
  expect(by('punct')).toContain(', ');
});

test('a string that looks like a key stays a string', () => {
  expect(kinds('["a","b"]').filter((k) => k === 'key')).toHaveLength(0);
  expect(kinds('{"a":"b"}').filter((k) => k === 'str')).toHaveLength(1);
});

test.each([
  ['trailing comma', '{"a":1,}'],
  ['trailing comma in array', '[1,2,]'],
  ['single quotes', "{'a':1}"],
  ['unquoted key', '{a:1}'],
  ['leading zero', '[01]'],
  ['bare decimal point', '[1.]'],
  ['NaN', '[NaN]'],
  ['truncated', '{"a": [1, 2'],
  ['truncated string', '{"a": "abc'],
  ['two documents', '{"a":1}{"b":2}'],
  ['trailing prose', '{"a":1} and more'],
  ['raw control character in a string', '"a\nb"'],
  ['bad escape', '"\\q"'],
  ['short unicode escape', '"\\u12"'],
  ['missing colon', '{"a" 1}'],
  ['missing comma', '[1 2]'],
  ['mismatched close', '[1}'],
  ['empty', ''],
  ['whitespace only', '  \n'],
  ['prose', 'Here is the JSON you asked for.'],
  ['literal prefix', 'nullx'],
])('malformed text is not highlighted: %s', (_name, text) => {
  expect(tokenizeJson(text)).toBeNull();
});

test('a fenced reply keeps its fence plain and highlights valid JSON inside', () => {
  const text = '```json\n{"a": [1, 2]}\n```\n';
  const segments = tokenizeJson(text);
  expect(joined(segments)).toBe(text);
  expect(segments[0]).toEqual({ kind: 'plain', text: '```json\n' });
  expect(segments.at(-1).kind).toBe('plain');
  expect(segments.some((s) => s.kind === 'key')).toBe(true);
  expect(tokenizeJson('```json\n{"a": \n```')).toBeNull();
  expect(tokenizeJson('```json\n{"a": 1}')).toBeNull();
});

test('deeply nested input does not exhaust the stack', () => {
  const depth = 20000;
  const text = '['.repeat(depth) + ']'.repeat(depth);
  expect(joined(tokenizeJson(text))).toBe(text);
});

test('very long text is left plain', () => {
  expect(tokenizeJson(`"${'x'.repeat(MAX_HIGHLIGHT_CHARS)}"`)).toBeNull();
  const long = `"${'x'.repeat(MAX_HIGHLIGHT_CHARS - 2)}"`;
  expect(joined(tokenizeJson(long))).toBe(long);
});

test('a very long unbroken string token is one segment', () => {
  const token = `"${'ab'.repeat(50000)}"`;
  const segments = tokenizeJson(`{"k":${token}}`);
  expect(segments.find((s) => s.kind === 'str').text).toBe(token);
});
