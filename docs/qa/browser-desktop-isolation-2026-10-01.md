# Browser preview desktop isolation follow-up

Updated 1 October 2026. This documents the desktop regression reported and corrected locally on 30 September after PR #272 merged. The correction is local working-tree work on main; it has not been committed or pushed as part of this follow-up.

## Cause and correction

The browser approval explanation was inserted into the shared MainContent composer without a browser-only rendering boundary. The native renderer therefore displayed it when its existing approval runtime reported prompts off. The text described that state; adding the banner did not change approval settings or policy. The earlier claim that desktop was unaffected was not supported by the validation performed.

The correction adds `BrowserProfileNotice`, which returns no markup unless `window.coworkBrowserHost === true`. It remains absent on desktop whether browser hosting is enabled or disabled. Notice styles are scoped to `.browser-host`. The browser-only Calm menu wrapper no longer changes the native composer structure.

The same review restored pre-preview desktop sidebar session-action placement and spacing, native primary navigation visibility, draft handling during file staging, and optimistic message feedback/error presentation. Browser-specific behavior stays behind the browser renderer boundary. These restorations do not constitute a complete audit of shared runtime changes.

## Recorded validation

- The running source desktop was reloaded and its accessibility tree showed the ordinary composer and access control without the approval explanation or Review profiles button.
- Four focused test files passed, 96 tests total: `BrowserProfileNotice.test.tsx`, `browser-capabilities.test.ts`, `access-profile-presentation.test.ts`, and `main-content-working-state.test.ts`.
- Rendered-markup tests cover desktop with absent/false browser identity, browser with a notice, and browser without a notice. Capability tests cover native availability independently of browser capability restrictions.
- `npm run type-check`, `npm run build:react`, `npm run build:web`, scoped formatting and `git diff --check` passed for the local correction. These are source-checkout checks, not installed-package acceptance or a full native runtime regression suite.

## Required native compatibility gate

Before claiming desktop neutrality, compare shared execution, storage, settings and renderer behavior against the pre-preview baseline. Exercise native task admission, execution, attachments, follow-ups, approvals/input, cancellation, profile settings, navigation and recovery with browser hosting disabled and enabled. In enabled mode, native and browser clients must retain their own UI and authorization boundaries while using the same host services. Validate installed artifacts separately.

Web-only changes must not alter native defaults, approval policy or user data. A shared runtime fix needs its own native evidence; browser task completion cannot substitute for it. The broader browser parity and release backlog remains in [the gap plan](../browser-parity-gap-plan.md).
