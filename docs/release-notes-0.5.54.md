# Release Notes 0.5.54

Release `0.5.54` is a release-engineering and adoption-reporting patch release. It makes registry publication recovery safer across draft GitHub releases, validates package bytes before archive parsing, corrects scoped GitHub Packages publication behavior, and refreshes the public adoption snapshot.

## Highlights

- **Registry publication recovery** now resolves draft GitHub releases when the tag endpoint does not return them, retains exact package bundles for retries, and verifies package checksums before parsing archives.
- **GitHub Packages publishing** leaves scoped-package access at the registry default, matching the supported GitHub Packages flow while retaining exact post-publication verification.
- **Recovery CI** uses portable workspace-relative bundle paths so manual registry recovery can start on GitHub-hosted runners without invalid job-level runner contexts.
- **Public adoption reporting** refreshes the generated README signals, detailed snapshot, and append-only history while keeping those numbers separate from active-user telemetry.

## Compatibility

- The package version is `0.5.54`; the desktop runtime remains Electron 44 and macOS 13 Ventura remains the minimum supported macOS version.
- macOS 12 Monterey users should remain on `0.5.51`.
- Existing CoWork data and profiles remain compatible with this patch release.

## Release validation

The release candidate should pass the repository gates before tagging or publishing:

```bash
npm run fmt:check
npm run type-check
npm run lint
npm run qa:docs-versions
npm run qa:approval-boundaries
npm run qa:harness
npm run build
npm run release:smoke
```

The release workflow additionally validates the exact registry bundle, clean npm installation, Electron native loading, CLI entrypoints, GitHub Packages publication, and platform artifacts before promoting the GitHub release.
