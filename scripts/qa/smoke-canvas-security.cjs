// Run after build:electron using the Electron binary, with ELECTRON_RUN_AS_NODE unset.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const dns = require("node:dns").promises;
const { app, BrowserWindow, session } = require("electron");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-canvas-security-"));
process.env.COWORK_USER_DATA_DIR = temporary;
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
const { CanvasManager } = require("../../dist/electron/electron/canvas/canvas-manager.js");
const { registerCanvasScheme, registerCanvasProtocol } = require("../../dist/electron/electron/canvas/canvas-protocol.js");
registerCanvasScheme();
let server;
let manager;
let host;
const deadline = setTimeout(() => { console.error("Canvas security smoke timed out"); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  registerCanvasProtocol();
  const requests = [];
  server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}/denied-redirect` });
      res.end();
    } else { res.setHeader("Content-Type", "text/html"); res.end("<h1>Allowed remote content</h1>"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let workspace = { id: "workspace", path: temporary, permissions: { network: false } };
  manager = CanvasManager.getInstance();
  manager.setWorkspaceResolver(() => workspace);
  const canvas = await manager.createSession("task", "workspace");
  const html = `<h1 id="offline">Offline canvas works</h1><img src="${url}/image"><script>fetch('${url}/script').catch(()=>{});</script>`;
  await manager.pushContent(canvas.id, html);
  assert.equal(await manager.evalScript(canvas.id, `fetch('${url}/eval').then(r=>r.ok,()=>false)`), false);
  assert.equal(requests.length, 0);
  assert.match(await manager.evalScript(canvas.id, "document.body.textContent"), /Offline canvas works/);
  assert.ok((await manager.takeSnapshot(canvas.id)).imageBase64.length > 0);

  host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  host.webContents.on("will-attach-webview", (_event, prefs, params) => manager.prepareWebview(prefs, params));
  host.webContents.on("did-attach-webview", (_event, guest) => manager.attachWebviewNetworkGuards(guest));
  // Deliberately omit partition: the main-process attachment guard must force it.
  await host.loadURL(`data:text/html,${encodeURIComponent(`<webview id="preview" src="canvas://${canvas.id}/index.html" style="width:500px;height:300px"></webview>`)}`);
  await host.webContents.executeJavaScript(`new Promise(resolve => {
    const view = document.getElementById('preview');
    if (view.getWebContentsId()) resolve(); else view.addEventListener('dom-ready', resolve, {once:true});
  })`);
  const guest = require("electron").webContents.fromId(await host.webContents.executeJavaScript("document.getElementById('preview').getWebContentsId()"));
  assert.equal(guest.session, session.fromPartition(`canvas-${canvas.id}`));
  assert.equal(await guest.executeJavaScript(`fetch('${url}/webview').then(r=>r.ok,()=>false)`), false);
  assert.equal(requests.length, 0);

  workspace.permissions = { network: true, accessNetworkMode: "on-request" };
  assert.equal(await guest.executeJavaScript(`fetch('${url}/unapproved').then(r=>r.ok,()=>false)`), false);
  assert.equal(requests.length, 0);
  await manager.openUrl(canvas.id, `${url}/approved`, { show: false, authorizedNetwork: true });
  assert.equal(await guest.executeJavaScript(`fetch('${url}/approved-resource').then(r=>r.ok,()=>false)`), true);
  assert.ok(requests.includes("/approved-resource"));

  workspace.permissions = { network: true, accessNetworkMode: "allowlist", accessDomainRules: [{ pattern: "127.0.0.1", access: "allow" }] };
  assert.equal(await guest.executeJavaScript(`fetch('${url}/redirect').then(r=>r.ok,()=>false)`), false);
  assert.equal(requests.includes("/denied-redirect"), false);

  workspace.permissions = { network: true };
  const originalLookup = dns.lookup;
  dns.lookup = async (hostname, options) => hostname === "private.example"
    ? [{ address: "169.254.169.254", family: 4 }] : originalLookup(hostname, options);
  try {
    assert.equal(await guest.executeJavaScript(`fetch('http://private.example/metadata').then(r=>r.ok,()=>false)`), false);
  } finally { dns.lookup = originalLookup; }
  const before = requests.length;
  workspace = undefined;
  assert.equal(await guest.executeJavaScript(`fetch('${url}/restored-missing-owner').then(r=>r.ok,()=>false)`), false);
  assert.equal(requests.length, before);

  const unbound = new BrowserWindow({ show: false });
  await unbound.loadURL(`canvas://${canvas.id}/index.html`);
  assert.match(await unbound.webContents.executeJavaScript("document.body.textContent"), /Forbidden/);
  unbound.destroy();
  console.log("Canvas security smoke passed: HTML/eval/webview denial, offline snapshot, approved origin, redirect/DNS denial, missing owner, unbound protocol");
}).then(async () => {
  host?.destroy();
  await manager?.cleanup();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
  clearTimeout(deadline);
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  host?.destroy();
  await manager?.cleanup().catch(() => {});
  server?.closeAllConnections();
  server?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
  clearTimeout(deadline);
  app.exit(1);
});
