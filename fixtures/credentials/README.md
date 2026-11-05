# Content Credentials fixtures

These independently generated PNGs and the public test certificate use the
repository's MIT license. No signing keys are distributed.

- `unsigned.png`: a plain blue field with no credentials.
- `signed.png`: the same pixels with a signed C2PA manifest. Signature and data
  binding validate; its test signer is untrusted without an explicit test root.
- `tampered.png`: one changed pixel, preserving the signed manifest and valid
  PNG encoding. The SDK reports an asset data-hash mismatch.
- `test-root.pem`: load only in tests that explicitly exercise signer trust.

`manifest.json` records hashes, SDK versions and observed validation states.
The browser SDK was exercised against all three assets with remote manifest and
OCSP fetching disabled, both with and without the explicit test root. Signature
validity, signer trust and the truth of image content remain separate questions.
