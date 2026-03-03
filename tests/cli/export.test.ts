import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exportSessionToGitMock = vi.fn(() => ({
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  outputDir: ".governance",
  filesWritten: [".governance/sessions/01ARZ3NDEKTSV4RRFFQ69G5FAV/session.json"],
  eventCount: 10,
  agentCount: 2,
  violationCount: 1,
}));

const connectMock = vi.fn();
const closeMock = vi.fn();

vi.mock("../../src/export/git.js", () => ({
  exportSessionToGit: (...args: unknown[]) => exportSessionToGitMock(...args),
}));

vi.mock("../../src/store/db.js", () => ({
  Db: class {
    connect(): void {
      connectMock();
    }
    close(): void {
      closeMock();
    }
  },
}));

describe("export command", () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    exportSessionToGitMock.mockClear();
    connectMock.mockClear();
    closeMock.mockClear();

    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-export-cli-"));
    mkdirSync(path.join(projectRoot, ".khoregos"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".khoregos", "k6s.db"), "");
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("exports in git format and prints human-readable summary", async () => {
    const { registerExportCommand } = await import("../../src/cli/export.js");
    const program = new Command();
    registerExportCommand(program);

    await program.parseAsync(
      ["export", "--format", "git", "--session", "latest", "--output", ".governance"],
      { from: "user" },
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(exportSessionToGitMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Exported session"));
  });

  it("prints json output when --json is set", async () => {
    const { registerExportCommand } = await import("../../src/cli/export.js");
    const program = new Command();
    registerExportCommand(program);

    await program.parseAsync(
      ["export", "--format", "git", "--output", ".governance", "--json"],
      { from: "user" },
    );

    const firstCall = logSpy.mock.calls[0]?.[0];
    expect(typeof firstCall).toBe("string");
    const parsed = JSON.parse(firstCall as string) as { session_id: string; output_dir: string };
    expect(parsed.session_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(parsed.output_dir).toBe(".governance");
  });

  it("fails when unsupported format is requested", async () => {
    const { registerExportCommand } = await import("../../src/cli/export.js");
    const program = new Command();
    registerExportCommand(program);

    await expect(
      program.parseAsync(
        ["export", "--format", "json", "--output", ".governance"],
        { from: "user" },
      ),
    ).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported export format"),
    );
  });
});
