import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, makeZip } from '../src/io/zip.js';

describe('makeZip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a zip that a standard reader opens with the same files', () => {
    const enc = new TextEncoder();
    const zip = makeZip([
      { name: 'robot_baseColor.png', data: enc.encode('first file') },
      { name: 'robot_normal.png', data: new Uint8Array([0, 1, 2, 255]) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const path = join(dir, 't.zip');
    writeFileSync(path, zip);
    const out = execFileSync('python3', [
      '-I',
      '-c',
      'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print([(i.filename,len(z.read(i))) for i in z.infolist()])',
      path,
    ]).toString();
    expect(out.trim()).toBe("[('robot_baseColor.png', 10), ('robot_normal.png', 4)]");
  });
});
