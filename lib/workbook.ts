import ExcelJS from 'exceljs';
import type { Row } from 'exceljs';
import { cellText } from './xlsx.ts';

export type SheetRow = { number: number; cells: string[] };

/** Trailing empty cells are dropped; interior gaps become ''. */
function toCells(row: Row): string[] {
  const cells: string[] = [];
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cells[colNumber - 1] = cellText(cell.value);
  });
  for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
  return cells;
}

export type SheetHandler = (
  name: string,
  rows: AsyncIterable<SheetRow>,
) => Promise<'continue' | 'stop'>;

async function* streamRows(
  worksheet: AsyncIterable<Row>,
  onRow: () => void,
): AsyncGenerator<SheetRow> {
  for await (const row of worksheet) {
    onRow();
    yield { number: row.number, cells: toCells(row) };
  }
}

async function eachSheetStreaming(file: string, onSheet: SheetHandler, onRow: () => void) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
    styles: 'cache',
  });
  for await (const worksheet of reader) {
    const name = (worksheet as unknown as { name?: string }).name ?? '(unnamed)';
    const verdict = await onSheet(name, streamRows(worksheet, onRow));
    if (verdict === 'stop') return;
  }
}

async function eachSheetBuffered(file: string, onSheet: SheetHandler) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  for (const worksheet of workbook.worksheets) {
    const rows: SheetRow[] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      rows.push({ number: row.number, cells: toCells(row) });
    });
    const verdict = await onSheet(worksheet.name, (async function* () {
      for (const row of rows) yield row;
    })());
    if (verdict === 'stop') return;
  }
}

/**
 * Walks every sheet, handing the caller an async row stream per sheet. Return
 * 'stop' from the handler to finish early.
 *
 * The streaming reader keeps memory flat on the large NHS releases, but it
 * assumes xl/workbook.xml appears in the zip before the sheet parts, which is
 * not guaranteed. If it fails before producing a single row we read the whole
 * workbook instead; a failure after rows have been delivered is a real error
 * and is rethrown.
 */
export async function eachSheet(file: string, onSheet: SheetHandler): Promise<void> {
  let delivered = 0;
  try {
    await eachSheetStreaming(file, onSheet, () => {
      delivered += 1;
    });
  } catch (error) {
    if (delivered > 0) throw error;
    await eachSheetBuffered(file, onSheet);
  }
}

/** Merged ranges per sheet. Needs the whole workbook, so it is opt-in. */
export async function readMerges(file: string): Promise<Map<string, string[]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const merges = new Map<string, string[]>();
  for (const worksheet of workbook.worksheets) {
    merges.set(
      worksheet.name,
      (worksheet.model as unknown as { merges?: string[] }).merges ?? [],
    );
  }
  return merges;
}
