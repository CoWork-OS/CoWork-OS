# Contributing to CoWork OS

Thanks for helping. This page says what we want most, how to avoid duplicate work, and what a mergeable pull request looks like. Setup details live in the [Development Guide](development.md). Please follow the [Code of Conduct](../CODE_OF_CONDUCT.md).

## What we want, in priority order

1. **Bug fixes.** Crashes, wrong results, data loss, broken flows. A failing test plus the fix is the best possible PR.
2. **Cross-platform work.** Windows parity, Intel Mac support, Linux packaging. Most maintainers use Apple Silicon Macs, so reports and fixes from other systems are especially valuable.
3. **Security hardening.** Access-profile gaps, approval bypasses, credential handling, sandbox escapes. Report vulnerabilities privately first; see [SECURITY.md](../SECURITY.md).
4. **Robustness.** Better recovery from provider errors, timeouts, flaky tests, migrations that survive upgrades.
5. **Broadly useful skills.** A skill that helps many people with a common task (see "Skill or tool?" below).
6. **Documentation.** Fix what confused you; you are the best judge of what is missing.
7. **New tools.** Rarely. Prefer a skill unless the work needs new capabilities in the app itself.

Good starting points are labeled [`good first issue`](https://github.com/CoWork-OS/CoWork-OS/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) and [`help wanted`](https://github.com/CoWork-OS/CoWork-OS/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22). Comment on the issue to claim it.

## Search first

Before you open an issue or start coding:

- Search [open and closed issues](https://github.com/CoWork-OS/CoWork-OS/issues?q=is%3Aissue) and [pull requests](https://github.com/CoWork-OS/CoWork-OS/pulls?q=is%3Apr).
- Search [Discussions](https://github.com/CoWork-OS/CoWork-OS/discussions) for questions and design ideas, or ask in #contributors on [Discord](https://discord.gg/UjykKwjhRC).
- For anything larger than a bug fix, open an issue or Discussion describing the change before writing it, so we can agree on the approach. We reply to new issues within a day.

## Skill or tool?

CoWork OS has two extension points. Pick the smaller one that works.

| | Skill | Tool |
| --- | --- | --- |
| What it is | Instructions and optional scripts in a `SKILL.md` folder | A TypeScript class the agent calls directly |
| Where | `resources/skills/<name>/` | `src/electron/agent/tools/<name>-tools.ts`, registered in `tools/registry.ts` |
| Use when | The model can already do the work with existing tools and needs know-how, a workflow, or a template | The work needs a new capability: a new API, OS integration, file format, or permission boundary |
| Review cost | Low | High: security review of the tool policy, approvals and file access |

Skills must pass `npm run skills:check`. New tools must explain in their description **when** to use them, go through the tool policy in `src/electron/security/`, and never bypass approval checks.

## Development setup

You need Node.js 24 or later, npm 10 or later, Git, and macOS or Windows for the desktop app.

```bash
git clone https://github.com/YOUR_USERNAME/CoWork-OS.git
cd CoWork-OS
npm run setup      # dependencies, native modules, git hooks with a gitleaks secret scan
npm run dev        # Electron app and renderer with hot reload
```

Install [gitleaks](https://github.com/gitleaks/gitleaks#installing) so the pre-commit secret scan can run. More commands, debugging and the project layout are in the [Development Guide](development.md).

## Making a pull request

1. Branch from `main` with a descriptive name, for example `fix/approval-card-timeout` or `docs/windows-install`.
2. Keep the change focused. One fix or feature per PR; unrelated formatting changes make review harder.
3. Add or update tests next to the code, in a `__tests__/` folder.
4. Run the checks for what you touched. `npm run type-check` alone is not enough: the Electron build uses a stricter config.

   ```bash
   npm run build:electron   # main process
   npm run build:react      # renderer
   npm run type-check
   npm run lint
   npm run test             # runs skills:check first
   ```

5. Open the PR using the template. Link the issue, say how you tested it (untested, lightly tested, fully tested), and add screenshots for UI changes.
6. Expect a first review within a few days. We may push small fixes to your branch to get it merged.

## Code conventions

- TypeScript strict mode. No unused imports, no implicit `any`, no `console.log` (use the logger module).
- Shared types live in `src/shared/types.ts`. IPC channel names come from constants in `src/shared/`, and main-process handlers validate every input from the renderer.
- Credentials go through Electron `safeStorage`. Never write secrets to SQLite, logs or test fixtures.
- File access on user-supplied paths goes through `checkProjectAccess` in `src/electron/security/project-access.ts`.
- Format only the lines you changed (`npx oxfmt <file>` on new files); do not reformat whole existing files.
- UI changes should match the existing quiet, monochrome style. Sidebar notices go through `src/renderer/components/sidebar/SidebarNotices.tsx`.

## Commit messages

Use conventional commits: `type(scope): description`, where type is `feat`, `fix`, `docs`, `refactor`, `test`, `perf` or `chore`. For example `fix(gateway): retry Telegram polling after a network drop`.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/CoWork-OS/CoWork-OS/issues/new/choose). For bugs, include steps to reproduce, expected and actual behavior, your OS and CoWork OS version, and relevant logs with secrets removed. For features, describe the problem you are trying to solve before the solution you have in mind.

## Questions

Ask in [Discussions](https://github.com/CoWork-OS/CoWork-OS/discussions), or chat in #contributors on [Discord](https://discord.gg/UjykKwjhRC). Maintainer release steps are in the [Development Guide](development.md#releasing-maintainers).
