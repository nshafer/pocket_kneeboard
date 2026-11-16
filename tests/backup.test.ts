import { describe, expect, it } from 'vitest';
import { describeBackup, makeBackup, parseBackup } from '../src/lib/backup';

describe('backups', () => {
  const all = {
    'kb:live': { callsign: 'N1C0', pid: 'p1' },
    'kb:ledger:p1': { entries: [{}, {}] },
    'kb:prefs': { zoom: 1.2 },
    'something-else': 1,
  };

  it('holds only the kb:* records, and reads back', () => {
    const b = makeBackup(all, '0.3.0', 5);
    expect(Object.keys(b.data)).toEqual(['kb:live', 'kb:ledger:p1', 'kb:prefs']);
    const back = parseBackup(JSON.stringify(b));
    expect(back).toEqual(b);
    expect(describeBackup(back)).toEqual({ records: 3, flights: 2, pilot: 'N1C0' });
  });

  it('rejects files that aren’t backups', () => {
    expect(() => parseBackup('not json')).toThrow(/not JSON/);
    expect(() => parseBackup('{"a":1}')).toThrow(/isn’t a Pocket Kneeboard backup/);
    expect(() => parseBackup('{"kind":"pocket-kneeboard-backup","data":{}}')).toThrow(/no records/);
    expect(() => parseBackup('{"kind":"pocket-kneeboard-backup","data":{"flash.auth":"x"}}')).toThrow(/doesn’t keep/);
  });
});
