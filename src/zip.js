const fs = require('fs');

/*
 * Minimal ZIP writer (store method, no compression).
 *
 * Written by hand on purpose: the report only bundles CSV text plus webp
 * images that are already compressed, so there is nothing to gain from
 * deflate - and this keeps the center free of an extra npm dependency on
 * machines that sit behind the factory proxy.
 *
 * Entries are streamed to a file so a large report never sits in memory.
 * 32-bit sizes only: refuses to build an archive over 4 GB.
 */
const MAX_TOTAL = 4 * 1024 * 1024 * 1024 - 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// MS-DOS date/time as used in zip headers
const dosTime = (date) => {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
};

class ZipWriter {
  constructor(outPath) {
    this.fd = fs.openSync(outPath, 'w');
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    fs.writeSync(this.fd, buf);
    this.offset += buf.length;
    if (this.offset > MAX_TOTAL) {
      this.close();
      throw new Error('รายงานใหญ่เกิน 4 GB - ลดช่วงเวลาหรือปิดการแนบรูป');
    }
  }

  /** Add one file. `data` is a Buffer, or pass `filePath` to stream from disk. */
  add(name, data, filePath) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, day } = dosTime(new Date());
    let size;
    let crc;

    if (filePath) {
      const stat = fs.statSync(filePath);
      size = stat.size;
      // crc first (read once), then copy the bytes
      const src = fs.openSync(filePath, 'r');
      const chunk = Buffer.alloc(64 * 1024);
      let c = -1;
      let bytes;
      // eslint-disable-next-line no-cond-assign
      while ((bytes = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
        for (let i = 0; i < bytes; i += 1) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
      }
      crc = (c ^ -1) >>> 0;
      fs.closeSync(src);
    } else {
      size = data.length;
      crc = crc32(data);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 file names
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const headerOffset = this.offset;
    this._write(local);
    this._write(nameBuf);

    if (filePath) {
      const src = fs.openSync(filePath, 'r');
      const chunk = Buffer.alloc(64 * 1024);
      let bytes;
      // eslint-disable-next-line no-cond-assign
      while ((bytes = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
        this._write(chunk.subarray(0, bytes));
      }
      fs.closeSync(src);
    } else {
      this._write(data);
    }

    this.entries.push({ nameBuf, crc, size, headerOffset, time, day });
  }

  addText(name, text) {
    this.add(name, Buffer.from(text, 'utf8'));
  }

  close() {
    const start = this.offset;
    for (const e of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);      // version made by
      central.writeUInt16LE(20, 6);      // version needed
      central.writeUInt16LE(0x0800, 8);  // UTF-8
      central.writeUInt16LE(0, 10);      // store
      central.writeUInt16LE(e.time, 12);
      central.writeUInt16LE(e.day, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.size, 20);
      central.writeUInt32LE(e.size, 24);
      central.writeUInt16LE(e.nameBuf.length, 28);
      central.writeUInt16LE(0, 30);      // extra
      central.writeUInt16LE(0, 32);      // comment
      central.writeUInt16LE(0, 34);      // disk
      central.writeUInt16LE(0, 36);      // internal attrs
      central.writeUInt32LE(0, 38);      // external attrs
      central.writeUInt32LE(e.headerOffset, 42);
      this._write(central);
      this._write(e.nameBuf);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    this._write(end);

    fs.closeSync(this.fd);
    this.fd = null;
  }
}

module.exports = { ZipWriter, crc32 };
