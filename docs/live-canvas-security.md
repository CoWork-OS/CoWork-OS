# Live Canvas network access

Live Canvas content, scripts, snapshots, and interactive previews use an isolated
session bound to their owning task. Requests follow the task's current network
permissions and domain rules, including redirects and subresources. A missing
or closed task session cannot make remote requests. Task tools cannot modify or
execute another task's Canvas session.

With networking disabled, local HTML, CSS, JavaScript, images, and snapshots still
work. With networking set to Ask for approval, agent-authored HTML and JavaScript
cannot silently open a connection. Use the approved `canvas_open_url` tool to
open a destination; its origin can then load resources in that Canvas session.
Authorization applies only while the task's permissions match the state used
to authorize the origin. The grant is not persisted across app restarts. Opening a URL directly from Canvas controls
also authorizes that origin, subject to the task's network restrictions.

Remote Canvas requests support HTTP and HTTPS. Connections use the address
validated by the network guard, retaining the destination hostname for HTTP and
TLS. WebSocket and other remote schemes are blocked; Canvas pages that require
them need an HTTP-based alternative. Popups cannot create an unguarded window.
Exporting HTML and opening it in an external browser is an explicit user action;
that external browser has its own network settings.

After `npm run build:electron`, run the desktop regression with:

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/qa/smoke-canvas-security.cjs
```

The regression uses hidden windows, a disposable application-data directory, and
a local HTTP server. It checks HTML/script/webview denial, offline snapshots,
approved origins, redirects, private DNS answers, missing owners, and unbound
Canvas protocol access. It removes its temporary data when finished.

See the [2026-09-30 security fix record](security-fixes-2026-09-30.md) for the
related HTTP, webhook, tunnel, and archive fixes and recorded validation.
