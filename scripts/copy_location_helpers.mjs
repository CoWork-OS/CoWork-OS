import { chmodSync, copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const root = process.cwd();

const winSrc = join(root, "native", "location-helper-windows", "Get-Location.ps1");
const winDst = join(root, "build", "location-helper-windows");
if (existsSync(winSrc)) {
  mkdirSync(winDst, { recursive: true });
  copyFileSync(winSrc, join(winDst, "Get-Location.ps1"));
  console.log("[location-helpers] Copied Windows helper to", winDst);
} else {
  console.log("[location-helpers] Windows helper not found, skipping.");
}

const linuxSrc = join(root, "native", "location-helper-linux", "get-location.sh");
const linuxDst = join(root, "build", "location-helper-linux");
if (existsSync(linuxSrc)) {
  mkdirSync(linuxDst, { recursive: true });
  copyFileSync(linuxSrc, join(linuxDst, "get-location.sh"));
  chmodSync(join(linuxDst, "get-location.sh"), 0o755);
  console.log("[location-helpers] Copied Linux helper to", linuxDst);
} else {
  console.log("[location-helpers] Linux helper not found, skipping.");
}
