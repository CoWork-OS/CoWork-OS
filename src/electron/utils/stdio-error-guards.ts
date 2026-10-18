type ErrorStream = Pick<NodeJS.WriteStream, "on" | "off">;

/** A detached launcher can close its output pipes while Electron is still alive. */
export function installStdioErrorGuards(streams: readonly ErrorStream[]): () => void {
  const handleError = (error: NodeJS.ErrnoException) => {
    // Reporting this through console would write to the same broken pipe and
    // repeatedly enter the process-level uncaughtException logger.
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
    throw error;
  };
  for (const stream of streams) stream.on("error", handleError);
  return () => {
    for (const stream of streams) stream.off("error", handleError);
  };
}
