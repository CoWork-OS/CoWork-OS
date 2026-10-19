import type { AnnotationCreateInput } from "../../shared/types";
import { spreadsheetColumnLetter } from "../../shared/spreadsheet-preview";

type Position = { row: number; column: number };

/** At most this many cells' values travel with the annotation. */
const MAX_POINTED_CELLS = 50;

/** A1 address of a 1-based cell. */
function address(position: Position): string {
  return `${spreadsheetColumnLetter(position.column - 1)}${position.row}`;
}

/** `B2` or `B2:C4` for a 1-based range, whichever corner was clicked first. */
export function spreadsheetRangeAddress(range: { start: Position; end: Position }): string {
  const top = Math.min(range.start.row, range.end.row);
  const bottom = Math.max(range.start.row, range.end.row);
  const left = Math.min(range.start.column, range.end.column);
  const right = Math.max(range.start.column, range.end.column);
  const start = address({ row: top, column: left });
  const end = address({ row: bottom, column: right });
  return start === end ? start : `${start}:${end}`;
}

/**
 * The annotation for cells a user pointed at before asking for a change: the range is the
 * anchor, and the values there (the first 50 cells, by A1 address) are what it had.
 */
export function buildSpreadsheetPointerAnnotation(input: {
  taskId: string;
  workspaceId?: string;
  filePath: string;
  sheetName: string;
  range: { start: Position; end: Position };
  cellText: (row: number, column: number) => string;
  request: string;
}): AnnotationCreateInput {
  const top = Math.min(input.range.start.row, input.range.end.row);
  const bottom = Math.max(input.range.start.row, input.range.end.row);
  const left = Math.min(input.range.start.column, input.range.end.column);
  const right = Math.max(input.range.start.column, input.range.end.column);
  const before: Record<string, string> = {};
  let count = 0;
  for (let row = top; row <= bottom && count < MAX_POINTED_CELLS; row += 1) {
    for (let column = left; column <= right && count < MAX_POINTED_CELLS; column += 1) {
      before[address({ row, column })] = input.cellText(row, column);
      count += 1;
    }
  }
  const cellRange = spreadsheetRangeAddress(input.range);
  return {
    taskId: input.taskId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    surfaceType: "artifact",
    surfaceId: input.filePath,
    body: input.request,
    targetRef: {
      surfaceType: "artifact",
      filePath: input.filePath,
      fileType: "spreadsheet",
      sheetName: input.sheetName,
      cellRange,
    },
    intent: "change",
    before,
  };
}
