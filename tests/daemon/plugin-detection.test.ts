/**
 * Tests for Claude Code plugin installation detection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPluginInstalled } from "../../src/daemon/manager.js";

describe("isPluginInstalled", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-plugin-detect-"));
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns true when khoregos MCP server uses bare k6s command", () => {
    writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          khoregos: {
            command: "k6s",
            args: ["mcp", "serve"],
          },
        },
      }),
      "utf-8",
    );

    expect(isPluginInstalled(projectRoot)).toBe(true);
  });

  it("returns true when PostToolUse hook command is bare k6s", () => {
    writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "k6s hook post-tool-use", timeout: 10 },
              ],
            },
          ],
        },
      }),
      "utf-8",
    );

    expect(isPluginInstalled(projectRoot)).toBe(true);
  });

  it("returns false for absolute executable command wiring", () => {
    writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "\"/usr/local/bin/k6s\" hook post-tool-use", timeout: 10 },
              ],
            },
          ],
        },
        mcpServers: {
          khoregos: {
            command: "/usr/local/bin/k6s",
            args: ["mcp", "serve"],
          },
        },
      }),
      "utf-8",
    );

    expect(isPluginInstalled(projectRoot)).toBe(false);
  });
});
