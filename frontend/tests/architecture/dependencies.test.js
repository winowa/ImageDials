// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * Import rules of frontend/src (see frontend/README.md): shared <- data <-
 * features <- app. Test files, CSS and package imports are not part of the graph.
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Pure (React-free) feature modules that lower layers may import, with the reason. */
const DATA_TO_FEATURE = [
  // The private thumbnail and the overlay draw with the one watermark renderer.
  'data/media/WatermarkMark.jsx > features/watermarks/watermarkGeometry.js',
  'data/media/WatermarkMark.jsx > features/watermarks/watermarkRenderer.js',
  'data/media/privateThumbnail.js > features/watermarks/watermarkRenderer.js',
  // Browse policy filters by control values.
  'data/records/browse.js > features/controls/controls.js',
  // The preset store persists the presets' own wire shape.
  'data/storage/controlPresetStore.js > features/controls/presets/controlPresets.js',
  // Private watermark state is a pure decision beside the stored record.
  'data/storage/privateHistory.js > features/watermarks/privateWatermark.js',
  'data/storage/privateLibrary.js > features/watermarks/privateWatermark.js',
];
/** Leaf modules of the app layer that features may import (no components, no state). */
const APP_LEAVES = ['app/routes.js', 'app/discovery.js'];
/** Feature unit -> feature units it may import. `controls/presets` is its own unit. */
const FEATURE_EDGES = {
  'controls/presets': ['controls', 'references'],
  create: ['controls', 'controls/presets', 'references', 'results'],
  gallery: ['library'],
  library: ['controls', 'credentials', 'results', 'watermarks'],
  references: ['controls'],
  // results imports only the pure draft-to-request rules of create.
  results: ['controls', 'create', 'references', 'watermarks'],
  settings: ['references', 'watermarks'],
};
/** The one mutual dependency: the generator embeds the result viewer, which re-submits. */
const ALLOWED_CYCLES = [['create', 'results']];

function sources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.jsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const posix = (path) => relative(SRC, path).split(sep).join('/');
const graph = new Map();
for (const file of sources(SRC)) {
  const text = readFileSync(file, 'utf8');
  const targets = new Set();
  for (const match of text.matchAll(
    /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g,
  )) {
    const target = resolve(dirname(file), match[1]);
    if (target.startsWith(SRC) && /\.jsx?$/.test(target))
      targets.add(posix(target));
  }
  graph.set(posix(file), [...targets].sort());
}
const edges = [...graph].flatMap(([from, to]) => to.map((t) => [from, t]));
const layer = (file) => file.split('/')[0];
const isReact = (file) =>
  file.endsWith('.jsx') || /(^|\/)use[A-Z][^/]*\.js$/.test(file);
const unit = (file) => {
  const [, name, sub] = file.split('/');
  return name === 'controls' && sub === 'presets' ? 'controls/presets' : name;
};

test('shared modules import only shared modules', () => {
  expect(
    edges.filter(
      ([from, to]) => layer(from) === 'shared' && layer(to) !== 'shared',
    ),
  ).toEqual([]);
});

test('data modules never import app code or feature components and hooks', () => {
  const found = edges
    .filter(
      ([from, to]) =>
        layer(from) === 'data' && ['app', 'features'].includes(layer(to)),
    )
    .map(([from, to]) => `${from} > ${to}`);
  expect(found.filter((edge) => !DATA_TO_FEATURE.includes(edge))).toEqual([]);
  expect(DATA_TO_FEATURE.filter((edge) => !found.includes(edge))).toEqual([]);
  expect(
    found.filter(
      (edge) =>
        isReact(edge.split(' > ')[1]) && layer(edge.split(' > ')[1]) !== 'data',
    ),
  ).toEqual([]);
});

test('features import app code only through its route and discovery leaves', () => {
  expect(
    edges.filter(
      ([from, to]) =>
        layer(from) === 'features' &&
        layer(to) === 'app' &&
        !APP_LEAVES.includes(to),
    ),
  ).toEqual([]);
});

test('features depend on other features only along the documented edges', () => {
  const found = {};
  for (const [from, to] of edges) {
    if (layer(from) !== 'features' || layer(to) !== 'features') continue;
    if (unit(from) === unit(to)) continue;
    (found[unit(from)] ??= new Set()).add(unit(to));
  }
  const actual = Object.fromEntries(
    Object.entries(found).map(([key, value]) => [key, [...value].sort()]),
  );
  const documented = Object.fromEntries(
    Object.entries(FEATURE_EDGES).map(([key, value]) => [
      key,
      [...value].sort(),
    ]),
  );
  expect(actual).toEqual(documented);
});

test('production modules have no import cycles', () => {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  let counter = 0;
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const group = [];
      let top;
      do {
        top = stack.pop();
        onStack.delete(top);
        group.push(top);
      } while (top !== node);
      if (group.length > 1) cycles.push(group.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  expect(cycles).toEqual([]);
});

test('the only mutual feature dependency is the generator and its result viewer', () => {
  const mutual = [];
  const pairs = new Set(
    edges
      .filter(
        ([from, to]) => layer(from) === 'features' && layer(to) === 'features',
      )
      .map(([from, to]) => `${unit(from)}>${unit(to)}`),
  );
  for (const pair of pairs) {
    const [a, b] = pair.split('>');
    if (a < b && pairs.has(`${b}>${a}`)) mutual.push([a, b]);
  }
  expect(mutual).toEqual(ALLOWED_CYCLES);
});
