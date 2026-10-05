/**
 * Knowledge graph extraction rules (audit DATA-10): which names automatic extraction may
 * turn into entities, how entity names are normalized for uniqueness, and which mail
 * domains never become organizations. Pure functions with no Electron or database
 * imports, so the database worker (cleanup SQL) and tests can load them.
 */

// ─── Entity names ──────────────────────────────────────────────────────

/**
 * The uniqueness key of an entity name within its workspace and type: Unicode-normalized
 * (NFKC), whitespace collapsed, lower-cased. `Go`, `go` and `GO` share one key.
 */
export function normalizeEntityName(name: string): string {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/** Source precedence for entity descriptions and properties: manual > agent > auto. */
export type KGWriteSource = "manual" | "agent" | "auto";

export const KG_SOURCE_RANK: Record<KGWriteSource, number> = { manual: 3, agent: 2, auto: 1 };

export function kgSourceRank(source: unknown): number {
  return source === "manual" || source === "agent" || source === "auto"
    ? KG_SOURCE_RANK[source]
    : // Rows written before sources were tracked default to manual (the column default).
      KG_SOURCE_RANK.manual;
}

/** The higher-precedence of two sources. */
export function strongerKgSource(left: unknown, right: unknown): KGWriteSource {
  const a = normalizeKgSource(left);
  const b = normalizeKgSource(right);
  return KG_SOURCE_RANK[a] >= KG_SOURCE_RANK[b] ? a : b;
}

export function normalizeKgSource(source: unknown): KGWriteSource {
  return source === "auto" || source === "agent" ? source : "manual";
}

// ─── Technology extraction ─────────────────────────────────────────────

/**
 * How a technology name may be matched in free text:
 *  - `distinctive`: the name is not an English word; matched case-insensitively.
 *  - `exact`: an English word only in other casings (Electron/electron, Tailwind/tailwind,
 *    REST/rest); matched only in its canonical casing (or an alias).
 *  - `ambiguous`: an English word even in canonical casing (Go, Rust, Express, React);
 *    matched only in a code-ish context: inline code, an import or package command, a
 *    file name with the language's extension, a version number, "using X" / "written in
 *    X", or a technical noun after the name ("Go module", "Express server").
 * A name inside a path, URL or dotted identifier (`src/electron/main.ts`) never matches.
 */
type TechMode = "distinctive" | "exact" | "ambiguous";

interface TechSpec {
  name: string;
  mode: TechMode;
  /**
   * Other spellings. Case-insensitive for distinctive names; for the others matched as
   * written (list each accepted casing), because some are English words in lower case
   * ("restful").
   */
  aliases?: string[];
  /** Package / module identifiers for import, require and install contexts. */
  packages?: string[];
  /** Further code-ish contexts (file names, CLI commands); case-sensitive. */
  contexts?: RegExp[];
}

/** A shell command at the start of a line, after a prompt, or in inline code. */
function commandContext(command: string, subcommands: string): RegExp {
  return new RegExp(`(?:^|[$>]\\s*|\`)${command} (?:${subcommands})\\b`, "m");
}

const TECH_SPECS: TechSpec[] = [
  { name: "TypeScript", mode: "distinctive" },
  { name: "JavaScript", mode: "distinctive" },
  { name: "Node.js", mode: "distinctive", aliases: ["NodeJS"] },
  { name: "Next.js", mode: "distinctive", aliases: ["NextJS"] },
  { name: "Python", mode: "distinctive" },
  { name: "Docker", mode: "distinctive" },
  { name: "Kubernetes", mode: "distinctive", aliases: ["k8s"] },
  { name: "PostgreSQL", mode: "distinctive", aliases: ["Postgres"] },
  { name: "MongoDB", mode: "distinctive" },
  { name: "Redis", mode: "distinctive" },
  { name: "GraphQL", mode: "distinctive" },
  { name: "Webpack", mode: "distinctive" },
  { name: "FastAPI", mode: "distinctive" },
  { name: "Django", mode: "distinctive" },
  { name: "SQLite", mode: "distinctive" },
  { name: "Vue", mode: "exact", aliases: ["Vue.js", "VueJS", "vuejs"] },
  { name: "Vite", mode: "exact" },
  { name: "Angular", mode: "exact", aliases: ["AngularJS"] },
  { name: "Electron", mode: "exact", aliases: ["Electron.js"] },
  { name: "Flask", mode: "exact" },
  { name: "Tailwind", mode: "exact", aliases: ["TailwindCSS", "Tailwind CSS"] },
  { name: "REST", mode: "exact", aliases: ["RESTful"] },
  {
    name: "Go",
    mode: "ambiguous",
    aliases: ["Golang", "golang"],
    contexts: [
      /(?:^|[\s`'"(/])[\w-]+\.go\b(?!\.)/,
      /\bgo\.(?:mod|sum)\b/,
      commandContext("go", "build|run|test|mod|get|install|vet|fmt|generate"),
    ],
  },
  {
    name: "Rust",
    mode: "ambiguous",
    aliases: ["rustc", "rustup", "Rust-lang"],
    contexts: [
      /(?:^|[\s`'"(/])[\w-]+\.rs\b(?!\.)/,
      /\bCargo\.(?:toml|lock)\b/,
      commandContext("cargo", "build|run|test|add|install|check|clippy"),
    ],
  },
  {
    name: "Express",
    mode: "ambiguous",
    aliases: ["Express.js", "ExpressJS", "expressjs"],
    packages: ["express"],
  },
  {
    name: "React",
    mode: "ambiguous",
    aliases: ["React.js", "ReactJS", "reactjs", "React Native"],
    packages: ["react", "react-dom"],
    contexts: [/(?<![\w./-])React 1[5-9]\b/],
  },
];

/**
 * Technology names that are English words in any casing. Automatic extraction accepts
 * them only in a code-ish context, and the one-time cleanup deletes automatic technology
 * entities with these names (their context was never checked).
 */
export const KG_AMBIGUOUS_TECH_WORDS: ReadonlySet<string> = new Set(
  TECH_SPECS.filter((spec) => spec.mode === "ambiguous").map((spec) =>
    normalizeEntityName(spec.name),
  ),
);

/** Nouns that make a preceding ambiguous name technical ("Go module", "Express server"). */
const TECH_NOUNS =
  "api|apis|app|apps|application|backend|binary|binaries|client|code|codebase|compiler|component|components|crate|crates|endpoint|endpoints|framework|frontend|function|functions|hook|hooks|library|libraries|middleware|module|modules|package|packages|program|programs|project|projects|router|routes?|runtime|sdk|server|servers|service|services|struct|structs|toolchain|workspace";

/** Verbs before "in X" / "to X" that make an ambiguous name technical ("written in Rust"). */
const TECH_VERBS =
  "written|implemented|built|coded|rewritten|ported|migrated|migrating|porting|rewrite|rewriting|programming|developed|compiled";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `name` as a standalone token: not part of a word, path, URL or dotted identifier. */
function tokenPattern(name: string, flags: string): RegExp {
  return new RegExp(`(?<![\\w./@#-])${escapeRegExp(name)}(?![\\w/@-]|\\.\\w)`, flags);
}

function packagePatterns(pkg: string): RegExp[] {
  const p = escapeRegExp(pkg);
  return [
    new RegExp(`\\bfrom\\s+['"]${p}(?:/[\\w./-]*)?['"]`),
    new RegExp(`\\brequire\\(\\s*['"]${p}(?:/[\\w./-]*)?['"]\\s*\\)`),
    new RegExp(`\\bimport\\s+['"]${p}['"]`),
    new RegExp(
      `\\b(?:npm|pnpm|yarn|bun)\\s+(?:i|install|add)\\b[^\\n]*?(?<![\\w@/-])${p}(?![\\w/-])`,
    ),
  ];
}

function ambiguousContexts(spec: TechSpec): RegExp[] {
  const n = escapeRegExp(spec.name);
  const patterns: RegExp[] = [
    // Inline code: `go`, `react@18`.
    new RegExp("`" + n + "(?:@[\\w.^~-]+)?`", "i"),
    // A dotted version right after the name: "Go 1.22", "Express 4.x", "Rust v1".
    new RegExp(`(?<![\\w./-])${n}\\s+(?:v\\d+|\\d+\\.(?:\\d+|x))\\b`),
    new RegExp(`\\b(?:using|uses|adopt|adopted|switched to|switch to)\\s+${n}(?![\\w/-])`),
    new RegExp(`\\b(?:${TECH_VERBS})\\s+(?:in|to)\\s+${n}(?![\\w/-])`),
    new RegExp(`(?<![\\w./-])${n}\\s+(?:${TECH_NOUNS})\\b`),
    ...(spec.contexts ?? []),
  ];
  for (const pkg of spec.packages ?? []) patterns.push(...packagePatterns(pkg));
  return patterns;
}

const COMPILED_TECH = TECH_SPECS.map((spec) => {
  const aliasFlags = spec.mode === "distinctive" ? "i" : "";
  const aliases = (spec.aliases ?? []).map((alias) => tokenPattern(alias, aliasFlags));
  const primary =
    spec.mode === "ambiguous"
      ? ambiguousContexts(spec)
      : [tokenPattern(spec.name, spec.mode === "distinctive" ? "i" : "")];
  const patterns = [...primary, ...aliases];
  return { spec, test: (text: string) => patterns.some((re) => re.test(text)) };
});

/**
 * Technology names (canonical casing) mentioned in `text`, in list order. Distinctive
 * names match in any casing, English-word names only in their canonical casing, and the
 * ambiguous ones only in a code-ish context.
 */
export function extractTechnologyMentions(text: string): string[] {
  if (!text) return [];
  return COMPILED_TECH.filter(({ test }) => test(text)).map(({ spec }) => spec.name);
}

function findTechSpec(name: string): TechSpec | undefined {
  const key = normalizeEntityName(name);
  return TECH_SPECS.find(
    (spec) =>
      normalizeEntityName(spec.name) === key ||
      (spec.aliases ?? []).some((alias) => normalizeEntityName(alias) === key),
  );
}

/** Canonical casing of a known technology name, or undefined. */
export function canonicalTechnologyName(name: string): string | undefined {
  return findTechSpec(name)?.name;
}

/**
 * Whether an automatically extracted technology entity named `name` is noise the old
 * case-insensitive extraction produced: an ambiguous word (its context was never
 * checked), or an English-word name in a casing extraction no longer accepts
 * ("electron" from `src/electron/...`, "rest").
 */
export function isNoisyAutoTechnologyName(name: string): boolean {
  const trimmed = String(name ?? "").trim();
  if (KG_AMBIGUOUS_TECH_WORDS.has(normalizeEntityName(trimmed))) return true;
  const spec = findTechSpec(trimmed);
  if (!spec || spec.mode !== "exact") return false;
  return trimmed !== spec.name && !(spec.aliases ?? []).includes(trimmed);
}

// ─── Mail domains ──────────────────────────────────────────────────────

/** Second-level labels that form a public suffix with a two-letter TLD (co.uk, com.tr). */
const SECOND_LEVEL_SUFFIX_LABELS = new Set([
  "ac",
  "bel",
  "biz",
  "co",
  "com",
  "edu",
  "gen",
  "go",
  "gob",
  "gov",
  "info",
  "k12",
  "ltd",
  "mil",
  "ne",
  "net",
  "nic",
  "or",
  "org",
  "plc",
  "tv",
]);

/** The registrable domain (`news.amazon.com` → `amazon.com`, `x.gov.tr` → `x.gov.tr`). */
export function registrableDomain(domain: string): string | undefined {
  const labels = String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter(Boolean);
  if (labels.length < 2) return undefined;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take =
    tld.length === 2 && SECOND_LEVEL_SUFFIX_LABELS.has(second) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The organization label of a domain (`mail.acme.co.uk` → `acme`). */
export function domainOrganizationLabel(domain: string): string | undefined {
  return registrableDomain(domain)?.split(".")[0];
}

/** Providers whose addresses say nothing about the sender's employer. */
const FREE_MAIL_PROVIDER_LABELS = new Set([
  "aol",
  "fastmail",
  "gmail",
  "gmx",
  "googlemail",
  "hotmail",
  "icloud",
  "live",
  "mail",
  "msn",
  "outlook",
  "proton",
  "protonmail",
  "rocketmail",
  "tutanota",
  "tuta",
  "yahoo",
  "yandex",
  "ymail",
  "zoho",
  "zohomail",
]);

/** Exact domains (and their subdomains) of personal or relay mail. */
const FREE_MAIL_DOMAINS = [
  "126.com",
  "163.com",
  "anonaddy.me",
  "btinternet.com",
  "comcast.net",
  "duck.com",
  "free.fr",
  "hanmail.net",
  "hey.com",
  "laposte.net",
  "libero.it",
  "mac.com",
  "mail.ru",
  "me.com",
  "naver.com",
  "orange.fr",
  "passmail.net",
  "pm.me",
  "privaterelay.appleid.com",
  "qq.com",
  "sbcglobal.net",
  "seznam.cz",
  "simplelogin.com",
  "users.noreply.github.com",
  "verizon.net",
  "web.de",
  "ya.ru",
];

/** Whether a mail domain is a free-mail, personal-ISP or relay provider. */
export function isFreeMailDomain(domain: string | undefined): boolean {
  const d = String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!d) return false;
  if (FREE_MAIL_DOMAINS.some((entry) => d === entry || d.endsWith(`.${entry}`))) return true;
  const label = domainOrganizationLabel(d);
  return Boolean(label && FREE_MAIL_PROVIDER_LABELS.has(label));
}

/**
 * Organization names the old mailbox ingest derived from free-mail domains (its first
 * domain label, capitalized). Used by the cleanup when an entity has no stored domain.
 */
export const KG_FREE_MAIL_ORGANIZATION_NAMES: ReadonlySet<string> = new Set([
  ...FREE_MAIL_PROVIDER_LABELS,
  "privaterelay",
  "me",
  "mac",
  "pm",
  "duck",
  "qq",
  "naver",
]);

/** Local parts of automated senders (no person behind them). */
const AUTOMATED_LOCAL_PART =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply[-_.\w]*|[\w.-]*[-_.]noreply|notifications?|notify|mailer[-_.]?daemon|postmaster|bounces?(?:[-+_.][\w.-]*)?|newsletters?|news|alerts?|updates?)$/i;

/** Whether an address is an automated sender (noreply, notifications, bounces, ...). */
export function isAutomatedSenderAddress(email: string | undefined): boolean {
  const local = String(email ?? "")
    .split("@")[0]
    ?.split("+")[0]
    ?.trim();
  return Boolean(local && AUTOMATED_LOCAL_PART.test(local));
}
