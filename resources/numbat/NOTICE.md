# Numbat runtime

CoWork OS integrates a pinned build of Perplexity's Numbat endpoint agent
security tool.

- Upstream: <https://github.com/perplexityai/numbat>
- Upstream version: `v0.1.1`
- Pinned commit: `3d20d782d45001fd3bb200bc5690ce4b9ce0f12b`
- Upstream license: Apache License 2.0
- Local adapter patch: `patches/cowork-os-v0.1.1.patch`

The adapter adds a distinct `cowork-os` live-hook source and a bounded control
response contract. It does not rename the existing `cowork` source, which
belongs to Anthropic Cowork at-rest audit logs.

Packaged binaries and recommended rule overrides are generated from the pinned,
checksum-verified source by `scripts/build_numbat_runtime.mjs`. The generated
files are not source-of-truth inputs.
