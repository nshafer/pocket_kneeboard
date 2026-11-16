// Backups of the Pocket Kneeboard's records: every `kb:*` key in the extension's storage, as one
// JSON file. None of them holds an account value (see types.ts), so a backup is safe to keep.

import type { Ledger, Snapshot } from './types';

export const BACKUP_KIND = 'pocket-kneeboard-backup';

export interface Backup {
  kind: typeof BACKUP_KIND;
  /** The extension's version that wrote it. */
  version: string;
  exported: number;
  data: Record<string, unknown>;
}

const KEY = /^kb:[a-z]+(?::[\w.-]{1,64})?$/;

/** A backup of the records in `all` (the whole of storage): only the `kb:*` keys. */
export function makeBackup(all: Record<string, unknown>, version: string, now: number): Backup {
  const data = Object.fromEntries(Object.entries(all).filter(([k]) => KEY.test(k)));
  return { kind: BACKUP_KIND, version, exported: now, data };
}

/** Reads a backup file's text. Throws, with a reason fit to show, when it isn't one. */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That isn’t a backup file (not JSON).');
  }
  const b = raw as Partial<Backup> | null;
  if (!b || typeof b !== 'object' || b.kind !== BACKUP_KIND) throw new Error('That isn’t a Pocket Kneeboard backup.');
  if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new Error('The backup has no records.');
  const keys = Object.keys(b.data);
  if (!keys.length) throw new Error('The backup has no records.');
  const bad = keys.find((k) => !KEY.test(k));
  if (bad) throw new Error(`The backup has a record this extension doesn’t keep (${bad.slice(0, 40)}).`);
  return {
    kind: BACKUP_KIND,
    version: typeof b.version === 'string' ? b.version : '?',
    exported: typeof b.exported === 'number' ? b.exported : 0,
    data: b.data as Record<string, unknown>,
  };
}

/** What a backup holds, to show before restoring it. */
export function describeBackup(b: Backup) {
  const live = b.data['kb:live'] as Partial<Snapshot> | undefined;
  const ledgers = Object.entries(b.data).filter(([k]) => k.startsWith('kb:ledger:'));
  const flights = ledgers.reduce((n, [, l]) => n + ((l as Partial<Ledger>)?.entries?.length ?? 0), 0);
  return { records: Object.keys(b.data).length, flights, pilot: typeof live?.callsign === 'string' ? live.callsign : undefined };
}
