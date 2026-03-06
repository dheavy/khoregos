/**
 * Transcript reader for Claude Code session JSONL files.
 *
 * Reads the transcript incrementally from a byte offset, extracting
 * token usage data from assistant messages. Designed to be called from
 * hook handlers without re-reading the entire file each time.
 */

import { openSync, readSync, fstatSync, closeSync } from "node:fs";

export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  model: string;
}

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  model?: string;
  usage?: TranscriptUsage;
  /** tool_use content block IDs found in this entry. */
  toolUseIds?: string[];
}

/** Maximum bytes to read per incremental pass (2 MB). */
const MAX_READ_BYTES = 2 * 1024 * 1024;

function parseUsage(
  msg: Record<string, unknown>,
): TranscriptUsage | null {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : 0;
  const model = typeof msg.model === "string" ? msg.model : "unknown";
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    model,
  };
}

function extractToolUseIds(msg: Record<string, unknown>): string[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_use" &&
      typeof (block as Record<string, unknown>).id === "string"
    ) {
      ids.push((block as Record<string, unknown>).id as string);
    }
  }
  return ids;
}

/**
 * Read new JSONL entries from `transcriptPath` starting at `byteOffset`.
 * Returns parsed entries and the new byte offset for the next call.
 */
export function readTranscriptIncremental(
  transcriptPath: string,
  byteOffset: number,
): { entries: TranscriptEntry[]; newOffset: number } {
  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return { entries: [], newOffset: byteOffset };
  }

  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize <= byteOffset) {
      return { entries: [], newOffset: byteOffset };
    }

    const readLen = Math.min(fileSize - byteOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, byteOffset);

    const raw = buf.toString("utf-8");
    const lines = raw.split("\n");

    // If the last line is incomplete (no trailing newline), don't process it.
    // We'll pick it up on the next read.
    let consumedBytes = 0;
    const completeLines = raw.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
    for (const line of completeLines) {
      consumedBytes += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
    }

    const entries: TranscriptEntry[] = [];
    for (const line of completeLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const entry: TranscriptEntry = {
          type: (obj.type as string) ?? "unknown",
          uuid: obj.uuid as string | undefined,
          timestamp: obj.timestamp as string | undefined,
        };

        if (obj.type === "assistant" && obj.message) {
          const msg = obj.message as Record<string, unknown>;
          entry.model = msg.model as string | undefined;
          entry.usage = parseUsage(msg) ?? undefined;
          entry.toolUseIds = extractToolUseIds(msg);
        }

        entries.push(entry);
      } catch {
        // Skip malformed lines.
      }
    }

    return { entries, newOffset: byteOffset + consumedBytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Find the usage data for a specific tool_use_id by scanning entries.
 * Returns the usage from the assistant message that contained the tool call.
 */
export function findUsageForToolUse(
  entries: TranscriptEntry[],
  toolUseId: string,
): TranscriptUsage | null {
  // Scan in reverse — the most recent entry is most likely the match.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.toolUseIds?.includes(toolUseId) && entry.usage) {
      return entry.usage;
    }
  }
  return null;
}
