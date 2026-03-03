/**
 * CLI tests for compliance checkpoint command wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const generateCheckpointMock = vi.fn(() => ({
  timestamp: "2026-02-20T12:00:00.000Z",
  sessionId: "session-123",
  chainIntegrity: { valid: true, eventsChecked: 3, errors: 0 },
  violations: { total: 1, reverted: 1, unresolved: 0 },
  gateEvents: { total: 2, eventTypes: ["sensitive_needs_review"] },
  agentCount: 1,
  eventCount: 3,
  durationSeconds: 300,
  attestation: "# Khoregos compliance checkpoint\n",
}));
const withDbMock = vi.fn((_projectRoot: string, fn: (db: object) => unknown) => fn({}));
const resolveSessionIdMock = vi.fn(() => "session-123");
const auditLogMock = vi.fn();

vi.mock("../../src/engine/checkpoint.js", () => ({
  generateCheckpoint: (...args: unknown[]) => generateCheckpointMock(...args),
}));

vi.mock("../../src/cli/shared.js", () => ({
  withDb: (...args: unknown[]) => withDbMock(...args),
  resolveSessionId: (...args: unknown[]) => resolveSessionIdMock(...args),
}));

vi.mock("../../src/engine/signing.js", () => ({
  loadSigningKey: vi.fn(() => Buffer.alloc(32, 1)),
}));

vi.mock("../../src/engine/audit.js", () => ({
  AuditLogger: class {
    start(): void {}
    stop(): void {}
    log(...args: unknown[]): void {
      auditLogMock(...args);
    }
  },
}));

vi.mock("../../src/engine/state.js", () => ({
  StateManager: class {
    constructor(_db: unknown, _projectRoot: string) {}
    getSession(_sessionId: string): { traceId: string } {
      return { traceId: "trace-123" };
    }
  },
}));

describe("compliance checkpoint command", () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    generateCheckpointMock.mockClear();
    withDbMock.mockClear();
    resolveSessionIdMock.mockClear();
    auditLogMock.mockClear();

    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-compliance-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".khoregos", "k6s.db"), "");
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("prints attestation to stdout by default", async () => {
    const { registerComplianceCommands } = await import("../../src/cli/compliance.js");
    const program = new Command();
    registerComplianceCommands(program);

    await program.parseAsync(["compliance", "checkpoint", "--session", "latest"], { from: "user" });

    expect(generateCheckpointMock).toHaveBeenCalledWith({}, "session-123", process.cwd());
    expect(logSpy).toHaveBeenCalledWith("# Khoregos compliance checkpoint\n");
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "system",
      }),
    );
  });

  it("writes attestation to file when output is provided", async () => {
    const { registerComplianceCommands } = await import("../../src/cli/compliance.js");
    const program = new Command();
    registerComplianceCommands(program);

    const outputPath = path.join(projectRoot, "checkpoint.md");
    await program.parseAsync(
      ["compliance", "checkpoint", "--session", "latest", "--output", outputPath],
      { from: "user" },
    );

    expect(readFileSync(outputPath, "utf-8")).toBe("# Khoregos compliance checkpoint\n");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Wrote compliance checkpoint to"));
  });

  it("outputs checkpoint JSON when --json is used", async () => {
    const { registerComplianceCommands } = await import("../../src/cli/compliance.js");
    const program = new Command();
    registerComplianceCommands(program);

    await program.parseAsync(
      ["compliance", "checkpoint", "--session", "latest", "--json"],
      { from: "user" },
    );

    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      session_id: string;
      chain_integrity: { result: string };
      boundary_compliance: { unresolved: number };
      gate_events: { total: number };
    };
    expect(payload.session_id).toBe("session-123");
    expect(payload.chain_integrity.result).toBe("CHAIN_INTACT");
    expect(payload.boundary_compliance.unresolved).toBe(0);
    expect(payload.gate_events.total).toBe(2);
  });

  it("returns exit code 1 when unresolved violations exist and --exit-code is set", async () => {
    generateCheckpointMock.mockReturnValueOnce({
      timestamp: "2026-02-20T12:00:00.000Z",
      sessionId: "session-123",
      chainIntegrity: { valid: true, eventsChecked: 3, errors: 0 },
      violations: { total: 1, reverted: 0, unresolved: 1 },
      gateEvents: { total: 2, eventTypes: ["sensitive_needs_review"] },
      agentCount: 1,
      eventCount: 3,
      durationSeconds: 300,
      attestation: "# Khoregos compliance checkpoint\n",
    });
    const { registerComplianceCommands } = await import("../../src/cli/compliance.js");
    const program = new Command();
    registerComplianceCommands(program);

    await expect(
      program.parseAsync(
        ["compliance", "checkpoint", "--session", "latest", "--exit-code"],
        { from: "user" },
      ),
    ).rejects.toThrow("process.exit:1");
  });
});
