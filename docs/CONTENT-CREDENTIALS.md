# Content Credentials reader contract

The browser integration uses the pinned MIT-licensed `@contentauth/c2pa-web`
0.15.5 SDK and its separately served WebAssembly resource. Load it on demand in
its worker; do not add the inline binary to the initial application bundle.
Preserve the packaged notices under `frontend/public/licenses/`.

Use `Reader.fromBlob` with a `Context` enabling `verifyAfterReading` and
`verifyTrust`, and disabling `remoteManifestFetch` and `ocspFetch`. Do not fetch
remote manifests, trust lists, certificate status or embedded resources without
an explicit product decision. Image bytes must remain in the browser. No
analytics or external inspection service is involved.

A null reader means credentials are absent. A rejected read means inspection
failed; it does not mean the image has no credentials. For a reader, obtain
`manifestStore()` and preserve its structured data and validation details.
Report the SDK's `Invalid`, `Valid` and `Trusted` states distinctly. Signature
validity and signer trust are different checks; neither establishes the truth
of image content. Missing or unknown validation state must remain unverified.
Release every reader with `free()` and dispose the worker when its owner ends.

The official [browser SDK guidance](https://opensource.contentauthenticity.org/docs/)
and the installed package declarations define the supported API. The
[SDK repository](https://github.com/contentauth/c2pa-js) provides its source and
license. Independent signed, tampered and unsigned inputs are in
`fixtures/credentials/`. Actual browser SDK checks distinguish absent, valid
with untrusted signer, trusted with an explicit test root, and invalid data
binding. The Library detail disclosure now uses this reader on demand. Production never
loads the fixture test root.

Original downloads and inspection share one byte reader. Browser-private and
imported records use the browser copy; shared records prefer a cached original
and then the canonical original-file endpoint. Thumbnails and watermarked
copies are never inspected as the original. Closing or cancelling an inspection
stops its worker and ignores late results. Read failures can be retried.

Generation currently normalizes the provider PNG and embeds the restoration
snapshot at its initial save. Provider-embedded credentials are not preserved
through that transformation. The reader reports credentials in the actual saved
or imported original; it does not infer them from provider identity or prompts.
Subsequent watermark analysis and prepared-file changes leave that original
unchanged.

The separately emitted SDK WebAssembly contains upstream compiler diagnostics
and build paths. The build privacy gate recognizes only the reviewed SDK
0.15.5 binary with SHA-256
`e6a3817fc7a4d5dddc66a26e9e21d5159bc73f60e95f27e76e249b3e70a37b95`.
Its emitted path, installed package version, locked version and installed bytes
must all match. Changed bytes and all other output retain normal privacy checks.
A dependency upgrade requires a fresh artifact review. The implementation and
negative tests are in `scripts/build_artifacts.py` and
`scripts/test_build_artifacts.py`; existing SDK notices remain distributed.
