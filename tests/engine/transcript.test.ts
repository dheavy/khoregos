/**
 * Tests for transcript JSONL reader.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, appendFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readTranscriptIncremental,
  findUsageForToolUse,
} from "../../src/engine/transcript.js";

let tempDir: string;

function transcriptPath(name = "transcript.jsonl"): string {
  return path.join(tempDir, name);
}

function writeTranscript(
  lines: Record<string, unknown>[],
  name = "transcript.jsonl",
): string {
  const fp = transcriptPath(name);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(fp, content);
  return fp;
}

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "k6s-transcript-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true });
});

describe("readTranscriptIncremental", () => {
  it("returns empty for nonexistent file", () => {
    const { entries, newOffset } = readTranscriptIncremental("/nonexistent/path.jsonl", 0);
    expect(entries).toEqual([]);
    expect(newOffset).toBe(0);
  });

  it("parses user and assistant entries", () => {
    const fp = writeTranscript([
      { type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 10 },
        },
      },
    ]);

    const { entries, newOffset } = readTranscriptIncremental(fp, 0);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("user");
    expect(entries[1].type).toBe("assistant");
    expect(entries[1].model).toBe("claude-opus-4-6");
    expect(entries[1].usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 10,
      model: "claude-opus-4-6",
    });
    expect(newOffset).toBeGreaterThan(0);
  });

  it("extracts tool_use IDs from assistant content", () => {
    const fp = writeTranscript([
      {
        type: "assistant",
        uuid: "a2",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "toolu_abc123", name: "Read", input: {} },
            { type: "tool_use", id: "toolu_def456", name: "Write", input: {} },
          ],
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      },
    ]);

    const { entries } = readTranscriptIncremental(fp, 0);
    expect(entries[0].toolUseIds).toEqual(["toolu_abc123", "toolu_def456"]);
  });

  it("reads incrementally from byte offset", () => {
    const line1 = { type: "user", uuid: "u1", message: { role: "user", content: "first" } };
    const line2 = {
      type: "assistant",
      uuid: "a1",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "second" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };

    const fp = writeTranscript([line1, line2], "incremental.jsonl");

    // First read
    const { entries: first, newOffset: offset1 } = readTranscriptIncremental(fp, 0);
    expect(first).toHaveLength(2);

    // Second read from offset — nothing new
    const { entries: second, newOffset: offset2 } = readTranscriptIncremental(fp, offset1);
    expect(second).toHaveLength(0);
    expect(offset2).toBe(offset1);

    // Append a new line and read again
    const line3 = { type: "user", uuid: "u2", message: { role: "user", content: "third" } };
    const appendContent = JSON.stringify(line3) + "\n";
    appendFileSync(fp, appendContent);

    const { entries: third, newOffset: offset3 } = readTranscriptIncremental(fp, offset1);
    expect(third).toHaveLength(1);
    expect(third[0].uuid).toBe("u2");
    expect(offset3).toBeGreaterThan(offset1);
  });

  it("handles missing usage fields gracefully", () => {
    const fp = writeTranscript([
      {
        type: "assistant",
        uuid: "a3",
        message: {
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "no usage" }],
        },
      },
    ], "no-usage.jsonl");

    const { entries } = readTranscriptIncremental(fp, 0);
    expect(entries[0].usage).toBeUndefined();
  });

  it("skips malformed JSON lines", () => {
    const fp = transcriptPath("malformed.jsonl");
    writeFileSync(fp, '{"type":"user"}\nnot-json\n{"type":"assistant"}\n');

    const { entries } = readTranscriptIncremental(fp, 0);
    expect(entries).toHaveLength(2);
  });
});

describe("findUsageForToolUse", () => {
  it("returns usage for matching tool_use_id", () => {
    const entries = [
      {
        type: "assistant" as const,
        toolUseIds: ["toolu_abc"],
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          model: "claude-opus-4-6",
        },
      },
      {
        type: "assistant" as const,
        toolUseIds: ["toolu_def"],
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          model: "claude-opus-4-6",
        },
      },
    ];

    const result = findUsageForToolUse(entries, "toolu_abc");
    expect(result).not.toBeNull();
    expect(result!.inputTokens).toBe(100);
  });

  it("returns null when tool_use_id is not found", () => {
    const entries = [
      { type: "assistant" as const, toolUseIds: ["toolu_abc"], usage: undefined },
    ];
    expect(findUsageForToolUse(entries, "toolu_xyz")).toBeNull();
  });

  it("returns null for empty entries", () => {
    expect(findUsageForToolUse([], "toolu_abc")).toBeNull();
  });

  it("prefers last match when multiple entries contain the same tool_use_id", () => {
    const usage1 = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      model: "claude-opus-4-6",
    };
    const usage2 = {
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      model: "claude-opus-4-6",
    };
    const entries = [
      { type: "assistant" as const, toolUseIds: ["toolu_dup"], usage: usage1 },
      { type: "assistant" as const, toolUseIds: ["toolu_dup"], usage: usage2 },
    ];

    const result = findUsageForToolUse(entries, "toolu_dup");
    expect(result!.inputTokens).toBe(200);
  });
});
