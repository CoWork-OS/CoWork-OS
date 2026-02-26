#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageDir, 'package.json');
const mainPath = path.join(packageDir, 'dist', 'electron', 'electron', 'main.js');
const rendererIndexPath = path.join(packageDir, 'dist', 'renderer', 'index.html');
const args = process.argv.slice(2);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function mapSignalToCode(signal) {
  if (signal === 'SIGKILL') return 137;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGINT') return 130;
  return 1;
}

function buildAppAndLaunch() {
  console.log('[cowork-os] Build artifacts not found, running npm run build...');
  const build = spawn(npmCmd, ['run', 'build'], {
    cwd: packageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  build.on('exit', (code) => {
    if (code !== 0) {
      console.error(
        '[cowork-os] Build failed. The installed package may be incomplete. ' +
        'Reinstall the latest release or run `npm run build` from source.'
      );
      process.exit(code || 1);
    }
    launchApp();
  });
}

if (fs.existsSync(mainPath) && fs.existsSync(rendererIndexPath)) {
  prepareAndLaunchApp();
} else {
  if (!fs.existsSync(mainPath)) {
    console.log('[cowork-os] Main process build artifacts are missing.');
  }
  if (!fs.existsSync(rendererIndexPath)) {
    console.log('[cowork-os] Renderer build artifacts are missing.');
  }
  buildAppAndLaunch();
}

function listMissingRuntimeDeps() {
  if (!fs.existsSync(packageJsonPath)) return [];

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return [];
  }

  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object'
    ? pkg.dependencies
    : {};

  const missing = [];
  for (const dep of Object.keys(deps)) {
    if (dep.startsWith('@types/')) continue;
    try {
      require.resolve(dep, { paths: [packageDir] });
    } catch {
      missing.push({ name: dep, version: deps[dep] });
    }
  }

  return missing;
}

function ensureRuntimeDeps() {
  const missing = listMissingRuntimeDeps();
  if (missing.length === 0) return true;

  const installArgs = [
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--omit=dev',
    '--package-lock=false',
    ...missing.map((dep) => `${dep.name}@${dep.version}`)
  ];

  console.log(
    `[cowork-os] Missing runtime dependencies detected (${missing.length}); repairing install...`
  );
  const res = spawnSync(npmCmd, installArgs, {
    cwd: packageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  return res.status === 0;
}

function resolveElectronBinary() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

function isBetterSqliteReady(electronBinary) {
  const probe = spawnSync(
    electronBinary,
    [
      '-e',
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close();process.stdout.write('ok')",
    ],
    {
      cwd: packageDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      encoding: 'utf8',
    }
  );

  return probe.status === 0;
}

function runNativeSetup(onDone) {
  const setupScript = path.join(packageDir, 'scripts', 'setup_native.mjs');
  const retryScript = path.join(packageDir, 'scripts', 'setup_native_retry.sh');
  if (!fs.existsSync(setupScript)) {
    console.error('[cowork-os] Missing native setup script at scripts/setup_native.mjs');
    process.exit(1);
  }

  console.log('[cowork-os] Preparing native modules for Electron (first run)...');
  const setupCommand = fs.existsSync(retryScript)
    ? (process.platform === 'win32' ? process.execPath : 'sh')
    : process.execPath;
  const setupArgs = fs.existsSync(retryScript)
    ? (process.platform === 'win32' ? [setupScript] : [retryScript])
    : [setupScript];
  const setup = spawn(setupCommand, setupArgs, {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env,
  });

  setup.on('exit', (code, signal) => {
    if (signal) {
      const exitCode = mapSignalToCode(signal);
      console.error(
        `[cowork-os] Native setup was terminated (${signal}).` +
          (signal === 'SIGKILL'
            ? ' Close other memory-heavy apps and rerun `npm run setup`.'
            : '')
      );
      process.exit(exitCode);
      return;
    }
    if (code !== 0) {
      process.exit(code || 1);
      return;
    }
    onDone();
  });
}

function prepareAndLaunchApp() {
  if (!ensureRuntimeDeps()) {
    console.error('[cowork-os] Failed to repair runtime dependencies.');
    process.exit(1);
  }

  const launchAfterSetup = () => {
    const electronBinary = resolveElectronBinary();
    if (!electronBinary) {
      console.error(
        '[cowork-os] Electron runtime is still missing after setup. Reinstall with:\n' +
          '  npm install --ignore-scripts --omit=optional --no-audit --no-fund cowork-os@latest\n'
      );
      process.exit(1);
    }
    if (isBetterSqliteReady(electronBinary)) {
      launchApp(electronBinary);
      return;
    }
    runNativeSetup(() => launchAfterSetup());
  };

  let electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    console.log('[cowork-os] Electron runtime is missing. Running setup...');
    runNativeSetup(() => launchAfterSetup());
    return;
  }

  if (isBetterSqliteReady(electronBinary)) {
    launchApp(electronBinary);
    return;
  }

  runNativeSetup(() => launchApp(electronBinary));
}

function launchApp(electronBinary) {
  // Strip ELECTRON_RUN_AS_NODE so Electron starts as a full GUI/app process,
  // not as plain Node.js.  This env var can leak from parent processes
  // (e.g. VS Code terminals, other Electron-based tools).
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBinary, [packageDir, ...args], {
    cwd: packageDir,
    stdio: 'inherit',
    env,
  });

  electron.on('exit', (code, signal) => {
    if (signal) {
      process.exit(mapSignalToCode(signal));
      return;
    }
    process.exit(code || 0);
  });
}
