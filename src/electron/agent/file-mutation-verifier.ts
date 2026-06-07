export interface MutationRecord {
  toolName: string;
  targetPath: string | null;
  succeeded: boolean;
  errorPreview: string | null;
  timestamp: number;
}

/**
 * Tracks file-mutation tool calls (write_file, edit_file, copy_file, etc.)
 * and detects discrepancies between what the model claims and what actually happened.
 *
 * Inspired by the Hermes agent's file mutation verifier: the model may summarise
 * a turn claiming every file was edited, but some write_file calls may have failed.
 * This verifier makes over-claiming structurally visible past the model.
 */
export class FileMutationVerifier {
  private mutations: MutationRecord[] = [];

  recordMutationResult(opts: {
    toolName: string;
    input: unknown;
    succeeded: boolean;
    error?: string;
  }): void {
    const targetPath = this.extractTargetPath(opts.toolName, opts.input);
    if (opts.succeeded && targetPath) {
      // Self-correction: remove prior failure for the same path
      this.mutations = this.mutations.filter(
        (m) => !(m.targetPath === targetPath && !m.succeeded),
      );
    }
    this.mutations.push({
      toolName: opts.toolName,
      targetPath,
      succeeded: opts.succeeded,
      errorPreview: opts.error ? opts.error.slice(0, 200) : null,
      timestamp: Date.now(),
    });
  }

  getFailedMutations(): MutationRecord[] {
    const successPaths = new Set(
      this.mutations.filter((m) => m.succeeded && m.targetPath).map((m) => m.targetPath),
    );
    return this.mutations.filter(
      (m) => !m.succeeded && (!m.targetPath || !successPaths.has(m.targetPath)),
    );
  }

  buildAdvisoryFooter(): string | null {
    const failed = this.getFailedMutations();
    if (failed.length === 0) return null;

    const details = failed
      .slice(0, 5)
      .map((m) => {
        const path = m.targetPath || "(unknown path)";
        const err = m.errorPreview || "tool returned failure";
        return `  - ${m.toolName}("${path}"): ${err}`;
      })
      .join("\n");

    return [
      `File-mutation verifier: ${failed.length} file(s) were NOT modified this turn`,
      "despite any wording above that may suggest otherwise.",
      details,
    ].join("\n");
  }

  reset(): void {
    this.mutations = [];
  }

  private extractTargetPath(toolName: string, input: unknown): string | null {
    if (!input || typeof input !== "object") return null;
    const obj = input as Record<string, unknown>;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.filename === "string") return obj.filename;
    if (typeof obj.destination === "string") return obj.destination;
    if (typeof obj.file_path === "string") return obj.file_path;
    if (typeof obj.target === "string") return obj.target;
    if (typeof obj.outputPath === "string") return obj.outputPath;
    return null;
  }
}
