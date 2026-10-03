import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

// Real macOS acceptance against a disposable profile. Build Electron and React first.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-dock-qa-"));
const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: path.join(outputDir, "profile"),
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform !== "darwin") throw new Error("This smoke test requires macOS.");

let desktop;
let main;
const checks = [];
async function launch() {
  desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 60000 });
  desktop
    .process()
    .stdout?.on("data", (data) => fs.appendFile(path.join(outputDir, "runtime.log"), data));
  desktop
    .process()
    .stderr?.on("data", (data) => fs.appendFile(path.join(outputDir, "runtime.log"), data));
  // Startup may briefly create a Keychain-context window before the app shell.
  for (let attempt = 0; attempt < 240; attempt++) {
    main = desktop.windows().find((page) => page.url().includes("/renderer/index.html"));
    if (main) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!main) throw new Error("Main renderer did not load");
  await main.waitForFunction(() => typeof window.electronAPI?.getTraySettings === "function");
  // Tray initialization is deferred until the shell is ready.
  for (let attempt = 0; attempt < 120; attempt++) {
    const ready = await desktop.evaluate((_, repo) => {
      const { trayManager } = process.mainModule.require(
        repo + "/dist/electron/electron/tray/TrayManager.js",
      );
      return !!trayManager.mainWindow;
    }, root);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Tray did not initialize");
}
async function badge() {
  return desktop.evaluate(({ app }) => app.dock.getBadge());
}
async function add(message = "TEST DATA — your sample report is ready.") {
  const pagePromise = desktop.waitForEvent("window", { timeout: 10000 });
  const notification = await main.evaluate(
    (body) =>
      window.electronAPI.addNotification({
        type: "task_completed",
        title: "TEST DATA — Report ready",
        message: body,
      }),
    message,
  );
  const page = await pagePromise;
  await page.waitForLoadState("domcontentloaded");
  await page.locator("body.dock").waitFor();
  return { notification, page };
}
async function waitBadge(expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await badge()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await badge(), expected);
}

try {
  await launch();
  // Skip onboarding only in this empty test profile to exercise the actual settings control.
  await main.evaluate(() =>
    window.electronAPI.saveAppearanceSettings({
      onboardingCompleted: true,
      disclaimerAccepted: true,
    }),
  );
  await main.reload();
  await main.waitForFunction(() => !!document.querySelector(".sidebar, .sidebar-rail"));
  await main.evaluate(() =>
    window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "system" } })),
  );
  await main.getByRole("button", { name: "System & Security", exact: true }).click();
  const selector = main.getByLabel("Notification style", { exact: true });
  await selector.waitFor();
  await selector.selectOption("near-dock");
  const styleLayout = await selector.evaluate((select) => {
    const text = select.previousElementSibling.getBoundingClientRect();
    const control = select.getBoundingClientRect();
    return {
      textWidth: text.width,
      textRight: text.right,
      controlLeft: control.left,
      controlTop: control.top,
      textBottom: text.bottom,
    };
  });
  assert.ok(styleLayout.textWidth > 200, "Notification description must remain readable");
  assert.ok(
    styleLayout.textRight <= styleLayout.controlLeft ||
      styleLayout.textBottom <= styleLayout.controlTop,
    "Notification control must not overlap its description",
  );
  await main.waitForFunction(
    async () => (await window.electronAPI.getTraySettings()).notificationStyle === "near-dock",
  );
  await main
    .locator(".system-security-section--tray")
    .screenshot({ path: path.join(outputDir, "notification-settings.png") });
  checks.push("Near Dock selected in the actual settings UI and saved through IPC");

  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((win) => win.hide()),
  );
  const first = await add();
  await waitBadge("1");
  const state = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().startsWith("data:text/html"),
    );
    const display = screen.getDisplayMatching(win.getBounds());
    return {
      bounds: win.getBounds(),
      workArea: display.workArea,
      focused: win.isFocused(),
      focusable: win.isFocusable(),
      visible: win.isVisible(),
    };
  });
  assert.equal(state.focusable, false);
  assert.equal(state.focused, false);
  assert.equal(state.visible, true);
  assert.ok(state.bounds.y + state.bounds.height <= state.workArea.y + state.workArea.height);
  await first.page.screenshot({ path: path.join(outputDir, "near-dock-card.png") });
  checks.push("real Mac overlay visible near Dock without stealing focus");

  await first.page.locator(".read").click();
  await waitBadge("");
  const notifications = await main.evaluate(() => window.electronAPI.listNotifications());
  assert.equal(notifications.find((n) => n.id === first.notification.id).read, true);
  checks.push("checkmark persists read state and clears badge");

  const second = await add("TEST DATA — <img src=x onerror=alert(1)> & sample text.");
  assert.equal(
    await second.page.locator(".sub").textContent(),
    "TEST DATA — <img src=x onerror=alert(1)> & sample text.",
  );
  assert.equal(await second.page.locator(".sub img").count(), 0);
  await second.page.locator(".dismiss").click();
  await waitBadge("1");
  checks.push("dismiss keeps item unread; notification text is escaped");

  const third = await add();
  await third.page.locator("#n").click();
  await waitBadge("1");
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (win) => win.webContents.getURL().startsWith("file:") && win.isVisible(),
      ),
    ),
    true,
  );
  checks.push("card click opens app and marks only that item read");

  await main.evaluate(() => window.electronAPI.saveTraySettings({ notificationStyle: "system" }));
  await waitBadge("");
  await main.evaluate(() =>
    window.electronAPI.saveTraySettings({ notificationStyle: "near-dock" }),
  );
  await waitBadge("1");
  await main.evaluate(() => window.electronAPI.saveTraySettings({ showNotifications: false }));
  await waitBadge("");
  await main.evaluate(() => window.electronAPI.saveTraySettings({ showNotifications: true }));
  await waitBadge("1");
  checks.push("style and notification toggles update badge immediately");

  await desktop.close();
  await launch();
  const restored = await main.evaluate(() => window.electronAPI.getTraySettings());
  assert.equal(restored.notificationStyle, "near-dock");
  await waitBadge("1");
  await main.evaluate(() => window.electronAPI.markAllNotificationsRead());
  await waitBadge("");
  checks.push("style and unread badge restore after restart; mark all read clears badge");
  await fs.writeFile(
    path.join(outputDir, "result.json"),
    JSON.stringify({ checks, state }, null, 2),
  );
  console.log(JSON.stringify({ success: true, outputDir, checks }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({ success: false, outputDir, checks, error: String(error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await desktop?.close().catch(() => {});
}
