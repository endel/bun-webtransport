#!/usr/bin/env bun
/**
 * Sync versions across all platform packages, then publish via pnpm.
 * Usage: bun run scripts/publish.ts [--dry-run]
 */
import { $ } from "bun";
import { resolve } from "path";
import { readFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");

const mainPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
const version = mainPkg.version;

const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

// Sync version across all platform packages
for (const p of platforms) {
  const pkgPath = resolve(ROOT, "npm", p, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

// Sync optionalDependencies versions in main package
for (const p of platforms) {
  mainPkg.optionalDependencies[`bun-webtransport-build-${p}`] = version;
}
await Bun.write(resolve(ROOT, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");

const args = dryRun ? ["--dry-run"] : [];
await $`pnpm publish -r --access public --no-git-checks ${args}`.cwd(ROOT);

console.log("Done.");
