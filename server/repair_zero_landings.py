#!/usr/bin/env python3
"""One-off repair for landing logs written before the poller re-read unmoved totals (3203cd3,
2026-11-16 14:15 UTC). Until then, /api/standings often answered with a stale total right after a
landing, and the landing was logged as "measured" with a pay of $0.

Such a landing's influence wasn't measured at all, so it becomes "unknown" (pay null): the Pocket
Kneeboard lists it as "pay not known" instead of counting $0. A real $0 rise, such as a landing with
no job, can't be told apart before the fix; after the fix it was re-read, so only landings before
--before change.

--split names landings whose combined influence is known from elsewhere, such as two company
totals the Pocket Kneeboard saw at that airport before and after them. They're logged as "shared"
with an even split, like the poller logs landings that share a rise.

Dry run unless --write. With --write, keeps a copy of the old file next to it, and holds the
poller's lock so it doesn't run at the same time. Only the standard library. Python 3.9+.

    python3 repair_zero_landings.py --out /var/www/kneeboard --co bmsx3mly \\
        --before 2026-11-16T14:15:00Z --split PID:T0,PID:T0=33030 --write
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import sys
import time
from datetime import datetime

from kneeboard_poll import write_atomic


def parse_time(s: str) -> int:
    return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)


def parse_split(s: str) -> tuple[list[str], int]:
    keys, _, amount = s.rpartition('=')
    if not keys or not amount.isdigit():
        raise argparse.ArgumentTypeError(f'expected KEY,KEY=AMOUNT, got {s!r}')
    return keys.split(','), int(amount)


def repair(state: dict, before: int, splits: list[tuple[list[str], int]]) -> list[str]:
    """Repairs `state` in place. Returns a line for each landing it changed."""
    changes: list[str] = []
    landings = state.get('landings', [])
    by_key = {l.get('key'): l for l in landings}
    split_keys: set[str] = set()

    for keys, amount in splits:
        missing = [k for k in keys if k not in by_key]
        if missing:
            raise SystemExit(f'not in the log: {", ".join(missing)}')
        group = [by_key[k] for k in keys]
        share = round(amount / len(group))
        for l in group:
            l.update(how='shared', pay=share, repaired='split')
            l['with'] = [{'pid': o['pid'], 'cs': o.get('cs')} for o in group if o is not l]
            split_keys.add(l['key'])
            changes.append(f'shared   {l["key"]}  {l.get("cs")} to {l["to"]}: ${share:,} of ${amount:,}')

    for l in landings:
        if l.get('key') in split_keys or l.get('how') != 'measured' or l.get('pay') != 0 or l.get('t', 0) >= before:
            continue
        l.update(how='unknown', pay=None, repaired='stale')
        changes.append(f'unknown  {l["key"]}  {l.get("cs")} to {l["to"]}')
    return changes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', required=True, help='the poller\'s folder of {id}.json files')
    ap.add_argument('--co', required=True, help='company id')
    ap.add_argument('--before', required=True, type=parse_time, help='when the fixed poller started, e.g. 2026-11-16T14:15:00Z')
    ap.add_argument('--split', action='append', default=[], type=parse_split, metavar='KEY,KEY=AMOUNT',
                    help='landings that share a known rise, split evenly (repeat for each group)')
    ap.add_argument('--write', action='store_true', help='save the changes (otherwise only list them)')
    args = ap.parse_args(argv)

    path = os.path.join(args.out, f'{args.co}.json')
    lock = open(os.path.join(args.out, '.kneeboard.lock'), 'w')
    fcntl.flock(lock, fcntl.LOCK_EX)  # wait for a running poll to finish
    with open(path) as f:
        state = json.load(f)

    changes = repair(state, args.before, args.split)
    print('\n'.join(changes) or 'nothing to repair')
    if not args.write:
        print(f'\n{len(changes)} landing(s) would change. Add --write to save.')
        return 0
    if changes:
        backup = f'{path}.{time.strftime("%Y%m%d-%H%M%S")}.bak'
        shutil.copy2(path, backup)
        write_atomic(path, state)
        print(f'\nSaved. The old file is {backup}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
