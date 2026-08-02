# Changelog

## 1.13.1 — 2026-08-02

- Re-inspect persisted custom models whose catalog entry has no resolved byte size instead of sending `ExpectedBytes: 0` into the downloader.
- Cover both exact-file and `repo:quantization` startup recovery from unresolved custom catalog entries.

## 1.12.1 — 2026-08-02

- Accept current official Hugging Face CDN and Xet redirects, including `us.aws.cdn.hf.co`, while retaining strict HTTPS and domain-boundary validation.
- Support custom native Home Assistant model configuration with either an exact repository/GGUF filename pair or llama.cpp-style `owner/repo:quantization` shorthand.
- Resolve custom models through Hugging Face metadata, reject ambiguous, split, and sidecar-only selections, and preserve resumable size/GGUF verification.
- Strip Hugging Face authorization before cross-host CDN/storage requests and keep tokens and signed URLs out of diagnostics.
- Preserve invalid or unavailable native configuration instead of silently replacing it.
