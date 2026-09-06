/**
 * Builds a small workbook that imitates the awkward parts of the NHS England
 * release, so the inspector and loader can be exercised without the real
 * download:
 *
 *   Cover Sheet          no table at all
 *   Provider             metadata rows, a caption row above a single header
 *                        row, column F headed just "Treatment Function"
 *   Provider with DTA    a different measure that must not be loaded
 *   IS Provider          independent sector, with the header split over two
 *                        merged rows instead
 *
 * plus thousands separators, percentages held as fractions, suppressed values
 * and a per-provider total row.
 *
 *   node scripts/fixtures/make-sample-xlsx.ts data/sample.xlsx
 */
import ExcelJS from 'exceljs';

const BANDS = ['>0-1', '>1-2', '>2-3'];

const SUMMARY = [
  'Total number of incomplete pathways',
  '% within 18 weeks',
  'Average (median) waiting time (in weeks)',
];

function addMetadata(sheet: ExcelJS.Worksheet, summary: string): void {
  sheet.getCell('B1').value = 'Title:';
  sheet.getCell('C1').value = 'Referral to Treatment (RTT) Waiting Times';
  sheet.getCell('B2').value = 'Summary:';
  sheet.getCell('C2').value = summary;
  sheet.getCell('B3').value = 'Period:';
  sheet.getCell('C3').value = 'June 2026';
}

/** The real release's shape: a caption row, then one header row. */
function addCaptionStyleSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  caption: string,
  summaryHeaders: string[],
  data: Array<Array<string | number>>,
): void {
  const sheet = workbook.addWorksheet(name);
  addMetadata(sheet, 'Monthly RTT waiting times for incomplete pathways.');

  sheet.getCell('B5').value = caption;
  sheet.getCell('G5').value = 'The number of incomplete pathways by week since referral';

  const headers = [
    'Region Code', 'Provider Code', 'Provider Name',
    'Treatment Function Code', 'Treatment Function',
    ...BANDS, ...summaryHeaders,
  ];
  headers.forEach((label, i) => {
    sheet.getRow(6).getCell(i + 2).value = label;
  });
  data.forEach((row, i) => {
    sheet.getRow(7 + i).values = [undefined, ...row] as never;
  });
}

/** The other awkward shape: a header genuinely split over two merged rows. */
function addMergedHeaderSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  data: Array<Array<string | number>>,
): void {
  const sheet = workbook.addWorksheet(name);
  addMetadata(sheet, 'Monthly RTT waiting times for incomplete pathways.');

  sheet.getCell('A5').value = 'Provider';
  sheet.mergeCells('A5:B5');
  sheet.getCell('C5').value = 'Treatment Function';
  sheet.mergeCells('C5:D5');
  sheet.getCell('E5').value = 'Weeks Waiting';
  sheet.mergeCells('E5:G5');
  sheet.getCell('H5').value = 'Summary';
  sheet.mergeCells('H5:J5');

  ['Code', 'Name', 'Code', 'Name', ...BANDS, ...SUMMARY].forEach((label, i) => {
    sheet.getRow(6).getCell(i + 1).value = label;
  });
  data.forEach((row, i) => {
    sheet.getRow(7 + i).values = row as never;
  });
}

export async function writeSampleWorkbook(out: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();

  const cover = workbook.addWorksheet('Cover Sheet');
  cover.getCell('A1').value = 'Referral to Treatment Waiting Times';
  cover.getCell('A3').value = 'Published: 13 August 2026';

  addCaptionStyleSheet(workbook, 'Provider', 'Provider Level Data', SUMMARY, [
    ['Y56', 'R0A', 'Manchester University NHS FT', 'C_110', 'Trauma and Orthopaedic Service', 120, 90, 80, '12,431', 0.612, 14.2],
    ['Y56', 'RJ1', "Guy's and St Thomas' NHS FT", 'C_110', 'Trauma and Orthopaedic Service', 200, 150, 130, '9,004', 0.735, 10.8],
    ['Y56', 'RJ1', "Guy's and St Thomas' NHS FT", 'C_120', 'Ear Nose and Throat Service', 60, 40, 35, '3,210', 0.812, 8.5],
    ['Y61', 'RGT', 'Cambridge University Hospitals NHS FT', 'C_120', 'Ear Nose and Throat Service', 10, 8, 5, '412', 1, '-'],
    ['Y61', 'RGT', 'Cambridge University Hospitals NHS FT', 'C_999', 'Total', 10, 8, 5, '412', 1, '-'],
  ]);

  // Same layout, different measure: must be recognised and left alone.
  addCaptionStyleSheet(workbook, 'Provider with DTA', 'Provider Level Data', [
    'Total number of incomplete pathways with a decision to admit for treatment',
    '% of incomplete pathways with a decision to admit for treatment',
  ], [
    ['Y56', 'R0A', 'Manchester University NHS FT', 'C_110', 'Trauma and Orthopaedic Service', 40, 30, 20, '1,617', 0.363],
  ]);

  addMergedHeaderSheet(workbook, 'IS Provider', [
    ['A1D1B', 'SpaMedica Wembley', 'C_130', 'Ophthalmology Service', 30, 25, 20, '1,004', 0.91, 5.2],
    ['A1D1B', 'SpaMedica Wembley', 'C_999', 'Total', 30, 25, 20, '1,004', 0.91, 5.2],
    ['Z9Z1G', 'SpaMedica Gateshead', 'C_130', 'Ophthalmology Service', 12, 9, 4, '318', 0.88, 6.1],
  ]);

  await workbook.xlsx.writeFile(out);
  return out;
}

// Running the file directly writes a sample into ./data.
if (process.argv[1] && process.argv[1].endsWith('make-sample-xlsx.ts')) {
  const out = process.argv[2] ?? 'data/sample-Incomplete-Provider-Jun25.xlsx';
  console.log(`wrote ${await writeSampleWorkbook(out)}`);
}
