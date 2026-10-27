/** Wait for the packaged app's actual first-window startup event. */
export function waitForFirstWindow(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    let finished = false;
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for the first window. Recent output:\n${output.trim()}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      // Startup can be verbose; retain a bounded tail for diagnostics.
      output = (output + chunk.toString()).slice(-32_768);
      if (/"lane"\s*:\s*"first_window_startup"[^\n]*"event"\s*:\s*"did_finish_load"/.test(output)) {
        finish();
      }
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) =>
      finish(
        new Error(
          `App exited before the first window (code ${code}, signal ${signal}).\n${output.trim()}`,
        ),
      );

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}
