import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export async function buildNativeSessionProbe(directory) {
  if (process.platform !== "darwin") return;
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, "native-session-probe");
  await promisify(execFile)("/usr/bin/xcrun", [
    "clang",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=11.0",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-x",
    "objective-c",
    "native/application-session-probe.c",
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    "-framework",
    "CoreFoundation",
    "-o",
    destination,
  ]);
  await promisify(execFile)("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    destination,
  ]);
  await fs.chmod(destination, 0o755);
  console.log(`Native session probe emitted: ${destination}`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!["electron", "daemon", "cli"].includes(target))
    throw new Error("Unknown runtime target");
  await buildNativeSessionProbe(
    path.join("dist", target, "electron/applications"),
  );
}
