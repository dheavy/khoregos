/**
 * Daemon lifecycle management for the K6s governance engine.
 *
 * The daemon is fire-and-forget: `k6s team start` sets up governance and exits.
 * Session liveness is tracked by the presence of .khoregos/daemon.state.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

function resolveK6sExecutable(): string {
  const argv1 = process.argv[1];
  if (argv1) {
    const abs = path.resolve(argv1);
    if (existsSync(abs)) return abs;
  }
  throw new Error("Unable to resolve absolute path for k6s executable.");
}

function shellQuote(cmd: string): string {
  // JSON string quoting is safe for shell command entries.
  return JSON.stringify(cmd);
}

/** Write a file and set owner-only permissions (0o600). */
function writeSecureFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o600 });
  // chmod explicitly in case the file already existed with wider perms.
  chmodSync(filePath, 0o600);
}

export class DaemonState {
  readonly stateFile: string;

  constructor(private khoregoDir: string) {
    this.stateFile = path.join(khoregoDir, "daemon.state");
  }

  isRunning(): boolean {
    return existsSync(this.stateFile);
  }

  /**
   * Atomically create the state file using O_EXCL. Returns true if the
   * file was created, false if it already exists (another session is
   * active). Eliminates the TOCTOU race between isRunning() and write.
   */
  createState(state: Record<string, unknown>): boolean {
    mkdirSync(this.khoregoDir, { recursive: true });
    chmodSync(this.khoregoDir, 0o700);
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
      const fd = openSync(this.stateFile, flags, 0o600);
      try {
        writeSync(fd, JSON.stringify(state, null, 2));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  /** Overwrite an existing state file (use after createState). */
  writeState(state: Record<string, unknown>): void {
    mkdirSync(this.khoregoDir, { recursive: true });
    chmodSync(this.khoregoDir, 0o700);
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    chmodSync(this.stateFile, 0o600);
  }

  readState(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf-8"));
    } catch {
      return {};
    }
  }

  removeState(): void {
    try {
      unlinkSync(this.stateFile);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

type SessionGovernanceBoundary = {
  pattern?: string;
  allowed_paths?: string[];
  forbidden_paths?: string[];
  enforcement?: string;
};

type SessionGovernanceInput = {
  sessionId: string;
  objective: string;
  traceId: string;
  signingEnabled: boolean;
  boundaries: SessionGovernanceBoundary[];
  resumeContext?: string;
};

function formatBoundaries(boundaries: SessionGovernanceBoundary[]): string {
  if (boundaries.length === 0) {
    return "- No explicit boundaries configured.\n";
  }

  return boundaries
    .map((boundary, index) => {
      const allowed = (boundary.allowed_paths ?? []).join(", ") || "(none)";
      const forbidden = (boundary.forbidden_paths ?? []).join(", ") || "(none)";
      const enforcement = boundary.enforcement ?? "warn";
      const pattern = boundary.pattern ?? "*";
      return [
        `- Rule ${index + 1} (${pattern}):`,
        `  - Allowed: ${allowed}`,
        `  - Forbidden: ${forbidden}`,
        `  - Enforcement: ${enforcement}`,
      ].join("\n");
    })
    .join("\n");
}

export function injectClaudeMdGovernance(
  projectRoot: string,
  input: SessionGovernanceInput,
): void {
  const claudeDir = path.join(projectRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const claudeMd = path.join(claudeDir, "CLAUDE.md");
  const contextBlock = input.resumeContext
    ? `\n### Previous session context\n\n${input.resumeContext}\n`
    : "";
  const signingStatus = input.signingEnabled ? "enabled" : "disabled";
  const boundariesSection = formatBoundaries(input.boundaries);

  const governanceSection = `

## Khoregos Governance (Auto-generated — do not edit)

Session metadata:

- Workspace governance ID: ${input.sessionId}
- Objective: ${input.objective}
- Trace ID: ${input.traceId}
- Audit signing: ${signingStatus}

### Active boundary rules

${boundariesSection}${contextBlock}
This section contains only session-specific governance context. Generic governance behavior is provided by the Khoregos Claude Code plugin skill.

<!-- K6S_GOVERNANCE_END -->
`;

  let existing = "";
  if (existsSync(claudeMd)) {
    existing = readFileSync(claudeMd, "utf-8");
  }

  // Remove existing governance section
  if (existing.includes("## Khoregos Governance")) {
    const start = existing.indexOf("## Khoregos Governance");
    const end = existing.indexOf("<!-- K6S_GOVERNANCE_END -->");
    if (end !== -1) {
      const endFull = end + "<!-- K6S_GOVERNANCE_END -->".length;
      existing = existing.slice(0, start) + existing.slice(endFull);
    }
  }

  writeSecureFile(claudeMd, existing.trimEnd() + governanceSection);
}

export function removeClaudeMdGovernance(projectRoot: string): void {
  const claudeMd = path.join(projectRoot, ".claude", "CLAUDE.md");
  if (!existsSync(claudeMd)) return;

  const content = readFileSync(claudeMd, "utf-8");
  if (!content.includes("## Khoregos Governance")) return;

  const start = content.indexOf("## Khoregos Governance");
  const end = content.indexOf("<!-- K6S_GOVERNANCE_END -->");
  if (end !== -1) {
    const endFull = end + "<!-- K6S_GOVERNANCE_END -->".length;
    const newContent = content.slice(0, start).trimEnd() + content.slice(endFull);
    writeSecureFile(claudeMd, newContent);
  }
}

function commandUsesPluginK6s(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim();
  return normalized.startsWith("k6s ");
}

/**
 * Detect whether the Claude Code plugin appears installed for this project.
 * Conservative behavior: return false on parse errors or uncertain states.
 */
export function isPluginInstalled(projectRoot: string): boolean {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
    const khoregosServer = mcpServers?.khoregos as Record<string, unknown> | undefined;
    if (khoregosServer?.command === "k6s") {
      return true;
    }

    const hooksRecord = settings.hooks as Record<string, unknown> | undefined;
    const postToolUse = hooksRecord?.PostToolUse;
    if (Array.isArray(postToolUse)) {
      for (const group of postToolUse) {
        const nestedHooks = (group as Record<string, unknown>).hooks;
        if (!Array.isArray(nestedHooks)) continue;
        for (const hook of nestedHooks) {
          const cmd = (hook as Record<string, unknown>).command;
          if (commandUsesPluginK6s(cmd)) {
            return true;
          }
        }
      }
    }

    const hooksArray = settings.hooks;
    if (Array.isArray(hooksArray)) {
      for (const hook of hooksArray) {
        const cmd = (hook as Record<string, unknown>).command;
        if (commandUsesPluginK6s(cmd)) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

function loadClaudeSettings(
  projectRoot: string,
): [filePath: string, settings: Record<string, unknown>] {
  const settingsDir = path.join(projectRoot, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const filePath = path.join(settingsDir, "settings.json");

  if (existsSync(filePath)) {
    try {
      return [filePath, JSON.parse(readFileSync(filePath, "utf-8"))];
    } catch {
      // corrupt file
    }
  }
  return [filePath, {}];
}

function loadProjectMcpConfig(
  projectRoot: string,
): [filePath: string, settings: Record<string, unknown>] {
  const filePath = path.join(projectRoot, ".mcp.json");
  if (existsSync(filePath)) {
    try {
      return [filePath, JSON.parse(readFileSync(filePath, "utf-8"))];
    } catch {
      // Ignore corrupt file and rewrite it.
    }
  }
  return [filePath, {}];
}

export function registerMcpServer(projectRoot: string): void {
  const [filePath, settings] = loadClaudeSettings(projectRoot);
  const k6sExec = resolveK6sExecutable();
  if (!settings.mcpServers) settings.mcpServers = {};
  (settings.mcpServers as Record<string, unknown>).khoregos = {
    command: k6sExec,
    args: ["mcp", "serve", "--project-root", projectRoot],
  };
  writeSecureFile(filePath, JSON.stringify(settings, null, 2));

  // Also register in .mcp.json for modern Claude versions.
  const [mcpPath, mcpSettings] = loadProjectMcpConfig(projectRoot);
  if (!mcpSettings.mcpServers) mcpSettings.mcpServers = {};
  (mcpSettings.mcpServers as Record<string, unknown>).khoregos = {
    command: k6sExec,
    args: ["mcp", "serve", "--project-root", projectRoot],
  };
  writeSecureFile(mcpPath, JSON.stringify(mcpSettings, null, 2));
}

export function unregisterMcpServer(projectRoot: string): void {
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsFile)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    const servers = settings.mcpServers as Record<string, unknown> | undefined;
    if (servers?.khoregos) {
      delete servers.khoregos;
      writeSecureFile(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // ignore corrupt file
  }

  const mcpFile = path.join(projectRoot, ".mcp.json");
  if (!existsSync(mcpFile)) return;

  try {
    const settings = JSON.parse(readFileSync(mcpFile, "utf-8"));
    const servers = settings.mcpServers as Record<string, unknown> | undefined;
    if (servers?.khoregos) {
      delete servers.khoregos;
      writeSecureFile(mcpFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // ignore corrupt file
  }
}

export function registerHooks(projectRoot: string): void {
  const [filePath, settings] = loadClaudeSettings(projectRoot);
  const k6sExec = resolveK6sExecutable();
  const hookPostToolUse = `${shellQuote(k6sExec)} hook post-tool-use`;
  const hookSubagentStart = `${shellQuote(k6sExec)} hook subagent-start`;
  const hookSubagentStop = `${shellQuote(k6sExec)} hook subagent-stop`;
  const hookSessionStop = `${shellQuote(k6sExec)} hook session-stop`;

  settings.hooks = {
    PostToolUse: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: hookPostToolUse, timeout: 10 },
        ],
      },
    ],
    SubagentStart: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: hookSubagentStart, timeout: 10 },
        ],
      },
    ],
    SubagentStop: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: hookSubagentStop, timeout: 10 },
        ],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [
          { type: "command", command: hookSessionStop, timeout: 10 },
        ],
      },
    ],
  };

  writeSecureFile(filePath, JSON.stringify(settings, null, 2));
}

export function unregisterHooks(projectRoot: string): void {
  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  if (!existsSync(settingsFile)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    if (settings.hooks) {
      delete settings.hooks;
      writeSecureFile(settingsFile, JSON.stringify(settings, null, 2));
    }
  } catch {
    // ignore corrupt file
  }
}
