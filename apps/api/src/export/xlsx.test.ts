import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './zip.js';
import { buildCsv, buildXlsx, columnName, excelDate } from './xlsx.js';

/** Reads the entries of a ZIP built by `zip()` (no ZIP64, deflate only). */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let pos = 0;
  while (buffer.readUInt32LE(pos) === 0x04034b50) {
    const size = buffer.readUInt32LE(pos + 18);
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 30, pos + 30 + nameLength).toString('utf8');
    const start = pos + 30 + nameLength + extraLength;
    const data = inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
    expect(crc32(Buffer.from(data, 'utf8'))).toBe(buffer.readUInt32LE(pos + 14));
    files.set(name, data);
    pos = start + size;
  }
  return files;
}

describe('zip / xlsx', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('names columns like Excel', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
  });

  it('converts dates to wall-clock serials in a time zone', () => {
    const date = new Date('2026-01-01T12:00:00Z');
    expect(excelDate(date, 'UTC')).toBeCloseTo(46023.5, 6);
    expect(excelDate(date, 'Europe/Madrid')).toBeCloseTo(46023.5 + 1 / 24, 6);
  });

  it('builds a workbook with the expected parts and escaped values', () => {
    const file = buildXlsx([
      {
        name: 'Orders',
        rows: [
          ['Order', 'Total', 'When'],
          ['#1 <Tea & Co>', { money: 12.9 }, { date: new Date('2026-01-01T00:00:00Z') }],
        ],
        widths: [12, 10, 18],
      },
      { name: 'Summary', rows: [['Only header']] },
    ]);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(file);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('#1 &lt;Tea &amp; Co&gt;');
    expect(sheet).toContain('<c r="B2" s="2"><v>12.9</v></c>');
    expect(sheet).toContain('<autoFilter ref="A1:C2"/>');
    expect(files.get('xl/workbook.xml')).toContain('name="Summary"');
  });

  it('writes CSV with a BOM and quoting', () => {
    const csv = buildCsv([
      ['a', 'b'],
      ['x, y', { money: 3 }],
    ]).toString('utf8');
    expect(csv).toBe('\uFEFFa,b\n"x, y",3.00\n');
  });
});
