import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("audit verify --from-export", () => {
  let projectRoot: string;
  let exportDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    projectRoot = mkdtempSync(path.join(tmpdir(), "k6s-audit-verify-export-"));
    exportDir = path.join(projectRoot, ".governance", "sessions", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    mkdirSync(exportDir, { recursive: true });
    process.chdir(projectRoot);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(originalCwd);
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("outputs JSON for export attestation verification", async () => {
    writeFileSync(
      path.join(exportDir, "session.json"),
      JSON.stringify({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        chain_integrity: "CHAIN_INTACT",
      }),
    );
    writeFileSync(path.join(exportDir, "audit-trail.json"), "[]");

    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(
      ["audit", "verify", "--from-export", exportDir, "--json"],
      { from: "user" },
    );

    const payload = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      source: string;
      session_id: string;
      result: string;
      total_events: number;
      errors: unknown[];
    };
    expect(payload.source).toBe("export");
    expect(payload.session_id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(payload.result).toBe("CHAIN_INTACT");
    expect(payload.total_events).toBe(0);
    expect(payload.errors).toEqual([]);
  });

  it("returns exit code 1 when export attestation is invalid and --exit-code is set", async () => {
    writeFileSync(
      path.join(exportDir, "session.json"),
      JSON.stringify({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        chain_integrity: "CHAIN_BROKEN",
      }),
    );
    writeFileSync(path.join(exportDir, "audit-trail.json"), "[]");

    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await expect(
      program.parseAsync(
        ["audit", "verify", "--from-export", exportDir, "--exit-code"],
        { from: "user" },
      ),
    ).rejects.toThrow("process.exit:1");
  });

  it("outputs strict JSON errors aligned with sqlite schema", async () => {
    const signingKeyPath = path.join(projectRoot, "signing.key");
    writeFileSync(signingKeyPath, "11".repeat(32));
    writeFileSync(
      path.join(exportDir, "session.json"),
      JSON.stringify({
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        chain_integrity: "CHAIN_INTACT",
      }),
    );
    writeFileSync(
      path.join(exportDir, "audit-trail.json"),
      JSON.stringify([
        {
          id: "evt-1",
          sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          sequence: 1,
          timestamp: "2026-02-20T10:00:00.000Z",
          eventType: "session_start",
          action: "session started",
          details: "{}",
          filesAffected: "[]",
          gateId: null,
          hmac: "broken-hmac",
          severity: "info",
        },
      ]),
    );

    const { registerAuditCommands } = await import("../../src/cli/audit.js");
    const program = new Command();
    registerAuditCommands(program);

    await program.parseAsync(
      [
        "audit",
        "verify",
        "--from-export",
        exportDir,
        "--strict",
        "--signing-key",
        signingKeyPath,
        "--json",
      ],
      { from: "user" },
    );

    const payload = JSON.parse(String(stdoutSpy.mock.calls.at(-1)?.[0])) as {
      result: string;
      mismatches: number;
      errors: Array<Record<string, unknown>>;
    };
    expect(payload.result).toBe("CHAIN_BROKEN");
    expect(payload.mismatches).toBeGreaterThan(0);
    expect(payload.errors[0]?.type).toBe("mismatch");
    expect(payload.errors[0]).toHaveProperty("event_id", "evt-1");
    expect(payload.errors[0]).toHaveProperty("expected_hmac");
    expect(payload.errors[0]).toHaveProperty("stored_hmac", "broken-hmac");
    expect(payload.errors[0]).not.toHaveProperty("message");
  });
});
