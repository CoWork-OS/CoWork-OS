---
name: playwright-qa
description: "Automated visual QA testing using Playwright — navigate web apps like a real user, capture screenshots, find bugs, and fix them."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
---

# Playwright QA

## Purpose

Automated visual QA testing for web applications. Uses Playwright to launch a headless browser, navigate the app like a real user, take screenshots, check for console/network errors, test interactive elements, verify responsive layouts, and identify visual bugs — then fix them automatically.

## Routing

- Use when: Any web app task that mentions testing, catching bugs, verifying it works, shipping, or quality — even without explicitly mentioning Playwright or visual QA. Also use when the user builds a web app and the implicit expectation is that it should work.
- Do not use when: The task is purely about unit tests, API testing, non-web application testing, or native mobile app testing.
- Outputs: QA report with checks (passed/failed), issues categorized by severity, screenshots, and interaction log.
- Success criteria: All checks pass, or issues are identified with clear descriptions and auto-fixed where possible.

## Trigger Examples

### Positive

- Build a todo app in React, test it to catch any bugs before shipping
- Build a dashboard and make sure it works
- Create a landing page and verify everything looks right
- Build this web app and ship it bug-free
- Make a React app, test it
- Build a weather app and check for issues
- Create the app and QA it
- Build and test the frontend
- Does the app work?
- Test this web app with Playwright
- Run visual QA on localhost:3000
- Check my site for bugs
- Do automated browser testing
- Verify the UI works
- Screenshot and test the web app
- Find visual bugs in my project
- Test the app like a real user
- QA the frontend
- Run Playwright tests
- Make sure it works before we ship

### Negative

- Write unit tests with Jest
- Run jest/vitest tests
- Test the API endpoints with curl
- Do load testing with k6
- This is a native iOS/Android app
- Run backend unit tests

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| url | string | No | Target URL to test (defaults to http://localhost:3000) |
| server_command | string | No | Command to start the dev server (e.g., "npm run dev") |
| checks | string | No | Comma-separated list of checks: visual_snapshot, console_errors, network_errors, interaction_test, responsive_check, accessibility_check, performance_check |

## Runtime Prompt

You are running automated visual QA on a web application using Playwright.

**Workflow:**

1. **Install dependencies** (if project was just scaffolded):
   - If the project has a `package.json` but no `node_modules`, run `npm install` (or `yarn`/`pnpm install`) via `run_command` first.
   - NEVER skip this step for a freshly created project — `npm run dev` will fail without it.

2. **Start the dev server** (if not already running):
   - Use `qa_run` with `server_command` to start it automatically, OR
   - Use `run_command` to start the server manually if needed

3. **Run full QA pipeline**:
   - Call `qa_run` with the target URL and enabled checks
   - This will automatically: launch browser, navigate, check console errors, check network errors, take visual snapshots, and test interactive elements

4. **Review results**:
   - Check the QA report for any issues
   - Issues are categorized as critical, major, or minor

5. **Fix issues** (if auto_fix is enabled):
   - For each critical/major issue, fix the code
   - Re-run `qa_run` to verify the fix
   - Repeat until all critical/major issues are resolved

6. **Manual testing** (for specific flows):
   - Use `qa_navigate` to go to specific pages
   - Use `qa_interact` to test user flows (click buttons, fill forms, hover elements)
   - Use `qa_screenshot` to capture state at key points
   - Use `qa_check` to run specific checks

7. **Cleanup**:
   - Always call `qa_cleanup` when done

**Key tools:**
- `qa_run` — Full automated pipeline (recommended starting point)
- `qa_navigate` — Navigate to a URL
- `qa_interact` — Click, fill, hover, scroll
- `qa_screenshot` — Take a screenshot with diagnostics
- `qa_check` — Run a specific check
- `qa_report` — Get current run report
- `qa_cleanup` — Tear down browser and server

**Best practices:**
- Always start with `qa_run` for a comprehensive first pass
- Fix critical issues before minor ones
- Re-run after fixes to verify
- Use `qa_interact` for specific user flow testing
- Take screenshots at key interaction points
- Check both desktop and mobile viewports
