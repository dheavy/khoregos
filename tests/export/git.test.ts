import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { sessionToDbRow } from "../../src/models/session.js";
import { generateSigningKey, loadSigningKey } from "../../src/engine/signing.js";
import { exportSessionToGit } from "../../src/export/git.js";

describe("exportSessionToGit", () => {
  let projectRoot: string;
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-export-git-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    dbPath = path.join(projectRoot, ".khoregos", "k6s.db");
    db = new Db(dbPath);
    db.connect();
    generateSigningKey(path.join(projectRoot, ".khoregos"));
  });

  afterEach(() => {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function seedSession(sessionId: string, startedAt: string): void {
    db.insert("sessions", sessionToDbRow({
      id: sessionId,
      objective: "implement export flow",
      state: "completed",
      startedAt,
      endedAt: "2026-02-20T11:00:00.000Z",
      parentSessionId: null,
      configSnapshot: JSON.stringify({
        project: { name: "demo" },
        observability: {
          webhooks: [{ url: "https://example.com/hook", secret: "[REDACTED]" }],
        },
      }),
      contextSummary: null,
      metadata: null,
      operator: "davy",
      hostname: "devbox",
      k6sVersion: "0.9.0",
      claudeCodeVersion: null,
      gitBranch: "feature/export",
      gitSha: "abc123",
      gitDirty: false,
      traceId: "trace-123",
    }));
  }

  it("writes full governance export files for latest session", () => {
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    seedSession(sessionId, "2026-02-20T10:00:00.000Z");

    const sm = new StateManager(db, projectRoot);
    const agent = sm.registerAgent({
      sessionId,
      name: "frontend-dev",
      role: "teammate",
    });
    sm.saveContext({
      sessionId,
      key: "auth-strategy",
      value: "PKCE.",
      agentId: agent.id,
    });
    db.insert("boundary_violations", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      session_id: sessionId,
      agent_id: agent.id,
      timestamp: "2026-02-20T10:15:00.000Z",
      file_path: ".env.local",
      violation_type: "forbidden_path",
      enforcement_action: "logged",
      details: "Path matches forbidden pattern.",
    });

    const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
    const logger = new AuditLogger(db, sessionId, "trace-123", signingKey);
    logger.start();
    logger.log({ eventType: "session_start", action: "session started" });
    logger.log({
      eventType: "tool_use",
      action: "created auth config",
      agentId: agent.id,
      filesAffected: ["src/auth.ts"],
    });
    logger.stop();

    const result = exportSessionToGit(db, {
      sessionId: "latest",
      outputDir: ".governance",
      projectRoot,
    });

    expect(result.sessionId).toBe(sessionId);
    expect(result.eventCount).toBe(2);
    expect(result.agentCount).toBe(1);
    expect(result.violationCount).toBe(1);

    const sessionDir = path.join(projectRoot, ".governance", "sessions", sessionId);
    const expectedFiles = [
      "session.json",
      "audit-trail.json",
      "agents.json",
      "violations.json",
      "context.json",
      "config-snapshot.yaml",
      "report.md",
    ];
    for (const fileName of expectedFiles) {
      expect(existsSync(path.join(sessionDir, fileName))).toBe(true);
    }

    const sessionJson = JSON.parse(
      readFileSync(path.join(sessionDir, "session.json"), "utf-8"),
    ) as { chain_integrity: string; event_count: number; agent_count: number; violation_count: number };
    expect(sessionJson.chain_integrity).toBe("CHAIN_INTACT");
    expect(sessionJson.event_count).toBe(2);
    expect(sessionJson.agent_count).toBe(1);
    expect(sessionJson.violation_count).toBe(1);

    const readme = readFileSync(path.join(projectRoot, ".governance", "README.md"), "utf-8");
    expect(readme).toContain(`[${sessionId}](sessions/${sessionId}/report.md)`);

    const yaml = readFileSync(path.join(sessionDir, "config-snapshot.yaml"), "utf-8");
    expect(yaml).toContain("[REDACTED]");
    expect(yaml).not.toContain("super-secret-token");
  });

  it("updates README without duplicating session rows", () => {
    const firstSession = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const secondSession = "01ARZ3NDEKTSV4RRFFQ69G5FAC";
    seedSession(firstSession, "2026-02-20T09:00:00.000Z");
    seedSession(secondSession, "2026-02-20T10:00:00.000Z");

    const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
    const loggerA = new AuditLogger(db, firstSession, null, signingKey);
    loggerA.start();
    loggerA.log({ eventType: "session_start", action: "start A" });
    loggerA.stop();

    const loggerB = new AuditLogger(db, secondSession, null, signingKey);
    loggerB.start();
    loggerB.log({ eventType: "session_start", action: "start B" });
    loggerB.stop();

    exportSessionToGit(db, {
      sessionId: firstSession,
      outputDir: ".governance",
      projectRoot,
    });
    exportSessionToGit(db, {
      sessionId: firstSession,
      outputDir: ".governance",
      projectRoot,
    });
    exportSessionToGit(db, {
      sessionId: secondSession,
      outputDir: ".governance",
      projectRoot,
    });

    const readmePath = path.join(projectRoot, ".governance", "README.md");
    const readme = readFileSync(readmePath, "utf-8");
    const firstMatches = (
      readme.match(
        new RegExp(`\\[${firstSession}\\]\\(sessions/${firstSession}/report\\.md\\)`, "g"),
      ) ?? []
    ).length;
    const secondMatches = (
      readme.match(
        new RegExp(`\\[${secondSession}\\]\\(sessions/${secondSession}/report\\.md\\)`, "g"),
      ) ?? []
    ).length;

    expect(firstMatches).toBe(1);
    expect(secondMatches).toBe(1);
  });

  it("throws when no session is available", () => {
    writeFileSync(path.join(projectRoot, ".governance-placeholder"), "");
    expect(() =>
      exportSessionToGit(db, {
        sessionId: "latest",
        outputDir: ".governance",
        projectRoot,
      })
    ).toThrow("No session found.");
  });
});
