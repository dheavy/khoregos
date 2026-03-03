/**
 * End-to-end coverage for plugin packaging behavior.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const cliEntrypoint = path.join(projectRoot, "bin", "k6s.js");
const tempProjects: string[] = [];

function ensureBuiltCli(): void {
  const distCli = path.join(projectRoot, "dist", "cli", "index.js");
  if (existsSync(distCli)) return;
  execFileSync("npm", ["run", "build"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
}

function makeTempProject(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempProjects.push(dir);
  return dir;
}

function runK6s(cwd: string, args: string[]): string {
  return execFileSync("node", [cliEntrypoint, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

describe("plugin packaging e2e", () => {
  beforeAll(() => {
    ensureBuiltCli();
  });

  afterEach(() => {
    while (tempProjects.length > 0) {
      const dir = tempProjects.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("uses fallback registration when plugin is not detected", () => {
    const appRoot = makeTempProject("k6s-e2e-fallback-");

    const initOutput = runK6s(appRoot, ["init"]);
    expect(initOutput).toContain("Khoregos Claude Code plugin not detected.");
    expect(initOutput).toContain("/plugin marketplace add sibyllai/khoregos");
    expect(initOutput).toContain("/plugin install khoregos@sibyllai");

    const startOutput = runK6s(appRoot, ["team", "start", "fallback e2e objective"]);
    expect(startOutput).toContain("MCP server and hooks registered");

    const settings = readJson(path.join(appRoot, ".claude", "settings.json"));
    const mcpServers = settings.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServers.khoregos?.command).toContain("k6s.js");

    const hooks = settings.hooks as Record<string, unknown>;
    const postToolUse = hooks.PostToolUse as Array<Record<string, unknown>>;
    const firstGroup = postToolUse[0] ?? {};
    const firstHook = ((firstGroup.hooks as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
    expect(String(firstHook.command ?? "")).toContain("k6s.js");
    expect(String(firstHook.command ?? "")).not.toContain("k6s hook post-tool-use");

    runK6s(appRoot, ["team", "stop"]);

    const settingsAfterStop = readJson(path.join(appRoot, ".claude", "settings.json"));
    expect(settingsAfterStop).toEqual({ mcpServers: {} });
    expect(readJson(path.join(appRoot, ".mcp.json"))).toEqual({ mcpServers: {} });
    expect(readFileSync(path.join(appRoot, ".claude", "CLAUDE.md"), "utf-8")).not.toContain("Khoregos Governance");
  });

  it("skips registration and cleanup when plugin-style settings are present", () => {
    const appRoot = makeTempProject("k6s-e2e-plugin-managed-");
    const claudeDir = path.join(appRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          mcpServers: {
            khoregos: {
              command: "k6s",
              args: ["mcp", "serve", "--project-root", "."],
            },
          },
          hooks: {
            PostToolUse: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "k6s hook post-tool-use", timeout: 10 }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const initOutput = runK6s(appRoot, ["init", "--force"]);
    expect(initOutput).toContain("Khoregos Claude Code plugin detected");

    const startOutput = runK6s(appRoot, ["team", "start", "plugin managed e2e objective"]);
    expect(startOutput).toContain("Plugin-managed hooks/MCP detected");

    const settingsAfterStart = readJson(path.join(appRoot, ".claude", "settings.json"));
    const mcpServersAfterStart = settingsAfterStart.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServersAfterStart.khoregos?.command).toBe("k6s");

    runK6s(appRoot, ["team", "stop"]);

    const settingsAfterStop = readJson(path.join(appRoot, ".claude", "settings.json"));
    const mcpServersAfterStop = settingsAfterStop.mcpServers as Record<string, Record<string, unknown>>;
    expect(mcpServersAfterStop.khoregos?.command).toBe("k6s");
    expect(readFileSync(path.join(appRoot, ".claude", "CLAUDE.md"), "utf-8")).not.toContain("Khoregos Governance");
  });
});
