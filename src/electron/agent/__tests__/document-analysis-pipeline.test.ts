import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  discoverDocumentForAnalysis,
  extractDocumentForAnalysis,
  splitDocumentForAnalysis,
} from "../document-analysis-pipeline";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("document analysis pipeline", () => {
  it("creates bounded chunks with complete source coverage", () => {
    const source = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${index}: ${"x".repeat(120)}`,
    ).join("\n\n");
    const chunks = splitDocumentForAnalysis(source, 4_000, 200);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].start).toBe(0);
    expect(chunks.at(-1)?.end).toBe(source.length);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].start).toBeLessThanOrEqual(chunks[index - 1].end);
      expect(chunks[index].end).toBeGreaterThan(chunks[index].start);
      expect(chunks[index].content.length).toBeLessThanOrEqual(4_000);
    }
  });

  it("selects the named manuscript and ignores Office lock files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-document-analysis-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "other-notes.txt"), "notes");
    await fs.writeFile(
      path.join(directory, "Yapay_Zeka_Yan_Koltukta_Baski_Hazir_v7_word_pass4.docx"),
      "fixture",
    );
    await fs.writeFile(
      path.join(directory, "~$pay_Zeka_Yan_Koltukta_Baski_Hazir_v7_word_pass4.docx"),
      "lock",
    );

    const selected = await discoverDocumentForAnalysis(
      directory,
      "Yapay_Zeka_Yan_Koltukta_Baski_Hazir_v7_word_pass4 kitabını incele",
    );

    expect(path.basename(selected || "")).toBe(
      "Yapay_Zeka_Yan_Koltukta_Baski_Hazir_v7_word_pass4.docx",
    );
  });

  it("skips documents rejected by the access-profile read guard", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-document-analysis-"));
    temporaryDirectories.push(directory);
    const denied = path.join(directory, "secrets.txt");
    const allowed = path.join(directory, "notes.txt");
    await fs.writeFile(denied, "secret");
    await fs.writeFile(allowed, "allowed");

    const selected = await discoverDocumentForAnalysis(directory, "secrets", (candidate) => {
      return path.basename(candidate) !== "secrets.txt";
    });

    expect(path.basename(selected || "")).toBe("notes.txt");
    await expect(extractDocumentForAnalysis(directory, denied, () => false)).rejects.toThrow(
      /access profile/i,
    );
  });
});
