/**
 * Token usage and cost CLI commands.
 */

import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { Db } from "../store/db.js";
import { StateManager } from "../engine/state.js";
import { withDb, resolveSessionId } from "./shared.js";
import { output, resolveJsonOption } from "./output.js";

export function registerCostCommands(program: Command): void {
  const cost = program
    .command("cost")
    .description("Token usage and cost tracking");

  cost
    .command("show")
    .description("Show token usage and estimated costs")
    .option("--session <id>", "Session ID or 'latest'", "latest")
    .option("--by-agent", "Group by agent")
    .option("--by-model", "Group by model")
    .option("--json", "Output in JSON format")
    .action(
      (
        opts: {
          session: string;
          byAgent?: boolean;
          byModel?: boolean;
          json?: boolean;
        },
        command: Command,
      ) => {
        const json = resolveJsonOption(opts, command);
        const projectRoot = process.cwd();
        withDb(projectRoot, (db: Db) => {
          const sm = new StateManager(db, projectRoot);
          const sessionId = resolveSessionId(sm, opts.session);
          if (!sessionId) {
            if (json) {
              output({ error: "No sessions found", records: [] }, { json: true });
            } else {
              console.log(chalk.yellow("No sessions found."));
            }
            return;
          }

          if (opts.byAgent) {
            showByAgent(db, sessionId, json);
          } else if (opts.byModel) {
            showByModel(db, sessionId, json);
          } else {
            showSummary(db, sm, sessionId, json);
          }
        });
      },
    );
}

function showSummary(db: Db, sm: StateManager, sessionId: string, json: boolean): void {
  const session = sm.getSession(sessionId);
  const rows = db.fetchAll(
    `SELECT
       COUNT(*) as count,
       COALESCE(SUM(input_tokens), 0) as total_input,
       COALESCE(SUM(output_tokens), 0) as total_output,
       COALESCE(SUM(cache_creation_input_tokens), 0) as total_cache_creation,
       COALESCE(SUM(cache_read_input_tokens), 0) as total_cache_read,
       COALESCE(SUM(estimated_cost_usd), 0) as total_cost
     FROM cost_records
     WHERE session_id = ?`,
    [sessionId],
  );
  const row = rows[0] ?? {};
  const data = {
    session_id: sessionId,
    objective: session?.objective ?? null,
    api_calls: Number(row.count ?? 0),
    input_tokens: Number(row.total_input ?? 0),
    output_tokens: Number(row.total_output ?? 0),
    cache_creation_input_tokens: Number(row.total_cache_creation ?? 0),
    cache_read_input_tokens: Number(row.total_cache_read ?? 0),
    estimated_cost_usd: Number(row.total_cost ?? 0),
  };

  if (json) {
    output(data, { json: true });
    return;
  }

  console.log(chalk.bold("Session: ") + sessionId);
  if (session?.objective) {
    console.log(chalk.bold("Objective: ") + session.objective);
  }
  console.log();

  const table = new Table({
    head: ["Metric", "Value"],
    style: { head: ["cyan"] },
  });
  table.push(
    ["API calls", data.api_calls.toLocaleString()],
    ["Input tokens", data.input_tokens.toLocaleString()],
    ["Output tokens", data.output_tokens.toLocaleString()],
    ["Cache creation tokens", data.cache_creation_input_tokens.toLocaleString()],
    ["Cache read tokens", data.cache_read_input_tokens.toLocaleString()],
    ["Estimated cost", `$${data.estimated_cost_usd.toFixed(4)}`],
  );
  console.log(table.toString());
}

function showByAgent(db: Db, sessionId: string, json: boolean): void {
  const rows = db.fetchAll(
    `SELECT
       a.name as agent_name,
       COUNT(*) as count,
       COALESCE(SUM(c.input_tokens), 0) as total_input,
       COALESCE(SUM(c.output_tokens), 0) as total_output,
       COALESCE(SUM(c.estimated_cost_usd), 0) as total_cost
     FROM cost_records c
     JOIN agents a ON c.agent_id = a.id
     WHERE c.session_id = ?
     GROUP BY c.agent_id
     ORDER BY total_cost DESC`,
    [sessionId],
  );

  if (json) {
    output(
      rows.map((r) => ({
        agent: r.agent_name,
        api_calls: Number(r.count),
        input_tokens: Number(r.total_input),
        output_tokens: Number(r.total_output),
        estimated_cost_usd: Number(r.total_cost),
      })),
      { json: true },
    );
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.yellow("No cost records found for this session."));
    return;
  }

  const table = new Table({
    head: ["Agent", "API Calls", "Input Tokens", "Output Tokens", "Cost"],
    style: { head: ["cyan"] },
  });
  for (const r of rows) {
    table.push([
      String(r.agent_name),
      Number(r.count).toLocaleString(),
      Number(r.total_input).toLocaleString(),
      Number(r.total_output).toLocaleString(),
      `$${Number(r.total_cost).toFixed(4)}`,
    ]);
  }
  console.log(table.toString());
}

function showByModel(db: Db, sessionId: string, json: boolean): void {
  const rows = db.fetchAll(
    `SELECT
       model,
       COUNT(*) as count,
       COALESCE(SUM(input_tokens), 0) as total_input,
       COALESCE(SUM(output_tokens), 0) as total_output,
       COALESCE(SUM(estimated_cost_usd), 0) as total_cost
     FROM cost_records
     WHERE session_id = ?
     GROUP BY model
     ORDER BY total_cost DESC`,
    [sessionId],
  );

  if (json) {
    output(
      rows.map((r) => ({
        model: r.model,
        api_calls: Number(r.count),
        input_tokens: Number(r.total_input),
        output_tokens: Number(r.total_output),
        estimated_cost_usd: Number(r.total_cost),
      })),
      { json: true },
    );
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.yellow("No cost records found for this session."));
    return;
  }

  const table = new Table({
    head: ["Model", "API Calls", "Input Tokens", "Output Tokens", "Cost"],
    style: { head: ["cyan"] },
  });
  for (const r of rows) {
    table.push([
      String(r.model),
      Number(r.count).toLocaleString(),
      Number(r.total_input).toLocaleString(),
      Number(r.total_output).toLocaleString(),
      `$${Number(r.total_cost).toFixed(4)}`,
    ]);
  }
  console.log(table.toString());
}
