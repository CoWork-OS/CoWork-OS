/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { PDFDocument } = require("pdf-lib");
const PptxGenJS = require("pptxgenjs");

const input = JSON.parse(process.argv[2] || "{}");

function send(message) {
  if (typeof process.send === "function") process.send(message);
}

async function writeFixture(fixtureInput = input) {
  if (fixtureInput.delayMs)
    await new Promise((resolve) => setTimeout(resolve, fixtureInput.delayMs));
  const out = path.resolve(fixtureInput.workspacePath, fixtureInput.outRel || "");
  fs.mkdirSync(path.dirname(out), { recursive: true });

  switch (fixtureInput.kind) {
    case "text":
      fs.writeFileSync(out, fixtureInput.content, "utf8");
      break;
    case "browser":
      fs.writeFileSync(out, "Example Domain\n", "utf8");
      break;
    case "search":
      fs.writeFileSync(
        out,
        [
          "- TypeScript 5.7 adds checks for never-initialized variables.",
          "- The release improves import type handling.",
          "- It adds compiler options for version-specific resolution.",
          "- The release notes describe updates to typed array behavior.",
          "- Existing projects should review the official migration notes.",
        ].join("\n") + "\n",
        "utf8",
      );
      break;
    case "xlsx": {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      sheet.addRow(["A", "B", "Sum"]);
      sheet.addRow([
        2,
        3,
        { formula: "A2+B2", result: fixtureInput.result === undefined ? 5 : fixtureInput.result },
      ]);
      await workbook.xlsx.writeFile(out);
      break;
    }
    case "pdf": {
      const document = await PDFDocument.create();
      const page = document.addPage();
      page.drawText(fixtureInput.title || "QA Battery Report", { x: 48, y: 750, size: 18 });
      page.drawText(fixtureInput.runId || "fixture-run-id", { x: 48, y: 720, size: 11 });
      fs.writeFileSync(out, await document.save());
      break;
    }
    case "pptx": {
      const deck = new PptxGenJS();
      const title = deck.addSlide();
      title.addText(fixtureInput.title || "QA Battery", { x: 1, y: 1, w: 6, h: 1, fontSize: 28 });
      title.addText(fixtureInput.runId || "fixture-run-id", { x: 1, y: 2, w: 6, h: 1 });
      const bullets = deck.addSlide();
      (fixtureInput.bullets || ["One", "Two", "Three"]).forEach((text, index) => {
        bullets.addText(text, {
          x: 1,
          y: 1 + index * 0.6,
          w: 6,
          h: 0.5,
          bullet: { indent: 18 },
        });
      });
      await deck.writeFile({ fileName: out });
      break;
    }
    case "hang":
      await new Promise(() => setInterval(() => {}, 1000));
      break;
    case "followup": {
      fs.appendFileSync(out, "\nline2\n", "utf8");
      break;
    }
    default:
      throw new Error(`Unknown fixture worker kind: ${fixtureInput.kind}`);
  }
}

if (require.main === module) {
  send({ type: "started", pid: process.pid });
  writeFixture()
    .then(() => {
      send({ type: "terminal", status: "completed" });
      if (typeof process.send === "function") process.disconnect();
    })
    .catch((error) => {
      send({ type: "terminal", status: "failed", error: String(error.message || error) });
      if (typeof process.send === "function") process.disconnect();
      process.exitCode = 1;
    });
}

module.exports = { writeFixture };
