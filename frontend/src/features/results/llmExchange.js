/**
 * Turn the model-call evidence the application already keeps into a plain
 * description for the request/response inspector. Nothing is derived or
 * invented: every block comes from a stored field, and a missing field becomes
 * a note that says what was not kept.
 *
 * Evidence shapes seen:
 * - initial controls: `{prompt, response, raw_response, response_format,
 *   schema_fallback, model, provider}`; `prompt` is the JSON text of the
 *   messages sent. A failed call adds `status: 'failed'`, `failure` and
 *   either `raw_response` or `provider_body`.
 * - More controls: `{provider, model, request, attempts: [{request, response,
 *   review?}]}`; instructions and raw text were never kept.
 */

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStructured = (value) => value !== null && typeof value === 'object';

export const EXCHANGE_STATE = Object.freeze({
  received: 'received',
  failed: 'failed',
  mock: 'mock',
  partial: 'partial',
  unavailable: 'unavailable',
});

export const STATE_LABEL = Object.freeze({
  received: 'Received',
  failed: 'Failed',
  mock: 'Mock',
  partial: 'Partly saved',
  unavailable: 'Not saved',
});

function parse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Parse model text as the backend does: directly, or inside a code fence. */
function structuredFrom(text) {
  const direct = parse(text);
  if (direct.ok) return direct.value;
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const inner = trimmed
      .slice(trimmed.indexOf('\n') + 1)
      .replace(/```\s*$/, '');
    const fenced = parse(inner);
    if (fenced.ok) return fenced.value;
  }
  return undefined;
}

/** Chat messages from the saved JSON text, or null when it is not that shape. */
function messagesFrom(prompt) {
  if (typeof prompt !== 'string') return null;
  const parsed = parse(prompt);
  if (!parsed.ok || !Array.isArray(parsed.value) || !parsed.value.length)
    return null;
  const valid = parsed.value.every(
    (message) =>
      isObject(message) &&
      typeof message.role === 'string' &&
      typeof message.content === 'string',
  );
  return valid ? parsed.value : null;
}

/**
 * A block shows one stored value. `raw` is the exact stored text when there
 * is one; `value` is a structured reading of it, offered as a formatted view.
 */
const textBlock = (id, label, text, extra = {}) => ({
  kind: 'text',
  id,
  label,
  raw: text,
  value: undefined,
  ...extra,
});
const dataBlock = (id, label, value, raw = null, extra = {}) => ({
  kind: 'data',
  id,
  label,
  raw,
  value,
  ...extra,
});

function messageBlocks(messages) {
  return messages.map((message, index) => {
    const structured = structuredFrom(message.content);
    const label = `${message.role} message`;
    const id = `message-${index}`;
    // Long fixed instructions start closed; the data the person typed is open.
    const collapsed = message.role === 'system';
    return structured === undefined
      ? textBlock(id, label, message.content, { collapsed })
      : dataBlock(id, label, structured, message.content, { collapsed });
  });
}

function responseBlocks(evidence, notes, label = 'Raw reply') {
  const blocks = [];
  const raw = evidence.raw_response;
  const parsed = evidence.response;
  if (typeof raw === 'string') {
    const structured = structuredFrom(raw);
    blocks.push(
      structured === undefined
        ? textBlock('reply', label, raw)
        : dataBlock('reply', label, structured, raw),
    );
    if (raw === '') notes.push('The model returned an empty reply.');
    if (evidence.raw_response_truncated)
      notes.push('The reply is clipped here; the original was longer.');
    if (structured === undefined && raw !== '')
      notes.push('The reply is not JSON, so it is shown as received.');
  } else if (typeof evidence.provider_body === 'string') {
    const structured = structuredFrom(evidence.provider_body);
    blocks.push(
      structured === undefined
        ? textBlock('provider-body', 'Provider reply', evidence.provider_body)
        : dataBlock(
            'provider-body',
            'Provider reply',
            structured,
            evidence.provider_body,
          ),
    );
    notes.push('The provider reply had no message content to read.');
    if (evidence.provider_body_truncated)
      notes.push('The provider reply is clipped here.');
  } else if (isStructured(parsed) && !isEmptyList(parsed)) {
    blocks.push(
      dataBlock('reply', 'Parsed reply', parsed, null, {
        note: 'Parsed from the reply. The original text was not saved.',
      }),
    );
  }
  return blocks;
}

const isEmptyList = (value) => Array.isArray(value) && !value.length;

function failureBlocks(failure) {
  if (!isObject(failure)) return [];
  const blocks = [];
  if (typeof failure.reason === 'string' && failure.reason)
    blocks.push(textBlock('failure-reason', 'Reason', failure.reason));
  if (typeof failure.body === 'string') {
    const structured = structuredFrom(failure.body);
    const label = Number.isInteger(failure.http_status)
      ? `Error reply (HTTP ${failure.http_status})`
      : 'Error reply';
    blocks.push(
      structured === undefined
        ? textBlock('failure-body', label, failure.body)
        : dataBlock('failure-body', label, structured, failure.body),
    );
  }
  return blocks;
}

function chips(evidence) {
  const out = [];
  if (typeof evidence.provider === 'string' && evidence.provider)
    out.push(evidence.provider);
  if (typeof evidence.model === 'string' && evidence.model)
    out.push(evidence.model);
  if (evidence.schema_fallback)
    out.push('Sent without the schema format after it was refused');
  return out;
}

function describeControlsCall(evidence, base) {
  const notes = [];
  const failed = evidence.status === 'failed';
  const requestBlocks = [];
  const messages = messagesFrom(evidence.prompt);
  if (messages) requestBlocks.push(...messageBlocks(messages));
  else if (typeof evidence.prompt === 'string' && evidence.prompt) {
    requestBlocks.push(textBlock('prompt', 'Request text', evidence.prompt));
    notes.push('The request was saved as text, not as separate messages.');
  } else notes.push('The request was not saved.');
  if (isObject(evidence.response_format))
    requestBlocks.push(
      dataBlock('format', 'Response format', evidence.response_format, null, {
        collapsed: true,
      }),
    );
  const responses = responseBlocks(evidence, notes);
  const hasRaw = typeof evidence.raw_response === 'string';
  if (!responses.length && !failed)
    notes.push('The reply was not saved with this record.');
  const sections = [];
  if (failed) {
    const reasons = failureBlocks(evidence.failure);
    if (reasons.length)
      sections.push({ id: 'failure', title: 'Failure', blocks: reasons });
    else notes.push('The server gave no failure details.');
  }
  if (requestBlocks.length)
    sections.push({ id: 'request', title: 'Request', blocks: requestBlocks });
  if (responses.length)
    sections.push({
      id: 'response',
      title: failed && !hasRaw ? 'Received' : 'Response',
      blocks: responses,
    });
  if (
    failed &&
    !responses.length &&
    !Number.isInteger(evidence.failure?.http_status)
  )
    notes.push('No reply was received from the model.');
  if (evidence.failure?.body_truncated)
    notes.push('The error reply is clipped here; the original was longer.');
  let state = EXCHANGE_STATE.received;
  if (failed) state = EXCHANGE_STATE.failed;
  else if (!hasRaw || !messages) state = EXCHANGE_STATE.partial;
  if (!sections.length) state = EXCHANGE_STATE.unavailable;
  return { ...base, state, chips: chips(evidence), notes, sections };
}

function describeMoreCall(evidence, base) {
  const notes = [
    'Instructions and the raw reply text were not saved for More controls; the request data and parsed replies were.',
  ];
  const sections = [];
  const attempts = Array.isArray(evidence.attempts)
    ? evidence.attempts.filter(isObject)
    : [];
  if (attempts.length) {
    attempts.forEach((attempt, index) => {
      const blocks = [];
      if (isStructured(attempt.request))
        blocks.push(dataBlock('request', 'Request data', attempt.request));
      if (isStructured(attempt.response))
        blocks.push(dataBlock('reply', 'Parsed reply', attempt.response));
      const review = attempt.review;
      if (isObject(review)) {
        if (isStructured(review.request))
          blocks.push(
            dataBlock(
              'review-request',
              'Scope review request',
              review.request,
              null,
              {
                collapsed: true,
              },
            ),
          );
        if (isStructured(review.response))
          blocks.push(
            dataBlock('review-reply', 'Scope review reply', review.response),
          );
      }
      if (blocks.length)
        sections.push({
          id: `attempt-${index}`,
          title: attempts.length > 1 ? `Attempt ${index + 1}` : 'Attempt',
          blocks,
        });
    });
  } else {
    const request = isStructured(evidence.request)
      ? [dataBlock('request', 'Request data', evidence.request)]
      : [];
    const response = isStructured(evidence.response)
      ? [dataBlock('reply', 'Parsed reply', evidence.response)]
      : [];
    if (request.length)
      sections.push({ id: 'request', title: 'Request', blocks: request });
    if (response.length)
      sections.push({ id: 'response', title: 'Response', blocks: response });
  }
  return {
    ...base,
    state: sections.length
      ? EXCHANGE_STATE.partial
      : EXCHANGE_STATE.unavailable,
    chips: chips(evidence),
    notes,
    sections,
  };
}

/**
 * @param {unknown} evidence stored or received evidence for one model call
 * @param {{id: string, title: string, kind?: 'controls'|'more', notes?: string[]}} base
 */
export function describeExchange(evidence, base) {
  const { kind = 'controls', notes: extra = [], ...identity } = base;
  const common = { ...identity, kind };
  let described;
  if (!isObject(evidence)) {
    described = {
      ...common,
      state: EXCHANGE_STATE.unavailable,
      chips: [],
      notes: ['No request or reply was saved for this call.'],
      sections: [],
    };
  } else if (evidence.provider === 'mock') {
    // The mock keeps the idea text, not a model exchange; show none of it.
    described = {
      ...common,
      state: EXCHANGE_STATE.mock,
      chips: ['mock'],
      notes: ['The mock provider made no model call, so nothing was sent.'],
      sections: [],
    };
  } else {
    described =
      kind === 'more'
        ? describeMoreCall(evidence, common)
        : describeControlsCall(evidence, common);
  }
  return { ...described, notes: [...extra, ...described.notes] };
}

const unavailable = (id, title, note) => ({
  id,
  title,
  kind: 'controls',
  state: EXCHANGE_STATE.unavailable,
  chips: [],
  notes: [note],
  sections: [],
});

/**
 * Calls behind the generated controls on the page: failed attempts first, then
 * the call that produced the controls shown and every More controls batch.
 */
export function pageExchanges({ dynamic, additionalMetadata = [], stale }) {
  const list = [];
  if (dynamic?.status === 'error') {
    const error = dynamic.error;
    const attempts = Array.isArray(error?.attempts)
      ? error.attempts
      : isObject(error?.evidence)
        ? [error.evidence]
        : [];
    attempts.forEach((evidence, index) =>
      list.push(
        describeExchange(evidence, {
          id: `failed-${index}`,
          title:
            attempts.length > 1
              ? `Failed attempt ${index + 1} of ${attempts.length}`
              : 'Failed attempt',
          notes:
            index === attempts.length - 1 && error?.message
              ? [error.message]
              : [],
        }),
      ),
    );
    if (isObject(dynamic.rejected))
      list.push(
        describeExchange(dynamic.rejected, {
          id: 'rejected',
          title: 'Reply refused by this page',
          notes: error?.message ? [error.message] : [],
        }),
      );
    if (!attempts.length && !isObject(dynamic.rejected))
      list.push(
        unavailable(
          'failed',
          'Failed attempt',
          'The server returned no request or reply for this failure.',
        ),
      );
  }
  const title = stale ? 'Initial controls (earlier idea)' : 'Initial controls';
  if (isObject(dynamic?.metadata))
    list.push(describeExchange(dynamic.metadata, { id: 'initial', title }));
  else if (dynamic?.status !== 'error')
    list.push(
      unavailable(
        'initial',
        title,
        'No request or reply was saved with these controls.',
      ),
    );
  additionalMetadata.filter(isObject).forEach((metadata, index) =>
    list.push(
      describeExchange(metadata, {
        id: `more-${index}`,
        title: `More controls ${index + 1}`,
        kind: 'more',
      }),
    ),
  );
  if (list.length)
    list[0].notes.push('Option expansion requests and replies are not saved.');
  return list;
}

/** Calls retained with a saved result; empty when it had no generated controls. */
export function savedExchanges(image, generatedControls = false) {
  const list = [];
  if (isObject(image?.dynamic_controls_metadata))
    list.push(
      describeExchange(image.dynamic_controls_metadata, {
        id: 'initial',
        title: 'Initial controls',
      }),
    );
  const more = Array.isArray(image?.additional_controls_metadata)
    ? image.additional_controls_metadata.filter(isObject)
    : [];
  more.forEach((metadata, index) =>
    list.push(
      describeExchange(metadata, {
        id: `more-${index}`,
        title: `More controls ${index + 1}`,
        kind: 'more',
      }),
    ),
  );
  if (!list.length && generatedControls)
    list.push(
      unavailable(
        'initial',
        'Initial controls',
        'No request or reply was saved with this image.',
      ),
    );
  if (list.length)
    list[0].notes.push('Option expansion requests and replies are not saved.');
  return list;
}

/** The exact text a Copy action puts on the clipboard for a block. */
export function copyText(block) {
  if (typeof block.raw === 'string') return block.raw;
  return JSON.stringify(block.value, null, 2);
}
