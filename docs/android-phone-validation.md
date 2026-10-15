# Android phone development validation

Recorded on 2026-10-15 for the initial `phone.android.v1` integration and its edge-case fixes. Setup, supported actions and recovery rules are in [Android phone control](android-phone-control.md).

## Test surface and results

| Surface | Result | Scope |
| --- | --- | --- |
| Focused regression suite | 219 passed, 1 live opt-in skipped | Phone service/worker guards, durable execution, Android adapter, policy, tool allowlists/timeouts and native-app tool regression coverage |
| Live-enabled Android adapter suite | 5 passed in 209.17 seconds | Four adapter tests plus one real-device scenario on an Android API 34 emulator (`emulator-5554`) |
| Electron acceptance | Passed | Running source app via `npm run dev`, real ADB/phone-harness, visible screen/action approval cards and a local deterministic model fixture |
| Type checks | Passed | Electron, renderer and daemon TypeScript configurations |
| Builds | Passed | Electron and React renderer; renderer reported existing chunk-size warnings |
| Lint and patch checks | Passed | Oxlint with existing warnings, async SQLite lint, scoped formatting and `git diff --check` |

The live device scenario observed the selected emulator, opened Settings, exercised tapping and ASCII typing, checked screenshots and fresh package/text verification, restarted the service and reconciled the original receipt. A simulated lost response after a completed worker receipt resolved through readback with input dispatched once. Denied approval produced no input receipt.

Electron acceptance exercised runtime install/repair, device selection, enable, selection reset and Stop. An input approval was held for **125 seconds**: the operation remained `submitting` past the old 120-second adapter deadline, with no input receipt. Clicking Stop settled it as `failed`, left zero device locks and produced no input receipt. A new approved operation then acquired the same device and completed with verified foreground package `com.android.settings`. Read-only inspection of the operation journal and worker receipt confirmed these results.

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

This is source/development acceptance on macOS with an emulator and a deterministic local model fixture. It does not establish physical-phone compatibility, real-provider model behavior, packaged-release acceptance, Linux/Windows host acceptance, or remote CI success. CI and release test jobs now provision Python/Pillow, but their results must be checked on the PR. The adapter remains unqualified: visible package/text evidence cannot certify a remote purchase, message delivery or other business transaction.

Screenshots and machine-readable acceptance records were saved locally under the ignored `output/playwright/` directory. They are local test artifacts, not checked-in evidence or a publicly hosted report.
