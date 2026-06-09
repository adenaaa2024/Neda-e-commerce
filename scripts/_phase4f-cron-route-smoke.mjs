const base = process.env.SMOKE_BASE_URL?.trim() || "http://localhost:3000";
const path = "/api/cron/removal-nightly-sync";
const url = `${base.replace(/\/$/, "")}${path}`;

async function probe(label, headers) {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  let body;
  let isJson = false;
  try {
    body = JSON.parse(text);
    isJson = true;
  } catch {
    body = text.slice(0, 120);
  }
  return { label, status: res.status, is_json: isJson, body };
}

const results = [];
results.push(await probe("no_auth", {}));
results.push(await probe("invalid_bearer", { Authorization: "Bearer invalid" }));

const secret = process.env.CRON_SECRET?.trim();
if (secret) {
  results.push(await probe("valid_bearer", { Authorization: `Bearer ${secret}` }));
} else {
  results.push({ label: "valid_bearer", skipped: true, reason: "CRON_SECRET not in env" });
}

console.log(JSON.stringify({ url, results }, null, 2));
