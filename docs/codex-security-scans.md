# Codex Security Scans

CoWork OS ships a bundled **Codex Security** plugin pack for defensive repository security review. It adapts the Codex Security workflows into normal CoWork plugin-pack skills, slash commands, task timelines, approvals, workspace path rules, and packaged resources.

Access it from **Settings > Customize > Codex Security**, or invoke one of its slash commands in the composer:

```text
/codex-security:security-scan Run a security scan on this repository
/codex-security:security-diff-scan Review this branch diff for security regressions
/codex-security:deep-security-scan Run a deep repository-wide security scan
```

The pack is bundled at:

```text
resources/plugin-packs/codex-security/
```

Packaged desktop/server builds include the whole pack under Electron resources as `plugin-packs/codex-security`.

## Scan Modes

| Mode | Skill | Scope |
|------|-------|-------|
| Repository scan | `codex-security:security-scan` | Repository-wide or scoped-path scan |
| Diff scan | `codex-security:security-diff-scan` | Git revision, branch, commit, staged, or unstaged diff review |
| Deep scan | `codex-security:deep-security-scan` | Repository-wide multi-pass scan with six independent discovery workers per round |

The top-level skills preserve the upstream Codex Security phase model:

1. Resolve scan target and artifact paths.
2. Generate deterministic worklists.
3. Build or reuse threat model context.
4. Run finding discovery.
5. Deduplicate candidate findings.
6. Validate plausible findings.
7. Run attack-path analysis where needed.
8. Render the final report.

Deep scans repeat the variance-sensitive discovery phase before centralized validation and final reporting.

## Bundled Skills

The pack uses directory-backed skills via `skillDirectories` in `cowork.plugin.json`.

| Skill ID | Purpose |
|----------|---------|
| `codex-security:security-scan` | Repository-wide or scoped-path security scan entrypoint |
| `codex-security:security-diff-scan` | Security review for Git diffs |
| `codex-security:deep-security-scan` | Exhaustive repository-wide multi-pass scan |
| `codex-security:threat-model` | Threat modeling phase |
| `codex-security:finding-discovery` | Candidate discovery phase |
| `codex-security:validation` | Finding validation phase |
| `codex-security:attack-path-analysis` | Attack-path and severity analysis |
| `codex-security:fix-finding` | Fix and verify a validated or plausible finding |

Directory-backed skills read `SKILL.md` and relative `references/`, `scripts/`, `assets/`, and `agents/` files from their pack directory. CoWork uses the manifest definition first, then `SKILL.md` frontmatter, then a title generated from the skill ID for display metadata.

## Orchestration Tools

CoWork exposes a small set of internal helper tools only while a task is recognized as a Codex Security scan task:

| Tool | Purpose |
|------|---------|
| `security_scan_prepare` | Create a scan directory, generate `rank_input.csv`, and copy it to `deep_review_input.csv` |
| `security_scan_create_worker_dirs` | Create the six standard worker directories for a deep discovery round |
| `security_scan_check_worker_artifacts` | Verify required worker files and JSONL parse validity |
| `security_scan_merge_deep_round` | Merge deterministic deep-scan candidate inventories after all six workers finish |
| `security_scan_validate_report` | Run the bundled report validator and render `report.html` |

These tools are not general-purpose file tools. They are hidden from normal tasks and their handlers reject calls outside Codex Security scan tasks.

## Artifact Layout

`security_scan_prepare` writes artifacts under the active workspace by default:

```text
<repo>/.cowork/security-scans/<repo-name>/<scan-id>/
├── artifacts/
│   ├── 01_context/
│   ├── 02_discovery/
│   │   ├── rank_input.csv
│   │   └── deep_review_input.csv
│   ├── 03_coverage/
│   ├── 04_reconciliation/
│   ├── 05_findings/
│   └── deep_discovery/
├── report.md
└── report.html
```

Deep-scan rounds add worker directories:

```text
artifacts/deep_discovery/round-01/
├── worker-01/
├── worker-02/
├── worker-03/
├── worker-04/
├── worker-05/
└── worker-06/
```

Every deep-scan worker must produce:

```text
threat_model.md
finding_discovery_report.md
seed_research.md
work_ledger.jsonl
raw_candidates.jsonl
dedupe_report.md
deduped_candidates.jsonl
repository_coverage_ledger.md
```

The JSONL files are parsed before a worker is considered usable. Malformed JSONL makes that worker unusable for the round merge.

## Deep Scan Merge Rules

Deep Security Scan requires exactly six usable workers per completed round. A round is not mergeable if:

- fewer or more than six `worker-*` directories exist
- any worker is missing a required artifact
- any worker has malformed JSONL in `work_ledger.jsonl`, `raw_candidates.jsonl`, or `deduped_candidates.jsonl`

The deterministic merge writes:

```text
artifacts/deep_merge/round-XX_candidate_inventory.jsonl
artifacts/deep_merge/round-XX_candidate_inventory.md
artifacts/deep_merge/canonical_candidate_inventory.jsonl
```

The merge uses exact candidate keys as a bookkeeping aid only. The Codex Security skill still performs semantic remediation-subsumption merging before final validation and reporting.

## Workspace Safety

Security scan helpers are workspace-scoped:

- `repo_root`, `artifact_root`, `scan_dir`, and `worker_dir` must resolve inside the active workspace.
- `artifact_root` defaults to `.cowork/security-scans/<repo-name>` inside the target repository.
- `scan_id` may contain only letters, numbers, dot, underscore, or dash.
- `scope` for scoped-path scans must be a relative path inside the repository.
- Deep scans are repository-wide only. Use repository or scoped-path mode for narrower scans.
- The helper tools do not run for non-Codex-Security tasks even if a model tries to call them by name.

Imported third-party packs still use the normal imported-capability security gate. The bundled Codex Security pack is treated as first-party bundled content, packaged with the app, and loaded through normal plugin-pack discovery.

## Validation Commands

Use these focused checks after changing Codex Security scan orchestration, the bundled pack manifest, directory-backed skill loading, or scan tool gating:

```bash
npx vitest run src/electron/security-scans/__tests__/SecurityScanOrchestrator.test.ts src/electron/agent/tools/__tests__/registry-tool-catalog.test.ts src/electron/extensions/__tests__/codex-security-plugin-pack-manifest.test.ts
npm run build:electron
```

When changing skill content under `resources/plugin-packs/codex-security/skills/`, also run:

```bash
npm run skills:check:core
npm run skills:check
```

## Implementation Landmarks

| Area | Files |
|------|-------|
| Bundled pack | `resources/plugin-packs/codex-security/` |
| Scan orchestration | `src/electron/security-scans/SecurityScanOrchestrator.ts` |
| Tool definitions and handlers | `src/electron/agent/tools/registry.ts` |
| Task-level tool gating | `src/electron/agent/executor.ts` |
| Directory-backed pack skills | `src/electron/extensions/registry.ts`, `src/electron/extensions/types.ts` |
| Pack discovery/loading | `src/electron/extensions/loader.ts`, `src/electron/ipc/plugin-pack-handlers.ts` |
| Packaged resource inclusion | `package.json` `build.extraResources` |

If this feature changes, update this guide, [Plugin Packs](plugin-packs.md), [Security Guide](security-guide.md), and [Development](development.md) in the same PR.
