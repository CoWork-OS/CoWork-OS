import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { isAutomatedTaskLike, isSpeculativeTask } from "../../shared/automated-task-detection";
import type { AlwaysAllowedComputerUseApp } from "../../shared/computer-use-contract";
import type { Task } from "../../shared/types";

/**
 * Apps the user chose "Always allow" for when computer use asked to control them. A listed app
 * is controlled without asking, in the background and visibly, but only in sessions the user
 * started (see `AgentDaemon.computerUseAlwaysAllowCandidate`): bots and automated sessions
 * keep asking. Only the main process adds an app (after an approved "Always allow"); the
 * renderer can list and remove.
 */

const SETTINGS_KEY = "computer-use-apps";
const MAX_APPS = 200;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Apps that hold passwords, run commands, change system settings, or are CoWork itself.
 * Controlling them stays a decision each time, so they can never be always allowed.
 */
const NEVER_ALWAYS_ALLOWED = new Set(
  [
    // CoWork itself (release, development and plain Electron).
    "com.cowork-os.app",
    "com.cowork-os.app.dev",
    "com.github.Electron",
    // Passwords and keys.
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal",
    "com.1password.1password7",
    "org.keepassxc.keepassxc",
    "in.sinew.Enpass-Desktop",
    "com.keepersecurity.passwordmanager",
    "me.proton.pass.electron",
    // Terminals, scripting and automation (they run commands).
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "co.zeit.hyper",
    "com.github.wez.wezterm",
    "org.tabby",
    "com.apple.ScriptEditor2",
    "com.latenightsw.ScriptDebugger8",
    "com.apple.Automator",
    "com.apple.shortcuts",
    "com.stairways.keyboardmaestro.editor",
    "org.hammerspoon.Hammerspoon",
    // Code editors with built-in terminals.
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
    "com.todesktop.230313mzl4w4u92",
    "com.apple.dt.Xcode",
    "dev.zed.Zed",
    // Files, remote control and containers.
    "com.apple.finder",
    "com.apple.ScreenSharing",
    "com.docker.docker",
    // System settings and security.
    "com.apple.systempreferences",
    "com.apple.Settings",
    "com.apple.SecurityAgent",
    "com.apple.ActivityMonitor",
    "com.apple.DiskUtility",
    "com.apple.Console",
  ].map((id) => id.toLowerCase()),
);

/** Families matched by prefix: every JetBrains IDE has a built-in terminal. */
const NEVER_ALWAYS_ALLOWED_PREFIXES = ["com.jetbrains."];

export function isValidBundleId(bundleId: unknown): bundleId is string {
  return typeof bundleId === "string" && BUNDLE_ID_PATTERN.test(bundleId);
}

/** Whether an app may be put on the always-allowed list at all. */
export function canAlwaysAllowApp(bundleId: unknown): bundleId is string {
  if (!isValidBundleId(bundleId)) return false;
  const key = bundleId.toLowerCase();
  return (
    !NEVER_ALWAYS_ALLOWED.has(key) &&
    !NEVER_ALWAYS_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function cleanName(name: unknown, fallback: string): string {
  const text = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (text || fallback).slice(0, 120);
}

function normalizeList(value: unknown): AlwaysAllowedComputerUseApp[] {
  const raw = Array.isArray((value as { apps?: unknown })?.apps)
    ? ((value as { apps: unknown[] }).apps as unknown[])
    : [];
  const seen = new Set<string>();
  const apps: AlwaysAllowedComputerUseApp[] = [];
  for (const entry of raw) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const bundleId = record.bundleId;
    if (!canAlwaysAllowApp(bundleId)) continue;
    const key = bundleId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push({
      bundleId,
      name: cleanName(record.name, bundleId),
      addedAt:
        typeof record.addedAt === "number" && Number.isFinite(record.addedAt) ? record.addedAt : 0,
    });
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

export interface AlwaysAllowAppCandidate {
  bundleId: string;
  name: string;
}

/** Sources of sessions the user started themselves. */
const USER_STARTED_TASK_SOURCES = new Set<NonNullable<Task["source"]>>([
  "manual",
  "suggested_task",
  "side_chat",
]);

/**
 * The app a computer use approval is about, when the user may "Always allow" it (and when an
 * always-allowed app may skip the question): a valid app that is not on the never list, in a
 * session the user started. A session under a bot, an automation, the API, a hook or a bot
 * panel keeps asking.
 */
export function computerUseAlwaysAllowCandidate(
  taskRepo: { findById(id: string): Task | undefined } | undefined,
  taskId: string,
  type: string,
  details: Record<string, unknown>,
): AlwaysAllowAppCandidate | null {
  if (type !== "computer_use") return null;
  const bundleId = details.bundleId;
  if (!canAlwaysAllowApp(bundleId)) return null;
  let task = taskRepo?.findById(taskId);
  if (!task) return null;
  for (let depth = 0; task && depth < 16; depth += 1) {
    if (
      task.assignedAgentRoleId ||
      task.agentConfig?.botConversation === true ||
      isSpeculativeTask(task) ||
      isAutomatedTaskLike(task) ||
      // A task without a recorded source keeps asking: it may not be the user's.
      !task.source ||
      !USER_STARTED_TASK_SOURCES.has(task.source) ||
      // Channel and gateway tasks, CLI runs and tasks set to never ask a person.
      task.agentConfig?.gatewayContext ||
      task.agentConfig?.cli?.owner === "cowork-run" ||
      task.agentConfig?.humanInputPolicy === "none"
    ) {
      return null;
    }
    task = task.parentTaskId ? taskRepo?.findById(task.parentTaskId) : undefined;
  }
  return { bundleId, name: cleanName(details.targetApp, bundleId) };
}

export class ComputerUseAppAllowlist {
  private static cached: AlwaysAllowedComputerUseApp[] | null = null;

  static list(): AlwaysAllowedComputerUseApp[] {
    if (this.cached) return [...this.cached];
    let stored: unknown;
    try {
      stored = SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance().load(SETTINGS_KEY)
        : undefined;
    } catch {
      stored = undefined;
    }
    this.cached = normalizeList(stored);
    return [...this.cached];
  }

  static has(bundleId: unknown): boolean {
    if (!canAlwaysAllowApp(bundleId)) return false;
    const key = bundleId.toLowerCase();
    return this.list().some((app) => app.bundleId.toLowerCase() === key);
  }

  private static save(apps: AlwaysAllowedComputerUseApp[]): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Settings storage is not ready.");
    }
    if (!SecureSettingsRepository.getInstance().save(SETTINGS_KEY, { apps })) {
      throw new Error("The always-allowed apps could not be saved.");
    }
    this.cached = apps;
  }

  /** Add an app (main process only, after the user chose "Always allow"). */
  static add(bundleId: string, name: string, now = Date.now()): AlwaysAllowedComputerUseApp[] {
    if (!canAlwaysAllowApp(bundleId)) throw new Error("This app can't be always allowed.");
    if (this.has(bundleId)) return this.list();
    const apps = this.list();
    if (apps.length >= MAX_APPS) throw new Error("The always-allowed list is full.");
    this.save([...apps, { bundleId, name: cleanName(name, bundleId), addedAt: now }]);
    return this.list();
  }

  static remove(bundleId: string): AlwaysAllowedComputerUseApp[] {
    const key = typeof bundleId === "string" ? bundleId.toLowerCase() : "";
    const apps = this.list();
    const next = apps.filter((app) => app.bundleId.toLowerCase() !== key);
    if (next.length !== apps.length) this.save(next);
    return this.list();
  }

  /** Tests only. */
  static resetCacheForTests(): void {
    this.cached = null;
  }
}
