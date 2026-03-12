const { app, BrowserWindow, screen } = require("electron");

const WIDTH = 480;
const HEIGHT = 82;
const DISMISS_MS = 5000;
const FADE_MS = 300;

function buildHtml() {
  const radius = HEIGHT / 2;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
  }

  body {
    position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
      "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }

  #n {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    height: 100%;
    padding: 0 22px 0 15px;
    border-radius: ${radius}px;
    overflow: hidden;
    isolation: isolate;
    animation: in 0.38s cubic-bezier(0.16, 1, 0.3, 1);
    transform-origin: top center;
  }

  #n::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: rgba(20, 20, 26, 0.45);
    backdrop-filter: blur(80px) saturate(280%) brightness(1.08);
    -webkit-backdrop-filter: blur(80px) saturate(280%) brightness(1.08);
    z-index: -2;
  }

  #n::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.15),
      inset 0 -0.5px 0 rgba(0, 0, 0, 0.15);
    z-index: -1;
    pointer-events: none;
  }

  body:hover #n::before {
    background: rgba(30, 30, 40, 0.55);
  }

  @keyframes in {
    from { opacity: 0; transform: scaleX(0.72) scaleY(0.4); }
    to   { opacity: 1; transform: scaleX(1) scaleY(1); }
  }

  #n.out {
    animation: out 0.28s cubic-bezier(0.4, 0, 1, 1) forwards;
  }

  @keyframes out {
    to { opacity: 0; transform: scaleY(0.5) scaleX(0.8); }
  }

  .icon {
    width: 52px;
    height: 52px;
    min-width: 52px;
    border-radius: 50%;
    background: linear-gradient(145deg, #0891b2 0%, #22d3ee 55%, #06b6d4 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 2px 10px rgba(6, 182, 212, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  .icon svg {
    width: 26px;
    height: 26px;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.96);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.2px;
    line-height: 1.35;
    text-shadow: 0 1px 3px rgba(0,0,0,0.4);
  }

  .sub {
    font-size: 13px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
    letter-spacing: -0.1px;
    line-height: 1.35;
    text-shadow: 0 1px 2px rgba(0,0,0,0.3);
  }
</style>
</head>
<body>
  <div id="n">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2.2" y="7.1" width="19.6" height="9.4" rx="1.15" stroke-width="1.7"/>
        <path d="M4.3 16.9c0.45 1 1.25 1.45 2.55 1.45h10.3c1.3 0 2.1-0.45 2.55-1.45" stroke-width="1.5"/>
        <circle cx="17.4" cy="9.95" r="1.02" fill="white" stroke="none"/>
        <circle cx="19.2" cy="9.95" r="0.46" fill="white" stroke="none"/>
      </svg>
    </div>
    <div class="text">
      <div class="title">Overlay edge test</div>
      <div class="sub">Checking the macOS notification pill after the blur-layer fix.</div>
    </div>
  </div>
  <script>
    setTimeout(function () {
      document.getElementById("n").classList.add("out");
    }, ${DISMISS_MS - FADE_MS});
  </script>
</body>
</html>`;
}

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const { workArea, bounds } = display;
  const x = Math.round(bounds.x + bounds.width * 0.75 - WIDTH / 2);
  const y = workArea.y + 8;

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y,
    frame: false,
    transparent: process.platform === "darwin",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    backgroundColor: "#00000000",
    show: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, "floating");
  }

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml())}`);
  win.once("ready-to-show", () => win.showInactive());
  setTimeout(() => app.quit(), DISMISS_MS + 300);
});
