# Keeping release documentation current

Use the [latest stable release](https://github.com/CoWork-OS/CoWork-OS/releases/latest)
link in installation and support guidance whenever a specific version is unnecessary.
The canonical security support policy lives in [SECURITY.md](../SECURITY.md).
Link to that policy from other guides rather than maintaining another version table.

Run `npm run qa:docs-versions` when changing documentation or release metadata.
CI, the release gate, and `npm run build` run this check automatically. Run
`node --test scripts/qa/validate-doc-versions.test.mjs` when changing the validator.

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
