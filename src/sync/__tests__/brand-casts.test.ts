// §13's third type-level assertion, as a runtime test because it is about SOURCE
// TEXT rather than types: "no `as ChangesState` / `as SnapshotState` cast exists".
//
// §6.3's rule for implementers is that such a cast is a bug — an `as` cast is
// precisely the escape hatch that defeats a brand, and revision 2's own
// pseudocode modelled one, which is how it would have been copied. This repo goes
// one step further than the design and exposes `asChangesState` /
// `asSnapshotState` in `states.ts` instead, so a cast is never needed anywhere and
// the assertion can be absolute rather than "outside src/api/email.ts".
//
// A grep is a blunt instrument, but the alternative (an eslint
// no-restricted-syntax rule) needs an eslint setup this repo does not have, and a
// rule nobody runs is worse than a test that fails the suite.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(name) && path !== __filename) {
      // Skip this file: it necessarily contains the very strings it forbids.
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments describe the rule; only code can break it. Without this, every doc
 * comment explaining the ban would trip the ban.
 */
function codeLines(text: string): Array<{ line: string; number: number }> {
  const out: Array<{ line: string; number: number }> = [];
  let inBlockComment = false;
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      const end = line.indexOf('*/', blockStart + 2);
      if (end === -1) {
        inBlockComment = true;
        line = line.slice(0, blockStart);
      } else {
        line = line.slice(0, blockStart) + line.slice(end + 2);
      }
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);
    if (line.trim()) out.push({ line, number: i + 1 });
  });
  return out;
}

describe('branded cursor states cannot be cast into existence (§6.3, §13)', () => {
  const files = sourceFiles(SRC);

  it('scans a plausible number of files', () => {
    // Guards against the walk silently finding nothing and the test passing
    // vacuously — the failure mode of every grep-based assertion.
    expect(files.length).toBeGreaterThan(50);
  });

  it('contains no `as ChangesState` / `as SnapshotState` cast anywhere', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // states.ts is where the two minting functions live; the casts inside them
      // are the single, documented place a brand is applied.
      if (file.endsWith(join('sync', 'states.ts'))) continue;
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (/\bas\s+(ChangesState|SnapshotState)\b/.test(line)) {
          offenders.push(`${file}:${number}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no cast into EnumerationCommitment either', () => {
    const offenders: string[] = [];
    for (const file of files) {
      // `mintEnumerationCommitment` is the only constructor (§3.2 V3); a cast
      // would be the object-literal forgery the `unique symbol` tag exists to
      // prevent, smuggled past the compiler.
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (/\bas\s+EnumerationCommitment\b/.test(line)) {
          offenders.push(`${file}:${number}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the minting functions are only called from the API layer and tests (§12.1)', () => {
    // The wrappers in src/api/email.ts are the legitimate mint sites: they are
    // the boundary where a JMAP response becomes a typed value. Anywhere else is
    // someone re-opening D4 by hand.
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes('__tests__')) continue;
      if (file.endsWith(join('sync', 'states.ts'))) continue;
      if (file.includes(join('src', 'api'))) continue;
      for (const { line, number } of codeLines(readFileSync(file, 'utf8'))) {
        if (/\basChangesState\s*\(|\basSnapshotState\s*\(/.test(line)) {
          offenders.push(`${file}:${number}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
