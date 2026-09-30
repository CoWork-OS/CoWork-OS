# Browser preview PR readiness — 30 September 2026

This checkpoint covers the bounded readiness pass on `cowork-os/web-preview`. Browser access remains opt-in. It does not close the full browser parity backlog.

## Fixed and observed

- Explicit permitted integration tools survive the built-in tool selection cap. A report-only backticked tool reference no longer requires another invocation; imperative tool steps still require evidence.
- Approval constraints appear beside the composer. Review profiles opens the current Calm access menu and preserves the ordinary profile picker behavior.
- A fresh browser task using OpenRouter `openai/gpt-4o-mini` requested External service approval, received Allow once, called the local `mcp_qa_echo` fixture once, and returned `qa_echo:browser-tool-connected`. The reporting step used zero tools and the task visibly completed. Host executor prefix: `a9ad7066`. The fixture was disconnected and disabled afterward.
- With `COWORK_WEB_ENABLED=0`, `/app/` returned HTTP 404. A production-mode source Electron runtime completed task `ff6b01c6-ac68-48f7-93f9-acda7de18c44` through its existing local Control Plane; its inspected file contained `native-ok`. This proves native runtime execution with the web surface disabled, not desktop GUI task admission.
- Approval prompts were explicitly enabled only for the disposable integration QA host. The ordinary prompts-off runtime was separately checked for the visible explanation and profile menu.

## Validation

- Executor plan parsing: 80 tests passed, including the paired imperative/report-only regression.
- Access-profile presentation: 4 tests passed.
- WebApplication, browser MCP methods, MCPHostServer and MCPClientManager: 42 tests passed. Coverage includes session revocation, CSRF/origin enforcement, WebSocket ticket ownership/replay, launch approval ownership/expiry/replay and disconnected-call denial.
- Browser integration methods, StreamableHTTP transport and MCPRegistryManager: 20 tests passed.
- Actual stdio MCP fixture: 1 test passed.
- Electron-native SQLite tests for Git mutation receipts, encrypted channel records, SecureSettingsRepository and safe-storage migration: 78 tests passed. Includes durable receipt reopen and migration from an older profile without the new receipt table.
- `build:electron`, `build:daemon`, `build:react`, `build:web` and `type-check` passed.
- `lint` passed with zero errors and 439 warnings.
- Scoped formatting passed for all 144 changed/new source files. Full `fmt:check` still reports 46 untouched files byte-identical to `origin/main`; unrelated baseline formatting was not rewritten.
- `git diff --check` and host API inventory freshness passed.

Earlier Node/Electron recovery and integration acceptance results are in the point 2 and point 3 reports. Local screenshots and logs were captured during QA; they are not shipped runtime assets.

## Deferred release gates

Full browser/OS/provider compatibility, installed package workflows, desktop GUI task admission, real two-tab network interruption, actual structured-input recovery, remote connector revocation and complete rollback remain unverified. ChatGPT subscription login remains unverified; the real-provider proof uses OpenRouter. Do not advertise complete desktop parity or a production browser release from this checkpoint.
