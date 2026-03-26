#!/usr/bin/env bun
/**
 * Cross-compile quic-zig shared library for all supported platforms.
 * Outputs go into npm/<platform>/libquic-zig.{so,dylib}
 */
import { $ } from "bun";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const QUIC_ZIG = resolve(ROOT, "quic-zig");

const targets = [
  { dir: "darwin-arm64", zig: "aarch64-macos",  lib: "libquic-zig.dylib" },
  { dir: "darwin-x64",  zig: "x86_64-macos",   lib: "libquic-zig.dylib" },
  { dir: "linux-arm64",  zig: "aarch64-linux",  lib: "libquic-zig.so" },
  { dir: "linux-x64",   zig: "x86_64-linux",   lib: "libquic-zig.so" },
];

for (const t of targets) {
  console.log(`Building ${t.dir}...`);
  await $`zig build lib -Doptimize=ReleaseFast -Dtarget=${t.zig}`.cwd(QUIC_ZIG);
  await $`cp ${resolve(QUIC_ZIG, "zig-out/lib", t.lib)} ${resolve(ROOT, "npm", t.dir, t.lib)}`;
  console.log(`  -> npm/${t.dir}/${t.lib}`);
}

// Rebuild native library so local dev isn't broken after cross-compilation
console.log("Rebuilding native library for local dev...");
await $`zig build lib -Doptimize=ReleaseFast`.cwd(QUIC_ZIG);

console.log("Done.");
