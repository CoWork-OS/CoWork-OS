import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  findChangedWorkbooks,
  snapshotWorkbooks,
  workbookPathsInCommand,
} from "../spreadsheet-workbook-changes";

describe("workbook changes around a command", () => {
  it("reads workbook paths from a command line", () => {
    expect(
      workbookPathsInCommand(
        "python3 fix.py --in 'out/report.xlsx' --macro=book.xlsm https://example.com/a.xlsx ~$lock.xlsx notes.xlsx.bak",
        "/work",
      ),
    ).toEqual(["/work/out/report.xlsx", "/work/book.xlsm"]);
  });

  it("finds workbooks a command created or changed, and none it left alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-workbook-changes-"));
    const nested = path.join(dir, "out");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(dir, "kept.xlsx"), "a");
    await fs.writeFile(path.join(dir, "edited.xlsx"), "a");
    await fs.writeFile(path.join(dir, "notes.txt"), "a");

    const snapshot = await snapshotWorkbooks("python3 make.py out/new.xlsx", dir, [dir, dir]);
    await fs.writeFile(path.join(dir, "edited.xlsx"), "ab");
    await fs.writeFile(path.join(dir, "created.xlsx"), "a");
    await fs.writeFile(path.join(dir, "~$created.xlsx"), "lock");
    await fs.writeFile(path.join(nested, "new.xlsx"), "a");
    await fs.writeFile(path.join(nested, "unnamed.xlsx"), "a");
    await fs.writeFile(path.join(dir, "notes.txt"), "ab");

    expect((await findChangedWorkbooks(snapshot)).sort()).toEqual(
      [
        path.join(dir, "created.xlsx"),
        path.join(dir, "edited.xlsx"),
        path.join(nested, "new.xlsx"),
      ].sort(),
    );
  });
});
