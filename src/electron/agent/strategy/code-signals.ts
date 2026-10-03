/**
 * Language-independent cues that a prompt is about source code or about the
 * user's own project. Routing heuristics use these instead of growing English
 * keyword lists, so a Turkish or German request that names `src/parser.ts`
 * is recognized the same way as an English one.
 */

const CODE_FILE_EXTENSIONS =
  "(?:[cm]?[jt]sx?|py|pyi|rb|go|rs|java|kts?|swift|c|cc|cpp|cxx|h|hpp|cs|php|scala|sh|bash|zsh|ps1|sql|json|jsonc|ya?ml|toml|lock|css|scss|sass|less|html?|vue|svelte|astro|gradle|xml|ini|env|tf|proto|graphql|gql|ipynb|dart|lua|exs?|erl|clj|hs|sol)";

const STRUCTURAL_CODE_PATTERNS: RegExp[] = [
  // File names and paths with a source/config extension: src/parser.ts, package.json.
  new RegExp(
    `(?:^|[\\s"'\`(\\[{<,:;=])[\\w@~./\\\\-]*[\\w-]\\.${CODE_FILE_EXTENSIONS}(?=$|[\\s"'\`)\\]}>,:;!?.])`,
    "i",
  ),
  /(?:^|[\s"'`(])\.(?:env|gitignore|eslintrc|prettierrc|npmrc|nvmrc|babelrc|editorconfig|dockerignore)\b/i,
  // Conventional source directories: src/utils, packages/core, ./scripts/build.
  /(?:^|[\s"'`(])(?:\.{1,2}\/|~\/)?(?:src|lib|app|apps|packages|pkg|cmd|internal|tests?|specs?|scripts|server|client|api|components|pages|hooks|utils|config|bin)\/[\w.@-]/i,
  // Code fences and inline code.
  /```/,
  /`[^`\n]{1,120}`/,
  // Stack traces and runtime error signatures.
  /\bat\s+[\w.$<>[\]]+\s*\([^()\n]*:\d+(?::\d+)?\)/,
  /\bTraceback \(most recent call last\)/,
  /\bFile\s+"[^"\n]+",\s+line\s+\d+/,
  /\b[A-Z][A-Za-z]*(?:Error|Exception)\b(?::|\s+at\b|\s+in\b|\s+thrown\b)/,
  /\b(?:cannot|can't)\s+read\s+propert(?:y|ies)\s+of\s+(?:undefined|null)\b/i,
  /\bundefined\s+is\s+not\s+(?:a\s+function|an\s+object)\b/i,
  /\bsegmentation\s+fault\b|\bpanic:\s/i,
  // Identifiers: camelCase (at least two leading lowercase letters, so iPhone and
  // macOS do not count), PascalCase names with a code-role suffix, and calls.
  /\b[a-z][a-z0-9]+[A-Z][a-z0-9]+[A-Za-z0-9]*\b/,
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*(?:Service|Controller|Manager|Provider|Component|Handler|Repository|Factory|Error|Exception|Client|Module|Store|Context|Reducer|Router|Model|Helper|Utils?|Config|Spec|Builder|Adapter|Listener|Worker|Parser|Validator|Middleware|Schema|Props|State|Dto|Entity|Mapper|Executor|Engine|Runner|Loader|Registry|Gateway|View|Screen|Page|Panel|Modal|Dialog|Form|Button|Hook|Tests?|Api|Sdk)\b/,
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\s*\)/,
];

/** True when the text contains file paths, code, identifiers, or stack traces. */
export function hasStructuralCodeSignal(text: string): boolean {
  const value = String(text || "");
  if (!value.trim()) return false;
  return STRUCTURAL_CODE_PATTERNS.some((pattern) => pattern.test(value));
}

const OWN_WORKSPACE_PATTERNS: RegExp[] = [
  // English: "our <anything>", "my/this/the project|repo|codebase|app ...".
  /\bour\s+[a-z]/i,
  /\b(?:my|this)\s+(?:project|repo|repository|codebase|code\s*base|code|app|application|service|api|backend|frontend|server|site|website|database|db|schema|workspace|module|package|library|component|function|class|endpoint|script|tests?|build|config|setup)\b/i,
  /\bthe\s+(?:project|repo|repository|codebase|code\s*base|monorepo|workspace)\b/i,
  // Turkish: "bu proje(de)", "projemiz", "kodumuz".
  /(?:^|[^\p{L}])(?:bu|şu)\s+(?:proje|repo|depo|kod|uygulama|servis)\p{L}*/iu,
  /(?:^|[^\p{L}])(?:projem|kodum|uygulamam|repom)\p{L}*/iu,
  // German, Spanish, French: "dieses Projekt", "unser Code", "este proyecto", "notre code".
  /\b(?:dies(?:e[mnrs]?)?|unser(?:e[mnrs]?)?|mein(?:e[mnrs]?)?)\s+(?:projekt|repo|repository|code|codebasis|app|anwendung|dienst|service|backend|frontend)/iu,
  /\b(?:este|esta|nuestro|nuestra|mi)\s+(?:proyecto|repositorio|repo|c[oó]digo|aplicaci[oó]n|app|servicio)/iu,
  /\b(?:ce|cet|cette|notre|mon|ma)\s+(?:projet|d[ée]p[oô]t|repo|code|application|app|service)/iu,
  // Chinese: 这个项目, 我们的代码, 本仓库.
  /(?:这个|此|本|我们的|我的|我们)(?:项目|仓库|代码|应用|服务|程序)/u,
];

/**
 * True when the text points at the user's own project (our app, this repo,
 * dieses Projekt, a file path, an identifier) rather than at general knowledge.
 */
export function referencesOwnWorkspace(text: string): boolean {
  const value = String(text || "");
  if (!value.trim()) return false;
  return (
    OWN_WORKSPACE_PATTERNS.some((pattern) => pattern.test(value)) || hasStructuralCodeSignal(value)
  );
}

/**
 * Questions that only make sense about a concrete codebase: where something is
 * defined or configured, or why a feature fails, crashes, or is slow.
 */
export function asksAboutProjectBehavior(text: string): boolean {
  const lower = String(text || "")
    .trim()
    .toLowerCase();
  if (!lower) return false;
  const locatesCode =
    /\bwhere\b[^?.!\n]{0,80}\b(?:defined|configured|declared|implemented|set\s+up|handled|initiali[sz]ed|registered|stored|loaded|called|used|imported|exported|created|instantiated|validated|computed|calculated|wired|mounted|triggered|rendered|logged|thrown|raised)\b/.test(
      lower,
    );
  const diagnosesFailure =
    /^why\s+(?:does|do|did|is|are|was|were|would|isn['’]?t|aren['’]?t|doesn['’]?t|don['’]?t|won['’]?t|can['’]?t)\b[^?.!\n]{0,120}\b(?:fail(?:s|ed|ing)?|crash(?:es|ed|ing)?|break(?:s|ing)?|broken|hang(?:s|ing)?|freez(?:e|es|ing)|slow|slower|leak(?:s|ing)?|errors?|throw(?:s|ing)?|time\s*out|timing\s+out|not\s+work(?:ing)?|return(?:s|ing)?\s+(?:null|undefined|nil|empty|nothing|wrong|\d{3}))\b/.test(
      lower,
    );
  return locatesCode || diagnosesFailure;
}
