import { expect, test } from 'vitest';
import { matchesControlIdentity } from './controlIdentity.js';
import { referenceSignature } from '../references/references.js';
import { normalizeClientPolicy } from '../../data/api/clientPolicy.js';
import { promptKey } from '../create/submission.js';

const policy = normalizeClientPolicy();
const draft = { mode: 'image', prompt: 'A red wooden bridge in snow' };
const refs = [
  { sha256: 'first', role: 'base', description: 'A red bridge' },
  { sha256: 'second', role: 'reference', description: 'Snow' },
];
const current = {
  draft,
  provider: 'provider-one',
  refs: referenceSignature(refs),
  policy,
};
const set = {
  anchor: promptKey(draft.prompt, draft.mode),
  provider: current.provider,
  refs: current.refs,
};
test('ready and flight identity share near-prompt reuse without fetch-per-keystroke', () => {
  expect(matchesControlIdentity(set, current)).toBe(true);
  expect(
    matchesControlIdentity(
      { ...set, key: set.anchor, anchor: undefined },
      current,
    ),
  ).toBe(true);
  expect(
    matchesControlIdentity(set, {
      ...current,
      draft: { ...draft, prompt: `${draft.prompt}!` },
    }),
  ).toBe(true);
});
test('every relevant identity dimension disqualifies old metadata and flights', () => {
  for (const changed of [
    { provider: 'provider-two' },
    { draft: { ...draft, mode: 'asset-image' } },
    { draft: { ...draft, prompt: 'Underwater jellyfish' } },
    { refs: referenceSignature([...refs].reverse()) },
    {
      refs: referenceSignature([
        { ...refs[0], description: 'A blue bridge' },
        refs[1],
      ]),
    },
    { refs: referenceSignature([{ ...refs[0], sha256: 'changed' }, refs[1]]) },
    { refs: referenceSignature([{ ...refs[0], role: 'another' }, refs[1]]) },
  ])
    expect(matchesControlIdentity(set, { ...current, ...changed })).toBe(false);
});
