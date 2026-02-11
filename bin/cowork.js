#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageDir = path.resolve(__dirname, '..');
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
  launchApp();
} else {
  buildAppAndLaunch();
}

function launchApp() {
  let electronBinary;
  try {
    electronBinary = require('electron');
  } catch {
    console.error(
      '[cowork-os] Electron runtime is missing. Reinstall with:\n' +
      '  npm install cowork-os@latest --include=dev\n'
    );
    process.exit(1);
  }

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
