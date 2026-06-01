/**
 * Approval-gated: force-set Neda password on ORIGINAL via Admin API only.
 * Requires: NEDA_TEMP_PASSWORD in process.env (min 12 chars). Never logs password.
 * Usage: $env:NEDA_TEMP_PASSWORD='...'; node scripts/_auth-neda-force-set-password-original.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const TARGET_EMAIL = "neda@samdistributioninc.com";
const RUN_ID = process.env.AUTH_NEDA_RUN_ID ?? "20260529T220000Z";
const OUT_DIR = join(
  process.cwd(),
  ".cursor/audit-reports/auth-neda-force-set-password-original-admin-approved",
  RUN_ID,
);

function loadEnv() {
  const env = { ...process.env };
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

function refFromUrl(url) {
  const m = String(url ?? "").match(/https:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return m?.[1] ?? null;
}

function readApproval() {
  const paths = [
    join(process.cwd(), ".cursor/operator-approvals/auth-neda-original-admin-password-reset.md"),
    join(
      process.cwd(),
      ".cursor/operator-approvals/.cursor/operator-approvals/auth-neda-original-admin-password-reset.md",
    ),
  ];
  for (const p of paths) {
    try {
      return { path: p, text: readFileSync(p, "utf8") };
    } catch {
      /* next */
    }
  }
  return { path: null, text: "" };
}

function approvalValid(text) {
  return (
    /APPROVED_AUTH_ADMIN_PASSWORD_RESET\s*=\s*true/i.test(text) &&
    /TARGET_SUPABASE_REF\s*=\s*kxsvedvpjldygtdbylsy/i.test(text) &&
    /TARGET_EMAIL\s*=\s*neda@samdistributioninc\.com/i.test(text)
  );
}

function writeArtifact(name, body) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), body);
}

async function main() {
  const env = loadEnv();
  const approval = readApproval();
  const approved = approvalValid(approval.text);
  const tempPassword = process.env.NEDA_TEMP_PASSWORD ?? "";
  const tempOk = tempPassword.length >= 12;

  const originalUrl = env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const originalServiceKey = env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  const originalAnonKey = env.ORIGINAL_ANON_KEY?.trim() ?? env.ORIGINAL_SUPABASE_ANON_KEY?.trim() ?? "";
  const originalRef = refFromUrl(originalUrl);
  const nextPublicRef = refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);

  writeArtifact(
    "approval-proof.md",
    `# Approval proof\n\n**Run ID:** \`${RUN_ID}\`\n\n| Check | Result |\n|-------|--------|\n| Approval file | ${approval.path ?? "NOT FOUND"} |\n| Approval valid | **${approved ? "YES" : "NO"}** |\n`,
  );

  writeArtifact(
    "local-env-explanation.md",
    `# Local env explanation\n\n| \`NEXT_PUBLIC_SUPABASE_URL\` | \`${nextPublicRef ?? "unknown"}\` |\n| \`ORIGINAL_SUPABASE_URL\` | \`${originalRef ?? "unknown"}\` |\n\nLocal dev uses **NEXT_PUBLIC_*** → **${nextPublicRef === ORIGINAL_REF ? "original" : "staging"}**. Production: **https://menorix.com/login**.\n`,
  );

  if (!approved || originalRef !== ORIGINAL_REF || !originalServiceKey || !originalAnonKey) {
    const blockers = [];
    if (!approved) blockers.push("Invalid approval");
    if (originalRef !== ORIGINAL_REF) blockers.push("ORIGINAL ref mismatch");
    if (!originalServiceKey) blockers.push("Missing ORIGINAL_SERVICE_ROLE_KEY");
    if (!originalAnonKey) blockers.push("Missing ORIGINAL anon key");
    writeArtifact("blockers.md", blockers.map((b) => `- ${b}`).join("\n"));
    console.log(JSON.stringify({ status: "BLOCKED_PREFLIGHT", blockers }));
    process.exit(1);
  }

  if (!tempOk) {
    writeArtifact("blockers.md", "- NEDA_TEMP_PASSWORD missing or < 12 chars in shell env\n");
    console.log(JSON.stringify({ status: "BLOCKED_NO_TEMP_PASSWORD", approval_valid: true }));
    process.exit(1);
  }

  const admin = createClient(originalUrl, originalServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: listData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const matches = (listData?.users ?? []).filter(
    (u) => (u.email ?? "").toLowerCase() === TARGET_EMAIL.toLowerCase(),
  );
  if (listErr || matches.length !== 1) {
    console.log(JSON.stringify({ status: "BLOCKED_USER_LOOKUP", count: matches.length }));
    process.exit(1);
  }

  const user = matches[0];
  const beforeLastSignIn = user.last_sign_in_at ?? null;
  writeArtifact(
    "original-user-before.md",
    `# Original user before\n\n| User ID | \`${user.id}\` |\n| Email | \`${user.email}\` |\n| Confirmed | ${user.email_confirmed_at ? "YES" : "NO"} |\n| last_sign_in_at | ${beforeLastSignIn ?? "null"} |\n`,
  );

  const { error: updateErr } = await admin.auth.admin.updateUserById(user.id, {
    password: tempPassword,
    email_confirm: true,
  });

  writeArtifact(
    "admin-password-update-result.md",
    `# Admin password update\n\n| Success | **${updateErr ? "NO" : "YES"}** |\n| Error | ${updateErr?.message ?? "none"} |\n`,
  );
  if (updateErr) {
    console.log(JSON.stringify({ status: "UPDATE_FAILED", error: updateErr.message }));
    process.exit(1);
  }

  const anon = createClient(originalUrl, originalAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signInData, error: signInErr } = await anon.auth.signInWithPassword({
    email: TARGET_EMAIL,
    password: tempPassword,
  });
  if (signInData.session) await anon.auth.signOut();

  writeArtifact(
    "original-signin-verify.md",
    `# Original sign-in verify\n\n| Success | **${signInErr ? "NO" : "YES"}** |\n| Error | ${signInErr?.message ?? "none"} |\n| Status | ${signInErr?.status ?? "n/a"} |\n`,
  );

  const { data: afterAuth } = await admin.auth.admin.getUserById(user.id);
  const afterLastSignIn = afterAuth.user?.last_sign_in_at ?? null;
  const moved =
    afterLastSignIn != null &&
    (beforeLastSignIn == null || new Date(afterLastSignIn) > new Date(beforeLastSignIn));

  writeArtifact(
    "last-signin-after.md",
    `# Last sign-in after\n\n| Before | ${beforeLastSignIn ?? "null"} |\n| After | ${afterLastSignIn ?? "null"} |\n| Changed | **${moved ? "YES" : "NO"}** |\n`,
  );

  writeArtifact(
    "manifest.json",
    JSON.stringify(
      {
        run_id: RUN_ID,
        status: signInErr ? "VERIFY_FAILED" : "PASS",
        password_update_success: true,
        sign_in_success: !signInErr,
        sign_in_error: signInErr?.message ?? null,
        last_sign_in_at_changed: moved,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify({
      status: signInErr ? "VERIFY_FAILED" : "PASS",
      password_update_success: true,
      sign_in_success: !signInErr,
      sign_in_error: signInErr?.message ?? null,
      last_sign_in_at_changed: moved,
    }),
  );
}

void main().catch((e) => {
  console.error(JSON.stringify({ status: "ERROR", message: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
