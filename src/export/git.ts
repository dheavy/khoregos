import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { generateAuditReport } from "../engine/report.js";
import { loadSigningKey, verifyChain, type VerifyResult } from "../engine/signing.js";
import { auditEventFromDbRow, type AuditEvent } from "../models/audit.js";
import { agentFromDbRow, type Agent } from "../models/agent.js";
import { boundaryViolationFromDbRow, contextEntryFromDbRow } from "../models/context.js";
import { sessionDurationSeconds } from "../models/session.js";

export interface GitExportOptions {
  sessionId: string;
  outputDir: string;
  projectRoot: string;
}

export interface GitExportResult {
  sessionId: string;
  outputDir: string;
  filesWritten: string[];
  eventCount: number;
  agentCount: number;
  violationCount: number;
}

type ChainIntegrityState = "CHAIN_INTACT" | "CHAIN_BROKEN" | "CHAIN_UNVERIFIED";

interface SessionExportFile {
  id: string;
  objective: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  parent_session_id: string | null;
  operator: string | null;
  hostname: string | null;
  git_branch: string | null;
  git_sha: string | null;
  git_dirty: boolean;
  trace_id: string | null;
  k6s_version: string | null;
  event_count: number;
  agent_count: number;
  violation_count: number;
  chain_integrity: ChainIntegrityState;
}

interface ReadmeSessionRow {
  sessionId: string;
  objective: string;
  operator: string;
  date: string;
  events: number;
  violations: number;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function toRelativeOutputPath(projectRoot: string, absolutePath: string): string {
  const relative = path.relative(projectRoot, absolutePath);
  return toPosixPath(relative);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function computeChainIntegrity(
  projectRoot: string,
  sessionId: string,
  eventsAscending: AuditEvent[],
): { state: ChainIntegrityState; result: VerifyResult | null } {
  const signingKey = loadSigningKey(path.join(projectRoot, ".khoregos"));
  if (!signingKey) {
    return { state: "CHAIN_UNVERIFIED", result: null };
  }
  const result = verifyChain(signingKey, sessionId, eventsAscending);
  return {
    state: result.valid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
    result,
  };
}

function renderReadmeTemplate(rows: ReadmeSessionRow[]): string {
  const lines: string[] = [
    "# Governance records",
    "",
    "This directory contains exported governance data from Khoregos sessions.",
    "",
    "| Session | Objective | Operator | Date | Events | Violations |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| [${row.sessionId}](sessions/${row.sessionId}/report.md) | ${row.objective} | ${row.operator} | ${row.date} | ${row.events} | ${row.violations} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function parseReadmeSessionIds(existingReadme: string): Set<string> {
  const found = new Set<string>();
  const regex = /\[([A-Z0-9]+)\]\(sessions\/\1\/report\.md\)/g;
  for (const match of existingReadme.matchAll(regex)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return found;
}

function updateReadmeIndex(
  readmePath: string,
  newRow: ReadmeSessionRow,
): void {
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, renderReadmeTemplate([newRow]), "utf-8");
    return;
  }

  const existing = readFileSync(readmePath, "utf-8");
  const existingIds = parseReadmeSessionIds(existing);
  if (existingIds.has(newRow.sessionId)) {
    return;
  }

  const appendLine =
    `| [${newRow.sessionId}](sessions/${newRow.sessionId}/report.md) | ${newRow.objective} | ${newRow.operator} | ${newRow.date} | ${newRow.events} | ${newRow.violations} |`;
  const trimmed = existing.trimEnd();
  const next = `${trimmed}\n${appendLine}\n`;
  writeFileSync(readmePath, next, "utf-8");
}

export function exportSessionToGit(
  db: Db,
  options: GitExportOptions,
): GitExportResult {
  const state = new StateManager(db, options.projectRoot);
  const resolvedSessionId = options.sessionId === "latest"
    ? state.getLatestSession()?.id ?? null
    : options.sessionId;
  if (!resolvedSessionId) {
    throw new Error("No session found.");
  }

  const session = state.getSession(resolvedSessionId);
  if (!session) {
    throw new Error(`Session not found: ${resolvedSessionId}.`);
  }

  const outputDirAbsolute = path.resolve(options.projectRoot, options.outputDir);
  const sessionDir = path.join(outputDirAbsolute, "sessions", session.id);
  mkdirSync(sessionDir, { recursive: true });

  const agents = db
    .fetchAll("SELECT * FROM agents WHERE session_id = ? ORDER BY spawned_at ASC", [session.id])
    .map(agentFromDbRow);
  const agentById = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));

  const auditRows = db.fetchAll(
    "SELECT * FROM audit_events WHERE session_id = ? ORDER BY sequence ASC",
    [session.id],
  );
  const auditEvents = auditRows.map(auditEventFromDbRow);
  const violations = db
    .fetchAll(
      "SELECT * FROM boundary_violations WHERE session_id = ? ORDER BY timestamp ASC",
      [session.id],
    )
    .map(boundaryViolationFromDbRow)
    .map((violation) => ({
      id: violation.id,
      agent_id: violation.agentId,
      agent_name: violation.agentId ? (agentById.get(violation.agentId)?.name ?? "unknown") : "system",
      timestamp: violation.timestamp,
      file_path: violation.filePath,
      violation_type: violation.violationType,
      enforcement_action: violation.enforcementAction,
      details: violation.details,
    }));
  const contextEntries = db
    .fetchAll(
      "SELECT * FROM context_store WHERE session_id = ? ORDER BY key ASC",
      [session.id],
    )
    .map(contextEntryFromDbRow)
    .map((entry) => ({
      key: entry.key,
      value: entry.value,
      agent_id: entry.agentId,
      agent_name: entry.agentId ? (agentById.get(entry.agentId)?.name ?? "unknown") : "system",
      updated_at: entry.updatedAt,
    }));

  const chainIntegrity = computeChainIntegrity(
    options.projectRoot,
    session.id,
    auditEvents,
  );

  const sessionFile: SessionExportFile = {
    id: session.id,
    objective: session.objective,
    state: session.state,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    duration_seconds: sessionDurationSeconds(session),
    parent_session_id: session.parentSessionId,
    operator: session.operator,
    hostname: session.hostname,
    git_branch: session.gitBranch,
    git_sha: session.gitSha,
    git_dirty: session.gitDirty,
    trace_id: session.traceId,
    k6s_version: session.k6sVersion,
    event_count: auditEvents.length,
    agent_count: agents.length,
    violation_count: violations.length,
    chain_integrity: chainIntegrity.state,
  };

  const configSnapshotPath = path.join(sessionDir, "config-snapshot.yaml");
  const configSnapshotParsed = session.configSnapshot ? safeJsonParse(session.configSnapshot) : null;
  const configSnapshotYaml = configSnapshotParsed
    ? YAML.stringify(configSnapshotParsed, { sortMapEntries: false })
    : "null\n";

  const report = generateAuditReport(db, session.id, options.projectRoot, "generic");

  const filesToWrite: Array<{ path: string; content: string }> = [
    {
      path: path.join(sessionDir, "session.json"),
      content: JSON.stringify(sessionFile, null, 2) + "\n",
    },
    {
      path: path.join(sessionDir, "audit-trail.json"),
      content: JSON.stringify(auditEvents, null, 2) + "\n",
    },
    {
      path: path.join(sessionDir, "agents.json"),
      content: JSON.stringify(agents, null, 2) + "\n",
    },
    {
      path: path.join(sessionDir, "violations.json"),
      content: JSON.stringify(violations, null, 2) + "\n",
    },
    {
      path: path.join(sessionDir, "context.json"),
      content: JSON.stringify(contextEntries, null, 2) + "\n",
    },
    {
      path: configSnapshotPath,
      content: configSnapshotYaml,
    },
    {
      path: path.join(sessionDir, "report.md"),
      content: report.endsWith("\n") ? report : `${report}\n`,
    },
  ];

  for (const file of filesToWrite) {
    writeFileSync(file.path, file.content, "utf-8");
  }

  const row: ReadmeSessionRow = {
    sessionId: session.id,
    objective: session.objective,
    operator: session.operator ?? "unknown",
    date: session.startedAt.slice(0, 10),
    events: auditEvents.length,
    violations: violations.length,
  };
  const readmePath = path.join(outputDirAbsolute, "README.md");
  updateReadmeIndex(readmePath, row);

  return {
    sessionId: session.id,
    outputDir: toRelativeOutputPath(options.projectRoot, outputDirAbsolute),
    filesWritten: filesToWrite.map((file) =>
      toRelativeOutputPath(options.projectRoot, file.path)
    ),
    eventCount: auditEvents.length,
    agentCount: agents.length,
    violationCount: violations.length,
  };
}
