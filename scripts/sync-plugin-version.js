#!/usr/bin/env node

/**
 * Sync the version from package.json into plugin.json and marketplace.json.
 * Wired into the npm `version` lifecycle so bumps propagate automatically.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const version = pkg.version;

const targets = [
  "plugin/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

for (const rel of targets) {
  const filePath = path.join(root, rel);
  const content = JSON.parse(readFileSync(filePath, "utf-8"));

  if (content.version !== undefined) {
    content.version = version;
  }

  if (Array.isArray(content.plugins)) {
    for (const plugin of content.plugins) {
      if (plugin.version !== undefined) {
        plugin.version = version;
      }
    }
  }

  writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf-8");
}

console.log(`Synced plugin version to ${version}`);
