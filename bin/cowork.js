#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageDir, 'package.json');
const mainPath = path.join(packageDir, 'dist', 'electron', 'electron', 'main.js');
const args = process.argv.slice(2);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function buildAppAndLaunch() {
  console.log('[cowork-os] Build artifacts not found, running npm run build...');
  const build = spawn(npmCmd, ['run', 'build'], {
    cwd: packageDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  build.on('exit', (code) => {
    if (code !== 0) {
      console.error('[cowork-os] Build failed. Run `npm run build` and retry.');
      process.exit(code || 1);
    }
    launchApp();
  });
}

if (fs.existsSync(mainPath)) {
  prepareAndLaunchApp();
} else {
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
      process.kill(process.pid, signal);
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

  const electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    console.error(
      '[cowork-os] Electron runtime is missing. Reinstall with:\n' +
      '  npm install cowork-os@latest\n'
    );
    process.exit(1);
  }

  if (isBetterSqliteReady(electronBinary)) {
    launchApp(electronBinary);
    return;
  }

  runNativeSetup(() => launchApp(electronBinary));
}

function launchApp(electronBinary) {
  const electron = spawn(electronBinary, [packageDir, ...args], {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env
  });

  electron.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}
