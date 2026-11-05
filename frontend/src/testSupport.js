import { configure } from '@testing-library/react';
import { vi } from 'vitest';

import editControls from '../../fixtures/api/edit-controls.json';
import browserSettings from '../../fixtures/api/browser-settings.json';
import generation from '../../fixtures/api/generation.json';
import m1 from '../../fixtures/api/m1.json';
import m2 from '../../fixtures/api/m2.json';
import m3 from '../../fixtures/api/m3.json';
import m4 from '../../fixtures/api/m4.json';
import libraryPages from '../../fixtures/api/library-pages.json';
import m5Configuration from '../../fixtures/api/m5-configuration.json';
import { nextSeed, seededOrder } from './galleryPlayback.js';
import { imageKey } from './imageRecord.js';

// A restored image now takes page and record reads; a loaded machine needs room.
configure({ asyncUtilTimeout: 4000 });

export const fixtures = {
  m1,
  m2,
  m3,
  m4,
  generation,
  browserSettings,
  libraryPages,
};

export const clone = (value) => JSON.parse(JSON.stringify(value));

/** Wrap a status, body and headers so a handler can return something other than 200. */
export const respond = (status, body, headers = {}) => ({
  __response: { status, body, headers },
});

/** A route handler that fails like a dropped connection. */
export const networkFailure = () => {
  throw new TypeError('Failed to fetch');
};

const NULL_BODY_STATUSES = new Set([204, 304]);

function toResponse(result) {
  if (
    result &&
    typeof result.arrayBuffer === 'function' &&
    typeof result.type === 'string'
  )
    return new Response(result);
  const wrapped = result?.__response;
  const { status, body, headers } = wrapped ?? {
    status: 200,
    body: result,
    headers: {},
  };
  const text = NULL_BODY_STATUSES.has(status)
    ? null
    : typeof body === 'string'
      ? body
      : JSON.stringify(body);
  return new Response(text, { status, headers });
}

const SUMMARY_FIELDS = [
  'created_at',
  'dimensions',
  'event_id',
  'filename',
  'generation_mode',
  'id',
  'image_id',
  'image_url',
  'orientation',
  'sha256',
  'storage_id',
  'storage_type',
  'title',
  'visibility',
  'print_watermark',
  'derivative_type',
];

/** A library record as the page endpoint lists it: no prompt, no controls. */
export function summaryOf(record) {
  const summary = {};
  for (const field of SUMMARY_FIELDS)
    if (Object.hasOwn(record, field)) summary[field] = record[field];
  return {
    ...summary,
    image_id: record.image_id ?? record.id,
    display_prompt: record.original_prompt ?? record.prompt ?? null,
    detail_url: `/api/images/library/record/${record.id}`,
    has_prepared_record: Boolean(record.print_ready),
    has_watermark_analysis: Boolean(record.print_watermark),
  };
}

/**
 * Serve `/page` and `/record` from a test's complete catalog route, with the
 * real shapes, so a test states what the catalog holds and Create still reads it
 * only through the bounded endpoints. Records keep their catalog order.
 */
function pagedLibraryRoute(routes, key) {
  const source = routes['GET /api/images/library'];
  if (!source) return null;
  const page = /^GET \/api\/images\/library\/page(?:\?(.*))?$/.exec(key);
  const record = /^GET \/api\/images\/library\/record\/([^?]+)/.exec(key);
  if (!page && !record) return null;
  return async (body, call, init) => {
    const listed = await source(body, call, init);
    const wrapped = listed?.__response;
    if (wrapped && wrapped.status !== 200) return listed;
    const library = wrapped ? wrapped.body : listed;
    const images = library.images;
    if (record) {
      const id = decodeURIComponent(record[1]);
      const found = images.find((i) => i.id === id || i.image_id === id);
      return found ?? respond(404, { detail: 'Image not found' });
    }
    const query = new URLSearchParams(page[1] ?? '');
    const limit = Number(query.get('limit') ?? 48);
    let from = 0;
    let anchorIndex = null;
    if (query.get('cursor')) from = Number(query.get('cursor').slice(1));
    else if (query.get('around')) {
      const at = images.findIndex(
        (i) =>
          i.id === query.get('around') || i.image_id === query.get('around'),
      );
      if (at < 0) return respond(404, { detail: 'Image not found' });
      from = Math.max(0, at - Math.floor(limit / 2));
      anchorIndex = at - from;
    } else if (query.get('edge') === 'last')
      from = Math.max(0, images.length - limit);
    const rows = images.slice(from, from + limit);
    return {
      images: rows.map(summaryOf),
      count: rows.length,
      total: images.length,
      orientation_counts: {},
      next_cursor: from + limit < images.length ? `c${from + limit}` : null,
      previous_cursor: from > 0 ? `c${Math.max(0, from - limit)}` : null,
      position: from,
      anchor_index: anchorIndex,
      revision: images.length,
      order: 'newest',
      listing_kind: 'summary-page',
      watermark_backfill: library.watermark_backfill ?? null,
    };
  };
}

const BOUNDED_SHARED = m5Configuration.shared.shared_library;

/**
 * Capabilities with the implemented bounded shared-library features (paging,
 * event facets and shuffle sessions) as the current server publishes them.
 */
export function withBoundedGallery(capabilities) {
  const shared = capabilities.shared_library ?? {};
  return {
    ...capabilities,
    shared_library: {
      ...shared,
      paging: shared.paging ?? clone(BOUNDED_SHARED.paging),
      shuffle_sessions:
        shared.shuffle_sessions ?? clone(BOUNDED_SHARED.shuffle_sessions),
    },
  };
}

/**
 * Stub `fetch` with canonical-fixture routes. Handlers receive the parsed JSON
 * body, the call number and the request init, and may return a body,
 * `respond(status, body, headers)`, or a promise of either.
 */
export function installApi(overrides = {}) {
  const calls = [];
  const routes = {
    'GET /healthz': () => m1.health,
    'GET /api/app-capabilities': () => ({
      ...withBoundedGallery(m1.capabilities),
      watermark: { transient_analysis_enabled: true },
    }),
    'GET /api/models': () => m1.models,
    'GET /api/browser-settings/defaults': () => browserSettings.defaults,
    'GET /api/controls/static?generation_mode=standard': () =>
      m1.static_standard,
    'GET /api/controls/static?generation_mode=trellis': () => m1.static_trellis,
    'GET /api/controls/static?generation_mode=standard&image_edit=true': () =>
      editControls,
    'GET /api/controls/static?generation_mode=trellis&image_edit=true': () =>
      editControls,
    'GET /api/prompt-suggestions?generation_mode=standard': () =>
      m3.suggestions_standard,
    'GET /api/prompt-suggestions?generation_mode=trellis': () =>
      m3.suggestions_trellis,
    ...overrides,
  };
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    // A multipart upload reaches the handler as the FormData itself.
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ key, body, headers: init.headers ?? {} });
    const handler =
      routes[key] ?? routes.match?.(key) ?? pagedLibraryRoute(routes, key);
    if (!handler)
      return toResponse(respond(404, { detail: `No route: ${key}` }));
    return toResponse(await handler(body, calls.length, init));
  });
  return {
    calls,
    routes,
    called: (key) => calls.filter((c) => c.key === key),
  };
}

/** A library record built from the fixture's completed job. */
export const completedRecord = (overrides = {}) => ({
  ...clone(m1.job_complete.result),
  ...overrides,
});

export const completeStatus = (overrides) => ({
  ...clone(m1.job_complete),
  result: completedRecord(overrides),
});

/** A library record (A12 shape) for `id`, with its own storage identity. */
export const libraryRecord = (overrides = {}) => {
  const id = overrides.id ?? m2.library.images[0].id;
  return {
    ...clone(m2.library.images[0]),
    image_id: id,
    filename: `${id}.png`,
    ...overrides,
  };
};

/** A library record with an actual size and a title derived from its id. */
export const sizedRecord = (id, width, height, extra = {}) =>
  libraryRecord({
    id,
    title: `Image ${id}`,
    width,
    height,
    dimensions: { width, height },
    requested_dimensions: { width, height },
    ...extra,
  });

/** The list-shaped record the server holds for a completed job result. */
export const listedFromJob = (result) => ({
  ...clone(result),
  // Just saved: the server lists it ahead of every earlier image.
  created_at: 4102444800,
  selected_controls: clone(
    result.original_selected_controls ?? result.selected_controls,
  ),
  dimensions: {
    width: result.width,
    height: result.height,
  },
});

const textHash = (text) => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1)
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
};

/**
 * An in-memory canonical library (A12/A15): newest first, a content ETag,
 * exact-match 304 and identity-exact deletion, as the server behaves.
 */
/** Orientation as the server classifies stored dimensions. */
function fakeOrientationOf(record) {
  const dimensions = record.dimensions;
  const width = Number(dimensions?.width ?? record.width);
  const height = Number(dimensions?.height ?? record.height);
  if (!(width > 0 && height > 0)) return 'unknown';
  const longer = Math.max(width, height);
  if (Math.abs(width - height) <= longer * 0.05) return 'square';
  return width > height ? 'landscape' : 'portrait';
}
const fakeEventOf = (record) => record.event_name ?? record.event_id ?? null;
const FACET_CURSOR = /^fake-facet:(\d+)$/;

export function fakeLibrary(records = []) {
  const library = {
    records,
    deleted: [],
    /** Event names a test's capabilities configure as the gallery scope. */
    configured: [],
    /** Seed of the next shuffle session (the server's keyed order). */
    sessionSeed: 11,
    sessions: new Map(),
    created: [],
    released: [],
    renewed: [],
    /** Reads answered `building` before a new session is ready. */
    buildingReads: 0,
    revision: () =>
      parseInt(textHash(JSON.stringify(library.records)), 16) || 1,
    scopeOf(eventName) {
      if (eventName && library.configured.length)
        return library.configured.includes(eventName) ? [eventName] : null;
      if (eventName) return [eventName];
      return library.configured;
    },
    inScope(record, scope) {
      return !scope.length || scope.includes(fakeEventOf(record));
    },
    summaryOf(record) {
      return library.summaryRow(record);
    },
    createSession(body) {
      const scope = library.scopeOf(body?.event_name ?? null);
      if (!scope) return respond(400, { detail: 'Outside the gallery scope' });
      const shapes = body?.orientations ?? null;
      const eligible = library.records.filter(
        (record) =>
          library.inScope(record, scope) &&
          (shapes === null || shapes.includes(fakeOrientationOf(record))),
      );
      const seed = library.sessionSeed;
      library.sessionSeed = nextSeed(seed);
      let order = seededOrder(eligible.map(imageKey), seed);
      const first = eligible.find(
        (record) =>
          body?.first_image_id &&
          (record.id === body.first_image_id ||
            record.image_id === body.first_image_id),
      );
      if (first)
        order = [
          imageKey(first),
          ...order.filter((k) => k !== imageKey(first)),
        ];
      const id = `session-${library.created.length + 1}`;
      library.sessions.set(id, {
        id,
        order,
        scope,
        shapes,
        building: library.buildingReads,
        firstMember: body?.first_image_id ? Boolean(first) : false,
      });
      library.created.push({ id, body: body ?? {} });
      return respond(202, {
        session_id: id,
        state: 'building',
        first_image_member: null,
        expires_at: 1700001810,
      });
    },
    readSession(id, values) {
      const held = library.sessions.get(id);
      if (!held) return respond(404, { detail: 'Gallery session not found' });
      if (held.building > 0) {
        held.building -= 1;
        return respond(202, { session_id: id, state: 'building' });
      }
      const byKey = new Map(library.records.map((r) => [imageKey(r), r]));
      const members = held.order
        .map((key, rank) => ({ rank, record: byKey.get(key) }))
        .filter(
          ({ record }) =>
            record &&
            library.inScope(record, held.scope) &&
            (held.shapes === null ||
              held.shapes.includes(fakeOrientationOf(record))),
        );
      const rank = Number(values.get('rank') ?? 0);
      const limit = Number(values.get('limit') ?? 48);
      const backward = values.get('direction') === 'backward';
      const run = backward
        ? members.filter((m) => m.rank <= rank).slice(-limit)
        : members.filter((m) => m.rank >= rank).slice(0, limit);
      const firstRank = run[0]?.rank;
      const lastRank = run.at(-1)?.rank;
      return {
        session_id: id,
        state: 'ready',
        error: null,
        expires_at: 1700001810,
        first_image_member: held.firstMember,
        snapshot_revision: 1,
        snapshot_total: held.order.length,
        revision: library.revision(),
        images: run.map(({ rank: at, record }) => ({
          ...library.summaryRow(record),
          session_rank: at,
        })),
        count: run.length,
        next_rank:
          run.length && members.some((m) => m.rank > lastRank)
            ? lastRank + 1
            : null,
        previous_rank:
          run.length && members.some((m) => m.rank < firstRank)
            ? firstRank - 1
            : null,
      };
    },
    facets(params, init) {
      const values = new URL(params, 'http://imagedials.test').searchParams;
      const scope = library.scopeOf(values.get('event_name'));
      if (!scope) return respond(400, { detail: 'Outside the gallery scope' });
      const limit = Number(values.get('limit') ?? 100);
      const query = (values.get('q') ?? '').trim().toLocaleLowerCase();
      const scoped = library.records.filter((r) => library.inScope(r, scope));
      const countsOf = (rows) => {
        const counts = { landscape: 0, portrait: 0, square: 0, unknown: 0 };
        for (const row of rows) counts[fakeOrientationOf(row)] += 1;
        return counts;
      };
      const names = scope.length
        ? [...scope].sort()
        : [
            ...new Set(
              library.records
                .map(fakeEventOf)
                .filter((name) => typeof name === 'string' && name),
            ),
          ].sort();
      const matching = names.filter((name) =>
        name.toLocaleLowerCase().includes(query),
      );
      const cursor = values.get('cursor');
      const parsed = cursor ? FACET_CURSOR.exec(cursor) : null;
      if (cursor && !parsed) return respond(400, { detail: 'Invalid cursor' });
      const from = parsed ? Number(parsed[1]) : 0;
      const pageNames = matching.slice(from, from + limit);
      const counts = countsOf(scoped);
      const body = {
        events: pageNames.map((name) => {
          const rows = library.records.filter((r) => fakeEventOf(r) === name);
          return {
            name,
            count: rows.length,
            orientation_counts: countsOf(rows),
          };
        }),
        count: pageNames.length,
        next_cursor:
          from + limit < matching.length ? `fake-facet:${from + limit}` : null,
        revision: library.revision(),
        configured: scope.length > 0,
        orientation_counts: counts,
        total_images: Object.values(counts).reduce((a, b) => a + b, 0),
      };
      const etag = `"${textHash(JSON.stringify(body))}"`;
      if (init.headers?.['If-None-Match'] === etag)
        return respond(304, null, { ETag: etag });
      return respond(200, body, { ETag: etag });
    },
    body: () => ({
      images: library.records,
      count: library.records.length,
      watermark_settings: m2.library.watermark_settings,
    }),
    etag: () => `"${textHash(JSON.stringify(library.body()))}"`,
    summaryRow(record) {
      const id = String(record.id);
      const dimensions = record.dimensions ?? {
        width: record.width ?? null,
        height: record.height ?? null,
      };
      return {
        id,
        image_id: record.image_id ?? id,
        storage_id: record.storage_id ?? 'test-storage',
        filename: record.filename ?? `${id}.png`,
        sha256: record.sha256 ?? null,
        title: record.title ?? id,
        display_prompt: record.display_prompt ?? record.prompt ?? '',
        created_at: record.created_at ?? null,
        dimensions,
        orientation: fakeOrientationOf(record),
        generation_mode: record.generation_mode ?? 'standard',
        event_id: record.event_id ?? null,
        has_prepared_record: Boolean(
          record.watermark?.prepared || record.print_watermark_key,
        ),
        has_watermark_analysis: Boolean(
          record.watermark ||
          record.print_watermark ||
          record.print_watermark_key,
        ),
        ...(record.print_watermark
          ? {
              print_watermark: {
                analysis_version:
                  record.print_watermark.analysis_version ??
                  record.print_watermark.provenance?.generator_version,
                position: {
                  corner: record.print_watermark.position?.corner,
                },
                presentation: Object.fromEntries(
                  Object.entries(
                    record.print_watermark.presentation ?? {},
                  ).filter(([name]) =>
                    [
                      'gradient_start',
                      'gradient_end',
                      'separation_color',
                      'glow_color',
                      'gradientStart',
                      'gradientEnd',
                      'separationColor',
                      'glowColor',
                    ].includes(name),
                  ),
                ),
              },
            }
          : {}),
        ...(record.derivative_type === 'watermarked'
          ? { derivative_type: 'watermarked' }
          : {}),
        thumbnail_url: `/api/images/library/file/${encodeURIComponent(record.storage_id ?? 'test-storage')}/${encodeURIComponent(record.filename ?? `${id}.png`)}?variant=thumbnail`,
        detail_url: `/api/images/library/record/${encodeURIComponent(id)}`,
        image_url: `/api/images/${encodeURIComponent(id)}/content`,
      };
    },
    page(params, init) {
      const url = new URL(params, 'http://imagedials.test');
      const values = url.searchParams;
      const limit = Math.max(
        1,
        Math.min(96, Number(values.get('limit')) || 48),
      );
      const order = values.get('order') === 'oldest' ? 'oldest' : 'newest';
      const terms = (values.get('q') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => term.toLocaleLowerCase());
      const eventName = values.get('event_name');
      const searchable = (value, seen = new Set()) => {
        if (typeof value === 'string')
          return /^data:/i.test(value) || value.length > 20_000 ? '' : value;
        if (typeof value === 'number' || typeof value === 'boolean')
          return String(value);
        if (!value || typeof value !== 'object' || seen.has(value)) return '';
        seen.add(value);
        return Object.values(value)
          .map((entry) => searchable(entry, seen))
          .join(' ');
      };
      const orientationOf = fakeOrientationOf;
      let matches = [...library.records].filter((record) => {
        if (eventName && (record.event_name ?? record.event_id) !== eventName)
          return false;
        const text = searchable(record).toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      });
      // A test's array order stands for the server's order among equal times.
      const listedAt = new Map(library.records.map((r, i) => [r, i]));
      matches.sort((left, right) => {
        const date =
          Number(right.created_at ?? 0) - Number(left.created_at ?? 0);
        const position = listedAt.get(left) - listedAt.get(right);
        const direction = order === 'oldest' ? -1 : 1;
        return direction * (date || position);
      });
      const orientationCounts = {
        landscape: 0,
        portrait: 0,
        square: 0,
        unknown: 0,
      };
      for (const record of matches)
        orientationCounts[orientationOf(record)] += 1;
      const orientation = values.get('orientation');
      if (orientation)
        matches = matches.filter((r) => orientationOf(r) === orientation);

      let offset = 0;
      const edge = values.get('edge');
      const around = values.get('around');
      const cursor = values.get('cursor');
      if (edge === 'last') offset = Math.max(0, matches.length - limit);
      else if (around) {
        const index = matches.findIndex(
          (record) => String(record.id) === around,
        );
        if (index < 0) return respond(404, { detail: 'Image not found' });
        offset = Math.max(
          0,
          Math.min(index - Math.floor(limit / 2), matches.length - limit),
        );
      } else if (cursor) {
        const parsed = /^fake-page:(\d+)$/.exec(cursor);
        if (!parsed) return respond(400, { detail: 'Invalid cursor' });
        offset = Math.min(
          Number(parsed[1]),
          Math.max(0, matches.length - limit),
        );
      }
      const images = matches
        .slice(offset, offset + limit)
        .map((record) => library.summaryRow(record));
      const previousOffset = Math.max(0, offset - limit);
      const nextOffset = offset + images.length;
      const body = {
        listing_kind: 'summary-page',
        images,
        count: images.length,
        total: matches.length,
        orientation_counts: orientationCounts,
        position: offset,
        anchor_index: around
          ? images.findIndex((record) => record.id === around)
          : null,
        revision: 1,
        order,
        previous_cursor: offset > 0 ? `fake-page:${previousOffset}` : null,
        next_cursor:
          nextOffset < matches.length ? `fake-page:${nextOffset}` : null,
        watermark_backfill: null,
      };
      const etag = `"${textHash(JSON.stringify(body))}"`;
      if (init.headers?.['If-None-Match'] === etag)
        return respond(304, null, { ETag: etag });
      return respond(200, body, { ETag: etag });
    },
    detail(id, eventName, init) {
      const record = library.records.find(
        (candidate) => String(candidate.id) === id,
      );
      if (
        !record ||
        (eventName && (record.event_name ?? record.event_id) !== eventName)
      )
        return respond(404, m2.errors.missing);
      const etag = `"${textHash(JSON.stringify(record))}"`;
      if (init.headers?.['If-None-Match'] === etag)
        return respond(304, null, { ETag: etag });
      return respond(200, record, { ETag: etag });
    },
    routes: {
      'GET /api/images/library': (_body, _n, init) => {
        const etag = library.etag();
        if (init.headers?.['If-None-Match'] === etag)
          return respond(304, null, { ETag: etag });
        return respond(200, library.body(), { ETag: etag });
      },
      'DELETE /api/images/library': (body) => {
        const match = library.records.find(
          (r) =>
            r.storage_id === body.storage_id && r.filename === body.filename,
        );
        if (!match) return respond(404, m2.errors.missing);
        library.records = library.records.filter((r) => r !== match);
        library.deleted.push(body);
        return { deleted: true, ...body };
      },
      'POST /api/images/library/shuffle-sessions': (body) =>
        library.createSession(body),
      match: (key) => {
        const session =
          /^(GET|DELETE|POST) \/api\/images\/library\/shuffle-sessions\/([^/?]+)(\/renew)?(?:\?(.*))?$/.exec(
            key,
          );
        if (session) {
          const [, method, rawId, renew, query] = session;
          const id = decodeURIComponent(rawId);
          const values = new URLSearchParams(query ?? '');
          if (method === 'GET') return () => library.readSession(id, values);
          if (method === 'DELETE')
            return () => {
              if (!library.sessions.has(id))
                return respond(404, { detail: 'Gallery session not found' });
              library.sessions.delete(id);
              library.released.push(id);
              return respond(204, null);
            };
          if (renew)
            return () => {
              if (!library.sessions.has(id))
                return respond(404, { detail: 'Gallery session not found' });
              library.renewed.push(id);
              return { session_id: id, state: 'ready', expires_at: 1700003610 };
            };
        }
        if (
          key === 'GET /api/images/library/event-facets' ||
          key.startsWith('GET /api/images/library/event-facets?')
        )
          return (_body, _n, init) => library.facets(key.slice(4), init);
        if (key.startsWith('GET /api/images/library/page?'))
          return (_body, _n, init) => library.page(key.slice(4), init);
        if (key.startsWith('GET /api/images/library/record/'))
          return (_body, _n, init) => {
            const [path, query] = key.slice(4).split('?');
            const id = decodeURIComponent(
              path.slice('/api/images/library/record/'.length),
            );
            const eventName = new URLSearchParams(query ?? '').get(
              'event_name',
            );
            return library.detail(id, eventName, init);
          };
        return undefined;
      },
    },
  };
  return library;
}

/**
 * A controllable EventSource. Instances register in `FakeEventSource.all`;
 * tests drive them with `open()`, `emit(name, data)` and `fail()`.
 */
export class FakeEventSource {
  static all = [];
  static reset() {
    FakeEventSource.all = [];
  }
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.all.push(this);
  }
  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  count(name) {
    return this.listeners.get(name)?.length ?? 0;
  }
  dispatch(name, event = {}) {
    if (this.closed) return;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  open() {
    this.dispatch('open');
  }
  /** A named JSON event; `raw` sends the text unchanged. */
  emit(name, data, raw) {
    this.dispatch(name, { data: raw ?? JSON.stringify(data) });
  }
  fail() {
    this.dispatch('error');
  }
}
