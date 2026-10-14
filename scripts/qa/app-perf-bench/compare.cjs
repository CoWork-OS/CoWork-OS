// Pool runs of A files vs B files and print medians per metric.
const fs = require("fs");
const [aGlob, bGlob, filter = ""] = process.argv.slice(2);
const load = (list) => list.split(",").flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")).runs);
const A = load(aGlob),
  B = load(bGlob);
const med = (xs) => {
  xs = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
};
const metrics = {};
const add = (side, key, v) => {
  (metrics[key] ||= { A: [], B: [] })[side].push(v);
};
for (const [side, runs] of [
  ["A", A],
  ["B", B],
])
  for (const r of runs) {
    if (r.startup) {
      add(side, "startup.window", r.startup.windowAt);
      add(side, "startup.sidebar_ready", r.startup.marks?.sidebar_ready);
      add(side, "startup.fcp", r.startup.fcp);
    }
    for (const [k, v] of Object.entries(r.screens || {})) {
      add(side, `screen.${k}.settled`, v.settled);
      add(side, `screen.${k}.firstChange`, v.firstChange);
      add(side, `screen.${k}.maxFrameGap`, v.maxFrameGap);
    }
    for (const [k, v] of Object.entries(r.tasks || {})) {
      for (const m of ["firstRows", "settled", "longTaskMs"]) add(side, `task.${k}.${m}`, v[m]);
    }
    for (const [k, v] of Object.entries(r.scroll || {}))
      if (typeof v === "number") add(side, `scroll.${k}`, v);
  }
console.log("metric".padEnd(52), "A(base)".padStart(9), "B(new)".padStart(9), "  n");
for (const [k, v] of Object.entries(metrics)) {
  if (filter && !k.includes(filter)) continue;
  console.log(
    k.padEnd(52),
    String(med(v.A)).padStart(9),
    String(med(v.B)).padStart(9),
    `  ${v.A.length}/${v.B.length}`,
  );
}
