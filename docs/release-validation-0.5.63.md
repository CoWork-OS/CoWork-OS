# 0.5.63 release validation

Release preparation on macOS arm64 with Node 24.21.0, run on 2026-11-15. Nothing has
been tagged, uploaded or published.

The candidate is `b249935c5`. It adds the release documentation and the version bump
on top of main `1d616843c`, which is the merge of #860. The code under test is main at
that commit. Contributor PRs #859 and #861 were reviewed and left out of this release;
the findings are on each PR.

All checks ran from a clean worktree after `npm ci`, with `build/numbat` copied in.

## Checks

| Check | Command or surface | Result |
| --- | --- | --- |
| Clean install | `npm ci` | Passed. |
| Build | `npm run build`, `build:daemon`, `build:cli` | Passed. |
| Static checks | `npm run type-check`, `npx tsc --noEmit -p tsconfig.electron.json`, `npm run lint`, `npm run fmt:check`, `qa:docs-versions`, `qa:positioning-copy`, `test:release-surfaces`, `git diff --check` | Passed. |
| Full suite | `npm test` | 19,858 Vitest tests passed (10 skipped), and 153 Node tests passed. Nothing failed. |
| #860 sandbox shims | The two sandbox toolchain suites plus the rest of `src/electron/agent/sandbox/__tests__` | 226 passed (5 skipped) on a Mac with Xcode selected. The shim test is pinned to the Command Line Tools with `DEVELOPER_DIR`. PR CI passed every job, including Tests (macOS). |
| Clean npm install | `node scripts/release-smoke-install.mjs` | Passed. The packed tarball installed and set up without falling back to dependency bootstrap. Electron loaded SQLite. The browser-host workflow passed. The installed CLI ran cold and warm local tasks and exited cleanly, and the desktop launcher started. |
| macOS artifacts | `npm run package:mac:unsigned`, then `package:mac:smoke --expected-version=0.5.63 --allow-unsigned --mock-keychain` | Passed. The app is ad hoc signed (`Signature=adhoc`, no Team ID). `hdiutil verify` passed. The first window loaded from the mounted DMG, and the ZIP installed with the terminal installer. DMG `01b7af438046e7b41839aa745cb610338271d4a6186c0179df1f68aaa7917278`, ZIP `fd2c089b2576e45cd25100a67d1e256e1360c366b41408d655f24ea9073c2273`. |

## Limits

- **The real Keychain path was not covered by the packaged smoke.** This Mac already has
  a "CoWork OS Safe Storage" Keychain item from the installed app. A freshly built,
  differently signed binary that reads it waits for a Keychain approval prompt.
  - The clean-install CLI smoke passed only after the prompt was approved by hand. Before
    that, two runs timed out while blocked in `SecItemCopyMatching`.
  - The packaged desktop smoke timed out twice at the same step because nobody answered
    the prompt within its 60-second window. The passing run used `--mock-keychain`,
    which is how `release.yml` runs it on the runner.
  - A first start that creates the data key against the real Keychain still needs a
    manual check on the installed artifact.
- **Developer ID signing must not be used for releases.** `npm run package` on this Mac
  picked up a Developer ID from the login Keychain and signed with it. Those builds were
  set aside unused. Release builds go through `package:mac:unsigned`, or
  `COWORK_MAC_UNSIGNED=1` with `--mac`, as in `release.yml`.
- **Some checks were not run for this release:** Windows and Linux artifacts, the
  task-computer smokes, upgrade smokes from 0.5.62, and real-provider runs.
  `release.yml` builds and smokes the Windows and Linux artifacts at tag time.
- **Unverified in the running app**, as noted on their PRs: #891's stop button,
  #847's LM Studio detection against a live server, and #892's browser permission
  prompt.
