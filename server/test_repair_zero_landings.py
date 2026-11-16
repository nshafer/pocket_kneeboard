"""Offline tests for repair_zero_landings. Run: python3 -m unittest -v"""

import unittest

import repair_zero_landings as rz

FIX = rz.parse_time('2026-11-16T14:15:00Z')
H = 3_600_000


def landing(key, t, how='measured', pay=0, pid='me', cs='ME', to='EIDW'):
    return {'key': key, 'pid': pid, 'cs': cs, 'to': to, 't0': t - H, 't': t, 'how': how, 'pay': pay}


class RepairTest(unittest.TestCase):
    def test_stale_zeros_become_unknown_and_the_rest_stay(self):
        state = {'landings': [
            landing('a', FIX - 5 * H),
            landing('b', FIX - 4 * H, pay=990),
            landing('c', FIX - 3 * H, how='unknown', pay=None),
            landing('d', FIX + H),  # after the fix: a real $0
        ]}
        changes = rz.repair(state, FIX, [])
        self.assertEqual(len(changes), 1)
        a, b, c, d = state['landings']
        self.assertEqual((a['how'], a['pay'], a['repaired']), ('unknown', None, 'stale'))
        self.assertEqual((b['how'], b['pay']), ('measured', 990))
        self.assertNotIn('repaired', c)
        self.assertEqual((d['how'], d['pay']), ('measured', 0))

    def test_a_known_rise_is_split_evenly(self):
        state = {'landings': [landing('x', FIX - 8 * H), landing('y', FIX - 4 * H), landing('z', FIX - 2 * H, to='EIME')]}
        rz.repair(state, FIX, [rz.parse_split('x,y=33030')])
        x, y, z = state['landings']
        self.assertEqual((x['how'], x['pay'], y['pay']), ('shared', 16515, 16515))
        self.assertEqual(x['with'], [{'pid': 'me', 'cs': 'ME'}])
        self.assertEqual(z['how'], 'unknown')

    def test_a_split_must_name_landings_in_the_log(self):
        with self.assertRaises(SystemExit):
            rz.repair({'landings': [landing('x', FIX - H)]}, FIX, [(['x', 'nope'], 100)])


if __name__ == '__main__':
    unittest.main()
