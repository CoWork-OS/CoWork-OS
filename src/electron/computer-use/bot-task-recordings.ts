import { randomUUID } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { TAUGHT_TASK_NAME_MAX_LENGTH, type TaughtTask } from "../../shared/bot-computer";
import { botDesktopKey } from "./bot-desktop-manager";

export type { TaughtTask };

/** One input event of a recording, as cowork-teach writes it (see resources/bot-desktop). */
export interface RecordedEvent {
  /** Milliseconds since the first event. */
  t: number;
  e: "key" | "button" | "move";
  /** 1 for a press, 0 for a release (and for moves). */
  down: 0 | 1;
  /** The key code or button number. */
  d: number;
  x: number;
  y: number;
}

/** Encrypts and decrypts a recording at rest (Electron's safeStorage in the app). */
export interface RecordingCipher {
  encrypt(plain: Buffer): Buffer;
  decrypt(sealed: Buffer): Buffer;
}

const MAX_EVENTS = 50_000;
const MAX_DURATION_MS = 11 * 60 * 1000;

/** A taught task's name, trimmed, or an error: 1 to 60 printable characters. */
export function normalizeTaughtTaskName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > TAUGHT_TASK_NAME_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error(`Name the task in 1 to ${TAUGHT_TASK_NAME_MAX_LENGTH} characters.`);
  }
  return name;
}

/** The events of a recording (JSON lines from cowork-teach), checked, or an error. */
export function parseRecording(jsonl: string): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("The recording is damaged.");
    }
    const event = {
      t: Number(raw.t),
      e: raw.e,
      down: Number(raw.down),
      d: Number(raw.d),
      x: Number(raw.x),
      y: Number(raw.y),
    };
    if (
      (event.e !== "key" && event.e !== "button" && event.e !== "move") ||
      !Number.isInteger(event.t) ||
      event.t < 0 ||
      event.t > MAX_DURATION_MS ||
      (event.down !== 0 && event.down !== 1) ||
      !Number.isInteger(event.d) ||
      event.d < 0 ||
      event.d > 255 ||
      !Number.isInteger(event.x) ||
      !Number.isInteger(event.y) ||
      event.x < 0 ||
      event.y < 0 ||
      event.x > 10_000 ||
      event.y > 10_000
    ) {
      throw new Error("The recording is damaged.");
    }
    events.push(event as RecordedEvent);
    if (events.length > MAX_EVENTS) throw new Error("The recording is too long.");
  }
  return events;
}

export function toRecordingLines(events: RecordedEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

interface StoredRecording extends TaughtTask {
  /** "safe" when the events are encrypted, "plain" when encryption was unavailable. */
  sealing: "safe" | "plain";
  /** The events as JSON lines, base64 (encrypted when sealing is "safe"). */
  events: string;
}

/**
 * Taught tasks, per bot, in CoWork's app data. They are never kept on the bot's desktop, where
 * the bot's own commands could read what the person typed while teaching.
 */
export class BotTaskRecordings {
  private static instance: BotTaskRecordings | null = null;

  static getInstance(): BotTaskRecordings {
    if (!BotTaskRecordings.instance) throw new Error("Taught tasks are not ready yet.");
    return BotTaskRecordings.instance;
  }

  static configure(options: { dataDir: () => string; cipher?: () => RecordingCipher | null }) {
    BotTaskRecordings.instance = new BotTaskRecordings(
      options.dataDir,
      options.cipher ?? (() => null),
    );
    return BotTaskRecordings.instance;
  }

  static resetForTesting(): void {
    BotTaskRecordings.instance = null;
  }

  constructor(
    private readonly dataDir: () => string,
    /** Asked on each save and load: encryption may become available only after start-up. */
    private readonly cipher: () => RecordingCipher | null,
  ) {}

  private folder(botId: string): string {
    return path.join(this.dataDir(), "bot-taught-tasks", botDesktopKey(botId));
  }

  private readAll(botId: string): StoredRecording[] {
    const dir = this.folder(botId);
    if (!existsSync(dir)) return [];
    const stored: StoredRecording[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        stored.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
      } catch {
        // A damaged file is skipped, not shown.
      }
    }
    return stored;
  }

  list(botId: string): TaughtTask[] {
    return this.readAll(botId)
      .map(({ id, name, createdAt, durationMs, eventCount }) => ({
        id,
        name,
        createdAt,
        durationMs,
        eventCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saves a recording under a name; teaching a task again under the same name replaces it. */
  save(botId: string, rawName: unknown, events: RecordedEvent[]): TaughtTask {
    const name = normalizeTaughtTaskName(rawName);
    if (events.length === 0) throw new Error("Nothing was recorded.");
    const dir = this.folder(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const plain = Buffer.from(toRecordingLines(events), "utf8");
    const cipher = this.cipher();
    const sealed = cipher ? cipher.encrypt(plain) : plain;
    const task: TaughtTask = {
      id: randomUUID(),
      name,
      createdAt: Date.now(),
      durationMs: events[events.length - 1].t,
      eventCount: events.length,
    };
    const stored: StoredRecording = {
      ...task,
      sealing: cipher ? "safe" : "plain",
      events: sealed.toString("base64"),
    };
    const file = path.join(dir, `${task.id}.json`);
    writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    chmodSync(file, 0o600);
    for (const old of this.readAll(botId)) {
      if (old.id !== task.id && old.name.toLowerCase() === name.toLowerCase()) {
        rmSync(path.join(dir, `${old.id}.json`), { force: true });
      }
    }
    return task;
  }

  /** A taught task's events, found by its name (case does not matter) or id. */
  load(botId: string, nameOrId: unknown): { task: TaughtTask; events: RecordedEvent[] } {
    const wanted = typeof nameOrId === "string" ? nameOrId.trim().toLowerCase() : "";
    const stored = this.readAll(botId).find(
      (item) => item.id === wanted || item.name.toLowerCase() === wanted,
    );
    if (!stored) {
      const names = this.list(botId).map((task) => `"${task.name}"`);
      throw new Error(
        names.length > 0
          ? `No taught task by that name. This bot was taught: ${names.join(", ")}.`
          : "This bot hasn't been taught any tasks yet.",
      );
    }
    const sealed = Buffer.from(stored.events, "base64");
    let plain: Buffer;
    if (stored.sealing === "safe") {
      const cipher = this.cipher();
      if (!cipher) throw new Error("This taught task can't be read on this computer.");
      plain = cipher.decrypt(sealed);
    } else {
      plain = sealed;
    }
    const { id, name, createdAt, durationMs, eventCount } = stored;
    return {
      task: { id, name, createdAt, durationMs, eventCount },
      events: parseRecording(plain.toString("utf8")),
    };
  }

  delete(botId: string, id: unknown): boolean {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return false;
    const file = path.join(this.folder(botId), `${id}.json`);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }
}
