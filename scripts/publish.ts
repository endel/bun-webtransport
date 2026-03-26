#!/usr/bin/env bun
/**
 * Publish all platform packages then the main package.
 * Usage: bun run scripts/publish.ts [--dry-run]
 */
import { $ } from "bun";
import { resolve } from "path";
import { readFileSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");
const npmArgs = dryRun ? ["--dry-run"] : [];

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
  const depName = `bun-webtransport-build-${p}`;
  mainPkg.optionalDependencies[depName] = version;
}
await Bun.write(resolve(ROOT, "package.json"), JSON.stringify(mainPkg, null, 2) + "\n");

// Publish platform packages first
for (const p of platforms) {
  const dir = resolve(ROOT, "npm", p);
  console.log(`Publishing bun-webtransport-build-${p}@${version}...`);
  await $`npm publish --access public ${npmArgs}`.cwd(dir);
}

// Publish main package
console.log(`Publishing bun-webtransport@${version}...`);
await $`npm publish --access public ${npmArgs}`.cwd(ROOT);

console.log("Done.");
