/**
 * Canvas Store - File-based persistence for canvas sessions
 * Uses atomic writes with temporary files for data safety
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { CanvasSession } from '../../shared/types';

export interface CanvasStoreFile {
  version: number;
  sessions: CanvasSession[];
}

// Lazy-evaluated paths (app.getPath() is not available until app is ready)
let _canvasDir: string | null = null;
let _canvasStorePath: string | null = null;

export function getCanvasDir(): string {
  if (!_canvasDir) {
    _canvasDir = path.join(app.getPath('userData'), 'canvas');
  }
  return _canvasDir;
}

export function getCanvasStorePath(): string {
  if (!_canvasStorePath) {
    _canvasStorePath = path.join(getCanvasDir(), 'sessions.json');
  }
  return _canvasStorePath;
}

// Maximum sessions to keep (to prevent unbounded growth)
const MAX_SESSIONS = 50;

/**
 * Validate a single canvas session object
 */
function isValidSession(s: unknown): s is CanvasSession {
  if (!s || typeof s !== 'object') return false;
  const session = s as Record<string, unknown>;
  const mode = session.mode;
  const isValidMode = mode === undefined || mode === 'html' || mode === 'browser';
  const url = session.url;
  const isValidUrl = url === undefined || typeof url === 'string';
  return (
    typeof session.id === 'string' &&
    typeof session.taskId === 'string' &&
    typeof session.workspaceId === 'string' &&
    typeof session.sessionDir === 'string' &&
    isValidMode &&
    isValidUrl &&
    typeof session.status === 'string' &&
    ['active', 'paused', 'closed'].includes(session.status as string) &&
    typeof session.createdAt === 'number' &&
    typeof session.lastUpdatedAt === 'number'
  );
}

/**
 * Load canvas sessions from the store file
 * Returns empty array if file doesn't exist or is invalid
 */
export async function loadCanvasStore(storePath?: string): Promise<CanvasStoreFile> {
  const effectivePath = storePath || getCanvasStorePath();
  try {
    const raw = await fs.promises.readFile(effectivePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CanvasStoreFile> | null;
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];

    // Validate and filter sessions
    const validSessions = sessions.filter((s): s is CanvasSession => {
      if (!isValidSession(s)) return false;

      // Also verify the session directory still exists
      try {
        return fs.existsSync(s.sessionDir);
      } catch {
        return false;
      }
    });

    return {
      version: 1,
      sessions: validSessions,
    };
  } catch {
    // File doesn't exist or is invalid - return empty store
    return { version: 1, sessions: [] };
  }
}

/**
 * Load canvas store synchronously (for initialization)
 */
export function loadCanvasStoreSync(storePath?: string): CanvasStoreFile {
  const effectivePath = storePath || getCanvasStorePath();
  try {
    const raw = fs.readFileSync(effectivePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CanvasStoreFile> | null;
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];

    // Validate and filter sessions
    const validSessions = sessions.filter((s): s is CanvasSession => {
      if (!isValidSession(s)) return false;

      // Also verify the session directory still exists
      try {
        return fs.existsSync(s.sessionDir);
      } catch {
        return false;
      }
    });

    return {
      version: 1,
      sessions: validSessions,
    };
  } catch {
    return { version: 1, sessions: [] };
  }
}

/**
 * Save canvas sessions to the store file
 * Uses atomic writes to prevent data corruption
 */
export async function saveCanvasStore(
  store: CanvasStoreFile,
  storePath?: string
): Promise<void> {
  const effectivePath = storePath || getCanvasStorePath();

  // Ensure directory exists
  await fs.promises.mkdir(path.dirname(effectivePath), { recursive: true });

  // Only keep non-closed sessions, and limit to max
  let sessionsToSave = store.sessions.filter(s => s.status !== 'closed');

  // Trim to max sessions (keep most recent)
  if (sessionsToSave.length > MAX_SESSIONS) {
    sessionsToSave = sessionsToSave
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, MAX_SESSIONS);
  }

  const storeToSave: CanvasStoreFile = {
    version: 1,
    sessions: sessionsToSave,
  };

  // Generate temp file path with process ID and random suffix
  const tmp = `${effectivePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(storeToSave, null, 2);
  await fs.promises.writeFile(tmp, json, 'utf-8');

  // Atomic rename
  await fs.promises.rename(tmp, effectivePath);
}

/**
 * Save canvas store synchronously
 */
export function saveCanvasStoreSync(
  store: CanvasStoreFile,
  storePath?: string
): void {
  const effectivePath = storePath || getCanvasStorePath();

  // Ensure directory exists
  fs.mkdirSync(path.dirname(effectivePath), { recursive: true });

  // Only keep non-closed sessions, and limit to max
  let sessionsToSave = store.sessions.filter(s => s.status !== 'closed');

  // Trim to max sessions (keep most recent)
  if (sessionsToSave.length > MAX_SESSIONS) {
    sessionsToSave = sessionsToSave
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, MAX_SESSIONS);
  }

  const storeToSave: CanvasStoreFile = {
    version: 1,
    sessions: sessionsToSave,
  };

  // Generate temp file path
  const tmp = `${effectivePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;

  // Write to temp file
  const json = JSON.stringify(storeToSave, null, 2);
  fs.writeFileSync(tmp, json, 'utf-8');

  // Atomic rename
  fs.renameSync(tmp, effectivePath);
}
