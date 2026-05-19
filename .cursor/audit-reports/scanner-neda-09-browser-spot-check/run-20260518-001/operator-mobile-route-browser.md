# Operator-mobile route — browser spot check

- **URL:** `/scanner/operator-mobile/scan`
- **Unauthenticated HTTP:** 307 → login redirect
- **Dev session:** GET 200=true, POST 200=true
- **Playwright:** Cannot find package 'playwright' imported from C:\Users\Christian\ecommerce-os\scripts\scanner-neda-09-browser-spot-check.ts

Sample terminal lines:
```
 POST /scanner/operator-mobile/scan 200 in 741ms (compile: 14ms, proxy.ts: 73ms, render: 654ms)
 POST /scanner/operator-mobile/scan 200 in 561ms (compile: 11ms, proxy.ts: 73ms, render: 478ms)
 POST /scanner/operator-mobile/scan 200 in 1079ms (compile: 10ms, proxy.ts: 79ms, render: 990ms)Using the user object as returned from supabase.auth.getSession() or from some supabase.auth.onAuthStateChange() events could be insecure! This value comes directly from the storage medium (usually cookies on the server) and may not be authentic. Use supabase.auth.getUser() instead which authenticates the data by contacting the Supabase Auth server.
 POST /scanner/operator-mobile/scan 200 in 295ms (compile: 15ms, proxy.ts: 67ms, render: 213ms)
 POST /scanner/operator-mobile/scan 200 in 482ms (compile: 15ms, proxy.ts: 80ms, render: 387ms)
 POST /scanner/operator-mobile/scan 200 in 298ms (compile: 9ms, proxy.ts: 89ms, render: 199ms)
 POST /scanner/operator-mobile/scan 200 in 1031ms (compile: 11ms, proxy.ts: 57ms, render: 963ms)Using the user object as returned from supabase.auth.getSession() or from some supabase.auth.onAuthStateChange() events could be insecure! This value comes directly from the storage medium (usually cookies on the server) and may not be authentic. Use supabase.auth.getUser() instead which authenticates the data by contacting the Supabase Auth server.
 POST /scanner/operator-mobile/scan 200 in 710ms (compile: 10ms, proxy.ts: 76ms, render: 624ms)---
```
