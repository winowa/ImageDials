import { describe, expect, it } from 'vitest';
import {
  copyText,
  describeExchange,
  pageExchanges,
  savedExchanges,
} from './llmExchange.js';

const messages = [
  { role: 'system', content: 'Return only JSON.\nBe specific.' },
  { role: 'user', content: JSON.stringify({ idea: 'A <b>barn</b> owl' }) },
];
const reply = { categories: { range: { id: 'a' } } };
const received = () => ({
  prompt: JSON.stringify(messages),
  response: reply,
  raw_response: JSON.stringify(reply),
  response_format: { type: 'json_schema' },
  schema_fallback: false,
  model: 'm-1',
  provider: 'openai-compatible',
});
const describe1 = (evidence, base = {}) =>
  describeExchange(evidence, { id: 'x', title: 'T', ...base });
const blocks = (exchange, section) =>
  exchange.sections.find((s) => s.id === section)?.blocks ?? [];

describe('describeExchange', () => {
  it('shows the exact messages and raw reply with formatted views', () => {
    const exchange = describe1(received());
    expect(exchange.state).toBe('received');
    expect(exchange.chips).toEqual(['openai-compatible', 'm-1']);
    const request = blocks(exchange, 'request');
    expect(request.map((b) => b.label)).toEqual([
      'system message',
      'user message',
      'Response format',
    ]);
    expect(request[0]).toMatchObject({
      kind: 'text',
      raw: messages[0].content,
      collapsed: true,
    });
    expect(request[1].value).toEqual({ idea: 'A <b>barn</b> owl' });
    expect(request[1].raw).toBe(messages[1].content);
    const [response] = blocks(exchange, 'response');
    expect(response.raw).toBe(JSON.stringify(reply));
    expect(response.value).toEqual(reply);
  });

  it('keeps fenced raw text exact and formats the parsed content', () => {
    const raw = '```json\n' + JSON.stringify(reply) + '\n```';
    const [response] = blocks(
      describe1({ ...received(), raw_response: raw }),
      'response',
    );
    expect(response.raw).toBe(raw);
    expect(response.value).toEqual(reply);
  });

  it('shows non-JSON text as received, with no formatted view', () => {
    const exchange = describe1({
      ...received(),
      raw_response: 'Sure! {oops',
      response: undefined,
    });
    const [response] = blocks(exchange, 'response');
    expect(response).toMatchObject({ kind: 'text', raw: 'Sure! {oops' });
    expect(response.value).toBeUndefined();
    expect(exchange.notes.join(' ')).toMatch(/not JSON/);
  });

  it('says an empty reply was empty', () => {
    const exchange = describe1({ ...received(), raw_response: '' });
    expect(blocks(exchange, 'response')[0].raw).toBe('');
    expect(exchange.notes).toContain('The model returned an empty reply.');
    expect(blocks(exchange, 'response')[0].value).toBeUndefined();
  });

  it('formats JSON primitives and never substitutes parsed data for different raw text', () => {
    for (const value of [null, true, 42, 'received']) {
      const [block] = blocks(
        describe1({ ...received(), raw_response: JSON.stringify(value) }),
        'response',
      );
      expect(block.value).toEqual(value);
    }
    const [block] = blocks(
      describe1({ ...received(), raw_response: 'not JSON' }),
      'response',
    );
    expect(block.value).toBeUndefined();
    expect(block.raw).toBe('not JSON');
  });

  it('marks legacy records that kept only the parsed reply', () => {
    const { raw_response: _raw, ...legacy } = received();
    const exchange = describe1(legacy);
    expect(exchange.state).toBe('partial');
    const [response] = blocks(exchange, 'response');
    expect(response.label).toBe('Parsed reply');
    expect(response.raw).toBeNull();
    expect(response.note).toMatch(/original text was not saved/);
  });

  it('shows an unparsed prompt as text and invents no messages', () => {
    const exchange = describe1({ ...received(), prompt: 'plain request' });
    expect(blocks(exchange, 'request')[0]).toMatchObject({
      kind: 'text',
      raw: 'plain request',
    });
    expect(exchange.state).toBe('partial');
    expect(exchange.notes.join(' ')).toMatch(/not as separate messages/);
  });

  it('shows the mock provider as no exchange at all', () => {
    const exchange = describe1({
      provider: 'mock',
      prompt: 'idea',
      response: [],
      raw_response: '',
    });
    expect(exchange.state).toBe('mock');
    expect(exchange.sections).toEqual([]);
    expect(exchange.notes[0]).toMatch(/no model call/);
  });

  it('describes a failed call with its failure, request and received text', () => {
    const exchange = describe1({
      ...received(),
      status: 'failed',
      failure: { reason: 'ValueError: Missing generated category slots' },
    });
    expect(exchange.state).toBe('failed');
    expect(exchange.sections.map((s) => s.id)).toEqual([
      'failure',
      'request',
      'response',
    ]);
    expect(blocks(exchange, 'failure')[0].raw).toMatch(/Missing generated/);
  });

  it('does not invent a reply for an unreachable provider', () => {
    const exchange = describe1({
      status: 'failed',
      prompt: JSON.stringify(messages),
      failure: { reason: 'Provider request failed' },
    });
    expect(exchange.sections.map((s) => s.id)).toEqual(['failure', 'request']);
    expect(exchange.notes).toContain('No reply was received from the model.');
  });

  it('shows an HTTP error reply and a provider body without content', () => {
    const http = describe1({
      status: 'failed',
      prompt: JSON.stringify(messages),
      failure: {
        reason: 'x',
        http_status: 503,
        body: '{"error":"busy"}',
      },
    });
    const [, body] = blocks(http, 'failure');
    expect(body.label).toBe('Error reply (HTTP 503)');
    expect(body.value).toEqual({ error: 'busy' });
    expect(http.notes).not.toContain('No reply was received from the model.');
    const empty = describe1({
      status: 'failed',
      prompt: JSON.stringify(messages),
      failure: { reason: 'x' },
      provider_body: '{"choices":[]}',
    });
    expect(blocks(empty, 'response')[0].label).toBe('Provider reply');
  });

  it('describes More controls from the saved request data and parsed replies', () => {
    const exchange = describe1(
      {
        provider: 'openai-compatible',
        model: 'm-1',
        request: { idea: 'x' },
        attempts: [
          {
            request: { idea: 'x', count: 3 },
            response: { categories: [] },
            review: { request: { a: 1 }, response: { keep_ids: [] } },
          },
          { request: { idea: 'x', count: 1 }, response: { categories: [] } },
        ],
      },
      { kind: 'more' },
    );
    expect(exchange.state).toBe('partial');
    expect(exchange.sections.map((s) => s.title)).toEqual([
      'Attempt 1',
      'Attempt 2',
    ]);
    expect(exchange.sections[0].blocks.map((b) => b.label)).toEqual([
      'Request data',
      'Parsed reply',
      'Scope review request',
      'Scope review reply',
    ]);
    expect(exchange.notes[0]).toMatch(/not saved for More controls/);
    expect(
      exchange.sections.flatMap((s) => s.blocks).every((b) => !b.raw),
    ).toBe(true);
  });

  it('reports unusable evidence as not saved', () => {
    for (const value of [null, undefined, 'text', []])
      expect(describe1(value).state).toBe('unavailable');
  });
});

describe('copyText', () => {
  it('copies the exact stored text, else the formatted JSON', () => {
    expect(copyText({ raw: ' a\n', value: 1 })).toBe(' a\n');
    expect(copyText({ raw: null, value: { a: 1 } })).toBe('{\n  "a": 1\n}');
  });
});

describe('pageExchanges', () => {
  it('lists failures first, then the current call and every More batch', () => {
    const failure = {
      ...received(),
      status: 'failed',
      failure: { reason: 'r' },
    };
    const error = Object.assign(new Error('Invalid controls'), {
      attempts: [failure, failure],
    });
    const list = pageExchanges({
      dynamic: { status: 'error', error, metadata: received() },
      additionalMetadata: [{ provider: 'mock' }],
      stale: true,
    });
    expect(list.map((e) => e.title)).toEqual([
      'Failed attempt 1 of 2',
      'Failed attempt 2 of 2',
      'Initial controls (earlier idea)',
      'More controls 1',
    ]);
    expect(list[1].notes[0]).toBe('Invalid controls');
    expect(list[0].notes).not.toContain('Invalid controls');
    expect(list.map((e) => e.state)).toEqual([
      'failed',
      'failed',
      'received',
      'mock',
    ]);
  });

  it('keeps a reply this page refused and a failure without evidence honest', () => {
    const rejected = pageExchanges({
      dynamic: {
        status: 'error',
        error: new Error('Too many controls'),
        rejected: received(),
        metadata: null,
      },
    });
    expect(rejected.map((e) => e.title)).toEqual([
      'Reply refused by this page',
    ]);
    expect(rejected[0].notes).toContain('Too many controls');
    const none = pageExchanges({
      dynamic: { status: 'error', error: new Error('offline') },
    });
    expect(none).toHaveLength(1);
    expect(none[0].state).toBe('unavailable');
  });

  it('marks controls with no saved call as not saved', () => {
    const [only] = pageExchanges({
      dynamic: { status: 'ready', metadata: null },
    });
    expect(only.state).toBe('unavailable');
  });
});

describe('savedExchanges', () => {
  it('lists the retained calls of a result', () => {
    const list = savedExchanges({
      dynamic_controls_metadata: received(),
      additional_controls_metadata: [{ provider: 'mock' }, null],
    });
    expect(list.map((e) => [e.title, e.state])).toEqual([
      ['Initial controls', 'received'],
      ['More controls 1', 'mock'],
    ]);
  });

  it('reports legacy results as not saved, and others as nothing to show', () => {
    expect(savedExchanges({}, true)[0].state).toBe('unavailable');
    expect(savedExchanges({}, false)).toEqual([]);
  });
});
