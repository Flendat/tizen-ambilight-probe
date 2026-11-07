'use strict';

const fs = require('fs');
const http = require('http');

const PORT = 18766;

const LIBRARY_PATHS = [
  '/usr/lib/libvideoenhance.so',
  '/usr/lib64/libvideoenhance.so',
  '/lib/libvideoenhance.so'
];

const FAMILIES = [
  'cs_ve',
  've',
  'ppi_ve'
];

const FUNCTIONS = [
  'get_rgb_measure_condition',
  'set_rgb_measure_position',
  'get_rgb_measure_pixel'
];

// Read the dynamic symbol table from an ELF binary.
// Supports 32-bit and 64-bit, little/big endian ELF.
function readElfSymbols(filePath) {
  const buf = fs.readFileSync(filePath);

  if (buf.length < 64 ||
      buf.toString('hex', 0, 4) !== '7f454c46') {
    throw new Error('Not a valid ELF file');
  }

  const elfClass = buf[4];
  const byteOrder = buf[5];

  if (elfClass !== 1 && elfClass !== 2) {
    throw new Error('Unsupported ELF class');
  }

  if (byteOrder !== 1 && byteOrder !== 2) {
    throw new Error('Unsupported byte order');
  }

  const little = byteOrder === 1;
  const is64 = elfClass === 2;

  function check(pos, size) {
    if (pos < 0 || size < 0 ||
        pos + size > buf.length) {
      throw new Error('ELF offset outside file');
    }
  }

  function u16(pos) {
    check(pos, 2);
    return little
      ? buf.readUInt16LE(pos)
      : buf.readUInt16BE(pos);
  }

  function u32(pos) {
    check(pos, 4);
    return little
      ? buf.readUInt32LE(pos)
      : buf.readUInt32BE(pos);
  }

  function u64(pos) {
    const low = little ? u32(pos) : u32(pos + 4);
    const high = little ? u32(pos + 4) : u32(pos);

    const value = high * 4294967296 + low;

    if (!Number.isSafeInteger(value)) {
      throw new Error('ELF offset too large');
    }

    return value;
  }

  const sectionOffset = is64 ? u64(40) : u32(32);
  const sectionEntrySize = u16(is64 ? 58 : 46);
  const sectionCount = u16(is64 ? 60 : 48);

  if (!sectionOffset || !sectionCount) {
    throw new Error('No ELF section table');
  }

  if (sectionEntrySize < (is64 ? 64 : 40)) {
    throw new Error('Invalid section header size');
  }

  check(sectionOffset, sectionEntrySize * sectionCount);

  function getSection(index) {
    if (index < 0 || index >= sectionCount) {
      throw new Error('Invalid section index');
    }

    const p = sectionOffset + index * sectionEntrySize;

    return {
      type: u32(p + 4),
      offset: is64 ? u64(p + 24) : u32(p + 16),
      size: is64 ? u64(p + 32) : u32(p + 20),
      link: u32(p + (is64 ? 40 : 24)),
      entrySize: is64 ? u64(p + 56) : u32(p + 36)
    };
  }

  const symbols = new Set();
  let foundDynsym = false;

  for (let i = 0; i < sectionCount; i++) {
    const section = getSection(i);

    // SHT_DYNSYM = 11
    if (section.type !== 11) continue;

    foundDynsym = true;

    const strings = getSection(section.link);

    check(section.offset, section.size);
    check(strings.offset, strings.size);

    const entrySize =
      section.entrySize || (is64 ? 24 : 16);

    if (entrySize < (is64 ? 24 : 16)) {
      throw new Error('Invalid symbol entry size');
    }

    const end = section.offset + section.size;

    for (let p = section.offset;
         p + entrySize <= end;
         p += entrySize) {

      const nameOffset = u32(p);
      const defined = u16(p + (is64 ? 6 : 14));

      // Skip undefined/imported symbols.
      if (defined === 0) continue;

      if (nameOffset >= strings.size) continue;

      const start = strings.offset + nameOffset;
      const stringEnd = strings.offset + strings.size;

      const zero = buf.indexOf(0, start);

      if (zero < 0 || zero >= stringEnd) continue;

      const name = buf.toString('utf8', start, zero);

      if (name) symbols.add(name);
    }
  }

  if (!foundDynsym) {
    throw new Error('Dynamic symbol table not found');
  }

  return {
    elfClass: is64 ? 'ELF64' : 'ELF32',
    endian: little ? 'little' : 'big',
    fileSize: buf.length,
    exportedSymbols: Array.from(symbols).sort()
  };
}

function makeReport() {
  const report = {
    service: 'running',
    version: '0.2.0',
    node: process.version,
    architecture: process.arch,
    libraries: [],
    elf: null,
    families: [],
    relatedSymbols: [],
    error: null
  };

  let library = null;

  for (const path of LIBRARY_PATHS) {
    const exists = fs.existsSync(path);

    report.libraries.push({
      path: path,
      exists: exists
    });

    if (exists && !library) {
      library = path;
    }
  }

  if (!library) {
    report.error = 'libvideoenhance.so not found';
    return report;
  }

  try {
    const elf = readElfSymbols(library);

    report.elf = {
      path: library,
      class: elf.elfClass,
      endian: elf.endian,
      size: elf.fileSize,
      symbolCount: elf.exportedSymbols.length
    };

    const exported = new Set(elf.exportedSymbols);

    for (const family of FAMILIES) {
      const checks = FUNCTIONS.map(function(fn) {
        const name = family + '_' + fn;

        return {
          name: name,
          exported: exported.has(name)
        };
      });

      report.families.push({
        family: family,
        completeSymbols: checks.every(function(item) {
          return item.exported;
        }),
        symbols: checks
      });
    }

    // Show other possibly relevant exported functions.
    report.relatedSymbols = elf.exportedSymbols
      .filter(function(name) {
        return /rgb|measure|capture/i.test(name);
      })
      .slice(0, 100);

  } catch (err) {
    report.error = err.message;
  }

  return report;
}

// Read-only HTTP diagnostic endpoint.
const server = http.createServer(function(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  const report = makeReport();

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(report, null, 2));
});

server.on('error', function(err) {
  console.error('[Ambilight Probe] Server error:', err);
});

server.listen(PORT, '127.0.0.1', function() {
  console.log(
    '[Ambilight Probe] v0.2 running on port ' + PORT
  );
});
