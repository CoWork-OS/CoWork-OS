import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright";
import { launchCoworkDesktop } from "./electron-launch.mjs";

// Real Electron + native Browser Workbench, disposable encrypted profile, synthetic accounts.
// The op/bw executables below are fixture CLIs; no personal password manager is read.
// Native approval decisions and Touch ID availability are stubbed in this QA process only.
// Build first: npm run build:electron && npm run build:react
// Run: node scripts/qa/private-browser-vault-smoke.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-private-vault-qa-"));
const require = createRequire(path.join(root, "package.json"));
const { authenticatorCode } = require(
  path.join(root, "dist/electron/electron/browser/credentials/totp.js"),
);
const seed = "JBSWY3DPEHPK3PXP";
const canaries = [
  "qa-login-password-canary",
  "qa-op-password-canary",
  "qa-bw-password-canary",
  "qa-manager-master-canary",
  "4111111111111111",
];
const results = [];
let orders = 0;
const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="font:18px system-ui;padding:40px"><h1>${title}</h1>${body}</body></html>`;
const login = page(
  "Private login fixture",
  `<form method="POST" action="/authenticate"><label>Email<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
);
const otp = page(
  "Two-factor fixture",
  `<form method="POST" action="/verify"><label>Verification code<input name="code" autocomplete="one-time-code"></label><button>Verify</button></form>`,
);
const checkout = page(
  "Checkout fixture",
  `<form><label>Name on card<input name="cardholder" autocomplete="cc-name"></label><label>Card number<input name="cardNumber" autocomplete="cc-number"></label><label>Expires<input name="expiry" autocomplete="cc-exp"></label><label>Security code<input name="cvc" autocomplete="cc-csc"></label><label>Billing postal code<input name="billingPostal" autocomplete="postal-code"></label></form><form><input name="fullName" autocomplete="name"><input name="address1" autocomplete="address-line1"><input name="address2" autocomplete="address-line2"><input name="city" autocomplete="address-level2"><input name="state" autocomplete="address-level1"><input name="postalCode" autocomplete="postal-code"><select name="country" autocomplete="country"><option value="">Select</option><option value="PT">Portugal</option></select></form><button onclick="fetch('/order',{method:'POST'})">Place order</button>`,
);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = new URLSearchParams(body);
  if (url.pathname === "/authenticate") {
    if (canaries.slice(0, 3).includes(data.get("password"))) {
      res.writeHead(303, { Location: "/otp" });
      res.end();
      return;
    }
    res.writeHead(401);
    res.end("Fixture authentication rejected");
    return;
  }
  if (url.pathname === "/verify") {
    if ([authenticatorCode(seed), "654321", "123456"].includes(data.get("code"))) {
      res.writeHead(303, { Location: "/account" });
      res.end();
      return;
    }
    res.writeHead(401);
    res.end("Fixture verification rejected");
    return;
  }
  if (url.pathname === "/order") {
    orders++;
    res.end("fixture only");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    url.pathname === "/passkey"
      ? page("Passkey fixture", "<button>Use your security key</button>")
      : url.pathname === "/username"
        ? page(
            "Username first",
            '<form><input autocomplete="username" name="username"><button>Continue</button></form>',
          )
        : url.pathname === "/otp-split"
          ? page(
              "Split code",
              Array.from(
                { length: 6 },
                (_, i) => `<input name="digit${i}" autocomplete="one-time-code" maxlength="1">`,
              ).join(""),
            )
          : url.pathname === "/checkout"
            ? checkout
            : url.pathname === "/otp"
              ? otp
              : url.pathname === "/account"
                ? page("Signed in", "<p id='authenticated'>Authenticated fixture account</p>")
                : login,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const bin = path.join(output, "fixture-bin");
await fs.mkdir(bin);
const cliLog = path.join(output, "cli-arguments.jsonl");
for (const binary of ["op", "bw"]) {
  const code = `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); const origin=${JSON.stringify(origin)};
fs.appendFileSync(${JSON.stringify(cliLog)},JSON.stringify({binary:${JSON.stringify(binary)},args})+'\\n');
if(args[0]==='--version'){console.log('QA fixture CLI 1.0');process.exit(0);}
if(args[0]==='whoami'){console.log('{}');process.exit(0);}
if(args[0]==='signin'){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.trim())process.exit(1);console.log('qa-session-token');});}
else if(args[0]==='unlock'){if(!process.env.COWORK_BW_MASTER)process.exit(1);console.log('qa-session-token');}
else if(args.includes('--otp') || args[1]==='totp'){console.log('123456');}
else if(args[0]==='list'){if(process.env.BW_SESSION!=='qa-session-token')process.exit(1);console.log(JSON.stringify([{id:'fixture-id',type:1,name:'Fixture Bitwarden',login:{username:'fixture@example.test',password:'qa-bw-password-canary',totp:'private-fixture-seed',uris:[{uri:origin}]}}]));}
else if(args[1]==='list'){console.log(JSON.stringify([{id:'fixture-id',title:'Fixture 1Password',additional_information:'fixture@example.test',urls:[{href:origin}]}]));}
else if(args[0]==='get'){console.log('qa-bw-password-canary');}
else if(args[1]==='get'){console.log('qa-op-password-canary');}
else process.exit(1);
`;
  await fs.writeFile(path.join(bin, binary), code, { mode: 0o700 });
}
const env = {
  ...process.env,
  NODE_ENV: "production",
  COWORK_USER_DATA_DIR: path.join(output, "profile"),
  COWORK_DISABLE_OS_KEYCHAIN: "0",
  COWORK_IMPORT_ENV_SETTINGS: "0",
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop, main, task, workspace;
const serviceModule = path.join(
  root,
  "dist/electron/electron/browser/credentials/browser-credential-service.js",
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await check()) return;
    } catch {}
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function step(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message) });
    console.log(`FAIL ${name}: ${error.message}`);
    await main
      ?.screenshot({ path: path.join(output, `failure-${results.length}.png`) })
      .catch(() => {});
    throw error;
  }
}
async function guest() {
  return desktop.evaluate(
    ({ webContents }, origin) =>
      webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed())
        .find((w) => w.getURL().startsWith(origin))?.id,
    origin,
  );
}
async function inPage(code) {
  return desktop.evaluate(
    ({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code),
    { id: await guest(), code },
  );
}
async function navigate(route) {
  const box = main.getByLabel("Browser URL");
  await box.click();
  await pause(100);
  await box.fill(`${origin}${route}`);
  await box.press("Enter");
  await wait(
    async () =>
      desktop.evaluate(({ webContents }, { id, url }) => webContents.fromId(id)?.getURL() === url, {
        id: await guest(),
        url: `${origin}${route}`,
      }),
    route,
  );
  await pause(350);
}
async function command(command) {
  return main.evaluate(
    ({ taskId, command }) => window.electronAPI.browserVaultCommand(taskId, command),
    { taskId: task.id, command },
  );
}
async function startCommand(command) {
  await main.evaluate(
    ({ taskId, command }) => {
      window.__privateQaResult = null;
      window.electronAPI.browserVaultCommand(taskId, command).then((result) => {
        window.__privateQaResult = result;
      });
    },
    { taskId: task.id, command },
  );
}
async function result() {
  await wait(() => main.evaluate(() => window.__privateQaResult !== null), "private result");
  return main.evaluate(() => window.__privateQaResult);
}
async function privateInput(labels, button) {
  const dialog = main.getByRole("dialog");
  await dialog.waitFor();
  for (const [label, value] of Object.entries(labels))
    await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}
async function approve(value) {
  await desktop.evaluate((_, value) => {
    global.__privateQaApprove = value;
  }, value);
}
async function items() {
  const result = await command({ action: "list" });
  assert.equal(result.success, true);
  return result.items;
}
async function agentTool(name, input) {
  return desktop.evaluate(
    async (_, { root, workspace, taskId, name, input }) => {
      const { BrowserTools } = process.mainModule.require(
        root + "/dist/electron/electron/agent/tools/browser-tools.js",
      );
      const daemon = {
        logEvent() {},
        requestApproval: async (...args) => {
          global.__privateQaAgentApproval = args.slice(1);
          return false;
        },
      };
      return new BrowserTools(workspace, daemon, taskId).executeTool(name, input);
    },
    { root, workspace, taskId: task.id, name, input },
  );
}
try {
  desktop = await launchCoworkDesktop(electron, { root, env, timeout: 60000 });
  desktop
    .process()
    .stdout?.on("data", (data) => fs.appendFile(path.join(output, "runtime.log"), data));
  desktop
    .process()
    .stderr?.on("data", (data) => fs.appendFile(path.join(output, "runtime.log"), data));
  await wait(
    async () => {
      main = desktop.windows().find((p) => p.url().includes("renderer/index.html"));
      return !!main;
    },
    "renderer",
    60000,
  );
  await main.waitForFunction(() => !!window.electronAPI?.createWorkspace);
  await main.evaluate(() =>
    window.electronAPI.saveAppearanceSettings({
      onboardingCompleted: true,
      disclaimerAccepted: true,
    }),
  );
  await desktop.evaluate(({ dialog, systemPreferences }) => {
    global.__privateQaApprove = true;
    global.__privateQaApprovals = [];
    systemPreferences.canPromptTouchID = () => false;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      global.__privateQaApprovals.push({ message: options.message, detail: options.detail });
      return { response: global.__privateQaApprove ? 0 : 1, checkboxChecked: false };
    };
  });
  await main.reload();
  await main.waitForFunction(() => !!document.querySelector(".sidebar,.sidebar-rail"));
  const workspacePath = path.join(output, "workspace");
  await fs.mkdir(workspacePath);
  workspace = await main.evaluate((data) => window.electronAPI.createWorkspace(data), {
    name: "Private Browser QA",
    path: workspacePath,
    permissions: { read: true, write: true, delete: false, network: true, shell: false },
  });
  task = await main.evaluate((data) => window.electronAPI.createTask(data), {
    title: "Private Browser QA",
    prompt: "TEST DATA: private browser fixture validation",
    workspaceId: workspace.id,
  });
  await main.reload();
  await main.waitForFunction(() => !!document.querySelector(".sidebar,.sidebar-rail"));
  await desktop.evaluate(({ BrowserWindow }, taskId) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes("renderer/index.html"))
      .webContents.send("navigate-to-task", taskId);
  }, task.id);
  await main.locator(".title-bar-more").getByRole("button", { name: "More", exact: true }).click();
  await main.getByRole("menuitem", { name: "Open browser", exact: true }).click();
  await main.getByLabel("Browser URL").waitFor();
  await navigate("/login");
  await step("private login dialog saves and fills through the toolbar", async () => {
    await main.getByRole("button", { name: "Passwords & autofill" }).click();
    await main.getByRole("menuitem", { name: "Enter login privately", exact: true }).click();
    await main.getByRole("dialog").waitFor();
    await main.screenshot({ path: path.join(output, "private-login-dialog.png") });
    await privateInput(
      {
        "Email or username": "fixture@example.test",
        Password: canaries[0],
        "Authenticator setup key (optional)": seed,
      },
      "Save & sign in",
    );
    await wait(
      () =>
        inPage(
          `document.querySelector('[name=password]').value === ${JSON.stringify(canaries[0])}`,
        ),
      "password fill",
    );
    assert.ok((await items()).some((i) => i.source === "local" && i.hasOtp));
  });
  const savedLogin = (await items()).find((i) => i.source === "local" && i.kind === "login");
  await step("saved authenticator fills 2FA and completes fixture authentication", async () => {
    await inPage("document.querySelector('form').requestSubmit(); true");
    await wait(() => inPage("location.pathname === '/otp'"), "OTP page");
    const result = await command({ action: "enter_code", handle: savedLogin.id });
    assert.equal(result.success, true);
    assert.equal(result.authenticationVerified, false);
    await inPage("document.querySelector('form').requestSubmit(); true");
    await wait(() => inPage("!!document.querySelector('#authenticated')"), "authenticated account");
    await main.screenshot({ path: path.join(output, "authenticated-account.png") });
  });
  await step("username-first, split-digit OTP, and passkey handoff", async () => {
    await navigate("/username");
    const first = await command({ action: "fill", handle: savedLogin.id });
    assert.equal(first.success, true);
    assert.equal(first.filledPassword, false);
    assert.equal(
      await inPage("document.querySelector('[name=username]').value === 'fixture@example.test'"),
      true,
    );
    await navigate("/otp-split");
    assert.equal((await command({ action: "enter_code", handle: savedLogin.id })).success, true);
    const expected = authenticatorCode(seed);
    assert.equal(
      await inPage(
        `[...document.querySelectorAll('input')].map(el=>el.value).join('') === ${JSON.stringify(expected)}`,
      ),
      true,
    );
    const snapshot = await agentTool("browser_snapshot", {});
    const boxes = snapshot.nodes.filter((node) => node.role.toLowerCase() === "textbox");
    assert.equal(boxes.length, 6);
    assert.ok(boxes.every((node) => node.value === "[saved password]"));
    const digit = await agentTool("browser_get_text", { ref: boxes[0].ref });
    assert.equal(digit.text, "[saved password]");
    await navigate("/passkey");
    assert.equal(
      (await command({ action: "enter_code", handle: savedLogin.id })).error,
      "no_code_field",
    );
    assert.equal(await main.getByRole("dialog").count(), 0);
  });
  await step("phone/email code uses a private prompt", async () => {
    await navigate("/otp");
    await startCommand({ action: "enter_code" });
    await privateInput({ "Verification code": "654321" }, "Continue privately");
    assert.equal((await result()).success, true);
    assert.equal(await inPage("document.querySelector('[name=code]').value === '654321'"), true);
  });
  for (const source of ["onepassword", "bitwarden"])
    await step(`${source} CLI unlock, list, password fill and OTP`, async () => {
      await navigate("/login");
      await startCommand({ action: "unlock", source });
      await privateInput({ "Master password": canaries[3] }, "Unlock");
      assert.equal((await result()).success, true);
      const item = (await items()).find((i) => i.source === source);
      assert.ok(item);
      assert.equal((await command({ action: "fill", handle: item.id })).success, true);
      const expected = source === "onepassword" ? canaries[1] : canaries[2];
      assert.equal(
        await inPage(
          `document.querySelector('[name=password]').value === ${JSON.stringify(expected)}`,
        ),
        true,
      );
      await navigate("/otp");
      assert.equal((await command({ action: "enter_code", handle: item.id })).success, true);
      assert.equal(await inPage("document.querySelector('[name=code]').value === '123456'"), true);
      assert.equal((await command({ action: "lock", source })).success, true);
      assert.equal(
        (await items()).some((i) => i.source === source),
        false,
      );
    });
  await step("declined card approval leaves checkout fields empty", async () => {
    await navigate("/checkout");
    await approve(false);
    await startCommand({ action: "save_item", kind: "payment" });
    await privateInput(
      {
        "Name on card": "Fixture User",
        "Card number": canaries[4],
        "Expiry month": "12",
        "Expiry year": "2030",
        "Security code": "987",
        "Billing postal code": "1000-001",
      },
      "Continue privately",
    );
    assert.equal((await result()).success, false);
    assert.equal(await inPage("document.querySelector('[name=cardNumber]').value === ''"), true);
  });
  await step(
    "approved saved-card fill requests a fresh security code and places no order",
    async () => {
      await approve(true);
      const card = (await items()).find((i) => i.kind === "payment");
      assert.ok(card);
      await startCommand({ action: "fill", handle: card.id });
      await privateInput({ "Security code": "987" }, "Continue privately");
      assert.equal((await result()).success, true);
      assert.equal(
        await inPage(
          `document.querySelector('[name=cardNumber]').value === ${JSON.stringify(canaries[4])} && document.querySelector('[name=cvc]').value === '987'`,
        ),
        true,
      );
      const noCvc = await desktop.evaluate(
        async (_, { module, workspaceId, id }) => {
          const { getBrowserVault } = process.mainModule.require(module);
          return getBrowserVault().withItemSecret(workspaceId, id, (fields) => !fields.cvc);
        },
        {
          module: path.join(root, "dist/electron/electron/browser/credentials/vault.js"),
          workspaceId: workspace.id,
          id: card.id,
        },
      );
      assert.equal(noCvc, true);
      assert.equal(orders, 0);
    },
  );
  await step("address autofill sets text fields and country select", async () => {
    await startCommand({ action: "save_item", kind: "address" });
    await privateInput(
      {
        "Full name": "Fixture User",
        "Address line 1": "1 Fixture Street",
        City: "Lisbon",
        "State or region": "Lisbon",
        "Postal code": "1000-001",
        "Country code": "PT",
      },
      "Continue privately",
    );
    assert.equal((await result()).success, true);
    assert.equal(
      await inPage(
        "document.querySelector('[name=address1]').value === '1 Fixture Street' && document.querySelector('[name=country]').value === 'PT' && document.querySelector('[name=postalCode]').value === '1000-001'",
      ),
      true,
    );
  });
  await step("agent card fill requires a fresh non-recurring approval before writing", async () => {
    const card = (await items()).find((item) => item.kind === "payment");
    await inPage("document.querySelector('[name=cardNumber]').value=''; true");
    const decision = await agentTool("browser_vault", { action: "fill", handle: card.id });
    assert.equal(decision.error, "payment_declined");
    assert.equal(await inPage("document.querySelector('[name=cardNumber]').value === ''"), true);
    const approval = await desktop.evaluate(() => global.__privateQaAgentApproval);
    assert.equal(approval[3].allowAutoApprove, false);
    assert.equal(approval[3].noStandingApproval, true);
    assert.equal(approval[2].handle, card.id);
    assert.equal(approval[2].origin, origin);
    assert.equal(orders, 0);
  });
  await step(
    "agent tool blocks secret screenshots, honors cancellation, and keeps results model-safe",
    async () => {
      const result = await desktop.evaluate(
        async (_, { root, workspace, taskId }) => {
          const { BrowserTools } = process.mainModule.require(
            root + "/dist/electron/electron/agent/tools/browser-tools.js",
          );
          const daemon = { logEvent() {}, requestApproval: async () => false };
          const tools = new BrowserTools(workspace, daemon, taskId);
          const screenshot = await tools.executeTool("browser_screenshot", {});
          const snapshot = await tools.executeTool("browser_snapshot", {});
          return { screenshot, snapshot };
        },
        { root, workspace, taskId: task.id },
      );
      assert.equal(result.screenshot.success, false);
      for (const value of canaries) assert.equal(JSON.stringify(result).includes(value), false);
      await navigate("/login");
      await startCommand({ action: "save_login" });
      await main.getByRole("dialog").waitFor();
      await main.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal((await resultOrThrow()).success, false);
    },
  );
  await step(
    "no secret values in task events, workspace files, CLI argv or runtime logs",
    async () => {
      const events = await main.evaluate((id) => window.electronAPI.getTaskEvents(id), task.id);
      const metadata =
        JSON.stringify(events) +
        (await fs.readFile(cliLog, "utf8")) +
        (await fs.readFile(path.join(output, "runtime.log"), "utf8"));
      for (const value of canaries)
        assert.equal(metadata.includes(value), false, "secret canary in public output");
      let scannedFiles = 0;
      async function scan(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await scan(file);
          else if (entry.isFile()) {
            const bytes = await fs.readFile(file);
            for (const value of [...canaries, seed])
              assert.equal(
                bytes.includes(Buffer.from(value)),
                false,
                `secret canary persisted in ${entry.name}`,
              );
            scannedFiles++;
          }
        }
      }
      await scan(path.join(output, "profile"));
      await scan(path.join(output, "workspace"));
      assert.ok(scannedFiles > 0);
      const approvals = await desktop.evaluate(() => global.__privateQaApprovals);
      assert.ok(approvals.some((a) => a.message === "Fill this payment card?"));
      assert.equal(orders, 0);
    },
  );
} catch (error) {
  console.error(`Private browser QA failed: ${error.message}`);
  await main?.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        fixtureOrigin: origin,
        syntheticManagers: true,
        nativeApprovalDecisionsStubbed: true,
        results,
        orders,
      },
      null,
      2,
    ),
  );
  await desktop?.close().catch(() => {});
  server.close();
  console.log(`Evidence: ${output}`);
}
async function resultOrThrow() {
  return result();
}
