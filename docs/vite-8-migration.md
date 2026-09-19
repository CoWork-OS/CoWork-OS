# Vite 8 Renderer Toolchain Migration

This document records CoWork OS's renderer-toolchain migration from Vite 7.3.1 to Vite 8.3.0.
The migration is complete and intentionally does not move the desktop app to Electron Forge.

## Architecture boundary

CoWork uses separate build paths:

- The React renderer is bundled by Vite through `npm run build:react`.
- Electron main/preload code is compiled by TypeScript through `npm run build:electron`.
- The daemon, CLI, and connectors continue to use their existing TypeScript builds.
- Desktop installers continue to be produced by Electron Builder.

Vite 8 therefore upgrades the renderer bundler without changing the Electron runtime,
packaging system, IPC boundary, or native-module workflow. Electron Forge remains an
independent future evaluation rather than a prerequisite for this migration.

## Dependency versions

The manifest ranges and current lockfile resolution are:

| Package | Manifest range | Current resolution |
| --- | --- | --- |
| `vite` | `^8.3.0` | `8.3.0` |
| `@vitejs/plugin-react` | `^6.1.1` | `6.1.1` |
| `vitest` | `^4.1.10` | `4.1.11` |
| `@vitest/coverage-v8` | `^4.1.10` | `4.1.11` |
| `react-is` | `^19.3.0` | `19.3.0` |
| `esbuild` | `^0.28.2` | `0.28.2` |

Keep `package-lock.json` synchronized with `package.json`. Use the repository's normal
Node.js 24+ setup before installing or rebuilding native dependencies.

## Migration changes

### Renderer configuration

The existing renderer contract is preserved in [`vite.config.ts`](../vite.config.ts):

- root: `src/renderer`
- base URL: `./` for packaged Electron loading
- output: `dist/renderer`
- public assets: `src/renderer/public`
- aliases: `@` and `@shared`
- development server: `127.0.0.1` with strict port selection

The contract is covered by [`src/renderer/__tests__/vite-config.test.ts`](../src/renderer/__tests__/vite-config.test.ts).

### Explicit runtime dependencies

Two dependencies are intentionally direct rather than relying on transitive packages:

- `react-is` is required by the Recharts dependency graph. Vite 8/Rolldown resolves the
  import strictly enough that the renderer build must be able to resolve it from the
  project dependency tree.
- `esbuild` is used directly by existing build/test helpers. Vite 8 no longer provides
  a suitable transitive installation for those imports, so the project declares it
  explicitly as a development dependency.

## Validation checklist

Run the focused checks first:

```bash
npm run build:react
npm run build:electron
npm run type-check
npx vitest run \
  src/renderer/__tests__/vite-config.test.ts \
  src/electron/agent/__tests__/executor-step-failures.test.ts \
  src/electron/memory/__tests__/TranscriptStore.test.ts
```

For dependency-resolution validation, use:

```bash
npm ci --dry-run --ignore-scripts --no-audit --no-fund
npm ls vite @vitejs/plugin-react vitest @vitest/coverage-v8 esbuild react-is --depth=0
```

The full repository gates remain useful after the focused checks:

```bash
npm run lint
npm run fmt:check
npm test
```

For a macOS packaging check on an unsigned local build:

```bash
npm run package:mac:unsigned
npm run package:mac:smoke -- --allow-unsigned
```

Packaging smoke failures involving missing persona-template resources are packaging
manifest issues and should be investigated in Electron Builder `extraResources`; they
are not evidence of a Vite renderer failure.

## Known Vite 8 behavior

Vite 8 may report a non-fatal config-loader warning because the repository's
`vite.config.ts` and `vitest.config.ts` use ESM syntax while being loaded as CommonJS.
If a future Vite release makes the native config loader stricter, evaluate renaming the
files to `.mts` or setting the appropriate package module mode as a separate change.

Vite 8 also reports large-chunk warnings for existing renderer bundles. These are bundle
budget/code-splitting follow-ups, not migration blockers.

## Upstream references

- [Vite 8 announcement](https://vite.dev/blog/announcing-vite8)
- [Vite migration guide](https://vite.dev/guide/migration)
