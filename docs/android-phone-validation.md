# Android phone development validation

Recorded on 2026-10-15 for the initial `phone.android.v1` integration and its edge-case fixes. Setup, supported actions and recovery rules are in [Android phone control](android-phone-control.md).

## Test surface and results

| Surface | Result | Scope |
| --- | --- | --- |
| Focused regression suite | 227 passed, 1 live opt-in skipped | Phone service/worker guards, durable execution, Android adapter, policy, tool allowlists/timeouts and native-app tool regression coverage |
| Live-enabled Android adapter suite | 5 passed in 209.17 seconds | Four adapter tests plus one real-device scenario on an Android API 34 emulator (`emulator-5554`) |
| Electron acceptance | Passed | Running source app via `npm run dev`, real ADB/phone-harness, visible screen/action approval cards and a local deterministic model fixture |
| Type checks | Passed | Electron, renderer and daemon TypeScript configurations |
| Builds | Passed | Electron and React renderer; renderer reported existing chunk-size warnings |
| Lint and patch checks | Passed | Oxlint with existing warnings, async SQLite lint, scoped formatting and `git diff --check` |

The focused suite originally passed 219 tests. After merging current `main` and preserving both timeout regression cases, it passed 227 tests with the live opt-in scenario skipped. The live and Electron results below were recorded before that merge; the hardware scenario was not repeated for the merge-only resolution.

The live device scenario observed the selected emulator, opened Settings, exercised tapping and ASCII typing, checked screenshots and fresh package/text verification, restarted the service and reconciled the original receipt. A simulated lost response after a completed worker receipt resolved through readback with input dispatched once. Denied approval produced no input receipt.

Electron acceptance exercised runtime install/repair, device selection, enable, selection reset and Stop. An input approval was held for **125 seconds**: the operation remained `submitting` past the old 120-second adapter deadline, with no input receipt. Clicking Stop settled it as `failed`, left zero device locks and produced no input receipt. A new approved operation then acquired the same device and completed with verified foreground package `com.android.settings`. Read-only inspection of the operation journal and worker receipt confirmed these results.

## Real ChatGPT subscription validation

The follow-up source validation uses the primary profile's configured ChatGPT OAuth subscription with `gpt-6.1-sol` (Medium), copied into the isolated QA profile. The primary profile database was opened read-only. The local deterministic fixture was stopped; neither API-key authentication nor provider failover was used for this run.

The running Electron app (`npm run dev`) drove `Pixel_3a_API_34`, serial `emulator-5554`, through the actual ADB/phone-harness runtime. Playwright operated the isolated app's visible approval cards and screenshot viewer. The LLM opened Settings, tapped search, typed exactly `cowork real llm qa`, and verified it in `com.google.android.settings.intelligence`. Settings itself opens in `com.android.settings`; its delegated search package is explicitly included in the acceptance contract.

The real-provider runs exposed and repaired these issues:

- Approved screenshots were attached to the model but lacked a usable deliverable path and file evidence. Captures now publish authorized workspace PNGs, retain path/hash/ownership metadata through normalization, and participate in file verification.
- A planned operation could disappear between steps near the repeated-tool-use threshold. Bounded volatile context now carries operation IDs/state, and the wrap-up guidance distinguishes planned work from executed work.
- Observations did not identify the safe focused editor. They now expose it so the model can avoid redundant coordinate taps; pixel, secure-field, approval and no-replay guards remain enforced.
- Settings search was classified as web research, causing unrelated network evidence requests. Local Android UI search is excluded while explicit web research remains covered.
- Definitively stale no-dispatch attempts could not be superseded, leaving successful recovery marked partial. Explicit later revisions now preserve the failed record and require the same action/criteria, a fresh snapshot, and fresh approval. Unknown/dispatched effects remain ineligible.
- Restored tasks with a generated title containing “Search” lost their phone tools to a read-only review heuristic. The heuristic now retains explicitly requested Android workflows while preserving host-desktop and explicit tool restrictions.
- Earlier Android readbacks expired after 60 seconds while later steps ran. Completed receipt-backed readbacks now retain historical verification at `checkedAt`; the requested final screen still needs fresh evidence. Other routes retain their expiry checks.

The expanded focused suite passes **321 tests**, with one separate opt-in live scenario skipped. Regression coverage includes no-dispatch supersession, rejection of unknown/completed/mismatched/legacy inputs, historical phone verification, screenshot authorization and integrity, focused-editor output, context continuity, and local versus web search classification.

The emulator needed host GPU rendering, four virtual cores and 3 GiB RAM after a System UI ANR in an early attempt. Test setup restarted only this emulator and dismissed its ANR; the model did not alter settings or enter credentials. Repeated stale screens caused a pause and one bounded continuation instruction in the final recovery run. Three stale typing attempts produced no input receipts; revision 4 completed with one typing receipt. Screen and input approvals remained per-call. A separately approved local command checked only screenshot existence/readability/byte count; phone input used `application_operation`, not shell commands.

After the final fixes and app restart, the same task completed its post-restart check: a fresh approved observation confirmed the exact query, and its new PNG opened in the in-app viewer at **1920 × 1080, 91,062 bytes**, with no renderer page errors. The original three completed receipts matched the persisted journal, all three stale attempts remained superseded without receipts, and zero device locks remained. This check dispatched no new phone input. The task finished as Completed without a partial-success marker.

The final run used `<no-memory />`; read-only inspection found zero memory rows for its task. Earlier attempts are isolated QA history, not primary-profile work. Local reports and screenshots are retained under ignored `output/playwright/android-real-*` paths.

## Regression cases

- Stop during asynchronous discovery or pending approval prevents later dispatch; concurrent settings writes cannot re-enable control after Stop.
- Missing, malformed or failed security XML blocks input. A busy accessibility tree still permits an approved screenshot with an observation-only warning.
- Changed screenshot pixels reject stale coordinate input even when the accessibility tree is unchanged.
- Typing permits caret paint changes only inside the same uniquely focused native field; changed focus, target, text or surrounding pixels block dispatch.
- Cancellation or failure in the approval-only phase is definitively not dispatched and releases the device lock. Interrupted input remains unknown and is never replayed.

## Reproduction

Install the worker-test prerequisite, Python 3 with Pillow 12.3.0, then run:

```sh
npx vitest run \
  src/electron/phone/__tests__ \
  src/electron/applications/__tests__/ApplicationExecutionService.test.ts \
  src/electron/applications/__tests__/android-phone-adapter.test.ts \
  src/electron/agent/__tests__/tool-policy-engine.test.ts \
  src/electron/agent/__tests__/executor-tool-allowlist.test.ts \
  src/electron/agent/__tests__/executor-tool-timeouts.test.ts \
  src/electron/agent/tools/__tests__/native-app-tools.test.ts
```

With a disposable, unlocked emulator connected:

```sh
COWORK_ANDROID_E2E_DEVICE=emulator-5554 \
COWORK_ANDROID_E2E_ROOT=/tmp/cowork-android-phone-e2e \
npx vitest run src/electron/applications/__tests__/android-phone-adapter.test.ts
```

For independent UI acceptance, launch an isolated development profile:

```sh
COWORK_PROFILE=android-phone-qa \
COWORK_USER_DATA_DIR=/tmp/cowork-android-phone-dev \
COWORK_REMOTE_DEBUGGING_PORT=9344 npm run dev
```

Follow the setup guide, verify both visible approval cards, hold an action approval beyond 120 seconds, use Stop, and confirm no input occurred and a newly approved task can acquire the device. The device suite uses a controlled approval callback; it cannot establish the renderer approval behavior by itself.

## Validation boundaries

This is source/development acceptance on macOS with an emulator, including both the original deterministic fixture and the subsequent real ChatGPT subscription run described above. It does not establish physical-phone compatibility, packaged-release acceptance, Linux/Windows host acceptance, or remote CI success. CI and release test jobs now provision Python/Pillow, but their results must be checked on the PR. The adapter remains unqualified: visible package/text evidence cannot certify a remote purchase, message delivery or other business transaction.

Screenshots and machine-readable acceptance records were saved locally under the ignored `output/playwright/` directory. They are local test artifacts, not checked-in evidence or a publicly hosted report.
