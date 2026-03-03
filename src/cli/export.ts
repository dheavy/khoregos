import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { Db } from "../store/db.js";
import { exportSessionToGit } from "../export/git.js";

interface ExportCommandOptions {
  format: string;
  session: string;
  output: string;
  json?: boolean;
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export governance state for sharing and archival")
    .requiredOption("--format <fmt>", "Export format (git)")
    .option("--session <id>", "Session ID or 'latest'", "latest")
    .requiredOption("--output <dir>", "Output directory")
    .option("--json", "Output metadata as JSON")
    .action((opts: ExportCommandOptions) => {
      if (opts.format !== "git") {
        console.error(chalk.red(`Unsupported export format: ${opts.format}.`));
        process.exit(1);
      }

      const projectRoot = process.cwd();
      const dbPath = path.join(projectRoot, ".khoregos", "k6s.db");
      if (!existsSync(dbPath)) {
        console.error(chalk.red("No audit data found."));
        process.exit(1);
      }

      const db = new Db(dbPath);
      db.connect();
      try {
        const result = exportSessionToGit(db, {
          sessionId: opts.session,
          outputDir: opts.output,
          projectRoot,
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                session_id: result.sessionId,
                output_dir: result.outputDir,
                files_written: result.filesWritten,
                event_count: result.eventCount,
                agent_count: result.agentCount,
                violation_count: result.violationCount,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(chalk.green("✓") + ` Exported session ${result.sessionId}.`);
        console.log(`${chalk.bold("Output directory:")} ${result.outputDir}`);
        console.log(
          `${chalk.bold("Counts:")} ${result.eventCount} events, ${result.agentCount} agents, ${result.violationCount} violations`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Export failed.";
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      } finally {
        db.close();
      }
    });
}
