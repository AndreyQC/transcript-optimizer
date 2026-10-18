// Сборка sidecar-пайплайна транскрибации и его копия в app/src-tauri/binaries
// под именем с target-triple (требование Tauri externalBin).
//
//   node scripts/build-pipeline.mjs          // сборка + копирование
//
// Запускать из app/. Бинарь берётся из root-workspace: ../../target/release.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcBin = join(root, "target", "release", "pipeline.exe");

const triple = execSync("rustc -vV", { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .slice("host:".length)
  .trim();

console.log(`[build-pipeline] target triple: ${triple}`);
console.log("[build-pipeline] cargo build -p pipeline --release…");
execSync("cargo build -p pipeline --release", { cwd: root, stdio: "inherit" });

if (!existsSync(srcBin)) {
  console.error(`[build-pipeline] не найден ${srcBin}`);
  process.exit(1);
}
const outDir = join(root, "app", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const dst = join(outDir, `pipeline-${triple}.exe`);
copyFileSync(srcBin, dst);
console.log(`[build-pipeline] OK -> ${dst}`);
