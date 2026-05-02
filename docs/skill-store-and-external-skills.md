# Skill Store & External Skills

CoWork OS supports both its own curated skill surfaces and external skill sources.

This is an important capability because it means users are not limited to bundled skills or CoWork-managed packs. They can install third-party skills directly from ClawHub, import skill bundles from Git repositories, and bring in raw manifests or `SKILL.md` bundles from other ecosystems without leaving the desktop app.

## What CoWork OS Supports

There are two different concepts in the product:

1. **Plugin Packs**
   Packs bundle skills, agent roles, connectors, slash commands, and metadata.
   These are managed through the Customize panel and Plugin Store.

2. **Skill Store / external skills**
   These are individual skills installed into the managed skills directory and surfaced in the Skills settings area.
   This is the capability documented here.

Bundled skills such as [`manim-video`](skills/manim-video.md) and [`kami`](skills/kami.md) do not need installation from the Skill Store. They ship with the app and are available immediately.

## Supported Skill Sources

### 1. CoWork Registry

The Skills settings page includes the **CoWork Registry** tab for curated skills distributed through CoWork’s own registry flow.

Use this when:
- You want the built-in, curated catalog.
- You want skills presented in CoWork’s native registry format.

### 2. ClawHub

CoWork OS has first-class ClawHub support in the GUI.

Supported ClawHub flows:
- Search ClawHub skills directly from the **ClawHub** tab.
- See the top 10 most-downloaded public ClawHub skills when the tab opens with an empty query.
- View live ClawHub stats in result cards:
  - stars
  - downloads
  - current installs
  - all-time installs
- Install directly from a search result card.
- Install by pasting a ClawHub page URL such as `https://clawhub.ai/owner/skill`.
- Import using a `clawhub:slug`-style identifier internally.

How ClawHub installs work:
- CoWork resolves the ClawHub skill metadata.
- It resolves a downloadable version.
- It downloads the skill ZIP bundle from ClawHub.
- It extracts `SKILL.md` and bundled support files such as `references/` and `scripts/`.
- It stages the bundle, scans it, and either installs it into CoWork’s managed skills directory or quarantines it with a stored report.

ClawHub installs are treated as managed skills after import, not as a separate runtime type.

### 3. Git Repositories

CoWork OS can install a skill from a Git repository through the external import field.

Supported Git-style inputs:
- `https://github.com/org/repo`
- `https://github.com/org/repo.git`
- `git@host:org/repo.git`
- `github:org/repo`

Repository support works when the repo contains either:
- a `SKILL.md` bundle, or
- a compatible JSON custom skill manifest

This is the main generic path for third-party skill stores that publish skills as Git repositories.

For multi-file bundles such as the upstream [Kami](https://github.com/tw93/Kami) repo, prefer the repository URL over a raw `SKILL.md` URL so bundled `scripts/`, `references/`, and asset files are imported together.

### 4. Raw JSON Skill Manifests

CoWork OS can import a raw skill manifest from a direct URL when the URL serves JSON.

Use this when an external store or repo exposes a single downloadable skill manifest file.

### 5. Raw `SKILL.md` Bundle Entry Points

CoWork OS can import a raw `SKILL.md` URL directly.

This is useful when:
- a skill is published as documentation-first bundle content
- the store exposes a raw `SKILL.md`
- you want to import a skill bundle without cloning a repository manually

This path is weaker for multi-file bundles because it stages the markdown entry point only. If a skill depends on support files, import the repository URL instead.

## “Other External Skill Stores”

CoWork OS does support other external skill stores, but usually through **generic import paths** rather than a first-class browse/search integration.

Today, first-class marketplace search/install exists for:
- CoWork Registry
- ClawHub

Other external stores are supported when they expose at least one of these install surfaces:
- a Git repository
- a raw JSON skill manifest URL
- a raw `SKILL.md` URL
- a stable page URL that CoWork knows how to translate into one of the above

So the practical rule is:

- **If the store behaves like a searchable marketplace, ClawHub is the first-class supported one right now.**
- **If the store exposes installable skill artifacts, CoWork can often import them through the generic external import box.**

## GUI Entry Points

This capability is intentionally available in the desktop GUI, not only through CLI-like flows.

Go to:

- **Settings → Skills → Skill Store**

From there, users can:
- browse the CoWork Registry
- browse ClawHub
- paste an external source into the import field
- install skills without leaving the desktop app

## Managed Skill Storage

Imported and installed external skills are stored in CoWork’s managed skills directory.

The managed install flow is now:
- stage the manifest and any bundled support files in a temp location
- run structural checks, content heuristics, and package-intelligence lookups where applicable
- install the skill as managed content if the result is clean or warning-only
- quarantine the import instead of activating it when the scan returns a blocking finding

Each managed import keeps a sidecar security report so CoWork can:
- show warning badges in the Skills UI
- keep a review trail for imported bundles
- detect if a managed import changes after install and re-quarantine it on the next load

## Optional External Skill Directories

CoWork OS can also load additional skill folders without importing them into the managed directory.

Use this when:
- your team already keeps shared skills in a Git checkout or synced folder
- you want CoWork to read those skills without taking ownership of the files

How it works:
- add one or more absolute directory paths in **Settings → Skills**
- CoWork loads matching skill manifests from those folders as **external** skills
- external skills are **read-only** in the app
- managed installs still go into CoWork’s managed skills directory

Precedence order:
- workspace skills
- managed skills
- external skill directories
- bundled skills

This means a local workspace override or a managed install can replace a shared external skill with the same ID.

Default locations:
- macOS: `~/Library/Application Support/cowork-os/skills/`
- Windows: `%APPDATA%\\cowork-os\\skills\\`

Each managed skill typically includes:
- a JSON manifest in the managed skills root
- an optional companion directory containing `SKILL.md`, `references/`, `scripts/`, and other bundled files

## Identity, Matching, and ClawHub Compatibility

CoWork preserves external skill identity carefully so installed skills can be recognized correctly in the UI.

For ClawHub specifically:
- the installed skill is tracked using the ClawHub page slug
- older ClawHub installs can also be recognized via their stored `homepage` or `repository` URL metadata

This matters because many external ecosystems have different internal names, display names, and bundle-level IDs. CoWork normalizes those enough to make the GUI install state reliable.

## What Users See After Install

After installation, external skills appear as managed skills in the Skills settings area.

They can then be:
- listed in the **Installed** tab
- checked for requirements and readiness
- uninstalled from the GUI
- surfaced to the runtime the same way as other managed skills
- shown with a **Security Warning** badge when the scan allowed install but flagged higher-risk capabilities or scan-service unavailability

ClawHub-originated skills are also labeled as **ClawHub** in the relevant UI surfaces.

If CoWork blocks an imported skill, it now appears in a **Quarantined Imports** section instead of the active installed list. From there, users can:
- view the stored scan findings
- retry the scan later
- remove the quarantined import entirely

## Runtime Behavior After Install

Installed external skills follow the same execution contract as bundled skills.

- they can be shortlisted proactively when their routing metadata matches the canonical task intent
- they can be invoked deterministically through slash/manual flows
- they can appear in the message box `/` picker when enabled and their skill ID is a valid slash token
- they can be targeted by plugin-pack `slashCommands` aliases when a pack maps a visible command token to the installed skill ID
- `use_skill` applies them as additive context and scoped runtime directives
- they do not replace the original task prompt

See [Skills Runtime Model](skills-runtime-model.md) for the runtime semantics after a skill is loaded and [Message Box Shortcuts](message-box-shortcuts.md) for picker and slash-alias behavior.

## Security and Trust Model

External skill support is powerful, but it is also a trust boundary.

CoWork treats external skills as imported content, not as implicitly trusted built-ins.

Important safeguards and behaviors:
- skill IDs are sanitized before installation
- imported bundles are staged and scanned before activation rather than executed in place from remote sources
- ClawHub ZIP extraction skips unsafe path traversal content
- Git imports require a valid repository and supported bundle shape
- imported skills are surfaced through the existing skill eligibility and managed-skill flows
- imported bundles with high-confidence malicious behavior are quarantined instead of being activated
- package references discovered in imported content can be checked against live package-malware intelligence
- temporary intelligence outages fail open with a visible warning rather than silently downgrading trust
- managed imports are rechecked by digest on load so post-install tampering can be quarantined automatically
- optional external skill directories remain loadable, but warning-only findings are surfaced in the status UI because CoWork does not take ownership of those files

This does **not** mean every third-party skill is safe by default.
Users should still treat external skills as untrusted until reviewed.

## Current Scope and Limits

Current scope:
- first-class GUI browse/search/install for ClawHub
- first-class GUI browse/search/install for CoWork Registry
- generic GUI import for Git, raw JSON, and raw `SKILL.md`

Current limits:
- only ClawHub has dedicated third-party marketplace browsing inside the GUI today
- other external skill stores do not yet have dedicated search adapters unless added explicitly
- compatibility depends on the store exposing installable skill artifacts in a format CoWork can import

## Why This Capability Matters

This gives CoWork OS an important ecosystem advantage:
- users can start with bundled skills
- bundled examples now include workflows such as `llm-wiki`, `kami`, `react-best-practices`, and `taste-skill`
- adopt curated CoWork registry skills
- pull in popular ClawHub skills directly from the app
- bring skills from other ecosystems without waiting for a custom marketplace integration

In practice, CoWork is not locked to a single skill source. It can act as a governed desktop runtime for skills that originate from multiple ecosystems.
