/** Static PWA asset validation for audit evidence. */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = process.cwd();
const manifestPath = join(root, "public", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  start_url?: string;
  scope?: string;
  icons?: { src: string }[];
};

const checks: { id: string; pass: boolean; detail: string }[] = [];

checks.push({
  id: "manifest_json",
  pass: true,
  detail: "public/manifest.json parses as JSON",
});

checks.push({
  id: "start_url",
  pass: manifest.start_url === "/",
  detail: `start_url=${manifest.start_url ?? "(missing)"}`,
});

checks.push({
  id: "scope",
  pass: manifest.scope === "/",
  detail: `scope=${manifest.scope ?? "(missing)"}`,
});

for (const icon of manifest.icons ?? []) {
  const rel = icon.src.replace(/^\//, "");
  const filePath = join(root, "public", rel);
  const ok = existsSync(filePath);
  checks.push({
    id: `icon_${rel.replace(/[^a-z0-9]+/gi, "_")}`,
    pass: ok,
    detail: `${icon.src} → ${ok ? "exists" : "MISSING"}`,
  });
}

const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
checks.push({
  id: "root_manifest_link",
  pass: layout.includes('manifest: "/manifest.json"'),
  detail: "app/layout.tsx metadata.manifest",
});

const operatorLayout = readFileSync(
  join(root, "app", "scanner", "operator-mobile", "layout.tsx"),
  "utf8",
);
checks.push({
  id: "operator_no_manifest",
  pass: !operatorLayout.includes("manifest:"),
  detail: "operator-mobile layout does not declare manifest",
});

const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ pass: failed.length === 0, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
