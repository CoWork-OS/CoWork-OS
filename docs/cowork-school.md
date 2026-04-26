---
title: "CoWork OS: A Beginner's Guide"
description: A practical guide to what CoWork OS is, how it differs from chat-only AI tools, how to get started, and which workflows to try first.
---

# CoWork OS: A Beginner's Guide

A local-first AI operating system that can chat, execute tasks, operate across channels, and run background workflows without giving up approvals, guardrails, or ownership of your data.

## Why this guide exists

The first question people ask after installing CoWork OS is simple:

> What should I actually do with it?

That is a fair question. CoWork OS can look like a lot at first because it is not just a chatbot, a coding assistant, or an automation tool. It is a runtime that can combine all three. This guide is here to make the first hour feel obvious.

The goal is not to teach every setting. It is to help you understand what CoWork OS is good at, what it should not be trusted with blindly, and which workflows are worth trying first.

## The basics

### What is CoWork OS?

CoWork OS is a local-first AI operating system for real work.

In practice, that means:

- it can chat with you like a normal assistant
- it can execute multi-step tasks using tools such as files, shell, browser automation, and connectors
- it can run across desktop, messaging channels, or a headless control plane
- it can keep background systems running through Memory, Heartbeat, Workflow Intelligence, Scheduled Tasks, and Daily Briefing
- it keeps approvals, guardrails, encrypted settings, and workspace boundaries in the product instead of expecting you to bolt them on later

If ChatGPT feels like “ask a smart model a question,” CoWork OS is closer to “give an operator a job, tools, memory, and rules.”

### How is it different from ChatGPT, Claude, or Codex?

The difference is not just the model. It is the operating model.

Chat-first tools are great when you want an answer, a draft, or a quick burst of reasoning. CoWork OS is better when you want the system to stay with the work.

It can:

- work inside a real workspace with files, outputs, and project context
- ask for approval before sensitive actions instead of silently assuming trust
- route work across messaging channels like Slack, Telegram, Discord, WhatsApp, Teams, iMessage, email, and more
- keep long-running operational loops alive through automations instead of waiting for the next prompt
- separate profiles, companies, devices, skills, and policies so one setup does not leak into another

In short: most AI tools are conversations. CoWork OS is a governed execution environment.

### What can it access?

By default, CoWork OS is only as capable as the permissions and connections you give it.

Depending on your setup, it can work with:

- local files in the selected workspace
- shell commands
- browser automation
- messaging channels
- email and inbox workflows
- MCP connectors for external systems
- remote CoWork devices
- local or hosted LLM providers

That does not all turn on at once. You choose what to enable.

### What are its boundaries?

CoWork OS is powerful, but it is not magic.

- It can still be wrong. Treat it as a collaborator, not an oracle.
- It only knows the context you give it or let it access.
- It is strongest on workflows with clear tools, clear boundaries, and clear completion criteria.
- It should not be given broad destructive permissions unless you actually need them.
- Some desktop features are specific to macOS or Windows, while Linux headless setups are better for server-style automation.

The best results come from treating it like a capable operator you supervise, not an all-knowing system you blindly trust.

## What it feels like to work with CoWork OS

### It moves from “AI time” into normal work time

With a normal chatbot, you leave your work, open a model, ask a question, then copy the result back into whatever you were doing.

CoWork OS reduces that context switching. You can create a task in the desktop app, start from an Ideas prompt, operate through a channel, or run it from a VPS control plane. The task, the outputs, the approvals, and the memory all stay in one operating surface.

### It is better at workflows than one-shot prompts

The real advantage shows up when the work has multiple steps:

- inspect files
- compare options
- browse a site
- draft an artifact
- ask you for confirmation
- continue the task with your answer

This is where CoWork OS starts to feel less like “generate text” and more like “run the job.”

### It can become a background operator

Once your setup is stable, CoWork OS does not have to wait for you to start every task manually.

You can add:

- Daily Briefing for recurring summaries
- Scheduled Tasks for time-based workflows
- Event Triggers and Webhooks for inbound events
- Heartbeat for periodic checks
- Workflow Intelligence for reviewable next actions and reflective follow-up

That changes the relationship. You stop using it only when you remember to ask, and start using it as a system that keeps watch.

### It can become a team surface, not just a personal toy

CoWork OS is especially strong when work crosses channels, people, and systems.

A founder can use it as a company operator shell. A lead can use it for inbox triage, planning, and approvals. A developer can use it for code review, debugging, refactors, and docs. A support or ops team can use it where auditability and governed execution matter more than raw novelty.

## Getting started

There are three sensible ways to begin, depending on how hands-on you want to be.

### 1. Use the desktop app on macOS or Windows

This is the best place to start if you want the full UI, approvals, task timeline, and easiest onboarding.

Download the latest release from GitHub Releases and install it locally.

### 2. Install it from npm

If you want the fastest local setup:

```bash
npm install -g cowork-os
cowork-os
```

This is a good fit if you already live in the terminal and want a lightweight install path.

### 3. Run it headless on a VPS

If you want CoWork OS running continuously without depending on your laptop, use the Linux daemon path.

Start with:

- [Self-Hosting](./self-hosting.md)
- [VPS / Linux](./vps-linux.md)
- [Remote Access](./remote-access.md)

That setup is ideal for always-on automation, messaging channels, and server-style operations.

## The first workflows to try

Do not start with the most impressive thing. Start with the thing that removes friction from your day immediately.

## Beginner

### 1. Give it a bounded local task

Start with a task where the workspace is obvious and the success criteria are easy to inspect.

Try:

```text
Organize this folder by file type. Create clear subfolders, avoid duplicates, and ask before deleting anything.
```

This teaches you the most important mental model: CoWork OS is not just replying. It is inspecting, planning, executing, and stopping when approval matters.

### 2. Ask it to produce a real artifact

Pick a spreadsheet, summary, document, or slide deck you would normally do yourself.

Try:

```text
Create a weekly project summary document from the files in this workspace. Include progress, open questions, risks, and next steps.
```

You will quickly see the difference between “a nice answer” and “a usable output.”

### 3. Use the Ideas panel

If you do not know what to try next, use the Ideas panel. It gives you pre-written prompts for common workflows so you can evaluate the product by running something real rather than inventing the perfect first prompt.

## Intermediate

### 1. Set up your inbox workflow

Inbox work is where CoWork OS starts paying rent quickly.

Try:

```text
Run inbox triage for the last 24 hours. Classify messages by urgency, draft replies for anything urgent, and stop before sending anything.
```

This works especially well if you want AI help without giving up the final decision.

### 2. Create a daily briefing

Once one-off tasks feel solid, make the system proactive.

Try:

```text
Every morning, give me one briefing with today's calendar, important inbox items, follow-ups, and anything that looks blocked or overdue.
```

This is a strong early automation because it is useful, low risk, and easy to judge.

### 3. Build a research vault

If you do recurring research, use `llm-wiki` instead of starting from scratch every time.

Try:

```text
Build a persistent research vault for [topic]. Capture raw sources, create linked notes, and show me the main open questions.
```

This is one of the clearest examples of CoWork OS acting like a durable operating environment rather than a stateless chat window.

## Advanced

### 1. Add channels

Once you trust the runtime locally, connect the channels where you actually work.

Good early choices:

- Slack
- Telegram
- Discord
- Email

Later, add the more personal or operational channels once you know the trust model you want.

### 2. Add a remote device

If you want work to run on another machine, use the Devices tab and connect a remote CoWork node. This is useful for persistent environments, isolated workloads, and automation that should not depend on your main laptop.

### 3. Build a governed company loop

If you are a founder or operator, CoWork OS can go beyond personal assistance into company execution.

That usually means combining:

- a git-backed workspace
- company files in `.cowork/`
- one or more operator personas
- automations
- Mission Control as the monitoring surface

That is not the right starting point for everyone, but it is where the product becomes much more than “an assistant with tools.”

## The right mindset

People get the most value out of CoWork OS when they shift from a chatbot mindset to an operator mindset.

### Think in jobs, not prompts

Do not ask only for answers. Ask it to complete bounded jobs with inputs, outputs, tools, and a stopping point.

### Start with something annoying

The best first workflow is usually:

- repetitive
- mildly painful
- easy to verify
- not catastrophic if the first version is imperfect

Inbox summaries, recurring briefs, document generation, research capture, and file organization are all good candidates.

### Expect iteration

The first result is usually not the final result. The product gets more useful as you clarify taste, constraints, and what “done” looks like.

### Keep trust proportional to risk

Use approvals, profiles, guardrails, and narrow workspace scope. Expand trust only after a workflow has earned it.

## Staying safe

CoWork OS is designed with stronger controls than most agent tools, but the controls only help if you use them well.

### Start narrow

Begin with one workspace and one concrete task. Do not enable broad shell or delete permissions unless the workflow needs them.

### Keep sensitive work in the right profile

Use profiles to separate personal, client, staging, and company contexts. That keeps credentials, channels, memory, and history from bleeding together.

### Prefer approval-heavy workflows at first

Early on, stop before sending messages, booking things, deleting files, or changing external systems. Once the workflow is consistently good, you can relax the friction where it makes sense.

### Treat channels as production surfaces

If you connect Slack, Telegram, iMessage, or email, remember that those are real communication surfaces. Configure them intentionally and review who can trigger what.

### Review automations before you forget about them

Background systems are powerful precisely because they keep running. Make sure Scheduled Tasks, Heartbeat, Daily Briefing, and triggers are doing the work you think they are doing.

## Where to go next

- [Getting Started](./getting-started.md) for setup and first-run instructions
- [Features](./features.md) for the full capability map
- [Use Case Showcase](./showcase.md) for workflow examples across engineering, ops, research, and business functions
- [Channels](./channels.md) for messaging setup
- [Core Automation](./core-automation.md) for the always-on runtime
- [Security Guide](./security-guide.md) for guardrails, permissions, and trust boundaries

If you only remember one thing, remember this:

CoWork OS is best when you use it to operate ongoing work with clear boundaries, not when you use it as a fancier search box.
