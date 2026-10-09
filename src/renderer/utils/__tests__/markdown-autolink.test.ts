import { describe, expect, it } from "vitest";

import { normalizeMarkdownForDisplay } from "../../components/MainContent/markdown-normalization";
import {
  autolinkBareDomains,
  autolinkBareUrls,
  autolinkUrlsInBrackets,
} from "../markdown-autolink";

const autolinkChain = (text: string) =>
  autolinkUrlsInBrackets(autolinkBareDomains(autolinkBareUrls(text)));

describe("markdown autolinking", () => {
  it("leaves local artifact links with multiword labels intact", () => {
    const links = [
      "[Transferir Northstar-brief.docx](Northstar-brief.docx)",
      "[Transferir Northstar-brief-pdf.pdf](Northstar-brief-pdf.pdf)",
      "[Open Northstar-pilot-costs.xlsx](Northstar-pilot-costs.xlsx)",
      "![Chart preview chart.png](outputs/chart.png)",
    ];
    for (const link of links) {
      expect(autolinkChain(link)).toBe(link);
      expect(autolinkChain(`Your file is ready: ${link}.`)).toBe(`Your file is ready: ${link}.`);
      expect(normalizeMarkdownForDisplay(link)).toBe(link);
    }
  });

  it("keeps links whose labels contain nested brackets or domains", () => {
    const nested = "[Report [v2] summary.pdf for example.com](reports/summary.pdf)";
    expect(autolinkChain(nested)).toBe(nested);
    const titled = '[Docs on docs.github.com](https://docs.github.com/en "GitHub docs")';
    expect(autolinkChain(titled)).toBe(titled);
    const reference = "[Budget sheet.xlsx][budget] and later\n\n[budget]: Budget-sheet.xlsx";
    expect(autolinkChain(reference)).toBe(reference);
  });

  it("does not autolink inside inline code, fenced code, or angle autolinks", () => {
    const code = "Run `curl example.com/api` then open `report.docx`.";
    expect(autolinkChain(code)).toBe(code);
    const fenced = "```\nfetch example.com\n```\nThen visit example.com";
    expect(autolinkChain(fenced)).toBe(
      "```\nfetch example.com\n```\nThen visit [example.com](https://example.com)",
    );
    const angle = "See <https://example.com/path> or <team@example.com>.";
    expect(autolinkChain(angle)).toBe(angle);
  });

  it("does not turn bare file names into web domains", () => {
    expect(autolinkChain("Saved Northstar-brief.docx and costs.xlsx next to notes.md")).toBe(
      "Saved Northstar-brief.docx and costs.xlsx next to notes.md",
    );
    expect(autolinkChain("Attached data.csv, summary.pdf; photo.jpg and archive.zip")).toBe(
      "Attached data.csv, summary.pdf; photo.jpg and archive.zip",
    );
    expect(autolinkChain("See [Northstar-brief.docx] for details")).toBe(
      "See [Northstar-brief.docx] for details",
    );
    expect(autolinkChain("Edit build_script.sh and README.md")).toBe(
      "Edit build_script.sh and README.md",
    );
  });

  it("still autolinks ordinary bare web domains and paths", () => {
    expect(autolinkChain("Visit example.com or docs.github.com/en/rest today")).toBe(
      "Visit [example.com](https://example.com) or [docs.github.com/en/rest](https://docs.github.com/en/rest) today",
    );
    expect(autolinkChain("Crate docs live on docs.rs and installs on bun.sh")).toBe(
      "Crate docs live on [docs.rs](https://docs.rs) and installs on [bun.sh](https://bun.sh)",
    );
    expect(autolinkChain("Use [learn.microsoft.com] after `x` and example.org")).toBe(
      "Use [learn.microsoft.com](https://learn.microsoft.com) after `x` and [example.org](https://example.org)",
    );
  });

  it("autolinks a domain that follows an existing link without touching the link", () => {
    expect(autolinkChain("[Open plan.pdf](plan.pdf) or read example.com")).toBe(
      "[Open plan.pdf](plan.pdf) or read [example.com](https://example.com)",
    );
  });
});
