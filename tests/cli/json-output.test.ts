import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { sessionToDbRow, type Session } from "../../src/models/session.js";
import { DaemonState } from "../../src/daemon/manager.js";

describe("CLI JSON output", () => {
  let projectRoot: string;
  let originalCwd: string;
  let db: Db;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-json-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, "k6s.yaml"), "version: '1'\nproject:\n  name: test\n", "utf-8");
    process.chdir(projectRoot);
    db = new Db(path.join(projectRoot, ".khoregos", "k6s.db"));
    db.connect();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    db.close();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("session list --json returns structured sessions payload", async () => {
    const session: Session = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      objective: "json list test",
      state: "completed",
      startedAt: "2026-02-20T10:00:00.000Z",
      endedAt: "2026-02-20T10:05:00.000Z",
      parentSessionId: null,
      configSnapshot: null,
      contextSummary: null,
      metadata: null,
      operator: "davy",
      hostname: "devbox",
      k6sVersion: "0.10.0",
      claudeCodeVersion: null,
      gitBranch: "main",
      gitSha: "abc123",
      gitDirty: false,
      traceId: "trace-1",
    };
    db.insert("sessions", sessionToDbRow(session));
    db.insert("audit_events", {
      id: "evt-1",
      sequence: 1,
      session_id: session.id,
      agent_id: null,
      timestamp: "2026-02-20T10:00:01.000Z",
      event_type: "session_start",
      action: "started",
      details: "{}",
      files_affected: "[]",
      gate_id: null,
      hmac: null,
      severity: "info",
    });

    const { registerSessionCommands } = await import("../../src/cli/session.js");
    const program = new Command();
    registerSessionCommands(program);

    await program.parseAsync(["session", "list", "--json"], { from: "user" });

    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      sessions: Array<{ id: string; event_count: number; operator: string }>;
    };
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].id).toBe(session.id);
    expect(payload.sessions[0].event_count).toBe(1);
    expect(payload.sessions[0].operator).toBe("davy");
  });

  it("team status --json returns null active session when daemon is stopped", async () => {
    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "status", "--json"], { from: "user" });

    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      active_session: null | Record<string, unknown>;
      daemon_running: boolean;
    };
    expect(payload.active_session).toBeNull();
    expect(payload.daemon_running).toBe(false);
  });

  it("team status --json returns active session metadata when daemon is running", async () => {
    const session: Session = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      objective: "json status test",
      state: "active",
      startedAt: "2026-02-20T11:00:00.000Z",
      endedAt: null,
      parentSessionId: null,
      configSnapshot: null,
      contextSummary: null,
      metadata: null,
      operator: "davy",
      hostname: "devbox",
      k6sVersion: "0.10.0",
      claudeCodeVersion: null,
      gitBranch: "feature/json",
      gitSha: "def456",
      gitDirty: false,
      traceId: "trace-2",
    };
    db.insert("sessions", sessionToDbRow(session));
    const daemon = new DaemonState(path.join(projectRoot, ".khoregos"));
    daemon.createState({ session_id: session.id });

    const { registerTeamCommands } = await import("../../src/cli/team.js");
    const program = new Command();
    registerTeamCommands(program);

    await program.parseAsync(["team", "status", "--json"], { from: "user" });

    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      active_session: { session_id: string; objective: string };
      daemon_running: boolean;
    };
    expect(payload.daemon_running).toBe(true);
    expect(payload.active_session.session_id).toBe(session.id);
    expect(payload.active_session.objective).toBe("json status test");
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { registerAuditCommands } from "../../src/cli/audit.js";
import { registerComplianceCommands } from "../../src/cli/compliance.js";
import { registerSessionCommands } from "../../src/cli/session.js";
import { registerTeamCommands } from "../../src/cli/team.js";
import { DaemonState } from "../../src/daemon/manager.js";

function parseJsonOutput(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

describe("CLI JSON output", () => {
  let projectRoot: string;
  let khoregosDir: string;
  let db: Db;
  let originalCwd: string;
  let sessionId: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-json-cli-"));
    khoregosDir = path.join(projectRoot, ".khoregos");
    mkdirSync(khoregosDir, { recursive: true });
    writeFileSync(path.join(projectRoot, "k6s.yaml"), "version: '1'\nproject:\n  name: test\n");
    writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { khoregos: {} } }));
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));

    db = new Db(path.join(khoregosDir, "k6s.db"));
    db.connect();
    process.chdir(projectRoot);

    const sm = new StateManager(db, projectRoot);
    const session = sm.createSession({
      objective: "json output test",
      configSnapshot: JSON.stringify({ boundaries: [] }),
    });
    sm.markSessionActive(session.id);
    sessionId = session.id;
    sm.registerAgent({
      sessionId: session.id,
      name: "frontend-dev",
      role: "teammate",
    });
    generateSigningKey(khoregosDir);
    const key = loadSigningKey(khoregosDir);
    const logger = new AuditLogger(db, session.id, session.traceId, key);
    logger.start();
    logger.log({
      eventType: "session_start",
      action: "session started",
      details: { objective: "json output test" },
    });
    logger.log({
      eventType: "tool_use",
      action: "modified src/auth/login.ts",
      filesAffected: ["src/auth/login.ts"],
      details: { duration_ms: 100 },
      severity: "info",
    });
    logger.stop();

    db.insert("boundary_violations", {
      id: "violation-1",
      session_id: session.id,
      agent_id: null,
      timestamp: new Date().toISOString(),
      file_path: ".env.local",
      violation_type: "forbidden_path",
      enforcement_action: "logged",
      details: "{}",
    });

    const daemon = new DaemonState(khoregosDir);
    daemon.createState({ session_id: session.id });

    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    db.close();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("session list/show/latest emit valid JSON", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerSessionCommands(program);

    await program.parseAsync(["--json", "session", "list"], { from: "user" });
    const listPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      sessions: Array<{ id: string }>;
    };
    expect(Array.isArray(listPayload.sessions)).toBe(true);
    expect(listPayload.sessions[0]?.id).toBe(sessionId);

    await program.parseAsync(["--json", "session", "show", sessionId], { from: "user" });
    const showPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      id: string;
      event_counts: { total: number };
    };
    expect(showPayload.id).toBe(sessionId);
    expect(showPayload.event_counts.total).toBeGreaterThan(0);

    await program.parseAsync(["--json", "session", "latest"], { from: "user" });
    const latestPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      id: string;
    };
    expect(latestPayload.id).toBe(sessionId);
    stdoutSpy.mockRestore();
  });

  it("team status/history emit valid JSON", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerTeamCommands(program);

    await program.parseAsync(["--json", "team", "status"], { from: "user" });
    const statusPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      daemon_running: boolean;
      active_session: { session_id: string };
      hooks_registered: boolean;
    };
    expect(statusPayload.daemon_running).toBe(true);
    expect(statusPayload.active_session.session_id).toBe(sessionId);
    expect(statusPayload.hooks_registered).toBe(false);

    await program.parseAsync(["--json", "team", "history"], { from: "user" });
    const historyPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      sessions: Array<{ id: string }>;
    };
    expect(historyPayload.sessions[0]?.id).toBe(sessionId);
    stdoutSpy.mockRestore();
  });

  it("session show --json emits structured stderr error when session is missing", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerSessionCommands(program);

    await expect(
      program.parseAsync(["--json", "session", "show", "does-not-exist"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");

    const payload = JSON.parse(String(stderrSpy.mock.calls.at(-1)?.[0])) as {
      error: string;
      code: string;
    };
    expect(payload.code).toBe("SESSION_NOT_FOUND");
    expect(payload.error).toContain("Session not found");
    stderrSpy.mockRestore();
  });

  it("audit show and report emit valid JSON", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerAuditCommands(program);

    await program.parseAsync(["--json", "audit", "show", "--session", "latest"], { from: "user" });
    const showPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      events: Array<{ event_type: string }>;
      filters_applied: { limit: number };
    };
    expect(Array.isArray(showPayload.events)).toBe(true);
    expect(showPayload.filters_applied.limit).toBe(50);
    expect(showPayload.events.some((event) => event.event_type === "tool_use")).toBe(true);

    await program.parseAsync(["--json", "audit", "report", "--session", "latest"], { from: "user" });
    const reportPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      session: { id: string };
      chain_integrity: { result: string };
    };
    expect(reportPayload.session.id).toBe(sessionId);
    expect(reportPayload.chain_integrity.result).toMatch(/CHAIN_/);
    stdoutSpy.mockRestore();
  });

  it("audit verify honors --exit-code", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerAuditCommands(program);

    await program.parseAsync(["--json", "audit", "verify", "--session", "latest"], { from: "user" });
    const okPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      result: string;
    };
    expect(okPayload.result).toBe("CHAIN_INTACT");

    db.update("audit_events", { hmac: "broken-hmac" }, "session_id = ? AND sequence = ?", [sessionId, 2]);
    await expect(
      program.parseAsync(["--json", "audit", "verify", "--session", "latest", "--exit-code"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");
    const brokenPayload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      result: string;
      mismatches: number;
    };
    expect(brokenPayload.result).toBe("CHAIN_BROKEN");
    expect(brokenPayload.mismatches).toBeGreaterThan(0);
    stdoutSpy.mockRestore();
  });

  it("compliance checkpoint emits JSON and honors --exit-code", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command().option("--json");
    registerComplianceCommands(program);

    await expect(
      program.parseAsync(["--json", "compliance", "checkpoint", "--session", "latest", "--exit-code"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");
    const payload = parseJsonOutput(stdoutSpy.mock.calls.at(-1)?.[0] as string) as {
      chain_integrity: { result: string };
      boundary_compliance: { unresolved: number };
    };
    expect(payload.chain_integrity.result).toMatch(/CHAIN_/);
    expect(payload.boundary_compliance.unresolved).toBeGreaterThan(0);
    stdoutSpy.mockRestore();
  });
});
