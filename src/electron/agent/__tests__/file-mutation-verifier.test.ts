import { describe, expect, it } from "vitest";
import { FileMutationVerifier } from "../file-mutation-verifier";

describe("FileMutationVerifier", () => {
  it("reports no discrepancy when write_file succeeds", () => {
    const verifier = new FileMutationVerifier();
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "output/report.md" },
      succeeded: true,
    });

    expect(verifier.getFailedMutations()).toHaveLength(0);
    expect(verifier.buildAdvisoryFooter()).toBeNull();
  });

  it("reports discrepancy when write_file fails", () => {
    const verifier = new FileMutationVerifier();
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "output/report.md" },
      succeeded: false,
      error: "Permission denied",
    });

    const failed = verifier.getFailedMutations();
    expect(failed).toHaveLength(1);
    expect(failed[0].targetPath).toBe("output/report.md");
    expect(failed[0].errorPreview).toBe("Permission denied");

    const footer = verifier.buildAdvisoryFooter();
    expect(footer).toContain("1 file(s) were NOT modified");
    expect(footer).toContain("output/report.md");
    expect(footer).toContain("Permission denied");
  });

  it("clears prior failure when same path succeeds (self-correction)", () => {
    const verifier = new FileMutationVerifier();
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "output/report.md" },
      succeeded: false,
      error: "Syntax error in content",
    });
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "output/report.md" },
      succeeded: true,
    });

    expect(verifier.getFailedMutations()).toHaveLength(0);
    expect(verifier.buildAdvisoryFooter()).toBeNull();
  });

  it("tracks multiple failures in the footer", () => {
    const verifier = new FileMutationVerifier();
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "a.txt" },
      succeeded: false,
      error: "Error 1",
    });
    verifier.recordMutationResult({
      toolName: "edit_file",
      input: { path: "b.ts" },
      succeeded: false,
      error: "Error 2",
    });

    const footer = verifier.buildAdvisoryFooter();
    expect(footer).toContain("2 file(s) were NOT modified");
    expect(footer).toContain("a.txt");
    expect(footer).toContain("b.ts");
  });

  it("returns null footer when no mutations recorded", () => {
    const verifier = new FileMutationVerifier();
    expect(verifier.buildAdvisoryFooter()).toBeNull();
  });

  it("clears state on reset", () => {
    const verifier = new FileMutationVerifier();
    verifier.recordMutationResult({
      toolName: "write_file",
      input: { path: "file.txt" },
      succeeded: false,
      error: "Failed",
    });
    expect(verifier.getFailedMutations()).toHaveLength(1);

    verifier.reset();
    expect(verifier.getFailedMutations()).toHaveLength(0);
    expect(verifier.buildAdvisoryFooter()).toBeNull();
  });

  it("extracts path from various input field names", () => {
    const verifier = new FileMutationVerifier();
    const fields = [
      { path: "a.txt" },
      { filename: "b.txt" },
      { destination: "c.txt" },
      { file_path: "d.txt" },
      { target: "e.txt" },
      { outputPath: "f.txt" },
    ];

    for (const input of fields) {
      verifier.recordMutationResult({
        toolName: "write_file",
        input,
        succeeded: false,
        error: "fail",
      });
    }

    const failed = verifier.getFailedMutations();
    expect(failed.map((m) => m.targetPath)).toEqual([
      "a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt",
    ]);
  });
});
