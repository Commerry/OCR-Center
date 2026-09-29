const fs = require('fs');
const path = require('path');
const { ZipWriter } = require('./zip');
const { imageInfo, imageInfoOf } = require('./imageInfo');

/*
 * Streaming XLSX writer.
 *
 * An xlsx file is a ZIP of XML parts, so the ZIP writer already here does the
 * packaging; this adds the handful of parts Excel insists on and writes rows
 * straight to a temporary file as they come, the way the CSV export did. A
 * report of a hundred thousand reads never sits in memory.
 *
 * What it supports is what the report needs and nothing more:
 *   - several sheets in one workbook
 *   - text and number cells, a few styles, frozen header, autofilter
 *   - a picture anchored inside a cell, which is the point of the file: the
 *     reader sees the frame next to the number read from it, instead of a
 *     filename pointing into a folder they have to go and find.
 */

const EMU = 9525;           // english metric units per pixel at 96 dpi
const PT_PER_PX = 0.75;     // row heights are in points
const WRITE_CHUNK = 256 * 1024;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// control characters are not legal in XML at all - Excel refuses the file
const esc = (value) => String(value)
  .replace(/[&<>"']/g, (c) => ESCAPES[c])
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** 0 -> A, 25 -> Z, 26 -> AA */
const colName = (index) => {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
};

// Excel counts column width in characters of the default font
const colWidth = (px) => Math.round(((px - 5) / 7 + 1) * 100) / 100;

/* ------------------------------------------------------------------ styles -- */
/*
 * Style slots used by the report:
 *   0 normal   1 bold   2 title   3 table header   4 section heading
 *   5 vertically centred (the rows that carry a picture)
 */
const STYLES = XML_HEAD
  + '<styleSheet xmlns="' + NS_MAIN + '">'
  + '<fonts count="5">'
  + '<font><sz val="11"/><name val="Tahoma"/></font>'
  + '<font><b/><sz val="11"/><name val="Tahoma"/></font>'
  + '<font><b/><sz val="14"/><name val="Tahoma"/></font>'
  + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font>'
  + '<font><sz val="11"/><color rgb="FF6B7280"/><name val="Tahoma"/></font>'
  + '</fonts>'
  + '<fills count="4">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="2">'
  + '<border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right>'
  + '<top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>'
  + '</borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="6">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
  + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">'
  + '<alignment vertical="center"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const STYLE = { normal: 0, bold: 1, title: 2, header: 3, section: 4, middle: 5 };

/* ------------------------------------------------------------------- sheet -- */

class Sheet {
  constructor(workbook, { name, index, columns = [], freezeRows = 0, autoFilter = null }) {
    this.wb = workbook;
    this.name = name;
    this.index = index;                 // 1-based, matches sheetN.xml
    this.columns = columns;
    this.autoFilter = autoFilter;       // e.g. 'A1:N1'
    this.rowNumber = 0;
    this.pictures = [];
    this.buffer = '';
    this.file = path.join(workbook.tmpDir, workbook.stamp + '-sheet' + index + '.xml');
    this.fd = fs.openSync(this.file, 'w');

    let head = XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">';
    const selected = index === 1 ? '1' : '0';
    if (freezeRows > 0) {
      head += '<sheetViews><sheetView workbookViewId="0" tabSelected="' + selected + '">'
        + '<pane ySplit="' + freezeRows + '" topLeftCell="A' + (freezeRows + 1)
        + '" activePane="bottomLeft" state="frozen"/>'
        + '<selection pane="bottomLeft" activeCell="A' + (freezeRows + 1) + '" sqref="A' + (freezeRows + 1) + '"/>'
        + '</sheetView></sheetViews>';
    } else {
      head += '<sheetViews><sheetView workbookViewId="0" tabSelected="' + selected + '"/></sheetViews>';
    }
    head += '<sheetFormatPr defaultRowHeight="15"/>';
    if (columns.length) {
      head += '<cols>';
      columns.forEach((c, i) => {
        head += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="'
          + colWidth(c.px || 90) + '" customWidth="1"/>';
      });
      head += '</cols>';
    }
    head += '<sheetData>';
    this._out(head);
  }

  _out(text) {
    this.buffer += text;
    if (this.buffer.length >= WRITE_CHUNK) this._flush();
  }

  _flush() {
    if (!this.buffer) return;
    fs.writeSync(this.fd, this.buffer, null, 'utf8');
    this.buffer = '';
  }

  /**
   * Write one row. A finite number lands in the sheet as a number so Excel can
   * add it up; everything else goes in as text - dates included, because a
   * text stamp is never reinterpreted as another timezone or shown as ####.
   * `options.style` styles the row, `options.heightPx` sets its height.
   */
  row(cells, options = {}) {
    this.rowNumber += 1;
    const r = this.rowNumber;
    const style = options.style === undefined ? STYLE.normal : options.style;
    const height = options.heightPx
      ? ' ht="' + (Math.round(options.heightPx * PT_PER_PX * 100) / 100) + '" customHeight="1"'
      : '';
    let xml = '<row r="' + r + '"' + height + '>';
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (cell === null || cell === undefined || cell === '') continue;
      const ref = colName(i) + r;
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        xml += '<c r="' + ref + '" s="' + style + '"><v>' + cell + '</v></c>';
      } else {
        xml += '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">'
          + esc(cell) + '</t></is></c>';
      }
    }
    xml += '</row>';
    this._out(xml);
    return r;
  }

  /**
   * Put a picture inside a cell of the row just written. Pass `file` (a path
   * on disk) or `buffer`. Only the header is read now and the bytes are copied
   * into the archive at close, so a report with thousands of pictures never
   * holds more than one of them in memory.
   *
   * Returns null when the bytes are not a picture this can measure, and the
   * caller then leaves the filename in the cell instead.
   */
  picture({ file, buffer, column, row, maxWidthPx = 200, maxHeightPx = 110, descr = '', info: known }) {
    const info = known || (buffer ? imageInfo(buffer) : imageInfoOf(file));
    if (!info || !info.width || !info.height) return null;
    const scale = Math.min(maxWidthPx / info.width, maxHeightPx / info.height, 1);
    const width = Math.max(8, Math.round(info.width * scale));
    const height = Math.max(8, Math.round(info.height * scale));
    this.pictures.push({
      file, buffer, ext: info.ext, column, row: row || this.rowNumber, width, height, descr,
    });
    return { width, height };
  }

  close() {
    let tail = '</sheetData>';
    if (this.autoFilter) tail += '<autoFilter ref="' + this.autoFilter + '"/>';
    tail += '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>';
    if (this.pictures.length) tail += '<drawing r:id="rId1"/>';
    tail += '</worksheet>';
    this._out(tail);
    this._flush();
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/* ---------------------------------------------------------------- workbook -- */

class XlsxWriter {
  constructor(outPath, { tmpDir } = {}) {
    this.outPath = outPath;
    this.tmpDir = tmpDir || path.dirname(outPath);
    this.stamp = 'xlsx-' + process.pid + '-' + Date.now().toString(36);
    this.sheets = [];
  }

  sheet(name, options = {}) {
    const sheet = new Sheet(this, { ...options, name, index: this.sheets.length + 1 });
    this.sheets.push(sheet);
    return sheet;
  }

  _drawingXml(sheet, firstMediaIndex) {
    let xml = XML_HEAD + '<xdr:wsDr xmlns:xdr="' + NS_XDR + '" xmlns:a="' + NS_A
      + '" xmlns:r="' + NS_REL + '">';
    sheet.pictures.forEach((p, i) => {
      const id = i + 2; // shape ids start after the sheet's own
      // media parts are numbered across the whole workbook
      p.mediaName = 'image' + (firstMediaIndex + i) + '.' + p.ext;
      xml += '<xdr:oneCellAnchor>'
        + '<xdr:from><xdr:col>' + p.column + '</xdr:col><xdr:colOff>' + (2 * EMU) + '</xdr:colOff>'
        + '<xdr:row>' + (p.row - 1) + '</xdr:row><xdr:rowOff>' + (2 * EMU) + '</xdr:rowOff></xdr:from>'
        + '<xdr:ext cx="' + (p.width * EMU) + '" cy="' + (p.height * EMU) + '"/>'
        + '<xdr:pic>'
        + '<xdr:nvPicPr><xdr:cNvPr id="' + id + '" name="Picture ' + id + '" descr="' + esc(p.descr) + '"/>'
        + '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        + '<xdr:blipFill><a:blip r:embed="rId' + (i + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/>'
        + '<a:ext cx="' + (p.width * EMU) + '" cy="' + (p.height * EMU) + '"/></a:xfrm>'
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
        + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
    });
    return xml + '</xdr:wsDr>';
  }

  /** Finish the file. Deletes the temporary sheet XML on the way out. */
  close() {
    for (const sheet of this.sheets) if (sheet.fd !== null) sheet.close();

    const withPictures = this.sheets.filter((s) => s.pictures.length);
    const zip = new ZipWriter(this.outPath);
    const rel = (id, type, target) => '<Relationship Id="' + id
      + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type
      + '" Target="' + target + '"/>';
    const relsOpen = XML_HEAD + '<Relationships xmlns="' + NS_PKG_REL + '">';

    try {
      let types = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="png" ContentType="image/png"/>'
        + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
        + '<Default Extension="gif" ContentType="image/gif"/>'
        + '<Default Extension="webp" ContentType="image/webp"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
      for (const s of this.sheets) {
        types += '<Override PartName="/xl/worksheets/sheet' + s.index
          + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }
      withPictures.forEach((s, i) => {
        types += '<Override PartName="/xl/drawings/drawing' + (i + 1)
          + '.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>';
      });
      zip.addText('[Content_Types].xml', types + '</Types>', { compress: true });

      zip.addText('_rels/.rels', relsOpen
        + rel('rId1', 'officeDocument', 'xl/workbook.xml') + '</Relationships>', { compress: true });

      let book = XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '"><sheets>';
      let rels = relsOpen;
      for (const s of this.sheets) {
        book += '<sheet name="' + esc(s.name).slice(0, 31) + '" sheetId="' + s.index
          + '" r:id="rId' + s.index + '"/>';
        rels += rel('rId' + s.index, 'worksheet', 'worksheets/sheet' + s.index + '.xml');
      }
      rels += rel('rId' + (this.sheets.length + 1), 'styles', 'styles.xml');
      zip.addText('xl/workbook.xml', book + '</sheets></workbook>', { compress: true });
      zip.addText('xl/_rels/workbook.xml.rels', rels + '</Relationships>', { compress: true });
      zip.addText('xl/styles.xml', STYLES, { compress: true });

      let mediaIndex = 1;
      withPictures.forEach((sheet, i) => {
        const n = i + 1;
        zip.addText('xl/drawings/drawing' + n + '.xml', this._drawingXml(sheet, mediaIndex), { compress: true });

        let dr = relsOpen;
        sheet.pictures.forEach((p, k) => {
          dr += rel('rId' + (k + 1), 'image', '../media/' + p.mediaName);
        });
        zip.addText('xl/drawings/_rels/drawing' + n + '.xml.rels', dr + '</Relationships>', { compress: true });

        zip.addText('xl/worksheets/_rels/sheet' + sheet.index + '.xml.rels', relsOpen
          + rel('rId1', 'drawing', '../drawings/drawing' + n + '.xml')
          + '</Relationships>', { compress: true });

        // the pictures themselves are already compressed: stored as they are
        for (const p of sheet.pictures) {
          zip.add('xl/media/' + p.mediaName, p.buffer || null, p.buffer ? null : p.file);
          p.buffer = null; // let it go as soon as it is written
          mediaIndex += 1;
        }
      });

      for (const s of this.sheets) {
        zip.add('xl/worksheets/sheet' + s.index + '.xml', null, s.file, { compress: true });
      }
      zip.close();
    } catch (error) {
      try { if (zip.fd !== null) zip.close(); } catch (e) { /* already closed */ }
      fs.unlink(this.outPath, () => {});
      throw error;
    } finally {
      for (const s of this.sheets) fs.unlink(s.file, () => {});
    }
    return this.outPath;
  }
}

module.exports = { XlsxWriter, STYLE, colName, colWidth };
