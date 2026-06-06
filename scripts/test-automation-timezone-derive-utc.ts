/**
 * Verify 23:30 America/Los_Angeles → ~06:30 UTC (PDT) and normalize derives UTC hours.
 */
import assert from "node:assert/strict";

import {
  deriveUtcRunSlotsFromLocalRunTimes,
  deriveUtcRunTimesDisplayFromLocal,
} from "../lib/automation-timezone-schedule";
import { normalizeStoreAutomationSettings } from "../lib/platform-automation-schedule";

const ref = new Date("2026-05-28T12:00:00.000Z");
const slots = deriveUtcRunSlotsFromLocalRunTimes("America/Los_Angeles", ["23:30"], ref);
assert.equal(slots.length, 1);
assert.equal(slots[0]!.hour, 6, `expected UTC hour 6, got ${slots[0]!.hour}`);
assert.equal(slots[0]!.minute, 30, `expected UTC minute 30, got ${slots[0]!.minute}`);

const display = deriveUtcRunTimesDisplayFromLocal("America/Los_Angeles", ["23:30"], ref);
assert.equal(display, "06:30");

const normalized = normalizeStoreAutomationSettings({
  removal_api_sync: {
    enabled: true,
    recent_sync: {
      runs_per_day: 1,
      run_times_local: ["23:30"],
      run_hours_utc: [21],
      timezone: "America/Los_Angeles",
      max_runtime_seconds: 1800,
    },
  },
});
assert.equal(normalized.removal_api_sync.recent_sync.run_hours_utc[0], 6);
assert.notEqual(normalized.removal_api_sync.recent_sync.run_hours_utc[0], 21);

console.log("ok automation-timezone-derive-utc");
