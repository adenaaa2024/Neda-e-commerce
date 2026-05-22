# ShipmentEntryGateResult

Exported from `lib/scanner/shipment-entry-lookup.ts`:

- `ShipmentEntryGateResult` type
- `toShipmentEntryGateResult(rawCode, lookup)`
- Existing `ShipmentEntryLookupResult` retained for gate UI state

Gate UI continues to consume `ShipmentEntryLookupResult`; stable API available for probes and audits.
