// CoWork OS performance benchmark: startup, screen switches, task open, older-history scroll.
// Drives the real Electron app with Playwright on a copy of a seeded profile per launch.
//
//   ELECTRON_RUN_AS_NODE=1 COWORK_USER_DATA_DIR=<tpl> NODE_ENV=test electron seed.cjs <repo>
//   node warm.mjs <repo> <tpl> 45000      # once or twice: lets one-time migrations finish
//   node bench.mjs <repo> <tpl> <label> [runs]
//
// Env: BENCH_SCENARIOS=startup,screens,tasks,scroll  BENCH_PROBE=1 (main-process phases)
//      BENCH_IDLE_MS (wait before interactions)  BENCH_RENDER_PROF=<file> (scroll CPU profile)
//      BENCH_KEYCHAIN=mock|off (see keychain-env.mjs; warm the template in the same mode)
// Results land in ./results/<label>.json; compare.cjs and startup-ab.cjs summarize A/B sets.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { applyKeychainEnv } from "./keychain-env.mjs";

const [root, template, label = "run", runsArg = "5"] = process.argv.slice(2);
const RUNS = Number(runsArg);
const SCENARIOS = (process.env.BENCH_SCENARIOS || "startup,screens,tasks,scroll").split(",");
const require = createRequire(path.join(root, "package.json"));
const { _electron: electron } = require("playwright");
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "results");
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function freshProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bench-"));
  // APFS clone: instant, identical bytes every run.
  execFileSync("cp", ["-cR", `${template}/.`, dir]);
  return dir;
}

async function launch(profile) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    COWORK_USER_DATA_DIR: profile,
    COWORK_IMPORT_ENV_SETTINGS: "0",
    COWORK_DEV_LOG_CAPTURE: "1",
    COWORK_DISABLE_UPDATE_CHECK: "1",
    COWORK_DEV_BRAND_APP: "0",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  applyKeychainEnv(env);
  if (process.env.BENCH_PROBE === "1")
    env.NODE_OPTIONS = `--require=${path.join(path.dirname(new URL(import.meta.url).pathname), "probe.cjs")}`;
  const logs = [];
  env.BENCH_PROBE_FILE = path.join(profile, "probe.log");
  const t0 = Date.now();
  const app = await electron.launch({
    args: [
      ...(process.env.BENCH_PROBE === "1"
        ? ["-r", path.join(path.dirname(new URL(import.meta.url).pathname), "probe.cjs")]
        : []),
      root,
      "--user-data-dir",
      profile,
    ],
    cwd: root,
    env,
    timeout: 120_000,
  });
  const onData = (d) => {
    const at = Date.now() - t0;
    for (const line of String(d).split(/\r?\n/)) if (line) logs.push({ at, line });
  };
  app.process().stdout?.on("data", onData);
  app.process().stderr?.on("data", onData);
  let main;
  let windowAt = null;
  for (let i = 0; i < 2400 && !main; i++) {
    main = app.windows().find((p) => p.url().includes("/renderer/index.html"));
    if (main && windowAt == null) windowAt = Date.now() - t0;
    if (!main) await sleep(50);
  }
  if (!main) throw new Error("main window not found");
  return { app, main, t0, logs, windowAt };
}

async function waitStartup(main, t0) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = await main
      .evaluate(() => {
        const st = window.__coworkRendererPerfState__;
        const marks = st
          ? Object.fromEntries([...st.startupMarks.values()].map((m) => [m.name, m.atMs]))
          : {};
        const rows = document.querySelectorAll(".cli-task-item").length;
        const nav = performance.getEntriesByType("navigation")[0];
        const paints = Object.fromEntries(
          performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]),
        );
        return {
          timeOrigin: performance.timeOrigin,
          marks,
          rows,
          dcl: nav?.domContentLoadedEventEnd ?? null,
          load: nav?.loadEventEnd ?? null,
          paints,
          now: performance.now(),
        };
      })
      .catch(() => null);
    if (r && r.marks.sidebar_ready != null && r.rows > 0) {
      const off = r.timeOrigin - t0; // renderer clock -> ms since launch
      const rel = (v) => (v == null ? null : Math.round(v + off));
      return {
        rendererStart: Math.round(off),
        dcl: rel(r.dcl),
        fcp: rel(r.paints["first-contentful-paint"]),
        marks: Object.fromEntries(Object.entries(r.marks).map(([k, v]) => [k, rel(v)])),
        rows: r.rows,
      };
    }
    await sleep(25);
  }
  throw new Error("startup timed out");
}

// Measure a UI action: click, then first DOM change and the moment DOM settles (300 ms quiet).
async function measureAction(
  main,
  clickExpr,
  { quietMs = 300, maxMs = 15_000, readyExpr = null } = {},
) {
  return main.evaluate(
    async ({ clickExpr, quietMs, maxMs, readyExpr }) => {
      const target = document.body;
      let first = null;
      let last = null;
      let longTasks = 0;
      let longTaskMs = 0;
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longTasks++;
          longTaskMs += e.duration;
        }
      });
      try {
        po.observe({ type: "longtask", buffered: false });
      } catch {}
      let maxGap = 0;
      let prev = performance.now();
      let raf = 0;
      const loop = () => {
        const n = performance.now();
        maxGap = Math.max(maxGap, n - prev);
        prev = n;
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      const mo = new MutationObserver((list) => {
        // The Home composer's rotating placeholder animates forever; it is not loading.
        const relevant = list.some((m) => {
          const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          return !el?.closest?.(".cli-rotating-placeholder");
        });
        if (!relevant) return;
        const n = performance.now();
        if (first == null) first = n;
        last = n;
      });
      mo.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false,
      });
      const start = performance.now();
      // eslint-disable-next-line no-new-func
      new Function(clickExpr)();
      let readyAt = null;
      await new Promise((resolve) => {
        const tick = () => {
          const n = performance.now();
          if (readyExpr && readyAt == null) {
            // eslint-disable-next-line no-new-func
            if (new Function(`return (${readyExpr})`)()) readyAt = n;
          }
          const quiet = last != null && n - last >= quietMs && (!readyExpr || readyAt != null);
          if (quiet || n - start > maxMs) return resolve();
          setTimeout(tick, 16);
        };
        setTimeout(tick, 16);
      });
      mo.disconnect();
      po.disconnect();
      cancelAnimationFrame(raf);
      return {
        firstChange: first == null ? null : Math.round(first - start),
        settled: last == null ? null : Math.round(last - start),
        ready: readyAt == null ? null : Math.round(readyAt - start),
        longTasks,
        longTaskMs: Math.round(longTaskMs),
        maxFrameGap: Math.round(maxGap),
      };
    },
    { clickExpr, quietMs, maxMs, readyExpr },
  );
}

const SCREENS = ["work", "team", "inbox", "agents", "automations", "library", "gitChanges", "home"];

async function screens(main) {
  const out = {};
  // Two passes: cold (first open, lazy chunk + data) and warm (re-open).
  for (const pass of ["cold", "warm"]) {
    for (const id of SCREENS) {
      const exists = await main.evaluate(
        (id) => !!document.querySelector(`[data-destination="${id}"]`),
        id,
      );
      if (!exists) continue;
      const r = await measureAction(
        main,
        `document.querySelector('[data-destination="${id}"]').click()`,
      );
      out[`${pass}:${id}`] = r;
      await sleep(400);
    }
    // Settings
    const r = await measureAction(
      main,
      `(document.querySelector('button.sidebar-rail-btn[aria-label^="Settings"]')||{click(){}}).click()`,
    );
    out[`${pass}:settings`] = r;
    await sleep(400);
    await main.evaluate(() => document.querySelector('[data-destination="home"]')?.click());
    await sleep(600);
  }
  return out;
}

async function openTask(main, title) {
  await main.evaluate(() => document.querySelector('[data-destination="home"]')?.click());
  await sleep(600);
  return main.evaluate(async (title) => {
    const rows = [...document.querySelectorAll(".cli-task-item")];
    const row = rows.find((r) => (r.textContent || "").includes(title));
    if (!row) return { error: `row not found: ${title}`, rows: rows.length };
    row.scrollIntoView({ block: "center" });
    const before = new Set(
      [...document.querySelectorAll("[data-task-feed-row]")].map((e) =>
        e.getAttribute("data-task-feed-row"),
      ),
    );
    let longTaskMs = 0;
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTaskMs += e.duration;
    });
    try {
      po.observe({ type: "longtask" });
    } catch {}
    let last = null;
    const mo = new MutationObserver(() => {
      last = performance.now();
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    const t = performance.now();
    row.click();
    let headerAt = null,
      rowsAt = null;
    const titleOk = () =>
      [...document.querySelectorAll("header, .title-bar, [class*='title']")].some((h) =>
        (h.textContent || "").includes(title),
      );
    while (performance.now() - t < 15000) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      const n = performance.now();
      if (headerAt == null && titleOk()) headerAt = n - t;
      if (rowsAt == null) {
        const now = [...document.querySelectorAll("[data-task-feed-row]")];
        if (now.length > 0 && now.some((e) => !before.has(e.getAttribute("data-task-feed-row"))))
          rowsAt = n - t;
      }
      if (rowsAt != null && last != null && n - last > 300) break;
    }
    mo.disconnect();
    po.disconnect();
    return {
      header: headerAt == null ? null : Math.round(headerAt),
      firstRows: rowsAt == null ? null : Math.round(rowsAt),
      settled: last == null ? null : Math.round(last - t),
      longTaskMs: Math.round(longTaskMs),
      feedRows: document.querySelectorAll("[data-task-feed-row]").length,
      domNodes: document.getElementsByTagName("*").length,
      heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    };
  }, title);
}

// Scroll a heavy session from its newest content back toward its start with real wheel
// input (the feed only unpins from the bottom on reader input), measuring frame pacing
// and how long older history takes to appear at the top.
async function scrollHistory(main, budgetMs = 40000) {
  await main
    .waitForFunction(
      () => {
        let el = document.querySelector("[data-task-feed-row]");
        while (el) {
          const s = getComputedStyle(el);
          if (
            (s.overflowY === "auto" || s.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight
          )
            return true;
          el = el.parentElement;
        }
        return false;
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  const box = await main.evaluate(() => {
    let el = document.querySelector("[data-task-feed-row]");
    while (el) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight)
        break;
      el = el.parentElement;
    }
    if (!el) return null;
    el.setAttribute("data-bench-scroller", "1");
    const r = el.getBoundingClientRect();
    const st = {
      frames: [],
      seen: new Set(),
      loads: [],
      topSince: null,
      longTasks: 0,
      longTaskMs: 0,
      startedAt: performance.now(),
      lastFreshAt: null,
      framesUntilStart: null,
    };
    for (const e of document.querySelectorAll("[data-task-feed-row]"))
      st.seen.add(e.getAttribute("data-task-feed-row"));
    let prev = performance.now();
    const loop = () => {
      const n = performance.now();
      st.frames.push(n - prev);
      prev = n;
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
    st.po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        st.longTasks++;
        st.longTaskMs += e.duration;
      }
    });
    st.po.observe({ type: "longtask" });
    window.__benchScroll = st;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!box) return { error: "no scroller" };
  await main.mouse.move(box.x, box.y);
  const start = Date.now();
  let idleChecks = 0;
  let steps = 0;
  while (Date.now() - start < budgetMs) {
    await main.mouse.wheel(0, -500);
    steps++;
    await sleep(16);
    const s = await main.evaluate(() => {
      const st = window.__benchScroll;
      const sc = document.querySelector("[data-bench-scroller]");
      let fresh = 0;
      for (const e of document.querySelectorAll("[data-task-feed-row]")) {
        const k = e.getAttribute("data-task-feed-row");
        if (!st.seen.has(k)) {
          st.seen.add(k);
          fresh++;
        }
      }
      if (fresh > 0) {
        st.lastFreshAt = performance.now();
        st.framesUntilStart = st.frames.length;
      }
      const atTop = !sc || sc.scrollTop <= 2;
      const n = performance.now();
      if (atTop && st.topSince == null) st.topSince = n;
      if (fresh > 0 && st.topSince != null) {
        st.loads.push(n - st.topSince);
        st.topSince = null;
      }
      if (!atTop) st.topSince = null;
      return { atTop, fresh };
    });
    if (s.atTop && s.fresh === 0) {
      if (++idleChecks > 120) break; // ~4 s at the top with nothing older: reached the start
    } else idleChecks = 0;
  }
  return main.evaluate(
    ({ elapsed, steps, reachedStart }) => {
      const st = window.__benchScroll;
      cancelAnimationFrame(st.raf);
      st.po.disconnect();
      // Frame and long-task stats cover the scroll up to the session start, not the idle wait.
      const active =
        st.framesUntilStart == null ? st.frames : st.frames.slice(0, st.framesUntilStart);
      const sorted = active.slice().sort((a, b) => a - b);
      const p = (q) =>
        Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0);
      const ls = st.loads.slice().sort((a, b) => a - b);
      return {
        elapsedMs: elapsed,
        toStartMs: st.lastFreshAt == null ? null : Math.round(st.lastFreshAt - st.startedAt),
        reachedFirstEvent: [...st.seen].some(
          (k) => /^event:ev-\d+-0$/.test(k) || /turn:ev-\d+-0$/.test(k),
        ),
        reachedStart,
        steps,
        rowsSeen: st.seen.size,
        olderLoads: st.loads.length,
        olderLoadMedianMs: Math.round(ls[Math.floor(ls.length / 2)] || 0),
        olderLoadP95Ms: Math.round(ls[Math.min(ls.length - 1, Math.floor(ls.length * 0.95))] || 0),
        frameP50: p(0.5),
        frameP95: p(0.95),
        frameP99: p(0.99),
        frameMax: Math.round(sorted[sorted.length - 1] || 0),
        jankFrames: active.filter((f) => f > 50).length,
        longTasks: st.longTasks,
        longTaskMs: Math.round(st.longTaskMs),
        domNodes: document.getElementsByTagName("*").length,
        heapMb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
      };
    },
    { elapsed: Date.now() - start, steps, reachedStart: idleChecks > 120 },
  );
}

const results = { label, runs: [] };
for (let run = 0; run < RUNS; run++) {
  const profile = freshProfile();
  const { app, main, t0, logs, windowAt } = await launch(profile);
  const r = { run };
  try {
    r.startup = { windowAt, ...(await waitStartup(main, t0)) };
    await main.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
    await sleep(Number(process.env.BENCH_IDLE_MS || 1500)); // let deferred startup work run first
    if (SCENARIOS.includes("screens")) r.screens = await screens(main);
    if (SCENARIOS.includes("tasks")) {
      r.tasks = {};
      for (const t of [
        "Bench heavy session 1",
        "Bench heavy session 2",
        "Bench heavy session 3",
        "Bench session 7:",
        "Bench session 12:",
        "Bench heavy session 1",
      ]) {
        r.tasks[`${t}#${Object.keys(r.tasks).length}`] = await openTask(main, t);
        await sleep(300);
      }
    }
    if (SCENARIOS.includes("scroll")) {
      await openTask(main, "Bench heavy session 1");
      await sleep(800);
      let cdp = null;
      if (process.env.BENCH_RENDER_PROF) {
        cdp = await main.context().newCDPSession(main);
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
        await cdp.send("Profiler.start");
      }
      r.scroll = await scrollHistory(main);
      if (cdp) {
        const { profile } = await cdp.send("Profiler.stop");
        fs.writeFileSync(process.env.BENCH_RENDER_PROF, JSON.stringify(profile));
      }
    }
  } catch (e) {
    r.error = String(e?.stack || e);
  } finally {
    r.mainLogs = logs
      .filter((l) =>
        /DAEMONPROF|PROBE|StartupLane|Startup phase|Startup complete|Deferred startup|DbSlow/i.test(
          l.line,
        ),
      )
      .slice(0, 200);
    await app.close().catch(() => {});
    try {
      r.probe = fs.readFileSync(path.join(profile, "probe.log"), "utf8").trim().split("\n");
    } catch {}
    fs.rmSync(profile, { recursive: true, force: true });
  }
  results.runs.push(r);
  console.log(JSON.stringify({ run, startup: r.startup, error: r.error }));
}

// Summaries (medians across runs).
const summary = {};
const put = (k, xs) => (summary[k] = median(xs));
const S = results.runs.filter((r) => r.startup);
put(
  "startup.window",
  S.map((r) => r.startup.windowAt),
);
put(
  "startup.rendererStart",
  S.map((r) => r.startup.rendererStart),
);
put(
  "startup.dcl",
  S.map((r) => r.startup.dcl),
);
put(
  "startup.fcp",
  S.map((r) => r.startup.fcp),
);
for (const k of ["app_shell_ready", "sidebar_ready", "main_content_ready", "home_ready"]) {
  put(
    `startup.${k}`,
    S.map((r) => r.startup.marks?.[k]),
  );
}
const screenKeys = new Set(results.runs.flatMap((r) => Object.keys(r.screens || {})));
for (const k of screenKeys) {
  put(
    `screen.${k}.settled`,
    results.runs.map((r) => r.screens?.[k]?.settled),
  );
  put(
    `screen.${k}.longTaskMs`,
    results.runs.map((r) => r.screens?.[k]?.longTaskMs),
  );
}
const taskKeys = new Set(results.runs.flatMap((r) => Object.keys(r.tasks || {})));
for (const k of taskKeys) {
  for (const m of ["header", "firstRows", "settled", "longTaskMs"]) {
    put(
      `task.${k}.${m}`,
      results.runs.map((r) => r.tasks?.[k]?.[m]),
    );
  }
}
for (const m of [
  "toStartMs",
  "steps",
  "rowsSeen",
  "olderLoads",
  "olderLoadMedianMs",
  "olderLoadP95Ms",
  "frameP50",
  "frameP95",
  "frameP99",
  "frameMax",
  "jankFrames",
  "longTaskMs",
  "domNodes",
  "heapMb",
]) {
  put(
    `scroll.${m}`,
    results.runs.map((r) => r.scroll?.[m]),
  );
}
results.summary = summary;
const file = path.join(outDir, `${label}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("wrote", file);
