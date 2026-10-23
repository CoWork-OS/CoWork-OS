# Keeping release documentation current

Use the [latest stable release](https://github.com/CoWork-OS/CoWork-OS/releases/latest)
link in installation and support guidance whenever a specific version is unnecessary.
The canonical security support policy lives in [SECURITY.md](../SECURITY.md).
Link to that policy from other guides rather than maintaining another version table.

Run `npm run qa:docs-versions` when changing documentation or release metadata.
CI, the release gate, and `npm run build` run this check automatically. Run
`node --test scripts/qa/validate-doc-versions.test.mjs` when changing the validator.

Navigation and primary work-choice labels are captured in
`docs/release-surfaces/<version>.json`. When cutting a release, copy the
development manifest to a versioned stable manifest and verify every path
against that release tag. Update `docs/release-surfaces/unreleased.json` for the
new development UI, then run `npm run docs:surfaces:generate`. The generated
`docs/release-surface-reference.md` is checked by `npm run qa:docs-versions`.

The check scans Markdown files throughout the checkout, including new unignored
files. It rejects numeric versions under supported-version/release policy headings
and explicit “current version” or “latest release” claims that disagree with
`package.json`. Prefer rolling links: even a matching numeric claim will need an
update at the next version bump.

Changelogs, `docs/release-notes-*.md`, and the dated generated
`docs/public-adoption-stats.md` snapshot retain historical versions. Compatibility
minimums and fenced code examples are also allowed. Do not exempt living support
guides as historical records. Add regression fixtures when introducing another
format for release claims; this check cannot assess every natural-language claim
or verify whether registry publication has completed.

## Implementation status claims

A roadmap phase, feature table row or doc section may say “Implemented” only
when a regression test or replay fixture that proves it is named in that
document's Verification section (or next to the claim). Until then, call it
“Planned” and keep any design text under an explicit “Target design — not yet
implemented” banner. Do not link to sections that do not exist yet; link once the
section ships.

## Documentation site ownership

This checkout maintains the Markdown sources and retained VitePress navigation/configuration
in `docs/.vitepress/config.mts`. The application package does not declare a local VitePress
build command or dependency; its CI checks documentation versions and source contracts.
`npm run build` builds application artifacts, not a documentation website.

On `main`, `.github/workflows/notify-website-docs.yml` requests a docs refresh in the separate
`CoWork-OS/cowork-os-web` repository. That dispatch requires
`WEBSITE_REPO_DISPATCH_TOKEN`; when absent, the workflow reports that refresh was skipped.
Website deployment and its dependency/toolchain checks belong to that repository. A passing
local application build does not verify the published site's pages or anchors.
