import { zip } from './zip.js';

/** Minimal XLSX (SpreadsheetML) writer: inline strings, numbers, dates, bold headers. */

export type CellValue =
  | null
  | string
  | number
  | { money: number }
  | { date: Date }
  | { link: string; text?: string };

export interface Sheet {
  name: string;
  /** First row is the header (bold, frozen, with filters). */
  rows: CellValue[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Add filter buttons on the header row (default true). */
  filter?: boolean;
}

export interface WorkbookOptions {
  /** IANA time zone used to show dates (wall-clock time), e.g. Europe/Madrid. */
  timeZone?: string;
}

const STYLE = { normal: 0, bold: 1, money: 2, date: 3, link: 4 } as const;

/** Drops control characters XML 1.0 does not allow (keeps tab, LF and CR). */
function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) out += ch;
  }
  return out;
}

function escapeXml(text: string): string {
  return stripControlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Excel serial date of the wall-clock time of `date` in `timeZone`. */
export function excelDate(date: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    return excelDate(date, 'UTC');
  }
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallClock = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClock / 86_400_000 + 25_569;
}

function cellXml(ref: string, value: CellValue, header: boolean, timeZone: string): string {
  if (value === null || value === '') return '';
  if (header || typeof value === 'string') {
    const text = typeof value === 'string' ? value : String(value);
    const style = header ? ` s="${STYLE.bold}"` : '';
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  }
  if ('money' in value) {
    return `<c r="${ref}" s="${STYLE.money}"><v>${value.money}</v></c>`;
  }
  if ('date' in value) {
    return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(value.date, timeZone)}</v></c>`;
  }
  const text = escapeXml(value.text ?? value.link);
  const url = value.link.replace(/"/g, '%22');
  return `<c r="${ref}" s="${STYLE.link}"><f>HYPERLINK("${escapeXml(url)}","${text.replace(/"/g, '""')}")</f><v>${text}</v></c>`;
}

function sheetXml(sheet: Sheet, timeZone: string): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const lastRef = `${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`;
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row.map((value, c) => cellXml(`${columnName(c)}${r + 1}`, value, r === 0, timeZone)).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : '';
  const filter =
    sheet.filter !== false && sheet.rows.length > 1 ? `<autoFilter ref="A1:${lastRef}"/>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0">' +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '</sheetView></sheetViews>' +
    cols +
    `<sheetData>${rows}</sheetData>` +
    filter +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
  '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Sheet names: max 31 chars, no []:*?/\ and unique. */
function sheetNames(sheets: readonly Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, i) => {
    let name = sheet.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsx(sheets: readonly Sheet[], options: WorkbookOptions = {}): Buffer {
  const timeZone = options.timeZone ?? 'UTC';
  const names = sheetNames(sheets);
  const text = (s: string): Buffer => Buffer.from(s, 'utf8');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const definedNames = sheets
    .map((sheet, i) => {
      if (sheet.filter === false || sheet.rows.length < 2) return '';
      const width = Math.max(1, ...sheet.rows.map((r) => r.length));
      const ref = `'${(names[i] ?? '').replace(/'/g, "''")}'!$A$1:$${columnName(width - 1)}$${sheet.rows.length}`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(ref)}</definedName>`;
    })
    .join('');

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>` +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  return zip([
    { name: '[Content_Types].xml', data: text(contentTypes) },
    { name: '_rels/.rels', data: text(rootRels) },
    { name: 'xl/workbook.xml', data: text(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(workbookRels) },
    { name: 'xl/styles.xml', data: text(STYLES_XML) },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: text(sheetXml(sheet, timeZone)),
    })),
  ]);
}

/** RFC 4180 CSV with a UTF-8 BOM (so Excel reads accents right). Header first. */
export function buildCsv(rows: readonly CellValue[][], options: WorkbookOptions = {}): Buffer {
  const timeZone = options.timeZone ?? 'UTC';
  const format = (value: CellValue): string => {
    if (value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if ('money' in value) return value.money.toFixed(2);
    if ('date' in value) {
      const serial = excelDate(value.date, timeZone);
      return new Date(Math.round((serial - 25_569) * 86_400_000))
        .toISOString()
        .slice(0, 16)
        .replace('T', ' ');
    }
    return value.link;
  };
  const quote = (text: string): string =>
    /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const body = rows.map((row) => row.map((v) => quote(format(v))).join(',')).join('\n');
  return Buffer.from(`\uFEFF${body}\n`, 'utf8');
}
