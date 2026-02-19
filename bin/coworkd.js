#!/usr/bin/env node

/**
 * coworkd: Headless daemon entrypoint.
 *
 * Defaults:
 * - headless (no UI)
 * - Control Plane enabled
 * - import env settings (so Linux deployments can configure providers via env vars)
 *
 * This keeps Linux/VPS docs and systemd units simple and avoids any dependency on a macOS GUI.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function probeBetterSqlite3ForElectron(electronPath, packageDir) {
  try {
    // Require alone may not load the native binding; open an in-memory DB to force dlopen.
    // Use ELECTRON_RUN_AS_NODE env var (not --runAsNode flag) so the binary runs as Node.
    await run(
      electronPath,
      ['-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();"],
      { cwd: packageDir, stdio: 'ignore', shell: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const packageDir = path.resolve(__dirname, '..');
  const electronPath = require('electron');
  const mainPath = path.join(packageDir, 'dist', 'electron', 'electron', 'main.js');

  const argv = process.argv.slice(2);
  if (hasFlag(argv, '-h') || hasFlag(argv, '--help')) {
    // eslint-disable-next-line no-console
    console.log([
      'CoWork OS daemon (headless)',
      '',
      'Usage:',
      '  node bin/coworkd.js [electronArgs...]',
      '',
      'Defaults (can be overridden by passing flags explicitly):',
      '  --headless',
      '  --enable-control-plane',
      '  --import-env-settings',
      '  --user-data-dir <path>',
      '',
      'Common env vars:',
      '  COWORK_USER_DATA_DIR=/var/lib/cowork-os',
      '  COWORK_CONTROL_PLANE_HOST=127.0.0.1',
      '  COWORK_CONTROL_PLANE_PORT=18789',
      '  COWORK_LLM_PROVIDER=openai',
      '  OPENAI_API_KEY=...',
      '',
      'Examples:',
      '  node bin/coworkd.js --print-control-plane-token',
    ].join('\n'));
    return;
  }

  // If the app hasn't been built (source install), build the Electron main process and connectors.
  if (!fs.existsSync(mainPath)) {
    // eslint-disable-next-line no-console
    console.log('CoWork OS: Building (electron + connectors)...');
    try {
      await run('npm', ['run', 'build:electron'], { cwd: packageDir, stdio: 'inherit', shell: true });
      await run('npm', ['run', 'build:connectors'], { cwd: packageDir, stdio: 'inherit', shell: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Build failed. Run "npm run build:electron && npm run build:connectors" manually.');
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
  }

  // Electron runtime needs better-sqlite3 rebuilt for Electron's ABI (postinstall typically does this,
  // but a Node-only daemon run may have rebuilt it back to Node).
  const ok = await probeBetterSqlite3ForElectron(electronPath, packageDir);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('CoWork OS: Rebuilding native deps for Electron (better-sqlite3)...');
    try {
      await run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], { cwd: packageDir, stdio: 'inherit', shell: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to rebuild better-sqlite3 for Electron. Ensure build tools are installed.');
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    }
  }

  const defaultArgs = ['--headless', '--enable-control-plane', '--import-env-settings'];
  const args = [...defaultArgs, ...argv];

  // Strip ELECTRON_RUN_AS_NODE so Electron starts as a full app process.
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronPath, [mainPath, ...args], {
    cwd: packageDir,
    stdio: 'inherit',
    env,
  });

  electron.on('close', (code) => {
    // eslint-disable-next-line no-process-exit
    process.exit(code);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
