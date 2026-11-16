#!/usr/bin/env python3
"""Logs every landing by the pilots of one or more Pocket Pilots companies, with the influence each
landing added, to one JSON file per company. Run it once a minute from cron:

    * * * * * /usr/bin/python3 /path/to/kneeboard_poll.py --co bmsx3mly --co OTHERID --out /var/www/kneeboard

Each run:
  1. GETs /api/air/co{id}: the company's flights, in progress and just landed. No login needed.
  2. For a flight it hasn't seen, GETs /api/standings for its destination: the company's total there
     before the landing.
  3. For a flight past its landing time (t0 + eta, as the game reckons it), GETs the destination's
     standings again. The rise is the influence the landing added, which is the job's base pay up to
     the weekly limit of $250,000 per pilot per airport. The game's API sometimes answers with an
     older total, and a phone may report its landing late, so a flight whose total hasn't moved is
     read again on later runs, for up to RETRY_S, keeping the highest total seen.
  4. Rewrites {out}/{id}.json with the landings of the last 15 days.

A landing's "how" says how sure its pay is:
  measured  the only company landing at that airport between the two totals.
  shared    several company landings there in that window: the rise is split evenly.
  unknown   no total from before it (first seen after landing, or a new week began in between),
            or the total never rose (an unpaid flight, or a credit the API never showed us).
"capped" is set when the pay reached the pilot's weekly limit there, so the job may have paid more.

Only the standard library. Python 3.9+.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = 'https://pilots.nimblebit.com'
AGENT = 'pocket-kneeboard-poller/1'
CAP = 250_000
KEEP_DAYS = 15
# A run sends at most this many standings requests per company; the rest wait for the next run.
MAX_STANDINGS = 12
# How long after its landing time a flight waits for the server's total to settle.
SETTLE_S = 120
# How long a landing whose total hasn't moved keeps being read again before it's logged as unknown.
RETRY_S = 15 * 60


def now_ms() -> int:
    return int(time.time() * 1000)


def week_start(t_ms: int) -> int:
    """Monday 00:00 UTC of the week that holds t_ms."""
    d = datetime.fromtimestamp(t_ms / 1000, timezone.utc)
    midnight = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    return int(midnight.timestamp() * 1000) - d.weekday() * 86_400_000


def get_json(path: str) -> dict:
    req = urllib.request.Request(API + path, headers={'User-Agent': AGENT, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def code_of(place) -> str | None:
    if isinstance(place, dict):
        return place.get('code')
    return place if isinstance(place, str) else None


class Poller:
    def __init__(self, co: str, state: dict, fetch=get_json, clock=now_ms):
        self.co = co
        self.fetch = fetch
        self.clock = clock
        self.state = state
        state.setdefault('co', co)
        state.setdefault('flying', {})  # key -> flight we're following
        state.setdefault('landings', [])
        self.budget = MAX_STANDINGS

    def total(self, code: str) -> dict | None:
        """The company's total at `code` now, or None when out of budget or on error."""
        if self.budget <= 0:
            return None
        self.budget -= 1
        try:
            reply = self.fetch(f'/api/standings?code={urllib.parse.quote(code)}&co={urllib.parse.quote(self.co)}')
        except Exception as e:  # noqa: BLE001 - one bad airport shouldn't stop the run
            print(f'{self.co}: standings {code}: {e}', file=sys.stderr)
            return None
        v = next((r.get('value', 0) for r in reply.get('list', []) if r.get('id') == self.co), 0)
        seen = {'t': self.clock(), 'v': v}
        return seen

    def run(self) -> None:
        reply = self.fetch(f'/api/air/co{urllib.parse.quote(self.co)}')
        now = self.clock()
        flying = self.state['flying']
        logged = {l['key'] for l in self.state['landings']}

        for f in reply.get('flights') or []:
            to, pid, t0 = code_of(f.get('to')), f.get('pid'), f.get('t0')
            if not to or not pid or not isinstance(t0, (int, float)):
                continue  # no destination: a free flight with nowhere set
            key = f'{pid}:{int(t0)}'
            if key in flying or key in logged:
                continue
            land = int(t0) + max(60_000, int((f.get('eta') or 0) * 1000))
            flying[key] = {
                'key': key, 'pid': pid, 'cs': f.get('cs'), 'from': code_of(f.get('from')), 'to': to,
                't0': int(t0), 't': land, 'type': f.get('type'), 'reg': f.get('reg'), 'before': None,
            }

        # A "before" total for each flight still in the air: taken this run (one request per airport),
        # so no landing it doesn't know about hides in it.
        taken: dict[str, dict | None] = {}
        for e in flying.values():
            if e['before'] is None and now < e['t']:
                if e['to'] not in taken:
                    taken[e['to']] = self.total(e['to'])
                e['before'] = taken[e['to']]

        # Landed and settled: measure.
        done = sorted((e for e in flying.values() if now >= e['t'] + SETTLE_S * 1000), key=lambda e: e['t'])
        by_airport: dict[str, list[dict]] = {}
        for e in done:
            by_airport.setdefault(e['to'], []).append(e)
        for code, group in by_airport.items():
            after = self.total(code)
            if after is None:
                continue  # out of budget: try next run
            # A company's total only rises within a week, so a lower reply than before is stale.
            best = max((e['seen'] for e in group if 'seen' in e), default=None)
            if best is not None and best > after['v']:
                after = {'t': after['t'], 'v': best}
            if self._unmoved(code, group, after) and now < max(e['t'] for e in group) + RETRY_S * 1000:
                for e in group:
                    e['seen'] = after['v']
                continue  # read it again next run
            self._settle(code, group, after)
            for e in group:
                del flying[e['key']]

        # Flights that vanished long before landing (diverted, cancelled) or are stale.
        for key in [k for k, e in flying.items() if now > e['t'] + 6 * 3_600_000]:
            del flying[key]
        cutoff = now - KEEP_DAYS * 86_400_000
        self.state['landings'] = [l for l in self.state['landings'] if l['t'] >= cutoff]
        self.state['updated'] = now

    def _window(self, code: str, group: list[dict], after: dict):
        """The earliest "before" total, the rise since it (None without one in the same week), this
        group's landings between the two totals, and the logged landings there in that window."""
        starts = [e['before'] for e in group if e['before']]
        before = min(starts, key=lambda b: b['t']) if starts else None
        if before is None or week_start(before['t']) != week_start(after['t']):
            return before, None, [], []
        window = [e for e in group if before['t'] < e['t'] <= after['t']]
        earlier = [l for l in self.state['landings'] if l['to'] == code and before['t'] < l['t'] <= after['t']]
        return before, max(0, after['v'] - before['v']), window, earlier

    def _unmoved(self, code: str, group: list[dict], after: dict) -> bool:
        """True when the total hasn't risen past what's already logged, for landings that should
        have raised it: worth reading again. Not for a pilot already at the weekly limit there."""
        _, rise, window, earlier = self._window(code, group, after)
        if rise is None or not any(self._week_pay(e) < CAP for e in window):
            return False
        return rise - sum(l.get('pay') or 0 for l in earlier) <= 0

    def _week_pay(self, e: dict) -> int:
        """What the pilot's logged landings at e's airport already added this week."""
        week = week_start(e['t'])
        return sum(l.get('pay') or 0 for l in self.state['landings']
                   if l['pid'] == e['pid'] and l['to'] == e['to'] and week_start(l['t']) == week)

    def _settle(self, code: str, group: list[dict], after: dict) -> None:
        # Landings that share a "before" total share its rise. Without one, pay is unknown.
        before, rise, window, earlier = self._window(code, group, after)
        for e in group:
            e = {k: v for k, v in e.items() if k not in ('before', 'seen')}
            if rise is None or e['t'] <= before['t'] or e['t'] > after['t']:
                e.update(how='unknown', pay=None)
            elif len(window) + len(earlier) == 1:
                e.update(how='measured', pay=rise)
            else:
                # Already-logged landings in the window keep their pay; the rest shares what's left.
                left = max(0, rise - sum(l.get('pay') or 0 for l in earlier))
                share = [o for o in window if o['key'] != e['key']]
                if earlier and len(window) == 1 and all(l.get('how') == 'measured' for l in earlier):
                    e.update(how='measured', pay=left)  # the rest is exactly this landing's
                else:
                    e.update(how='shared', pay=round(left / len(window)))
                # Who else landed there in the window, so a reader can tell its own from a teammate's.
                e['with'] = [{'pid': o['pid'], 'cs': o.get('cs')} for o in share + earlier]
            self._cap(e)
            if e['pay'] == 0:
                e.update(how='unknown', pay=None)  # the total never rose: we can't tell why
            self.state['landings'].append(e)

    def _cap(self, e: dict) -> None:
        """Marks a landing whose pay reached the pilot's weekly limit at that airport."""
        if e['pay'] is None:
            return
        before = self._week_pay(e)
        if before >= CAP:
            e.update(capped=True, pay=None, how='unknown')  # past the limit: the rise says nothing
        elif before + e['pay'] >= CAP:
            e['capped'] = True


def write_atomic(path: str, data: dict) -> None:
    d = os.path.dirname(path) or '.'
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.kneeboard-', suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--co', action='append', required=True, help='company id (repeat for each company)')
    ap.add_argument('--out', required=True, help='folder for the {id}.json files')
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)

    # One run at a time: a slow run must not overlap the next minute's.
    lock = open(os.path.join(args.out, '.kneeboard.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0

    status = 0
    for co in args.co:
        path = os.path.join(args.out, f'{co}.json')
        try:
            with open(path) as f:
                state = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            state = {}
        try:
            Poller(co, state).run()
        except Exception as e:  # noqa: BLE001 - keep the other company going
            print(f'{co}: {e}', file=sys.stderr)
            status = 1
            continue
        write_atomic(path, state)
    return status


if __name__ == '__main__':
    sys.exit(main())
