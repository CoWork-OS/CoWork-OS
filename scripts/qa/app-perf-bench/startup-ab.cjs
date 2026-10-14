const fs = require("fs");
// Usage: node startup-ab.cjs <resultsDir> [baselinePrefix=fin-A-] [candidatePrefix=fin-B-]
const [dir, prefixA = "fin-A-", prefixB = "fin-B-"] = process.argv.slice(2);
const pick = (prefix) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .flatMap((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).runs);
const med = (xs) => {
  xs = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
};
const g = (r, k) => {
  const l = (r.probe || []).find((x) => x.includes(k));
  return l ? +l.split(" ")[2] : NaN;
};
const lane = (r, ev) => {
  for (const l of r.mainLogs || []) {
    const m = /StartupLane\] (\{.*\})/.exec(l.line);
    if (m) {
      const j = JSON.parse(m[1]);
      if (j.event === ev) return j.elapsedMs;
    }
  }
  return NaN;
};
const rows = (runs) => ({
  "module load (main.js)": med(runs.map((r) => g(r, "main_js_evaluated") - g(r, "main_js_start"))),
  "files loaded at startup": med(
    runs.map(
      (r) =>
        +(((r.probe || []).find((x) => x.includes("cache files")) || "").match(/files=(\d+)/) ||
          [])[1],
    ),
  ),
  "blocking init (lane start→complete)": med(runs.map((r) => lane(r, "complete"))),
  "window created": med(runs.map((r) => r.startup?.windowAt)),
  "first contentful paint": med(runs.map((r) => r.startup?.fcp)),
  "sidebar ready": med(runs.map((r) => r.startup?.marks?.sidebar_ready)),
});
const A = rows(pick(prefixA)),
  Bv = rows(pick(prefixB));
for (const k of Object.keys(A))
  console.log(
    k.padEnd(38),
    String(A[k]).padStart(6),
    String(Bv[k]).padStart(6),
    A[k] ? `${Math.round((1 - Bv[k] / A[k]) * 100)}%` : "",
  );
