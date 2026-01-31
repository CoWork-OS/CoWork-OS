/**
 * Gmail Watcher Service
 *
 * Automatically starts Gmail watch when the app starts,
 * if hooks.gmail is configured with an account.
 *
 * This requires 'gog' (gogcli) to be installed and configured.
 * See: https://gogcli.sh/
 */

import { type ChildProcess, spawn } from 'child_process';
import { HooksConfig, GmailHookRuntimeConfig } from './types';
import { HooksSettingsManager } from './settings';
import { runCommand, checkBinaryExists } from '../utils/process';

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

let watcherProcess: ChildProcess | null = null;
let renewInterval: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;
let currentConfig: GmailHookRuntimeConfig | null = null;

export interface GmailWatcherStartResult {
  started: boolean;
  reason?: string;
}

/**
 * Check if gog binary is available
 */
export async function isGogAvailable(): Promise<boolean> {
  return checkBinaryExists('gog');
}

/**
 * Resolve Gmail runtime configuration from hooks config
 */
export function resolveGmailRuntimeConfig(
  config: HooksConfig,
): { ok: true; value: GmailHookRuntimeConfig } | { ok: false; error: string } {
  const hooks = config;
  const gmail = hooks.gmail;

  const hookToken = hooks.token?.trim();
  if (!hookToken) {
    return { ok: false, error: 'hooks.token missing (needed for gmail hook)' };
  }

  const account = gmail?.account?.trim();
  if (!account) {
    return { ok: false, error: 'gmail account required' };
  }

  const topic = gmail?.topic?.trim();
  if (!topic) {
    return { ok: false, error: 'gmail topic required' };
  }

  const pushToken = gmail?.pushToken?.trim();
  if (!pushToken) {
    return { ok: false, error: 'gmail push token required' };
  }

  const subscription = gmail?.subscription || 'cowork-gmail-watch-push';
  const label = gmail?.label || 'INBOX';
  const hookUrl = gmail?.hookUrl || 'http://127.0.0.1:9877/hooks/gmail';
  const includeBody = gmail?.includeBody ?? true;
  const maxBytes = gmail?.maxBytes || 20_000;
  const renewEveryMinutes = gmail?.renewEveryMinutes || 12 * 60;

  const serveBind = gmail?.serve?.bind || '127.0.0.1';
  const servePort = gmail?.serve?.port || 8788;
  const servePath = gmail?.serve?.path || '/gmail-pubsub';

  const tailscaleMode = gmail?.tailscale?.mode || 'off';
  const tailscalePath = gmail?.tailscale?.path || servePath;
  const tailscaleTarget = gmail?.tailscale?.target;

  return {
    ok: true,
    value: {
      account,
      label,
      topic,
      subscription,
      pushToken,
      hookToken,
      hookUrl,
      includeBody,
      maxBytes,
      renewEveryMinutes,
      serve: {
        bind: serveBind,
        port: servePort,
        path: servePath,
      },
      tailscale: {
        mode: tailscaleMode,
        path: tailscalePath,
        target: tailscaleTarget,
      },
    },
  };
}

/**
 * Build gog watch start arguments
 */
function buildWatchStartArgs(
  cfg: Pick<GmailHookRuntimeConfig, 'account' | 'label' | 'topic'>,
): string[] {
  return [
    'gmail',
    'watch',
    'start',
    '--account',
    cfg.account,
    '--label',
    cfg.label,
    '--topic',
    cfg.topic,
  ];
}

/**
 * Build gog watch serve arguments
 */
function buildWatchServeArgs(cfg: GmailHookRuntimeConfig): string[] {
  const args = [
    'gmail',
    'watch',
    'serve',
    '--account',
    cfg.account,
    '--bind',
    cfg.serve.bind,
    '--port',
    String(cfg.serve.port),
    '--path',
    cfg.serve.path,
    '--token',
    cfg.pushToken,
    '--hook-url',
    cfg.hookUrl,
    '--hook-token',
    cfg.hookToken,
  ];

  if (cfg.includeBody) {
    args.push('--include-body');
  }

  if (cfg.maxBytes > 0) {
    args.push('--max-bytes', String(cfg.maxBytes));
  }

  return args;
}

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, 'account' | 'label' | 'topic'>,
): Promise<boolean> {
  const args = buildWatchStartArgs(cfg);
  console.log(`[GmailWatcher] Starting watch: gog ${args.join(' ')}`);

  try {
    const result = await runCommand('gog', args, { timeoutMs: 120_000 });
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || 'gog watch start failed';
      console.error(`[GmailWatcher] Watch start failed: ${message}`);
      return false;
    }
    console.log(`[GmailWatcher] Watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    console.error(`[GmailWatcher] Watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process
 */
function spawnGogServe(cfg: GmailHookRuntimeConfig): ChildProcess {
  const args = buildWatchServeArgs(cfg);
  console.log(`[GmailWatcher] Starting serve: gog ${args.join(' ')}`);

  let addressInUse = false;

  const child = spawn('gog', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[GmailWatcher] [gog] ${line}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) return;
    if (ADDRESS_IN_USE_RE.test(line)) {
      addressInUse = true;
    }
    console.warn(`[GmailWatcher] [gog] ${line}`);
  });

  child.on('error', (err) => {
    console.error(`[GmailWatcher] gog process error: ${String(err)}`);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    if (addressInUse) {
      console.warn(
        '[GmailWatcher] gog serve failed to bind (address already in use); stopping restarts. ' +
          'Another watcher is likely running.',
      );
      watcherProcess = null;
      return;
    }

    console.warn(`[GmailWatcher] gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    watcherProcess = null;

    setTimeout(() => {
      if (shuttingDown || !currentConfig) return;
      watcherProcess = spawnGogServe(currentConfig);
    }, 5000);
  });

  return child;
}

/**
 * Start the Gmail watcher service.
 * Called automatically by the app if hooks.gmail is configured.
 */
export async function startGmailWatcher(config: HooksConfig): Promise<GmailWatcherStartResult> {
  // Check if gmail hooks are configured
  if (!config.enabled) {
    return { started: false, reason: 'hooks not enabled' };
  }

  if (!config.gmail?.account) {
    return { started: false, reason: 'no gmail account configured' };
  }

  // Check if gog is available
  const gogAvailable = await isGogAvailable();
  if (!gogAvailable) {
    return { started: false, reason: 'gog binary not found (install from gogcli.sh)' };
  }

  // Resolve the full runtime config
  const resolved = resolveGmailRuntimeConfig(config);
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  const runtimeConfig = resolved.value;

  // Check if watcher is already running
  if (watcherProcess && currentConfig) {
    // If same account, already running
    if (currentConfig.account === runtimeConfig.account) {
      console.log(`[GmailWatcher] Already running for ${runtimeConfig.account}`);
      return { started: true };
    }
    // Different account - stop the old watcher first
    console.log(`[GmailWatcher] Switching from ${currentConfig.account} to ${runtimeConfig.account}`);
    await stopGmailWatcher();
  }

  currentConfig = runtimeConfig;

  // Start the Gmail watch (register with Gmail API)
  const watchStarted = await startGmailWatch(runtimeConfig);
  if (!watchStarted) {
    console.warn('[GmailWatcher] Gmail watch start failed, but continuing with serve');
  }

  // Spawn the gog serve process
  shuttingDown = false;
  watcherProcess = spawnGogServe(runtimeConfig);

  // Set up renewal interval
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  renewInterval = setInterval(() => {
    if (shuttingDown) return;
    void startGmailWatch(runtimeConfig);
  }, renewMs);

  console.log(
    `[GmailWatcher] Gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

/**
 * Stop the Gmail watcher service.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  if (renewInterval) {
    clearInterval(renewInterval);
    renewInterval = null;
  }

  if (watcherProcess) {
    console.log('[GmailWatcher] Stopping Gmail watcher');
    watcherProcess.kill('SIGTERM');

    // Wait a bit for graceful shutdown
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (watcherProcess) {
          watcherProcess.kill('SIGKILL');
        }
        resolve();
      }, 3000);

      watcherProcess?.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    watcherProcess = null;
  }

  currentConfig = null;
  console.log('[GmailWatcher] Gmail watcher stopped');
}

/**
 * Check if the Gmail watcher is running.
 */
export function isGmailWatcherRunning(): boolean {
  return watcherProcess !== null && !shuttingDown;
}

/**
 * Get the current Gmail runtime config (if running)
 */
export function getGmailRuntimeConfig(): GmailHookRuntimeConfig | null {
  return currentConfig;
}
