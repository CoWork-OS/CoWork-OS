# Android phone control

CoWork controls a selected Android phone or emulator through `phone-harness==0.3.2` and ADB. The initial integration supports opening an installed package, taps, swipes, ASCII text, Home, Back, and Recents. No companion app or model-written Python is required.

## Setup

1. Install Android platform-tools (`adb`) and `uv` on the CoWork host.
2. Connect a phone by USB, enable USB debugging, and approve this computer on the phone. An already-connected emulator also works. Wake and unlock the device yourself.
3. Open **Settings → Built-in Tools → Android phone**. Searching settings for “Android” or “phone” finds this panel.
4. Click **Install / repair runtime**. CoWork creates a separate Python 3.12 environment in the active profile's `android-phone/runtime` directory and installs `phone-harness==0.3.2` and `pillow==12.3.0` from PyPI. A runtime is ready only after both dependencies finish installing; older or partial runtimes need Install / repair runtime. Global agent skills are untouched; telemetry and update checks are disabled.
5. Refresh devices, select the exact device, and enable control. Changing selection disables control until you enable it again.

Every call pins the selected ADB serial. A disconnected phone never falls through to another device or a cloud session. This release does not rent cloud phones, pair devices, enable debugging, or unlock phones.

## Agent workflow

Ask: “On my selected Android device, open Settings and tell me what is on screen.”

- `android_phone_devices` lists devices and the user's selection without taking a screenshot.
- `android_phone_observe({deviceId})` asks for screen access, then returns a PNG, visible text, element coordinates and `captureId`. If `focusedEditor` identifies the intended native input field, type directly instead of tapping it again; a blinking caret can invalidate coordinate taps.
- `application_operation` creates and executes capability `phone.android.action`. Its input contains `deviceId`, `snapshotId` (the observation's `captureId`), structured `action`, and optional `expected` package/text. Omit resources to derive the device lock.

Example create request after observing the selected device:

```json
{
  "action": "create",
  "request": {
    "idempotencyKey": "open-settings-1",
    "capability": "phone.android.action",
    "objective": "Open Android Settings",
    "input": {
      "deviceId": "emulator-5554",
      "snapshotId": "<captureId from this task>",
      "action": { "kind": "open_app", "package": "com.android.settings" },
      "expected": { "package": "com.android.settings" }
    }
  }
}
```

Creation records intent only; a planned operation has not sent input or obtained input approval. Phone operation IDs, status, unmet criteria, and the latest bounded observation remain available across task steps as volatile context, never long-term memory. Restoring a task whose generated title contains “Search” preserves the Android tools requested in its original user prompt; explicit tool restrictions and approvals still apply.

Execute the returned ID with `application_operation({action:"execute",operationId})`. Internal authorize/dispatch/readback tools refuse direct model calls. Third-party gateway senders cannot use phone tools. The route is available in desktop and daemon hosts, but requires interactive owner approval.

## Approval and recovery

Each independent observation and every input require explicit approval. Human review runs outside the device execution deadline; canceling before approval releases the operation’s resource lock without marking input as dispatched. A snapshot that expires during review still requires a new observation. Input approval also covers its readback and shows the exact device and action. A private approval record binds subsequent readback to that original task and action; cancellation before approval does not grant screen access. These approvals cannot become standing grants or automatic task permissions. Enabling the device alone never authorizes input.

Snapshots belong to the originating task, expire after two minutes, and are consumed once. Coordinate input and Back check the full screenshot before dispatch. Typing into a uniquely focused native text field binds its XML identity, bounds, text and focus plus every pixel outside that field; this permits caret blinking without permitting changes to the surrounding screen. Opaque or unidentified typing targets retain the full screenshot check. Any visual change, including a clock or animation, can require a new observation and approval rather than accepting stale coordinates. Home, Recents and a fixed package launch address explicit OS commands; they retain device, snapshot-age and screen-security checks. Secure-field XML must parse successfully before input. Busy or inaccessible screens still return approved screenshots with a warning; they are observation-only until accessibility and security checks recover. Secure fields, locked phones, recognized authentication screens and PIN/OTP-shaped numeric text require the user. Custom controls may not label themselves correctly; these checks are conservative, not universal authentication detection. Non-ASCII typing refuses instead of corrupting input.

Approved screenshots and text are shared with the selected model. With workspace write authority, approved captures are also saved as `android-screen-<captureId>.png` in the task workspace and returned as `path`. These PNGs are normal task artifacts that the model can link directly; completion checks validate their bytes and task ownership. Workspace copies follow normal artifact retention and are not removed by private-capture cleanup. Read-only workspaces still receive the attached screenshot, with an artifact warning instead of a saved deliverable. Captures are private files under `android-phone/snapshots`, retained for at most 24 hours when capture cleanup runs. Durable records store capture references and state hashes, not image bytes. Receipts under `android-phone/receipts` remain available for reconciliation.

When a stale input explicitly returns `notDispatched: true`, obtain a fresh approved observation and create a replacement with the same device, action and expected criteria, a new `snapshotId`, `supersedes: <failed operation ID>` and a greater `planRevision`. Execute the replacement with fresh approval. The journal retains the original failure as superseded so successful recovery can complete normally. Unknown/dispatched inputs, missing no-dispatch proof, changed actions/criteria and reused snapshots cannot use this path.

The application-operation journal persists the request and locks the exact device. The Python worker takes an OS file lock within the profile and flushes a receipt before input. An interrupted action can remain `unknown`. A completed original receipt permits fresh readback without repeating input; a dispatching or missing receipt never authorizes replay. Cancellation is not undo. **Stop phone activity** invalidates pending approvals and discovery as well as interrupting active workers. Settings writes preserve request order so a concurrent enable cannot overtake Stop; enable control again before reconciling.

Verification records the supplied package/visible-text conditions observed at `checkedAt`. Completed Android input receipts retain that historical verification while later steps run; they do not assert that the screen stays unchanged. The final requested state requires its own fresh approved observation. Verification proves only supplied package/visible-text conditions. It does not prove remote message delivery, purchase completion, or another business transaction. Without an outcome criterion, dispatch stays unverified. This is an initial unqualified adapter.

Criteria describe the state after the action. Android can delegate activities to another package: for example, a Pixel emulator opens Settings in `com.android.settings` and Settings search in `com.google.android.settings.intelligence`. Use an observed destination package, or expected visible text when the destination is unknown. A completed input with the wrong expected package remains unverified; creating a screenshot does not override it.

For the recorded development acceptance results and remaining validation boundaries, see [Android phone validation](android-phone-validation.md).

## Tests

```sh
npx vitest run src/electron/phone/__tests__ src/electron/applications/__tests__/android-phone-adapter.test.ts
```

Worker guard tests use Python 3 with Pillow 12.3.0 (CI provisions both). They run the actual bridge with an isolated fake phone transport.

Opt into live acceptance using a disposable emulator or test phone:

```sh
COWORK_ANDROID_E2E_DEVICE=emulator-5554 COWORK_ANDROID_E2E_ROOT=/tmp/cowork-android-phone-e2e npx vitest run src/electron/applications/__tests__/android-phone-adapter.test.ts
```

The live test installs the runtime if needed, opens Settings, exercises input, checks PNG output and fresh verification, restarts the service, reconciles receipts, and checks approval denial without dispatch. Its approval callback is controlled by the test; it does not replace acceptance through Electron’s visible approval cards. It writes `acceptance.png` and `acceptance.json` under the test root.

Upstream: [phone-harness](https://github.com/ShawnPana/phone-harness), MIT licensed. iPhone Mirroring and cloud integration are outside this release.
