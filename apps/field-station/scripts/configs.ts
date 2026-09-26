/**
 * Writes the StreamOtter configuration files from src/project.ts.
 *   node scripts/configs.ts           write them
 *   node scripts/configs.ts --check   exit 1 if any file is out of date
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonPretty } from "streamotter/contracts";
import { CONFIG_FILES, projectConfig, type Environment } from "../src/project.ts";

const appDir = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const [environment, file] of Object.entries(CONFIG_FILES) as [Environment, string][]) {
  const path = join(appDir, file);
  const content = canonicalJsonPretty(projectConfig(environment));
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) continue;
  if (check) {
    stale.push(file);
  } else {
    await writeFile(path, content);
    console.log(`Wrote ${file}`);
  }
}

if (stale.length > 0) {
  console.error(`Out of date: ${stale.join(", ")}. Run npm run configs in apps/field-station.`);
  process.exit(1);
}
