// Preloaded into the Electron main process (electron -r probe.cjs) to time startup phases.
const Module = require("node:module");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const t = () => Math.round(performance.now());
const file = process.env.BENCH_PROBE_FILE;
const out = (msg) => {
  const line = `[PROBE] ${msg}\n`;
  if (file) fs.appendFileSync(file, line);
  else process.stderr.write(line);
};
out(`probe_loaded ${t()}`);
if (process.env.BENCH_COMPILE_CACHE) {
  const r = Module.enableCompileCache(process.env.BENCH_COMPILE_CACHE);
  out(`compile_cache ${r.status} ${t()}`);
}
let session = null;
if (process.env.BENCH_CPUPROF) {
  const inspector = require("node:inspector");
  session = new inspector.Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: 200 });
  session.post("Profiler.start");
}
const stopProfile = () => {
  if (!session) return;
  const s = session;
  session = null;
  s.post("Profiler.stop", (err, res) => {
    if (!err) fs.writeFileSync(process.env.BENCH_CPUPROF, JSON.stringify(res.profile));
    out(`profile_written ${t()} ${err || ""}`);
    s.disconnect();
  });
};
let count = 0;
const origLoad = Module._load;
const edges = [];
Module._load = function (request, parent) {
  count++;
  if (process.env.BENCH_EDGES && parent && parent.filename) {
    try {
      edges.push([parent.filename, Module._resolveFilename(request, parent)]);
    } catch {}
  }
  const isEntry = /dist\/electron\/electron\/main\.js$/.test(String(request));
  if (isEntry) out(`main_js_start ${t()}`);
  try {
    return origLoad.apply(this, arguments);
  } finally {
    if (isEntry) {
      out(`main_js_evaluated ${t()} modules=${count}`);
      const files = Object.keys(require.cache);
      out(
        `cache files=${files.length} nm=${files.filter((f) => f.includes("/node_modules/")).length}`,
      );
      if (process.env.BENCH_CPUPROF_UNTIL !== "window") stopProfile();
      if (process.env.BENCH_EDGES) fs.writeFileSync(process.env.BENCH_EDGES, JSON.stringify(edges));
    }
  }
};
try {
  const { app } = require("electron");
  app.whenReady().then(() => out(`when_ready ${t()}`));
  let windows = 0;
  app.on("browser-window-created", (_e, w) => {
    windows++;
    const n = windows;
    out(`browser_window_created ${t()} n=${n}`);
    // The first window is the hidden keychain-prime window; the second is the app.
    if (n === 2 && process.env.BENCH_CPUPROF_UNTIL === "window") stopProfile();
    w.webContents.once("did-finish-load", () => out(`did_finish_load ${t()} n=${n}`));
  });
} catch (e) {
  out(`probe_error ${e}`);
}
