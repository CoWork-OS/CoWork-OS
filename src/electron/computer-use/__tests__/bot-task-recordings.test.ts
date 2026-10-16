import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BotTaskRecordings,
  normalizeTaughtTaskName,
  parseRecording,
  toRecordingLines,
  type RecordedEvent,
} from "../bot-task-recordings";

const events: RecordedEvent[] = [
  { t: 0, e: "move", down: 0, d: 0, x: 10, y: 20 },
  { t: 40, e: "key", down: 1, d: 38, x: 10, y: 20 },
  { t: 90, e: "key", down: 0, d: 38, x: 10, y: 20 },
];

// Reverses the bytes: enough to tell a sealed file from a plain one.
const cipher = {
  encrypt: (plain: Buffer) => Buffer.from(plain).reverse(),
  decrypt: (sealed: Buffer) => Buffer.from(sealed).reverse(),
};

describe("taught task recordings", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "taught-tasks-"));
  });

  afterEach(() => {
    BotTaskRecordings.resetForTesting();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads cowork-teach's JSON lines and refuses anything else", () => {
    expect(parseRecording(toRecordingLines(events))).toEqual(events);
    for (const bad of [
      "not json",
      '{"t":0,"e":"scroll","down":0,"d":0,"x":0,"y":0}',
      '{"t":0,"e":"key","down":2,"d":0,"x":0,"y":0}',
      '{"t":0,"e":"key","down":1,"d":999,"x":0,"y":0}',
      '{"t":-5,"e":"key","down":1,"d":9,"x":0,"y":0}',
      '{"t":0,"e":"move","down":0,"d":0,"x":20000,"y":0}',
    ]) {
      expect(() => parseRecording(bad)).toThrow(/damaged/);
    }
  });

  it("asks for a short, plain name", () => {
    expect(normalizeTaughtTaskName("  Download   the invoice ")).toBe("Download the invoice");
    for (const bad of ["", "   ", "x".repeat(61), `a${String.fromCodePoint(0)}b`, 42]) {
      expect(() => normalizeTaughtTaskName(bad)).toThrow(/Name the task/);
    }
  });

  it("keeps recordings per bot, encrypted, and replaces one taught again under its name", () => {
    const store = BotTaskRecordings.configure({ dataDir: () => dataDir, cipher: () => cipher });
    const first = store.save("bot-1", "Download the invoice", events);
    expect(store.list("bot-1")).toEqual([first]);
    expect(store.list("bot-2")).toEqual([]);

    const files = fs
      .readdirSync(dataDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const stored = fs.readFileSync(path.join(dataDir, files[0]), "utf8");
    expect(JSON.parse(stored).sealing).toBe("safe");
    expect(Buffer.from(JSON.parse(stored).events, "base64").toString("utf8")).not.toContain(
      '"d":38',
    );
    expect(fs.statSync(path.join(dataDir, files[0])).mode & 0o777).toBe(0o600);

    expect(store.load("bot-1", "DOWNLOAD THE INVOICE").events).toEqual(events);
    const second = store.save("bot-1", "download the invoice", events.slice(0, 2));
    expect(store.list("bot-1")).toEqual([second]);
    expect(store.load("bot-1", second.id).events).toHaveLength(2);
  });

  it("says what a bot was taught when asked for something else", () => {
    const store = BotTaskRecordings.configure({ dataDir: () => dataDir });
    expect(() => store.load("bot-1", "Pay rent")).toThrow(/hasn't been taught any tasks/);
    store.save("bot-1", "Download the invoice", events);
    expect(() => store.load("bot-1", "Pay rent")).toThrow(/taught: "Download the invoice"/);
  });

  it("won't read an encrypted recording without the key, and deletes by id only", () => {
    const sealedStore = BotTaskRecordings.configure({
      dataDir: () => dataDir,
      cipher: () => cipher,
    });
    const task = sealedStore.save("bot-1", "Download the invoice", events);
    const plainStore = BotTaskRecordings.configure({ dataDir: () => dataDir });
    expect(() => plainStore.load("bot-1", task.id)).toThrow(/can't be read on this computer/);
    expect(plainStore.delete("bot-1", "../../etc")).toBe(false);
    expect(plainStore.delete("bot-1", task.id)).toBe(true);
    expect(plainStore.list("bot-1")).toEqual([]);
  });

  it("refuses to save an empty recording", () => {
    const store = BotTaskRecordings.configure({ dataDir: () => dataDir });
    expect(() => store.save("bot-1", "Nothing", [])).toThrow(/Nothing was recorded/);
  });
});
