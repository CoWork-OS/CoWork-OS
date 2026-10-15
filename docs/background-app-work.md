# Working with apps in the background

CoWork does work in other applications without taking over your computer. It runs apps on your own computer, not on a remote worker, and it does not borrow your screen, pointer, keyboard or clipboard. It reaches each application the most direct way it can, in this order:

1. **The application's API**, through an MCP server or a connector. Remote services such as Workday Agent-Ready Tools are reached this way.
2. **The application's own scripting**, wrapped in a durable application operation. The background Photoshop route works this way.
3. **The application's window**, through `native_app`, which operates one exact window of an installed macOS app without activating it.

All three routes run under the task's normal access profile, approvals and tool restrictions, and treat an action as done only once a fresh readback confirms it.

## What you can do today

| Route | Example request | Where it runs | Details |
| --- | --- | --- | --- |
| Remote MCP with OAuth | "What is my time off balance in Workday?" (read); "Change my preferred first name in Workday" (write, asks first) | Desktop app and headless runs; an agent key (JWT bearer) identity needs no person or browser | [Remote MCP OAuth](remote-mcp-oauth.md) |
| Local Photoshop scripting | Create a banner PSD and PNG, or change a named text layer in an existing PSD | Desktop app on an unlocked Mac with Photoshop installed; Photoshop is launched without activating it | [Local Photoshop editing](photoshop-local-editing.md) |
| Background window control (`native_app`) | "In Calculator, in the background, calculate 12 × 12 and check the result" | Desktop app on an unlocked Mac, with Accessibility and Screen Recording permission | [Background app control](local-background-app-control.md) |
| Application operations | Any qualified adapter's work, tracked from proposal to verified result | Desktop app and the [Node daemon](node-daemon.md) expose the same Control Plane methods | [Application execution backend](application-execution-backend.md) |

Qualification is per app and per action, and the docs above list what has been checked. For example, Calculator is qualified for `native_app`, but Photoshop's generic UI is not: edit Photoshop documents through the local Photoshop route instead. An Excel route exists as an experimental pilot that needs a running Excel in your desktop session; it is not a background route.

## What you can rely on

- **Your work is left alone.** Apps are launched without activation, and `native_app` sends input only to the target window. If the app takes focus itself or the pointer moves unexpectedly, the action is reported as `outcome_unknown` rather than succeeded. If you start using the target app, CoWork pauses.
- **Approvals work as usual.** A write asks first under **Ask for approval** or **Approve for me**. For an MCP tool, the approval card shows the server and the call's exact arguments. **Full access** never opens an approval: a call that needs one is denied.
- **Nothing is sent twice.** Every change is written to the task's journal before it is sent. A lost reply is checked against the application, never resent blindly, and an unresolved change blocks further changes in that task until it is resolved.
- **Done means verified.** A delivered action or an accepted request is not proof. Completion needs a fresh observation of the window, a readback of the saved file, or the service's own response, and the final answer reports that evidence.
- **Stop cancels and doesn't undo.** Stopping the task cancels pending work, but changes that were already applied stay applied.
- **"Don't use scripts" is enforced.** If a task says not to use scripting, the scripting tools are hidden from the agent and denied if it calls them anyway.

## Headless and server use

A headless CoWork (the [Node daemon](node-daemon.md), a [Linux VPS](vps-linux.md) or a `--headless` run) can use API and MCP routes, including remote OAuth MCP servers. A server that signs in as a person needs one sign-in in the desktop app; after that its refresh token keeps it working headless until it expires (24 hours for Workday unless it is used). An agent key identity never needs a person. The daemon's Control Plane exposes the same `application.*` operation methods as the desktop app.

Routes that drive a local app, `native_app` and the Photoshop route, need the macOS desktop app in an unlocked session. Control while the Mac is locked is not implemented.

## Not supported

- Running apps over SSH or on a remote application worker.
- Controlling a locked Mac, minimized windows, menus or secure text fields through `native_app`.
- Treating an app as qualified before its route has been checked: other apps may ignore background input or activate themselves.

See [Architecture: application execution and background app control](architecture.md#application-execution-and-background-app-control) for the implementation map.
