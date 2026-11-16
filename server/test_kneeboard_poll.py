"""Offline tests for kneeboard_poll: a fake API and a fake clock. Run: python3 -m unittest -v"""

import unittest

import kneeboard_poll as kp

MIN = 60_000
# Wednesday 18 Nov 2026, 12:00 UTC.
T = 1_795_003_200_000
CO = 'c1'


class FakeGame:
    """The company feed and the standings, driven by the test."""

    def __init__(self):
        self.now = T
        self.flights = []
        self.totals = {}  # code -> our company's total
        self.calls = []

    def clock(self):
        return self.now

    def fetch(self, path):
        self.calls.append(path)
        if path.startswith('/api/air/co'):
            return {'flights': self.flights, 'landed': [], 'held': {}}
        code = path.split('code=')[1].split('&')[0]
        return {'list': [{'id': CO, 'value': self.totals.get(code, 0)}, {'id': 'other', 'value': 5}], 'cos': {}}

    def fly(self, pid, to, t0, eta_min, cs=None):
        self.flights.append({'pid': pid, 'cs': cs or pid.upper(), 'from': {'code': 'EIDW'}, 'to': {'code': to}, 't0': t0, 'eta': eta_min * 60})

    def land(self, pid, code, pay):
        self.totals[code] = self.totals.get(code, 0) + pay
        self.flights = [f for f in self.flights if f['pid'] != pid]


class PollerTest(unittest.TestCase):
    def setUp(self):
        self.g = FakeGame()
        self.state = {}

    def run_at(self, t):
        self.g.now = t
        kp.Poller(CO, self.state, fetch=self.g.fetch, clock=self.g.clock).run()

    def landings(self):
        return {(l['pid'], l['to']): l for l in self.state['landings']}

    def test_one_landing_is_measured(self):
        self.g.totals['EGNH'] = 40_000
        self.g.fly('me', 'EGNH', T, 30)
        self.run_at(T + MIN)  # sees the flight, takes the "before" total
        self.g.land('me', 'EGNH', 18_400)
        self.run_at(T + 33 * MIN)  # past landing + settle
        l = self.landings()[('me', 'EGNH')]
        self.assertEqual((l['how'], l['pay']), ('measured', 18_400))
        self.assertEqual(self.state['flying'], {})
        self.assertNotIn('before', l)

    def test_two_landings_in_one_window_share_the_rise(self):
        self.g.fly('me', 'EGNH', T, 30)
        self.g.fly('mate', 'EGNH', T, 31)
        self.run_at(T + MIN)
        self.g.land('me', 'EGNH', 10_000)
        self.g.land('mate', 'EGNH', 30_000)
        self.run_at(T + 40 * MIN)
        got = self.landings()
        self.assertEqual({got[('me', 'EGNH')]['how'], got[('mate', 'EGNH')]['how']}, {'shared'})
        self.assertEqual(got[('me', 'EGNH')]['pay'], 20_000)
        self.assertEqual(got[('me', 'EGNH')]['with'], [{'pid': 'mate', 'cs': 'MATE'}])

    def test_two_of_my_own_landings_share_with_only_me(self):
        self.g.fly('me', 'EGNH', T, 30)
        self.run_at(T + MIN)
        self.g.land('me', 'EGNH', 10_000)
        self.g.fly('me', 'EGNH', T + 31 * MIN, 1)
        self.run_at(T + 31 * MIN + 30_000)  # sees the second flight; the first hasn't settled yet
        self.g.land('me', 'EGNH', 4_000)
        self.run_at(T + 40 * MIN)
        mine = [l for l in self.state['landings'] if l['pid'] == 'me']
        self.assertEqual(len(mine), 2)
        self.assertTrue(all(l['how'] == 'shared' and l['with'][0]['pid'] == 'me' for l in mine))
        self.assertEqual(sum(l['pay'] for l in mine), 14_000)

    def test_a_logged_landing_keeps_its_pay_and_the_next_gets_the_rest(self):
        self.g.fly('mate', 'EGNH', T, 10)
        self.run_at(T + MIN)
        self.g.fly('me', 'EGNH', T + 2 * MIN, 30)
        self.run_at(T + 3 * MIN)  # me's "before" is taken now, mate still in the air
        self.g.land('mate', 'EGNH', 7_000)
        self.run_at(T + 13 * MIN)  # mate settles: measured
        self.g.land('me', 'EGNH', 12_000)
        self.run_at(T + 35 * MIN)
        got = self.landings()
        self.assertEqual((got[('mate', 'EGNH')]['how'], got[('mate', 'EGNH')]['pay']), ('measured', 7_000))
        # mate's pay was measured, so the rest of the rise is exactly me's.
        self.assertEqual((got[('me', 'EGNH')]['how'], got[('me', 'EGNH')]['pay']), ('measured', 12_000))
        self.assertEqual(got[('me', 'EGNH')]['with'], [{'pid': 'mate', 'cs': 'MATE'}])

    def test_a_late_credit_is_read_again(self):
        self.g.totals['EGNH'] = 40_000
        self.g.fly('me', 'EGNH', T, 30)
        self.run_at(T + MIN)
        self.g.flights = []
        self.run_at(T + 33 * MIN)  # landed, but the total hasn't moved yet
        self.assertEqual(self.state['landings'], [])
        self.assertIn('me:%d' % T, self.state['flying'])
        self.g.totals['EGNH'] += 18_400  # the phone reports its landing late
        self.run_at(T + 36 * MIN)
        l = self.landings()[('me', 'EGNH')]
        self.assertEqual((l['how'], l['pay']), ('measured', 18_400))
        self.assertNotIn('seen', l)

    def test_a_stale_reply_after_a_fresh_one_keeps_the_higher_total(self):
        self.g.totals['EGNH'] = 40_000
        self.g.fly('me', 'EGNH', T, 30)
        self.g.fly('mate', 'EGNH', T, 31)
        self.run_at(T + MIN)
        self.g.land('me', 'EGNH', 0)
        self.run_at(T + 33 * MIN)  # me's total hasn't moved: both wait (mate settles with me)
        self.g.land('mate', 'EGNH', 0)
        self.g.totals['EGNH'] = 46_000
        self.state['flying']['me:%d' % T]['seen'] = 50_000  # an earlier read showed more
        self.run_at(T + 35 * MIN)
        got = self.landings()
        self.assertEqual(got[('me', 'EGNH')]['pay'] + got[('mate', 'EGNH')]['pay'], 10_000)

    def test_a_total_that_never_rises_is_unknown_not_zero(self):
        self.g.totals['EIME'] = 830
        self.g.fly('me', 'EIME', T, 6)
        self.run_at(T + MIN)
        self.g.land('me', 'EIME', 0)
        for m in range(9, 6 + 15):
            self.run_at(T + m * MIN)
        self.assertEqual(self.state['landings'], [])  # still within the retry window
        self.run_at(T + (6 + 15) * MIN)
        l = self.landings()[('me', 'EIME')]
        self.assertEqual((l['how'], l['pay']), ('unknown', None))
        self.assertEqual(self.state['flying'], {})

    def test_first_seen_after_landing_is_unknown(self):
        self.g.fly('me', 'EGNH', T - 60 * MIN, 30)
        self.run_at(T)
        self.g.land('me', 'EGNH', 9_000)
        self.run_at(T + 3 * MIN)
        l = self.landings()[('me', 'EGNH')]
        self.assertEqual((l['how'], l['pay']), ('unknown', None))

    def test_a_new_week_in_between_is_unknown(self):
        sunday = kp.week_start(T) + 7 * 86_400_000 - 10 * MIN
        self.g.fly('me', 'EGNH', sunday, 30)
        self.run_at(sunday + MIN)
        self.g.land('me', 'EGNH', 9_000)
        self.run_at(sunday + 40 * MIN)
        self.assertEqual(self.landings()[('me', 'EGNH')]['how'], 'unknown')

    def test_reaching_the_weekly_limit_is_capped(self):
        self.state['landings'] = [{'key': 'old', 'pid': 'me', 'to': 'EGNH', 't': T - 60 * MIN, 'pay': 240_000, 'how': 'measured'}]
        self.g.totals['EGNH'] = 240_000
        self.g.fly('me', 'EGNH', T, 30)
        self.run_at(T + MIN)
        self.g.land('me', 'EGNH', 10_000)  # the job paid more, but only 10k counted
        self.run_at(T + 40 * MIN)
        l = self.landings()[('me', 'EGNH')]
        self.assertEqual((l['pay'], l.get('capped')), (10_000, True))

    def test_past_the_limit_pay_is_unknown(self):
        self.state['landings'] = [{'key': 'old', 'pid': 'me', 'to': 'EGNH', 't': T - 60 * MIN, 'pay': 250_000, 'how': 'measured'}]
        self.g.fly('me', 'EGNH', T, 30)
        self.run_at(T + MIN)
        self.g.land('me', 'EGNH', 0)
        self.run_at(T + 40 * MIN)
        l = self.landings()[('me', 'EGNH')]
        self.assertEqual((l['how'], l['pay'], l.get('capped')), ('unknown', None, True))

    def test_one_standings_request_per_airport_per_run_and_a_budget(self):
        for i in range(20):
            self.g.fly(f'p{i}', 'EGNH' if i < 5 else f'X{i:03}', T, 30)
        self.run_at(T + MIN)
        standings = [c for c in self.g.calls if c.startswith('/api/standings')]
        self.assertEqual(len(standings), kp.MAX_STANDINGS)
        self.assertEqual(sum('EGNH' in c for c in standings), 1)
        # The ones over budget get their "before" on the next run, while still in the air.
        self.g.calls.clear()
        self.run_at(T + 2 * MIN)
        self.assertTrue(all(e['before'] for e in self.state['flying'].values()))

    def test_old_landings_are_dropped(self):
        self.state['landings'] = [{'key': 'old', 'pid': 'me', 'to': 'EGNH', 't': T - 16 * 86_400_000, 'pay': 1, 'how': 'measured'}]
        self.run_at(T)
        self.assertEqual(self.state['landings'], [])


if __name__ == '__main__':
    unittest.main()
