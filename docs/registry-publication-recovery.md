# Registry publication and recovery

Tagged releases prepare a single retained registry bundle before either package is
published. The bundle is a GitHub release asset named
`registry-packages-<version>-<source-sha>.tar.gz`. It contains `manifest.json` and
two distinct npm tarballs: `cowork-os` for npm and `@cowork-os/cowork-os` for
GitHub Packages. The manifest records the original source commit, tag, workflow
run and attempt, package names, registry URLs, sizes, and SHA-512 integrity.

## Normal release

The existing hardening and desktop/server jobs must succeed first. The
`Prepare registry packages` job restores an existing bundle if available. On the
first attempt only, a missing bundle can be prepared when both registries return
accessible package metadata demonstrating that the version is absent. Package
lookup 404s are ambiguous and block preparation; they can indicate missing access.

Preparation explicitly installs dependencies and builds before packing with
`--ignore-scripts`. It uploads the bundle once without overwriting assets, reads
back the exact uploaded bytes, and smoke-tests both retained tarballs in clean
temporary install directories. The smoke checks verify setup does not fall back
to dependency bootstrap and Electron can load its SQLite addon. They do not
exercise a live provider task or demonstrate a production release.

Each registry job consumes the saved tarball. It verifies package identity,
version, registry metadata integrity, and the actual downloaded tarball bytes:

| State                                                                      | Result                                      |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| Accessible package metadata lacks the version                              | Publish the retained file once, then verify |
| Published version and bytes match                                          | Succeed without publishing again            |
| Conflicting identity, metadata, or bytes                                   | Fail                                        |
| Authentication failure, ambiguous 404, malformed response, network failure | Fail                                        |
| Upload response lost, but subsequent exact verification succeeds           | Succeed                                     |

Post-publish verification has bounded retries to allow registry propagation. It
never retries the upload blindly. Finalization separately re-verifies both
registries. Any missing or unverified version keeps the draft unpublished.

The release and recovery workflows share a tag-specific concurrency group and do
not cancel active publication. The bundle is retained as a release asset rather
than an expiring Actions artifact; do not delete or replace it.

## Recover a partial publication

1. Resolve the original tag's full commit SHA. Confirm the corresponding bundle
   still exists on that release.
2. Run **Recover registry publication** from the `main` branch, supplying the
   existing `tag` and `source_sha`. Recovery executes the maintained workflow
   code at the dispatch commit; it does not execute or rebuild the supplied tag.
3. The job checks the tag still resolves to that SHA and validates the saved
   bundle. It requires original successful hardening/platform jobs for the
   manifest's run and attempt. Package smoke evidence must have succeeded in
   that attempt or a later attempt of the same source run.
4. Both registries are checked and any missing version is published from the
   retained tarball. The GitHub release is finalized only after both verify.

Recovery publishes missing historical versions under `recovery-<version>` to
avoid moving `latest` backward. Existing matching versions leave distribution
tags unchanged. Promoting a recovered version to a public channel is a separate
release decision.

A full rerun of a partially completed new release also reuses the bundle. If
smoke testing failed after the bundle was uploaded, rerunning the source workflow
can produce successful smoke evidence for the same saved bytes. For an already
public immutable GitHub release, use the registry-only recovery workflow instead
of rerunning desktop asset uploads.

Missing/deleted bundles, unavailable source-run evidence, moved tags, failed
prerequisites, and integrity conflicts block automatic recovery. A failed first
attempt before bundle retention cannot be repaired by silently rebuilding on a
retry. Releases created before this workflow have no recovery bundle; rerunning
their old workflow does not install this fix. Do not reconstruct an artifact and
claim it is the original published package.

## Validation

```sh
node --test scripts/release/*.test.mjs
npx vitest run tests/release-publication-workflows.test.ts tests/qa-workflow-gates.test.ts tests/release-platform-metadata.test.ts
```

Tests use temporary packages and simulated registry/GitHub responses. They cover
partial success followed by replay, immutable-version conflicts, lost responses,
artifact corruption, source identity, prerequisite evidence, and credential
boundaries. They do not publish a production package.
