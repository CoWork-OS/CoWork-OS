/**
 * The dictation overlay page: a small pill that records from the microphone and shows
 * what dictation is doing. Main drives it with `executeJavaScript` (`window.__dictation`)
 * and reads the recording back as the return value, so the page needs no preload and no
 * IPC. Its two buttons report clicks as console messages with ACTION_PREFIX.
 *
 * It is served from a file, not a data: URL, because the microphone needs a secure context.
 */

export const DICTATION_ACTION_PREFIX = "cowork-dictation:";
export type DictationOverlayAction = "finish" | "cancel";

export function parseDictationAction(message: string): DictationOverlayAction | null {
  if (!message.startsWith(DICTATION_ACTION_PREFIX)) return null;
  const action = message.slice(DICTATION_ACTION_PREFIX.length);
  return action === "finish" || action === "cancel" ? action : null;
}

export const DICTATION_OVERLAY_WIDTH = 380;
export const DICTATION_OVERLAY_HEIGHT = 56;

export function buildDictationOverlayHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';" />
<title>Dictation</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: transparent; overflow: hidden; user-select: none;
    font: 13px/1.3 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; }
  body { display: flex; align-items: center; justify-content: center; padding: 4px; }
  .pill { display: flex; align-items: center; gap: 10px; width: 100%; height: 100%;
    padding: 0 8px 0 14px; border-radius: 24px; color: #f5f5f7;
    background: rgba(28, 28, 30, 0.92); border: 0.5px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
  .meter { display: flex; align-items: center; gap: 2px; height: 18px; flex: none; }
  .meter i { width: 3px; height: 18px; border-radius: 2px; background: #ff453a;
    transform: scaleY(calc(0.18 + var(--level, 0) * 0.82)); transition: transform 80ms linear; }
  .pill[data-state="working"] .meter i { background: #98989d; animation: wait 900ms ease-in-out infinite; }
  .pill[data-state="working"] .meter i:nth-child(2) { animation-delay: 120ms; }
  .pill[data-state="working"] .meter i:nth-child(3) { animation-delay: 240ms; }
  .pill[data-state="working"] .meter i:nth-child(4) { animation-delay: 360ms; }
  .pill[data-state="working"] .meter i:nth-child(5) { animation-delay: 480ms; }
  .pill[data-state="done"] .meter, .pill[data-state="error"] .meter { display: none; }
  .mark { display: none; flex: none; width: 18px; text-align: center; font-weight: 600; }
  .pill[data-state="done"] .mark { display: block; color: #32d74b; }
  .pill[data-state="error"] .mark { display: block; color: #ff9f0a; }
  .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill[data-state="done"] .text, .pill[data-state="error"] .text { white-space: normal;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12px; }
  button { flex: none; border: none; border-radius: 14px; height: 28px; padding: 0 12px;
    font: inherit; color: #f5f5f7; background: rgba(255, 255, 255, 0.12); cursor: default; }
  button:hover { background: rgba(255, 255, 255, 0.2); }
  button.icon { width: 28px; padding: 0; font-size: 15px; }
  .pill:not([data-state="listening"]) #finish { display: none; }
  .pill[data-state="done"] #cancel, .pill[data-state="error"] #cancel { display: none; }
  @keyframes wait { 0%, 100% { transform: scaleY(0.25); } 50% { transform: scaleY(0.7); } }
  @media (prefers-reduced-motion: reduce) {
    .meter i { transition: none; }
    .pill[data-state="working"] .meter i { animation: none; transform: scaleY(0.4); }
  }
</style>
</head>
<body>
<div class="pill" id="pill" data-state="listening" role="status" aria-live="polite">
  <span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
  <span class="mark" id="mark" aria-hidden="true"></span>
  <span class="text" id="text"></span>
  <button type="button" id="finish">Done</button>
  <button type="button" id="cancel" class="icon" aria-label="Cancel dictation">×</button>
</div>
<script>
(() => {
  const PREFIX = ${JSON.stringify(DICTATION_ACTION_PREFIX)};
  const pill = document.getElementById("pill");
  const text = document.getElementById("text");
  const mark = document.getElementById("mark");
  const bars = Array.from(document.querySelectorAll(".meter i"));
  const weights = [0.55, 0.85, 1, 0.8, 0.6];
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioContext = null;
  let frame = 0;

  document.getElementById("finish").addEventListener("click", () => console.log(PREFIX + "finish"));
  document.getElementById("cancel").addEventListener("click", () => console.log(PREFIX + "cancel"));

  function setLevel(level) {
    bars.forEach((bar, index) => bar.style.setProperty("--level", String(Math.min(1, level * weights[index]))));
  }

  function startMeter() {
    try {
      audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const value = (sample - 128) / 128;
          sum += value * value;
        }
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setLevel(0.3);
    }
  }

  function release() {
    cancelAnimationFrame(frame);
    frame = 0;
    setLevel(0);
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    recorder = null;
    chunks = [];
  }

  window.__dictation = {
    setState(state, message) {
      pill.dataset.state = state;
      text.textContent = message;
      mark.textContent = state === "done" ? "✓" : state === "error" ? "!" : "";
    },
    async start() {
      release();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        release();
        return { ok: false, error: (error && error.name) || "Error" };
      }
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      try {
        recorder = new MediaRecorder(stream, { mimeType });
      } catch (error) {
        release();
        return { ok: false, error: (error && error.name) || "Error" };
      }
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(1000);
      startMeter();
      return { ok: true };
    },
    stop() {
      return new Promise((resolve) => {
        const active = recorder;
        if (!active || active.state === "inactive") {
          release();
          resolve(null);
          return;
        }
        active.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: "audio/webm" });
            resolve(new Uint8Array(await blob.arrayBuffer()));
          } catch {
            resolve(null);
          } finally {
            release();
          }
        };
        try {
          active.stop();
        } catch {
          release();
          resolve(null);
        }
      });
    },
    cancel() {
      const active = recorder;
      if (active && active.state !== "inactive") {
        active.onstop = null;
        try {
          active.stop();
        } catch {}
      }
      release();
      return true;
    },
  };
})();
</script>
</body>
</html>
`;
}
