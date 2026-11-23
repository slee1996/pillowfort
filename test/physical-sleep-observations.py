"""A timing report must not turn an awake control, dark wake or old chat into a physical result."""
import importlib.util
from pathlib import Path
import unittest

src = Path(__file__).resolve().parents[1] / 'scripts/measure-laptop-sleep.py'
spec = importlib.util.spec_from_file_location('laptop_sleep', src)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SleepEvidence(unittest.TestCase):
    def setUp(self):
        self.obs = {'fault': 'physical-sleep', 'controlOnly': False, 'windowStartUtcMs': 1000, 'windowEndUtcMs': 50000,
                    'offers': [], 'signedAcceptances': [], 'samples': [
                        {'submittedAt': 15000, 'receivedAt': 23900},  # A pre-sleep message delivered after wake.
                        {'submittedAt': 23400, 'receivedAt': 23500},  # Overlaps the uncertainty interval for wake.
                        {'submittedAt': 25200, 'receivedAt': 25300}]}
        self.relay = {'fault': 'physical-sleep', 'events': [{'event': 'original-probe-send-attempt', 'at': 28000},
                                                            {'event': 'original-probe-reply-committed', 'at': 28200}]}
        self.power = [('Sleep', 17000), ('DarkWake', 20000), ('Sleep', 21000), ('Wake', 23000)]

    def report(self):
        return mod.summarize(self.obs, self.relay, self.power, [-50, 50])

    def test_waits_for_full_wake_and_counts_only_new_chat(self):
        result = self.report()
        self.assertEqual(result['fullWakeToFirstDefinitelyNewChatMs'], [1251, 2350])
        self.assertTrue(result['originalConnectionAnsweredAfterFullWake'])
        self.assertEqual(result['darkWakes'], 1)

    def test_no_physical_claim_from_an_awake_control_or_dark_wake_only(self):
        self.obs['controlOnly'] = True
        with self.assertRaisesRegex(ValueError, 'awake control'):
            self.report()
        self.obs['controlOnly'] = False
        self.power.pop()
        with self.assertRaisesRegex(ValueError, 'full wake'):
            self.report()

    def test_ambiguous_or_unobserved_recovery_is_not_zero_latency(self):
        self.power.extend([('Sleep', 32000), ('Wake', 38000)])
        with self.assertRaisesRegex(ValueError, 'multiple'):
            self.report()
        del self.power[-2:]
        self.obs['samples'].pop()
        self.obs['samples'].append({'submittedAt': 30000, 'receivedAt': None})
        censored = self.report()
        self.assertTrue(censored['physicalCycleVerified'])
        self.assertFalse(censored['measured'])
        self.assertIsNone(censored['fullWakeToFirstDefinitelyNewChatMs'])
        self.assertEqual(censored['postWakeSubmissions'], 1)
        self.assertEqual(censored['trafficOutcome'], 'not observed before the window ended')

    def test_offer_that_predates_sleep_is_not_attributed_to_sleep(self):
        self.obs['offers'] = [14000]
        with self.assertRaisesRegex(ValueError, 'before system sleep'):
            self.report()


if __name__ == '__main__':
    unittest.main()
