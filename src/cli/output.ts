import type { Command } from "commander";

export interface OutputOptions {
  json?: boolean;
}

export function resolveJsonOption(
  opts: OutputOptions,
  command?: Command,
): boolean {
  if (typeof opts.json === "boolean") {
    return opts.json;
  }
  return Boolean(command?.optsWithGlobals().json);
}

export function output(data: unknown, opts: OutputOptions): void {
  if (!opts.json) {
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function outputError(
  message: string,
  code: string,
  opts: OutputOptions,
): void {
  if (opts.json) {
    process.stderr.write(`${JSON.stringify({ error: message, code })}\n`);
    return;
  }
  console.error(message);
}
