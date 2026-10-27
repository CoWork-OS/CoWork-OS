import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { waitForFirstWindow } from "./desktop-smoke-readiness.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("requires the first window event, even when it spans output chunks", async () => {
  const child = fakeChild();
  const ready = waitForFirstWindow(child, 1000);
  child.stdout.write('[Main] [StartupLane] {"lane":"first_window_startup",');
  child.stdout.write('"event":"did_finish_load"}\n');
  await ready;
});

test("a live process without a first window fails rather than passing", async () => {
  const child = fakeChild();
  const ready = waitForFirstWindow(child, 10);
  child.stdout.write("[Main] waiting for Keychain\n");
  await assert.rejects(ready, /Timed out waiting for the first window.*Keychain/s);
});

test("an early clean exit still fails the window check", async () => {
  const child = fakeChild();
  const ready = waitForFirstWindow(child, 1000);
  child.emit("close", 0, null);
  await assert.rejects(ready, /exited before the first window/);
});

test("propagates a launch error", async () => {
  const child = fakeChild();
  const ready = waitForFirstWindow(child, 1000);
  child.emit("error", new Error("launch failed"));
  await assert.rejects(ready, /launch failed/);
});
