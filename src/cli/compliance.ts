import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { generateCheckpoint } from "../engine/checkpoint.js";
import { withDb, resolveSessionId } from "./shared.js";
import { StateManager } from "../engine/state.js";
import { AuditLogger } from "../engine/audit.js";
import { loadSigningKey } from "../engine/signing.js";
import { output, outputError, resolveJsonOption } from "./output.js";

export function registerComplianceCommands(program: Command): void {
  const compliance = program
    .command("compliance")
    .description("Compliance attestation and checkpoint tools");

  compliance
    .command("checkpoint")
    .description("Generate a compliance checkpoint attestation")
    .option("-s, --session <id>", "Session ID or 'latest'", "latest")
    .option("-o, --output <file>", "Write attestation to file (stdout if omitted)")
    .option("--json", "Output in JSON format")
    .option("--exit-code", "Exit with status 1 on compliance failure")
    .action((opts: { session: string; output?: string; json?: boolean; exitCode?: boolean }, command: Command) => {
      const json = resolveJsonOption(opts, command);
      const projectRoot = process.cwd();
      if (!existsSync(path.join(projectRoot, ".khoregos", "k6s.db"))) {
        if (json) {
          outputError("No audit data found.", "NO_AUDIT_DATA", { json: true });
          process.exit(1);
        }
        console.log(chalk.yellow("No audit data found."));
        return;
      }

      const result = withDb(projectRoot, (db) => {
        const sm = new StateManager(db, projectRoot);
        const sessionId = resolveSessionId(sm, opts.session);
        if (!sessionId) return null;
        const checkpoint = generateCheckpoint(db, sessionId, projectRoot);

        const key = loadSigningKey(path.join(projectRoot, ".khoregos"));
        const session = sm.getSession(sessionId);
        const logger = new AuditLogger(db, sessionId, session?.traceId, key);
        logger.start();
        logger.log({
          eventType: "system",
          action: `compliance checkpoint: chain ${checkpoint.chainIntegrity.valid ? "valid" : "invalid"}, ${checkpoint.violations.total} violations, ${checkpoint.gateEvents.total} gate events`,
          details: {
            chain_valid: checkpoint.chainIntegrity.valid,
            events_checked: checkpoint.chainIntegrity.eventsChecked,
            violations_total: checkpoint.violations.total,
            gate_events_total: checkpoint.gateEvents.total,
          },
          severity: "info",
        });
        logger.stop();
        return checkpoint;
      });

      if (!result) {
        if (json) {
          outputError("No session found.", "SESSION_NOT_FOUND", { json: true });
          process.exit(1);
        }
        console.log(chalk.yellow("No session found."));
        return;
      }

      const compliant = result.chainIntegrity.valid && result.violations.unresolved === 0;
      if (json) {
        const payload = {
          session_id: result.sessionId,
          timestamp: result.timestamp,
          chain_integrity: {
            result: result.chainIntegrity.valid ? "CHAIN_INTACT" : "CHAIN_BROKEN",
            events_checked: result.chainIntegrity.eventsChecked,
            errors: result.chainIntegrity.errors,
          },
          boundary_compliance: {
            total_violations: result.violations.total,
            reverted: result.violations.reverted,
            unresolved: result.violations.unresolved,
          },
          gate_events: {
            total: result.gateEvents.total,
            event_types: result.gateEvents.eventTypes,
          },
          session_summary: {
            agents: result.agentCount,
            total_events: result.eventCount,
            duration_seconds: result.durationSeconds,
          },
          attestation: result.attestation
            .split("\n")
            .find((line) => line.startsWith("This checkpoint attests"))
            ?? `Compliance checkpoint generated at ${result.timestamp} for session ${result.sessionId}.`,
        };
        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(payload, null, 2));
          console.log(chalk.green("✓") + ` Wrote compliance checkpoint to ${opts.output}`);
        } else {
          output(payload, { json: true });
        }
      } else if (opts.output) {
        writeFileSync(opts.output, result.attestation);
        console.log(chalk.green("✓") + ` Wrote compliance checkpoint to ${opts.output}`);
      } else {
        console.log(result.attestation);
      }

      if (opts.exitCode && !compliant) {
        process.exit(1);
      }
    });
}
