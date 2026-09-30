#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = process.cwd();
const rendererRoot = path.join(repoRoot, "src", "renderer");
const preloadPath = path.join(repoRoot, "src", "electron", "preload.ts");
const outputPath = path.join(repoRoot, "docs", "web-capability-matrix.md");
const checkOnly = process.argv.includes("--check");
const markdownTick = String.fromCharCode(96);

const plannedMethods = new Set([
  "getAppearanceSettings",
  "saveAppearanceSettings",
  "getLLMConfigStatus",
  "getLLMSettings",
  "getTempWorkspace",
  "listWorkspaces",
  "selectWorkspace",
  "touchWorkspace",
  "listSidebarTasks",
  "listTasks",
  "listBotConversations",
  "getTask",
  "createTask",
  "sendMessage",
  "cancelTask",
  "getTaskEvents",
  "getTaskTimelinePage",
  "getTaskEventDetail",
  "onTaskEvent",
  "listInputRequests",
  "respondToApproval",
  "respondToInputRequest",
  "getQueueStatus",
  "onQueueUpdate",
  "getComposerDraft",
  "upsertComposerDraft",
  "clearComposerDraft",
  "rekeyComposerDraft",
  "putComposerDraftAttachment",
  "resolveComposerDraftAttachment",
  "releaseComposerDraftAttachment",
]);

const nativeOnlyMethods = new Set([
  "getPlatform",
  "getNativeFrameMode",
  "windowMinimize",
  "windowMaximize",
  "windowClose",
  "selectFolder",
  "openFile",
  "showInFinder",
  "checkForUpdates",
  "onTrayOpenAbout",
  "openSystemSettings",
]);

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => stableCompare(left.name, right.name))
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(absolutePath);
      if (!entry.isFile() || !/\.(?:ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) return [];
      if (
        absolutePath.includes(`${path.sep}__tests__${path.sep}`) ||
        /\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ) {
        return [];
      }
      return [absolutePath];
    });
}

function relativeFile(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function sourceLocation(sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1;
  return { file: relativeFile(sourceFile.fileName), line };
}

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return current;
}

function isWindowIdentifier(node) {
  const current = unwrapExpression(node);
  return Boolean(current && ts.isIdentifier(current) && current.text === "window");
}

function isBridgeObject(node) {
  const current = unwrapExpression(node);
  if (!current) return false;
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text === "electronAPI" && isWindowIdentifier(current.expression);
  }
  return (
    ts.isElementAccessExpression(current) &&
    isWindowIdentifier(current.expression) &&
    current.argumentExpression &&
    ts.isStringLiteralLike(current.argumentExpression) &&
    current.argumentExpression.text === "electronAPI"
  );
}

function getBridgeMemberName(node) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (ts.isPropertyAccessExpression(current) && isBridgeObject(current.expression)) {
    return current.name.text;
  }
  if (ts.isElementAccessExpression(current) && isBridgeObject(current.expression)) {
    const argument = current.argumentExpression && unwrapExpression(current.argumentExpression);
    return argument && ts.isStringLiteralLike(argument) ? argument.text : "<computed>";
  }
  return null;
}

function memberName(nameNode) {
  if (!nameNode) return null;
  if (
    ts.isIdentifier(nameNode) ||
    ts.isStringLiteralLike(nameNode) ||
    ts.isNumericLiteral(nameNode)
  ) {
    return nameNode.text;
  }
  return null;
}

function bindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) return [bindingName.text];
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    return bindingName.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
    );
  }
  return [];
}

function getScriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseSource(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
}

const rendererFiles = walkFiles(rendererRoot);
if (rendererFiles.length === 0) {
  console.error(`[host-api-inventory] no renderer source files found under ${rendererRoot}`);
  process.exit(1);
}

const sourceFiles = rendererFiles.map(parseSource);
const directMembers = new Map();
const aliasRows = [];
const bridgeRootReferences = [];
const syntacticCounts = { sourceFiles: sourceFiles.length, directMembers: 0, directCalls: 0 };

function getScope(node) {
  let current = node.parent;
  let insideFunction = false;
  while (current) {
    if (ts.isFunctionLike(current)) {
      insideFunction = true;
      const parent = current.parent;
      if (
        parent &&
        ts.isCallExpression(parent) &&
        parent.arguments[0] === current &&
        ((ts.isIdentifier(parent.expression) &&
          (parent.expression.text === "useEffect" ||
            parent.expression.text === "useLayoutEffect")) ||
          (ts.isPropertyAccessExpression(parent.expression) &&
            (parent.expression.name.text === "useEffect" ||
              parent.expression.name.text === "useLayoutEffect")))
      ) {
        return "effect callback";
      }
    }
    current = current.parent;
  }
  return insideFunction ? "function/component" : "module scope";
}

function addDirectMember(name, sourceFile, node, isCall) {
  const row = directMembers.get(name) ?? {
    name,
    accesses: 0,
    calls: 0,
    files: new Map(),
    scopes: { "effect callback": 0, "function/component": 0, "module scope": 0 },
  };
  const location = sourceLocation(sourceFile, node);
  const fileLines = row.files.get(location.file) ?? new Set();
  fileLines.add(location.line);
  row.files.set(location.file, fileLines);
  row.accesses += 1;
  syntacticCounts.directMembers += 1;
  if (isCall) {
    row.calls += 1;
    syntacticCounts.directCalls += 1;
  }
  row.scopes[getScope(node)] += 1;
  directMembers.set(name, row);
}

for (const sourceFile of sourceFiles) {
  const apiObjectAliases = new Set();
  const declarations = [];

  function collectBridgeMethodReferences(root) {
    const references = [];
    function visit(node) {
      if (ts.isFunctionLike(node)) return;
      const name = getBridgeMemberName(node);
      if (name) {
        const parent = node.parent;
        const isCall =
          parent && ts.isCallExpression(parent) && unwrapExpression(parent.expression) === node;
        if (!isCall) references.push({ name, node });
      }
      ts.forEachChild(node, visit);
    }
    visit(root);
    return references;
  }

  function recordAlias(kind, apiMember, localName, node) {
    const location = sourceLocation(sourceFile, node);
    aliasRows.push({
      kind,
      apiMember,
      localName,
      file: location.file,
      line: location.line,
    });
  }

  function inspectVariableDeclaration(declaration) {
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(declaration.name)) {
      if (isBridgeObject(initializer)) {
        apiObjectAliases.add(declaration.name.text);
        recordAlias("object alias", "electronAPI", declaration.name.text, declaration);
        return true;
      }
      if (initializer && ts.isIdentifier(initializer) && apiObjectAliases.has(initializer.text)) {
        apiObjectAliases.add(declaration.name.text);
        recordAlias("object alias", "electronAPI", declaration.name.text, declaration);
        return true;
      }
      const references = initializer ? collectBridgeMethodReferences(initializer) : [];
      for (const reference of references) {
        recordAlias("method value", reference.name, declaration.name.text, reference.node);
      }
      return references.length > 0;
    }

    if (!ts.isObjectBindingPattern(declaration.name) || !initializer) return false;
    const sourceIsBridge = isBridgeObject(initializer);
    const sourceIsAlias = ts.isIdentifier(initializer) && apiObjectAliases.has(initializer.text);
    const sourceIsWindow = isWindowIdentifier(initializer);
    if (!sourceIsBridge && !sourceIsAlias && !sourceIsWindow) return false;

    let changed = false;
    for (const element of declaration.name.elements) {
      if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) continue;
      const property = memberName(element.propertyName) ?? element.name.text;
      if (sourceIsWindow && property === "electronAPI") {
        if (!apiObjectAliases.has(element.name.text)) changed = true;
        apiObjectAliases.add(element.name.text);
        recordAlias("object destructuring", "electronAPI", element.name.text, element);
        continue;
      }
      if (!sourceIsBridge && !sourceIsAlias) continue;
      recordAlias("method destructuring", property, element.name.text, element);
    }
    return changed;
  }

  function collectDeclarations(node) {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(sourceFile);

  // Resolve simple object aliases to a fixed point so destructuring from a
  // local alias is still surfaced. This does not infer dynamically returned
  // bridge objects or bind uses by name.
  let changed = true;
  let passes = 0;
  while (changed && passes <= declarations.length) {
    changed = false;
    passes += 1;
    for (const declaration of declarations) {
      const before = apiObjectAliases.size;
      inspectVariableDeclaration(declaration);
      if (apiObjectAliases.size !== before) changed = true;
    }
  }

  function visit(node) {
    if (isBridgeObject(node)) bridgeRootReferences.push(sourceLocation(sourceFile, node));
    const name = getBridgeMemberName(node);
    if (name) {
      const parent = node.parent;
      const isCall =
        parent && ts.isCallExpression(parent) && unwrapExpression(parent.expression) === node;
      addDirectMember(name, sourceFile, node, Boolean(isCall));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function getPreloadSurface() {
  if (!fs.existsSync(preloadPath)) return { declared: new Map(), exposed: new Map() };
  const sourceFile = parseSource(preloadPath);
  const declared = new Map();
  const exposed = new Map();

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "ElectronAPI") {
      for (const member of node.members) {
        const name = memberName(member.name);
        if (!name) continue;
        const prior = declared.get(name) ?? { name, count: 0, line: 0 };
        prior.count += 1;
        prior.line = sourceLocation(sourceFile, member).line;
        declared.set(name, prior);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callName = node.expression.name.text;
      const owner = node.expression.expression;
      const hasElectronApiName =
        node.arguments[0] &&
        ts.isStringLiteralLike(unwrapExpression(node.arguments[0])) &&
        unwrapExpression(node.arguments[0]).text === "electronAPI";
      const objectArgument = node.arguments[1] && unwrapExpression(node.arguments[1]);
      if (
        callName === "exposeInMainWorld" &&
        ts.isIdentifier(owner) &&
        owner.text === "contextBridge" &&
        hasElectronApiName &&
        objectArgument &&
        ts.isObjectLiteralExpression(objectArgument)
      ) {
        for (const property of objectArgument.properties) {
          const name = memberName(property.name);
          if (!name) continue;
          exposed.set(name, sourceLocation(sourceFile, property).line);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { declared, exposed };
}

const preloadSurface = getPreloadSurface();

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function inline(value) {
  return markdownTick + String(value) + markdownTick;
}

function formatLocations(fileMap) {
  return Array.from(fileMap.entries())
    .sort(([left], [right]) => stableCompare(left, right))
    .map(
      ([file, lines]) =>
        `${file}:${Array.from(lines)
          .sort((a, b) => a - b)
          .join(",")}`,
    )
    .join("; ");
}

function apiStatus(name) {
  if (nativeOnlyMethods.has(name)) return "Native-only today";
  if (plannedMethods.has(name)) return "Planned for browser work";
  return "Unreviewed";
}

function renderMarkdown() {
  const directRows = Array.from(directMembers.values()).sort((left, right) =>
    stableCompare(left.name, right.name),
  );
  const aliases = aliasRows
    .sort(
      (left, right) =>
        stableCompare(left.file, right.file) ||
        left.line - right.line ||
        stableCompare(left.kind, right.kind) ||
        stableCompare(left.localName, right.localName),
    )
    .filter(
      (row, index, rows) =>
        index ===
        rows.findIndex(
          (candidate) =>
            candidate.kind === row.kind &&
            candidate.apiMember === row.apiMember &&
            candidate.localName === row.localName &&
            candidate.file === row.file &&
            candidate.line === row.line,
        ),
    );
  const declaredNames = new Set(preloadSurface.declared.keys());
  const exposedNames = new Set(preloadSurface.exposed.keys());
  const directNames = new Set(directRows.map((row) => row.name));
  const unreviewedDirect = directRows.filter((row) => apiStatus(row.name) === "Unreviewed");
  const declaredUnused = Array.from(declaredNames)
    .filter((name) => !directNames.has(name))
    .sort(stableCompare);
  const directUndeclared = directRows.filter((row) => !declaredNames.has(row.name));
  const declaredNotExposed = Array.from(declaredNames)
    .filter((name) => !exposedNames.has(name))
    .sort(stableCompare);
  const exposedNotDeclared = Array.from(exposedNames)
    .filter((name) => !declaredNames.has(name))
    .sort(stableCompare);
  const directCallsByScope = { "effect callback": 0, "function/component": 0, "module scope": 0 };
  for (const row of directRows) {
    for (const [scope, count] of Object.entries(row.scopes)) directCallsByScope[scope] += count;
  }

  const lines = [
    "# Browser capability matrix and renderer host API inventory",
    "",
    "<!-- Generated by node scripts/qa/inventory-host-api.mjs. Do not edit generated sections by hand. -->",
    "",
    "This is a source inventory and implementation map, not proof of a complete browser workflow. Classifications remain partial; only the opt-in browser preview, selected roadmap slices, and clearly native UI calls are classified. Remaining bridge methods stay unreviewed.",
    "",
    "## Current status",
    "",
    "| Status | Capability | Evidence and limits |",
    "| --- | --- | --- |",
    "| Preview | Pairing, authenticated workspace/task summaries, keyed task admission, cancellation receipts, text follow-up receipts, committed timeline replay with older-page navigation, scoped approval/input decisions, workspace file transfer, task artifact download handles, host terminal attachment, and read-only Git status/diff. | `src/renderer-web`, `src/host/web/WebApplication.ts`, and `src/host/services/browser-*.ts`. The disposable Node host smoke passes from source and an installed npm tarball; no real-model task or packaged desktop/Linux workflow is proven. |",
    "| Compatibility | The standalone legacy Web Access client retains REST task/event operations and its token-based login. | `src/renderer/components/WebAccessClient.tsx`. Its initial token is read from the URL query; this legacy surface is separate from the new browser session. |",
    "| Preview | The browser entry mounts the shared desktop App, sidebar, home, composer, and task view through a capability-limited bridge. | `src/renderer-web/browser-entry.tsx` installs the browser bridge before importing App. Desktop-only navigation and controls are gated; visual reuse does not imply capability parity or real-model browser acceptance. |",
    "| Preview | Rich task and follow-up input, scoped attachment capture, skill status and catalog discovery, installed Feature Pack details, and workspace text/image/PDF previews. | Focused source tests cover input validation, durable attachment storage, replay privacy, and catalog DTOs. Provider execution and refresh during a real running task still require acceptance. |",
    "| Preview | Installed Feature Pack and skill toggles through shared host services. | Focused service, registry, bridge, and UI tests pass. A disposable Node host smoke verifies mutation replay and state restoration; browser clicks verified pack state across a host restart and skill state after reopening. Installation and import remain desktop-only. |",
    "| Preview | Task Queue concurrency and timeout settings. | Closed host-admin methods use the authoritative queue manager, persist before runtime publication, and confirm readback. Focused tests cover refused/failed writes and runtime slot application; the disposable host smoke verifies save/replay/readback and restoration. Browser clicks verified a changed limit across a host restart, then restored the original value. |",
    "| In progress | Queued follow-up recovery across host restarts. | Source validation is ongoing; real-model crash recovery must pass before release claims. |",
    "| Planned | Video media ranges and Git writes. | These workflows still need browser adapters and real acceptance. |",
    "| Native-only today | Native window controls, folder dialog, Finder reveal, desktop update checks, tray callback, and system-settings launch. | These methods express Electron/OS UI behavior and are gated in the browser. The bridge reads host platform from the authenticated host identity, not the browser client. |",
    "| Unreviewed | Every other direct bridge member and every declared member with no direct renderer access. | The direct inventory and unreferenced declaration appendix below expose the remaining names; no capability parity is inferred. |",
    "",
    "Planning basis: the CoWork web implementation plan (W0-W6). The installed npm Node-host smoke covers a bounded preview; each release surface still needs its own artifact and real-workflow acceptance before release claims.",
    "",
    "## Renderer entry and startup seams",
    "",
    "| Seam | Current behavior | Evidence |",
    "| --- | --- | --- |",
    "| Entry ordering | `main.tsx` statically imports `App` before `createRoot(...).render`; install a browser bridge before importing App or its stores. | `src/renderer/main.tsx:1-13` |",
    "| App branch | `hasElectronAPI` is checked at render, but the no-bridge fallback is near the end of App after hooks are declared. Non-local HTTP returns `WebAccessClient`; localhost shows the desktop-preload diagnostic. | `src/renderer/App.tsx:2918,7433-57` |",
    "| Platform/window frame | `getPlatform()` and `getNativeFrameMode()` are synchronous render-time reads used to set platform classes. They need an explicit browser/client-window seam; do not fabricate host OS values. | `src/renderer/App.tsx:3156-69` |",
    "| Appearance and onboarding | `getLLMConfigStatus()` and `getAppearanceSettings()` run in mount effects with empty dependency arrays; appearance controls theme, disclaimer, and onboarding state. | `src/renderer/App.tsx:3302-05,3325-65` |",
    "| Runtime appearance | `getAppearanceRuntimeInfo()` runs behind the bridge guard with dependency `[hasElectronAPI]`, and again for Darwin transparency with `[hasElectronAPI, transparencyEffectsEnabled]`. | `src/renderer/App.tsx:3061-84,3171-98` |",
    "| Migration and updates | `getMigrationStatus()` is checked on mount; `checkForUpdates()` is scheduled after three seconds on mount. These are desktop startup behaviors. | `src/renderer/App.tsx:3371-3414,3438-56` |",
    "| Workspace and sidebar | `getTempWorkspace()` runs on mount; task lists refresh when `currentWorkspace?.id` changes. Workspace restoration may call `selectWorkspace()` and `getTempWorkspace()`. | `src/renderer/App.tsx:3536-58,3561-90` |",
    "| Queue and pending input | Queue status/subscription and pending input listing run in mount effects with empty dependency arrays. | `src/renderer/App.tsx:3416-36,3862-83` |",
    "| Task events and history | `onTaskEvent()` subscribes for local tasks and is recreated as selected-task/cache state changes; history loads when task selection, remote view, or timeline cache key changes. Both return cleanup/cancellation paths. | `src/renderer/App.tsx:3935-4812,4814-5000` |",
    "| Renderer build and browser entry | The Electron build still uses `src/renderer` and `dist/renderer`. `build:web` emits a browser entry that pairs with the host, installs a limited bridge, then mounts the same React App used by desktop. Legacy dashboard modules remain in source but are not bundled as the entry. | `vite.config.mts`; `vite.web.config.mts`; `package.json`; `src/renderer-web/browser-entry.tsx` |",
    "",
    "The App has a wide hook and component graph. The browser adapter should expose only a reviewed capability set, and browser navigation must gate unsupported components before their effects run. The global declaration currently requires the full Electron API: `src/renderer/global.d.ts:1-7`; the `ElectronAPI` declaration is in `src/electron/preload.ts:5542` onward.",
    "",
    "## Static inventory summary",
    "",
    `| Measurement | Count |`,
    `| --- | ---: |`,
    `| Renderer source files scanned (tests excluded) | ${syntacticCounts.sourceFiles} |`,
    `| ElectronAPI members declared in preload type | ${preloadSurface.declared.size} |`,
    `| Methods/properties exposed by contextBridge | ${preloadSurface.exposed.size} |`,
    `| Distinct direct window.electronAPI member names | ${directRows.length} |`,
    `| Direct member expressions | ${syntacticCounts.directMembers} |`,
    `| Direct member expressions used as calls | ${syntacticCounts.directCalls} |`,
    `| Direct bridge root expressions (including method receivers) | ${bridgeRootReferences.length} |`,
    `| Simple alias/destructuring declarations surfaced | ${aliases.length} |`,
    `| Direct member expressions inside effect callbacks | ${directCallsByScope["effect callback"]} |`,
    `| Direct member expressions inside other functions/components | ${directCallsByScope["function/component"]} |`,
    `| Direct member expressions at module scope | ${directCallsByScope["module scope"]} |`,
    `| Directly used names not found in ElectronAPI interface | ${directUndeclared.length} |`,
    `| Declared names not found in exposed object | ${declaredNotExposed.length} |`,
    `| Exposed names not found in interface | ${exposedNotDeclared.length} |`,
    "",
    "The scan counts syntactic `window.electronAPI.member` and literal bracket-member expressions in renderer source while excluding tests. Calls are the subset whose member expression is the call target. Alias declarations are reported separately and are not included in direct member totals. The simple alias resolver is name-based within each file, so same-name shadowing can over-report an alias declaration. Dynamic reflection, values returned by helpers, destructured-variable use counts, and arbitrary aliases are outside this pass.",
    "",
    "## Direct renderer bridge members",
    "",
    "| Member | Status | Accesses | Calls | Effect callback | Other function/component | Module scope | Source locations |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const row of directRows) {
    lines.push(
      `| ${inline(escapeCell(row.name))} | ${apiStatus(row.name)} | ${row.accesses} | ${row.calls} | ${row.scopes["effect callback"]} | ${row.scopes["function/component"]} | ${row.scopes["module scope"]} | ${escapeCell(formatLocations(row.files))} |`,
    );
  }

  lines.push(
    "",
    "## Alias and destructuring declarations",
    "",
    "These rows show syntactic bridge captures found by this pass. They list declaration evidence only; uses of a local name are not attributed by spelling because that can misclassify shadowed variables.",
    "",
    "| Kind | Bridge member | Local name | Location |",
    "| --- | --- | --- | --- |",
  );
  for (const alias of aliases) {
    lines.push(
      `| ${escapeCell(alias.kind)} | ${inline(escapeCell(alias.apiMember))} | ${inline(escapeCell(alias.localName))} | ${alias.file}:${alias.line} |`,
    );
  }

  lines.push(
    "",
    "## Unreviewed direct renderer members",
    "",
    unreviewedDirect.length === 0
      ? "No direct names remain after the small explicit classification manifest. This does not mean the declared API surface is fully classified."
      : `There are ${unreviewedDirect.length} directly reached member names that remain unreviewed. Their names, access/call counts, and exact source locations are the rows marked Unreviewed in the inventory above.`,
    "",
    "## Preload type/runtime surface gaps",
    "",
    `Declared but not directly referenced by renderer source (${declaredUnused.length}; not proof of dead code): ${declaredUnused.length ? declaredUnused.map(inline).join(", ") : "none"}.`,
    "",
    `Directly reached but absent from the ElectronAPI interface (${directUndeclared.length}): ${directUndeclared.length ? directUndeclared.map((row) => inline(row.name)).join(", ") : "none"}.`,
    "",
    `Declared by the interface but absent from the exposed object (${declaredNotExposed.length}): ${declaredNotExposed.length ? declaredNotExposed.map(inline).join(", ") : "none"}.`,
    "",
    `Exposed but absent from the interface (${exposedNotDeclared.length}): ${exposedNotDeclared.length ? exposedNotDeclared.map(inline).join(", ") : "none"}.`,
    "",
    "## Scope and remaining review gaps",
    "",
    "This pass does not establish Electron/Node implementation parity, authorization policy, secret-bearing DTO safety, structured-clone/JSON compatibility, callback/event replay guarantees, transaction commit boundaries, or production readiness. It does not inspect Control Plane registrations or prove that a direct method can be transported over HTTP/WebSocket. The next inventory pass should classify each reachable UI area and trace method implementations, payloads, callback cleanup, native object values, and the corresponding Node registration.",
    "",
  );

  return lines.join("\n");
}

const generated = renderMarkdown();
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (checkOnly) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== generated) {
    console.error(`[host-api-inventory] generated matrix is stale: ${relativeFile(outputPath)}`);
    process.exit(1);
  }
  console.log(`[host-api-inventory] matrix is current: ${relativeFile(outputPath)}`);
} else {
  fs.writeFileSync(outputPath, generated, "utf8");
  console.log(
    `[host-api-inventory] wrote ${relativeFile(outputPath)} (${directRowsSummary()} direct members, ${syntacticCounts.directCalls} calls)`,
  );
}

function directRowsSummary() {
  return directMembers.size;
}
