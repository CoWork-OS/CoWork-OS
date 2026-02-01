#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const packageDir = path.resolve(__dirname, '..');
const electronPath = require.resolve('electron');
const mainPath = path.join(packageDir, 'dist', 'electron', 'electron', 'main.js');

// Check if the app has been built
if (!fs.existsSync(mainPath)) {
  console.log('CoWork-OSS: Building application...');
  const build = spawn('npm', ['run', 'build'], {
    cwd: packageDir,
    stdio: 'inherit',
    shell: true
  });

  build.on('close', (code) => {
    if (code === 0) {
      launchApp();
    } else {
      console.error('Build failed. Please run "npm run build" manually.');
      process.exit(1);
    }
  });
} else {
  launchApp();
}

function launchApp() {
  const electron = spawn(electronPath, [mainPath], {
    cwd: packageDir,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });

  electron.on('close', (code) => {
    process.exit(code);
  });
}
