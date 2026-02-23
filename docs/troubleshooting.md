# Troubleshooting

## macOS app won't launch (unsigned build)

CoWork OS is currently distributed as an unsigned build. On first launch, use **System Settings > Privacy & Security > Open Anyway** once.

Terminal fallback:

```bash
xattr -dr com.apple.quarantine "/Applications/CoWork OS.app"
```

If the app closes immediately with a `dyld` signature error:

```bash
codesign --force --deep --sign - "/Applications/CoWork OS.app"
```

> `spctl --add` / `spctl --enable` are deprecated on newer macOS and may show "This operation is no longer supported".

## npm install fails with SIGKILL

If install fails with `SIGKILL` during `node_modules/electron/install.js`, use a two-step install:

```bash
npm install --ignore-scripts cowork-os@latest --no-audit --no-fund
npm run setup
```

For local package testing, use the same `--ignore-scripts` flow with the tarball:

```bash
npm init -y
npm install --ignore-scripts /path/to/cowork-os-<version>.tgz
```

## macOS "Killed: 9" during setup

If you see `Killed: 9` during `npm run setup`, macOS terminated a native build due to memory pressure.

`npm run setup` already retries native setup automatically with backoff. Let it continue until it exits. If it still exits non-zero, close heavy apps and run the same command again:

```bash
npm run setup
```

## App shows "vUnknown" or remote method error

If the app opens but shows `vUnknown` or `Error invoking remote method 'app:getVersion'`, you likely connected to an older already-running instance.

```bash
pkill -f '/cowork-os' || true
cowork-os
```

## VPS: "tsc: not found"

If you see `sh: 1: tsc: not found` right after `npx coworkd-node`, you are on an older broken npm publish. Upgrade and retry:

```bash
npm install cowork-os@latest --no-audit --no-fund
```
