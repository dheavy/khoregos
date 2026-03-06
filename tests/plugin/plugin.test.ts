/**
 * Validation tests for the Claude Code plugin package layout.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");

function readJson(relativePath: string): Record<string, unknown> {
  const fullPath = path.join(projectRoot, relativePath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
}

describe("plugin package structure", () => {
  it("contains required plugin assets", () => {
    const requiredFiles = [
      "plugin/.claude-plugin/plugin.json",
      "plugin/hooks/hooks.json",
      "plugin/.mcp.json",
      "plugin/skills/governance/SKILL.md",
      "plugin/commands/k6s-start.md",
      "plugin/commands/k6s-status.md",
      "plugin/commands/k6s-audit.md",
      "plugin/commands/k6s-stop.md",
      "plugin/README.md",
      ".claude-plugin/marketplace.json",
    ];

    for (const file of requiredFiles) {
      expect(existsSync(path.join(projectRoot, file))).toBe(true);
    }
  });

  it("declares khoregos plugin metadata and marketplace source", () => {
    const pkg = readJson("package.json");
    const plugin = readJson("plugin/.claude-plugin/plugin.json");
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;

    expect(plugin.name).toBe("khoregos");
    expect(plugin.version).toBe(pkg.version);
    expect(Array.isArray(plugin.keywords)).toBe(true);

    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins[0]?.name).toBe("khoregos");
    expect(plugins[0]?.source).toBe("plugin");
    expect(plugins[0]?.version).toBe(pkg.version);
  });

  it("uses k6s command wiring for hooks and MCP", () => {
    const hooks = readJson("plugin/hooks/hooks.json");
    const mcp = readJson("plugin/.mcp.json");
    const hookEntries = hooks.hooks as Array<Record<string, unknown>>;
    const mcpServers = mcp.mcpServers as Record<string, Record<string, unknown>>;

    expect(Array.isArray(hookEntries)).toBe(true);
    expect(hookEntries.length).toBe(4);
    expect(hookEntries.every((entry) => String(entry.command ?? "").startsWith("k6s "))).toBe(true);
    expect(mcpServers.khoregos?.command).toBe("k6s");
  });
});
