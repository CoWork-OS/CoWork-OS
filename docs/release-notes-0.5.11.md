# Release Notes 0.5.11

> Historical release note: the personal Health feature was discontinued on 2026-09-26. See the [decision record](personal-health-discontinuation.md) for current support status.

This page summarizes the product changes included in `0.5.11`, based on the changes merged after `v0.5.1` on 2026-03-18.

## Overview

The branch adds a broader operating surface around mission control, health, QA, connector profiling, and autonomous follow-up, while also refreshing the core agent runtime and documentation.

## What Changed

### New operator surfaces

- **Mission Control**: new dashboard surfaces for agent board, feed, ops, overview, issue detail, task detail, agent detail, and a shared top bar.
- **Health panel**: a dedicated health surface for monitoring the app and the Apple Health bridge.
- **Dispatch panel**: a new renderer entry point for dispatching work.
- **Connector profile view**: a dedicated profile page for connector-specific guidance and example prompts.
- **Playwright QA panel**: a task-oriented QA UI for browser checks and validation flows.

### New agent and runtime capabilities

- **Chat mode detection**: the executor can now route direct chat sessions separately from tool-using task runs.
- **Context mode detection**: task context is now classified more explicitly so the runtime can choose the correct execution path.
- **Proactive suggestions**: the agent can surface more timely follow-up suggestions.
- **Managed output paths**: task artifacts now use managed output path handling rather than ad hoc file locations.
- **QA toolchain**: new QA tools and Playwright QA service support browser-based validation tasks.
- **Document generation**: new HTML and EPUB generators support richer output packaging.
- **Tooling updates**: file, shell, document, and channel tools were revised to fit the new execution and QA flows.

### New integrations and connectors

- **Figma, Monday, and Vercel MCP connectors**: new installable connector packages were added under `connectors/`.
- **Discord live fetch**: the gateway can now pull live Discord message data in addition to the local gateway log.
- **HealthKit bridge**: a new native Swift package bridges Apple Health data into the desktop app.
- **New bundled skills**: `aurl`, `autonovel`, `autoresearch-report`, and `playwright-qa` were added as bundled skill entries.

### Automation and intelligence improvements

- **Autonomy engine**: new autonomy and awareness services support more structured background follow-up.
- **Heartbeat service**: heartbeat orchestration was expanded to support the larger operator loop.
- **Daily briefing**: briefing logic was updated to better feed the operator surfaces.
- **Strategic planner**: planner services and tests were refreshed for the company/ops workflow.
- **Improvement candidates**: candidate handling was tightened around the legacy repo-improvement loop that preceded the current subconscious model.
- **Mode suggestions and task detection**: shared primitives now detect automated task patterns and suggest modes more accurately.

### Shared model and UI updates

- **Connector profiles**: shared connector profile metadata now drives connector-specific guidance in the UI.
- **Health primitives**: shared health types and handlers now feed the health dashboard and IPC layer.
- **Starter missions**: starter mission content was refreshed.
- **Provider error formatting**: provider errors now share a clearer normalized format.
- **Personality settings**: the settings flow was expanded into dedicated identity, style, traits, instructions, and advanced tabs.
- **Sidebar and home dashboard**: navigation, task views, notifications, and dashboard layout received broad polish.

### Documentation refresh

- **README**: updated the product summary to call out the new release areas.
- **Architecture, features, channels, and enterprise connector docs**: refreshed to match the current runtime.
- **Chat mode and channel comparison docs**: added focused guidance for the new execution split and channel behavior.
- **Changelog and index pages**: updated to help readers find the current capabilities quickly.

## Notes

- Generated build artifacts such as `node_modules`, `dist`, and `native/healthkit-bridge/.build` remain ignored and are not part of the release notes content.
- This page is the canonical summary for the changes included in `0.5.11`.
