/**
 * Tests for StateManager cost tracking and transcript offset methods.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { StateManager } from "../../src/engine/state.js";
import { AuditLogger } from "../../src/engine/audit.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("StateManager cost tracking", () => {
  let db: Db;
  let state: StateManager;
  let sessionId: string;
  let agentId: string;

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
    state = new StateManager(db, "/tmp/k6s-cost-test");

    const session = state.createSession({ objective: "cost tracking test" });
    sessionId = session.id;

    const agent = state.registerAgent({ sessionId, name: "primary" });
    agentId = agent.id;
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  describe("recordCost", () => {
    it("inserts a cost record", () => {
      state.recordCost({
        sessionId,
        agentId,
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 50,
          model: "claude-opus-4-6",
        },
        estimatedCostUsd: 0.025,
      });

      const rows = db.fetchAll(
        "SELECT * FROM cost_records WHERE session_id = ?",
        [sessionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].model).toBe("claude-opus-4-6");
      expect(rows[0].input_tokens).toBe(500);
      expect(rows[0].output_tokens).toBe(200);
      expect(rows[0].cache_creation_input_tokens).toBe(100);
      expect(rows[0].cache_read_input_tokens).toBe(50);
      expect(rows[0].estimated_cost_usd).toBeCloseTo(0.025);
    });

    it("updates session aggregates", () => {
      // Record a second cost entry
      state.recordCost({
        sessionId,
        agentId,
        usage: {
          inputTokens: 300,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          model: "claude-sonnet-4-6",
        },
        estimatedCostUsd: 0.005,
      });

      const row = db.fetchOne(
        "SELECT total_input_tokens, total_output_tokens, total_cost_usd FROM sessions WHERE id = ?",
        [sessionId],
      );
      expect(row).toBeDefined();
      // 500 + 300 = 800
      expect(row!.total_input_tokens).toBe(800);
      // 200 + 100 = 300
      expect(row!.total_output_tokens).toBe(300);
      // 0.025 + 0.005 = 0.03
      expect(Number(row!.total_cost_usd)).toBeCloseTo(0.03);
    });

    it("stores audit_event_id when provided", () => {
      // Create a real audit event to satisfy the FK constraint.
      const logger = new AuditLogger(db, sessionId, null, null);
      logger.start();
      const evt = logger.log({
        eventType: "tool_use",
        action: "tool_use: test",
        agentId,
      });
      logger.stop();

      state.recordCost({
        sessionId,
        agentId,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          model: "claude-opus-4-6",
        },
        estimatedCostUsd: 0.001,
        auditEventId: evt.id,
      });

      const row = db.fetchOne(
        "SELECT audit_event_id FROM cost_records WHERE audit_event_id = ?",
        [evt.id],
      );
      expect(row).toBeDefined();
      expect(row!.audit_event_id).toBe(evt.id);
    });
  });

  describe("transcript offset", () => {
    it("defaults to 0 for new sessions", () => {
      const offset = state.getTranscriptOffset(sessionId);
      expect(offset).toBe(0);
    });

    it("persists offset updates", () => {
      state.setTranscriptOffset(sessionId, 12345);
      expect(state.getTranscriptOffset(sessionId)).toBe(12345);

      state.setTranscriptOffset(sessionId, 99999);
      expect(state.getTranscriptOffset(sessionId)).toBe(99999);
    });
  });
});
