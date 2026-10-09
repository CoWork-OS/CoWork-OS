/**
 * Model guidance for native answer surfaces. Shared by chat mode and task mode so both
 * describe the same component vocabulary. The examples are parsed and linted by tests.
 */

export const ANSWER_SURFACE_EXAMPLES = {
  calculator: {
    type: "card",
    theme: "ocean",
    style: "gradient",
    icon: "piggy-bank",
    eyebrow: "Savings plan",
    title: "Reach your goal",
    computed: {
      months: "years * 12",
      r: "rate / 100 / 12",
      growth: "pow(1 + r, months)",
      need: "goal - start * growth",
      monthly: "max(0, r == 0 ? need / months : need * r / (growth - 1))",
    },
    children: [
      {
        type: "hero",
        title: "Save each month",
        value: { expr: "monthly", decimals: 0, prefix: "$" },
        caption: "for {{years}} years at {{rate}}% a year",
        icon: "target",
      },
      {
        type: "grid",
        columns: 2,
        children: [
          { type: "number", id: "goal", label: "Goal", default: 50000, min: 0, prefix: "$" },
          { type: "number", id: "start", label: "Saved so far", default: 0, min: 0, prefix: "$" },
        ],
      },
      {
        type: "stepper",
        id: "years",
        label: "Timeline",
        min: 1,
        max: 40,
        default: 5,
        unit: "years",
      },
      {
        type: "slider",
        id: "rate",
        label: "Annual return",
        min: 0,
        max: 10,
        step: 0.5,
        default: 4,
        unit: "%",
      },
      {
        type: "metrics",
        style: "colorful",
        items: [
          {
            label: "You put in",
            value: { expr: "monthly * months + start", decimals: 0, prefix: "$" },
            icon: "wallet",
          },
          {
            label: "Interest earned",
            value: { expr: "max(0, goal - monthly * months - start)", decimals: 0, prefix: "$" },
            icon: "sparkles",
          },
        ],
      },
    ],
  },
  chart: {
    type: "stack",
    theme: "violet",
    children: [
      {
        type: "metrics",
        items: [
          {
            label: "Invested at 7%",
            value: { value: 76123, prefix: "$" },
            delta: "+661%",
            icon: "trending-up",
            tone: "purple",
          },
          {
            label: "Kept as cash",
            value: { value: 10000, prefix: "$" },
            caption: "No growth",
            icon: "wallet",
            tone: "gray",
          },
        ],
      },
      {
        type: "chart",
        kind: "area",
        title: "Growth vs. cash, by year",
        prefix: "$",
        labels: ["0", "5", "10", "15", "20", "25", "30"],
        series: [
          { name: "Invested at 7%", values: [10000, 14026, 19672, 27590, 38697, 54274, 76123] },
          {
            name: "Cash",
            style: "muted",
            values: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
          },
        ],
      },
    ],
  },
  plan: {
    type: "card",
    theme: "sunset",
    title: "Weekend in Lisbon",
    subtitle: "Two easy days, mostly on foot",
    children: [
      {
        type: "gallery",
        images: [
          "Lisbon yellow tram 28 on a steep street",
          "Belém tower at sunset",
          "pastel de nata on a plate",
        ],
      },
      {
        type: "tabs",
        tabs: [
          {
            label: "Saturday",
            icon: "sun",
            children: [
              {
                type: "timeline",
                items: [
                  {
                    time: "9:00",
                    title: "Tram 28 to Alfama",
                    text: "Go early to get a seat.",
                    icon: "train",
                  },
                  { time: "12:30", title: "Lunch at Time Out Market", icon: "utensils" },
                  {
                    time: "18:00",
                    title: "Sunset at Miradouro da Senhora do Monte",
                    icon: "sunset",
                  },
                ],
              },
            ],
          },
          {
            label: "Sunday",
            icon: "compass",
            children: [
              {
                type: "timeline",
                items: [
                  { time: "10:00", title: "Belém and the monastery", icon: "landmark" },
                  { time: "15:00", title: "LX Factory", icon: "shopping-bag" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "tags",
        items: [
          "Walkable",
          { label: "Hilly", tone: "orange" },
          { label: "Great food", tone: "pink" },
        ],
      },
    ],
  },
  mortgage: {
    type: "card",
    theme: "forest",
    icon: "home",
    eyebrow: "Mortgage",
    title: "Your repayment plan",
    logic: {
      outputs: ["payment", "interest", "total", "yearLabels", "balances", "schedule"],
      code: 'function compute(s) {\n  const r = s.rate / 100 / 12, n = s.years * 12;\n  const payment = r === 0 ? s.principal / n : (s.principal * r) / (1 - Math.pow(1 + r, -n));\n  let balance = s.principal, interest = 0;\n  const yearLabels = ["0"], balances = [s.principal], schedule = [];\n  for (let y = 1; y <= s.years; y++) {\n    let yearInterest = 0, yearPrincipal = 0;\n    for (let m = 0; m < 12; m++) {\n      const i = balance * r, p = Math.min(balance, payment - i);\n      balance -= p; yearInterest += i; yearPrincipal += p;\n    }\n    interest += yearInterest;\n    yearLabels.push(String(y)); balances.push(Math.round(balance));\n    if (y % 5 === 0 || y === s.years) schedule.push(["Year " + y, Math.round(yearInterest), Math.round(yearPrincipal), Math.round(balance)]);\n  }\n  return { payment, interest, total: payment * n, yearLabels, balances, schedule };\n}',
    },
    children: [
      {
        type: "hero",
        title: "Monthly payment",
        value: { expr: "payment", decimals: 0, prefix: "$" },
        caption: "{{years}} years at {{rate}}%",
        icon: "home",
      },
      {
        type: "grid",
        columns: 2,
        children: [
          {
            type: "number",
            id: "principal",
            label: "Loan",
            default: 300000,
            min: 1000,
            prefix: "$",
          },
          {
            type: "stepper",
            id: "years",
            label: "Term",
            min: 5,
            max: 40,
            step: 5,
            default: 25,
            unit: "years",
          },
        ],
      },
      {
        type: "slider",
        id: "rate",
        label: "Interest rate",
        min: 0,
        max: 10,
        step: 0.1,
        default: 5.5,
        unit: "%",
      },
      {
        type: "metrics",
        style: "colorful",
        items: [
          {
            label: "Total interest",
            value: { expr: "interest", decimals: 0, prefix: "$" },
            icon: "percent",
            tone: "orange",
          },
          {
            label: "Total paid",
            value: { expr: "total", decimals: 0, prefix: "$" },
            icon: "wallet",
            tone: "green",
          },
        ],
      },
      {
        type: "chart",
        kind: "area",
        title: "Balance by year",
        prefix: "$",
        labels: { bind: "yearLabels" },
        series: [{ name: "Balance", values: { bind: "balances" } }],
      },
      {
        type: "table",
        columns: ["Year", "Interest", "Principal", "Balance"],
        rows: { bind: "schedule" },
      },
    ],
  },
  sales: {
    type: "card",
    theme: "violet",
    icon: "chart-bar",
    eyebrow: "Sales",
    title: "Revenue by region",
    data: { sales: "uploads/sales.csv" },
    logic: {
      outputs: ["total", "regions", "revenue", "top", "orders"],
      code: 'function compute(s, data) {\n  const byRegion = groupBy(records(data.sales), "Region");\n  const regions = Object.keys(byRegion).sort();\n  const revenue = regions.map((r) => sum(byRegion[r].map((row) => row.Revenue)));\n  const best = Math.max(...revenue);\n  return { total: sum(revenue), regions, revenue, top: regions[revenue.indexOf(best)] || "", orders: data.sales.rows.length };\n}',
    },
    children: [
      {
        type: "hero",
        title: "Total revenue",
        value: { expr: "total", decimals: 0, prefix: "$" },
        caption: "{{orders}} orders · top region {{top}}",
        icon: "trending-up",
      },
      {
        type: "chart",
        kind: "bar",
        prefix: "$",
        labels: { bind: "regions" },
        series: [{ name: "Revenue", values: { bind: "revenue" } }],
      },
    ],
  },
} as const;

const example = (value: unknown) => ["```cowork-ui", JSON.stringify(value), "```"].join("\n");

export const ANSWER_SURFACE_PROMPT = [
  "INTERACTIVE ANSWER COMPONENTS (cowork-ui):",
  "The app renders native, themed components inside your answer from fenced ```cowork-ui blocks. Use them when they make the answer faster to understand, act on or enjoy.",
  "- Good fits: calculators and planners (budgets, savings, quantities), side-by-side comparisons, charts of real numbers, itineraries and schedules, checklists, progress toward goals, photo-led inspiration (food, places, outfits, products).",
  "- Keep plain text for short facts, definitions, translations, rewrites, one-step arithmetic, code, and whenever the user asks for text only.",
  "- Shape: a short markdown heading and one or two short paragraphs, then usually ONE rich block (at most three). Don't repeat a block's numbers in prose. State assumptions briefly in prose or a muted text.",
  "",
  "DESIGN — make it look like a polished modern app, not a form:",
  "- Lead with the answer: put the key result first, as a `hero` (big number on a gradient) or `metrics`, then the inputs that change it, then detail.",
  "- Pick a `theme` on the outer card/stack that fits the topic: ocean (money, calm, travel by sea), violet (tech, creative), sunset (travel, food, fun), forest (health, nature, sustainability), ember (energy, urgency, sport), rose (lifestyle, beauty, celebrations), mono (serious, formal), accent (app default).",
  "- Use color with purpose: `icon` on cards, metrics, tiles, tabs and timeline steps; `tone` to tell items apart; `style: colorful` metrics for a row of highlights; `style: gradient` cards for the main block.",
  "- Make every value the user would change editable (`number` for amounts, `slider` for rates and percentages, `stepper` for small counts, `select` for choices). Never call something editable unless it is a control.",
  "- Group with `grid` (bento layouts via `spans`) and `tabs` instead of long single columns. Put context series in charts as `style: muted`.",
  "",
  "- Each block is one strict JSON object (double quotes, no comments). Formulas only read controls and `computed` names in the same block.",
  "- Components (`type`):",
  "  card {title?, eyebrow?, subtitle?, icon?, style?: plain|tinted|gradient, theme?, computed?, children[]} · stack {theme?, children[]}",
  "  grid {columns: 2|3|4, spans?: [n per child], children[]} · tabs {tabs: [{label, icon?, children[]}] (2-6)}",
  "  hero {title, value?, eyebrow?, caption?, icon?, delta?, style?: gradient|soft|image, image?} (headline result)",
  "  metrics {style?: cards|colorful|plain, items: [{label, value, icon?, tone?, delta?, direction?: up|down|flat, good?: up|down, caption?, spark?: [numbers]}]}",
  "  progress {style?: bar|ring, title?, items: [{label, value, max? (default 100), caption?, tone?}]}",
  "  timeline {title?, items: [{title, time?, text?, icon?, status?: done|current|upcoming, tone?}]}",
  "  tags {items: [label | {label, tone?, icon?}]} · heading {text} · text {text, tone?: muted} · callout {tone: info|tip|warning|success, title?, text} · divider",
  "  image {image, caption?, aspect?: wide|square|portrait} · gallery {layout: collage|grid|row, images[1-8]} · media_list {items: [{title, text?, meta?, badge?, image?}]}",
  "  tiles {items: [{title, subtitle?, icon? or emoji?, tone?}], selectable?, id?, caption?} · values {title?, items: [{label, value, note?}]} · table {columns[], rows[][], caption?}",
  "  chart {kind: bar|line|area|pie, labels[], series: [{name, values[], style?: solid|muted|dashed, tone?}], title?, prefix?, unit?, format?: number|compact|percent, stacked?, horizontal?, height?: sm|md|lg}",
  "  checklist {id, title?, items: [{id, text, time?, detail?}]} (ticks are saved)",
  "  number {id, label, default, min?, max?, step?, prefix?, unit?} · slider {id, label, min, max, step?, default, unit?, prefix?} · stepper {id, label, min, max, step?, default, unit?}",
  "  select {id, label, options: [{label, value}], default} · toggle {id, label, default} · copy {label, text}",
  "- Tones: accent, blue, teal, green, yellow, orange, red, pink, purple, gray. Icons (lowercase names): piggy-bank, wallet, coins, dollar, euro, pound, credit-card, receipt, chart-line, chart-bar, chart-pie, trending-up, trending-down, percent, calculator, target, trophy, flag, calendar, clock, timer, hourglass, sun, moon, cloud, rain, snowflake, thermometer, wind, droplet, flame, leaf, tree, sprout, mountain, waves, plane, car, train, bike, ship, map, map-pin, compass, globe, home, building, hotel, landmark, store, utensils, chef-hat, coffee, wine, pizza, apple, cake, shopping-cart, shopping-bag, gift, package, truck, heart, heart-pulse, activity, dumbbell, footprints, bed, brain, pill, baby, user, users, paw, music, film, camera, gamepad, ticket, party, book, graduation-cap, briefcase, laptop, smartphone, code, rocket, zap, lightbulb, sparkles, star, gem, crown, award, medal, shield, lock, key, bell, mail, message, phone, check, check-circle, info, alert, list-checks, layers, palette, shirt, scale, ruler, wrench, recycle, repeat, tent, umbrella, sunrise, sunset.",
  '- Values: a number, a string, or {"expr": "people * 0.4", "decimals": 1, "unit": "kg", "prefix": "£"} or {"value": 1200, "prefix": "$"}. Formulas read control ids (a checklist id gives its ticked count) and `computed` names; they support + - * / % ^, comparisons, && || !, cond ? a : b, min, max, round(x, d), ceil, floor, abs, sqrt, pow, exp, log, clamp. Any text may embed {{formula}}.',
  "- Formulas must give a number for every input in range: guard division (`r == 0 ? need / months : need * r / (growth - 1)`), and check the result at the defaults.",
  '- Logic: when formulas are not enough (loops, schedules and amortization, simulations, sorting or filtering lists), add "logic": {"outputs": [names], "code": "function compute(state) { … return {name: value} }"} on the block\'s outer object. `state` holds the control values by id. Return numbers, strings or booleans for formulas ({"expr": "payment"}), lists for chart labels and series values, and lists of rows for tables; bind lists with {"bind": "name"}. The code is plain JavaScript that runs offline in a sandbox: no network, DOM or imports; keep it deterministic and under a second. Use formulas for simple arithmetic.',
  '- Images: {"query": "roast leg of lamb with rosemary on a platter", "alt": "Roast lamb"}; the app finds a matching photo. Write a concrete visual description. For food, travel, places, outfits and products, photos make the answer: a 3-photo collage gallery near the top, a hero with style image, or a photo per media_list item. Never use images for abstract topics. Never invent image URLs; use "src" only for an https image URL a tool gave you.',
  "- Accuracy: use well-established ratios and real data. Do not invent prices, places, quotes or statistics; if key data is missing, give a useful partial answer with editable defaults or ask one focused question.",
  '- When the user later changes controls, their values come back to you as "Interactive answer state". Build on them.',
  '- Real data: when the user attached or the task produced a data file (CSV, TSV, XLSX or JSON), compute every number from it instead of typing values in. Add "data": {"sales": "uploads/sales.csv"} (the workspace-relative path you were given) beside "logic"; compute(state, data) gets data.sales = {columns, rows, totalRows, truncated} with numbers parsed, plus helpers records(table), column(table, name), sum(list), mean(list) and groupBy(list, key). The app reads the file and shows its name and row count under the answer. Use only columns you have actually seen.',
  "Examples (a calculator, a chart story, a trip plan, a schedule with logic, a chart from a data file):",
  example(ANSWER_SURFACE_EXAMPLES.calculator),
  example(ANSWER_SURFACE_EXAMPLES.chart),
  example(ANSWER_SURFACE_EXAMPLES.plan),
  example(ANSWER_SURFACE_EXAMPLES.mortgage),
  example(ANSWER_SURFACE_EXAMPLES.sales),
].join("\n");
