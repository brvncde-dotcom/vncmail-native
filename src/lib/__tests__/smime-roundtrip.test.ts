/**
 * The S/MIME round trip, run in Node.
 *
 * The assertions live in `src/lib/smime/selftest.ts` so the identical set also
 * runs inside the React Native runtime from Settings → S/MIME. This file just
 * executes them and surfaces each one to vitest individually, so a failure names
 * the property that broke rather than "the self-test failed".
 */
import { describe, it, expect } from 'vitest';
import { runSmimeSelfTest, type SelfTestReport } from '../smime/selftest';

let report: SelfTestReport;

describe('S/MIME self-test (Node runtime)', () => {
  it('runs to completion', () => {
    report = runSmimeSelfTest();
    expect(report.fatal).toBeUndefined();
    expect(report.assertions.length).toBeGreaterThan(60);
  });

  it('found a CSPRNG', () => {
    expect(report.randomSource).not.toBe('none');
  });

  it('has no failing assertions', () => {
    const failures = report.assertions
      .filter((a) => !a.passed)
      .map((a) => `[${a.group}] ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
    expect(failures).toEqual([]);
  });

  it('covers every pipeline stage', () => {
    const groups = new Set(report.assertions.map((a) => a.group));
    for (const expected of [
      'Random source',
      'Header sanitisation',
      'PKCS#12 import',
      'Sign / verify (detached)',
      'Sign / verify (opaque)',
      'Encrypt / decrypt (AES-256-GCM)',
      'Content-encryption allowlist',
      'Message round trip',
      'Certificate auto-import gate',
      'MIME builder / parser',
    ]) {
      expect(groups.has(expected), `missing group: ${expected}`).toBe(true);
    }
  });
});
