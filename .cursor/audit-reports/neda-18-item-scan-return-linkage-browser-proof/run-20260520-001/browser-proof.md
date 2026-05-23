# Browser proof — item scan return_items linkage

| Check | Result |
|-------|--------|
| Signed in | true |
| Store configured | true |
| Item scan / Expected Items | false / true |
| Linkage copy in DOM | true |
| Matched labels | X004DMS1TT, X00525Q5XZ, no_product_link_yet |
| Staging API only | true |
| Server action POST 200 | true |
| Hydrated scanned hint | n/a |

Routes:
- http://127.0.0.1:3001/scanner/operator-mobile/scan
- http://127.0.0.1:3001/scanner/operator-mobile/scan

```
RECOVRA SAM DISTRIBUTION STORE Sam AM SHIPMENT ENTRY TRACKING NUMBER OR SLIP CODE UNEXPECTED Tracking number234324324 Order ID — Not on the expected list (0 expected). Not on expected list. Scan progress 2 / 0 Product name — Carrier FedEx Total expected qty 0 Total scanned (view) 2 LINE ITEMS· exact Tracking number PRODUCT NAME FNSKU EXPECTED SCANNED VARIANCE STATUS X00525Q5XZ · TU-8QKU-LV50 NO PRODUCT LINK YET X00525Q5XZ · TU-8QKU-LV50 X00525Q5XZ 0 1 +1 IN_PROGRESS_NOT X004DMS1TT NO PRODUCT LINK YET X004DMS1TT X004DMS1TT 0 1 +1 IN_PROGRESS_NOT IDENTIFY AS PALLET SINGLE BOX / ITEM Continue Scanning Home Scan Tasks 2 Alerts More
```
