# Browser-local settings contract

Provider choices are request-scoped. They do not change the server environment,
other browsers, accepted jobs, or saved provenance. The browser owns persistence
and sends explicit overrides only on provider-consuming requests.

`GET /api/browser-settings/defaults` returns `providers`, `keys_configured`,
`watermark` and `storage: "browser"`, with `Cache-Control: no-store`. Endpoints
and language-model names come from runtime configuration. Keys are represented
only by configured flags; default key values are never returned. Reset removes
a local override rather than copying a secret into browser storage.

Supported override fields are `LLM_MODEL_ENDPOINT_1`, `LLM_MODEL_KEY_1`,
`LLM_MODEL_NAME`, `IMAGE_MODEL_ENDPOINT_1`, `IMAGE_MODEL_KEY_1`,
`DESCRIPTION_MODEL_ENDPOINT`, `DESCRIPTION_MODEL_KEY` and
`DESCRIPTION_MODEL_NAME`. The server selects the image protocol (`mock` or
`comfyui`); it is returned for display and cannot be overridden by a browser.
`IMAGE_MODEL_NAME` is returned for display; the server-owned workflow determines
the image model and cannot be replaced with a browser-supplied filesystem path.

Send `X-ImageDials-Provider-Overrides` as standard base64 of UTF-8 JSON containing
only explicit field overrides. The encoded header is limited to 6144 bytes and
each value to 1024 characters. Values are single-line strings. Endpoints accept
HTTP(S) with an optional API path, without embedded credentials, queries or
fragments. Unsupported or malformed overrides return 400 without echoing values.

Changing an endpoint without providing its new key clears that endpoint's
inherited server key. A distinct description endpoint does not inherit the
language endpoint's key. Provider choices are captured when a job is accepted;
later requests cannot redirect an accepted generation. The idempotency check
also distinguishes endpoint/model choices, without persisting API keys.

`POST /api/browser-settings/watermark/validate` validates and normalizes local
text or SVG settings without saving them. It returns the content fingerprint,
limits and renderer policy. The JSON body limit is 65 KiB. Standard text/SVG
validation and sanitization apply. Root and configured-prefix aliases are
available for both routes.

`WATERMARK_DEFAULT_TEXT` sets the initial browser watermark text. When blank,
defaults use the current server watermark setting. Saving a local value must not
call the shared settings PUT. To obtain a local derivative key, pass normalized
content as the `watermark_settings` JSON field alongside the original image in
`POST /api/watermark/analyze-image`. It returns compatible analysis and a key
bound to that local content, without image, job, settings or sidecar writes.
Do not upload such a derivative to shared print-ready storage.

The header settings panel keeps provider overrides in a versioned LocalStorage
document. Each field has its own reset action. Changing providers cancels stale
control requests and separates suggestion caches by provider and mode. A retry
after an ambiguous submission retains the original provider choices and
idempotency key.

Watermark content uses the same browser-local owner from the header settings
panel and library editor. Text overrides use LocalStorage; SVG markup uses
IndexedDB. Save validates without changing shared settings. Cancel discards the
draft, and reset rereads the server defaults. Denied storage applies changes for
the page lifetime with a persistence notice.

Shared and browser-only originals use one local preparation pipeline. It renders
a separate PNG, then sends that PNG and its provenance to
`POST /api/watermark/embed-metadata`. The returned PNG carries the source identity,
hash, watermark settings, analysis and opaque derivative key. Those returned bytes
are cached, downloaded and printed. A preparation failure reports an error rather
than substituting the original. Download original remains a separate action.
Imported watermarked derivatives are recognized as baked pixels and receive no
second overlay. Rebuildable prepared copies have independent bounded storage;
neither preparation nor changing watermark content rewrites the original image.
