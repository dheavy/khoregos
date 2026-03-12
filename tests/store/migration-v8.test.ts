/**
 * Tests for migration v8: unique sequence index on audit_events.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Db } from "../../src/store/db.js";
import { getTempDbPath, cleanupTempDir } from "../helpers.js";

describe("migration v8", () => {
  let db: Db;

  beforeAll(() => {
    db = new Db(getTempDbPath());
    db.connect();
  });

  afterAll(() => {
    db.close();
    cleanupTempDir();
  });

  it("creates unique index on audit_events(session_id, sequence)", () => {
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_session_seq_unique'")
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("unique index prevents duplicate sequence numbers per session", () => {
    db.insert("sessions", {
      id: "mig8-test",
      objective: "migration test",
      state: "active",
      started_at: new Date().toISOString(),
    });

    db.insert("audit_events", {
      id: "mig8-evt-1",
      sequence: 1,
      session_id: "mig8-test",
      timestamp: new Date().toISOString(),
      event_type: "tool_use",
      action: "first",
      severity: "info",
    });

    expect(() => {
      db.insert("audit_events", {
        id: "mig8-evt-2",
        sequence: 1,
        session_id: "mig8-test",
        timestamp: new Date().toISOString(),
        event_type: "tool_use",
        action: "duplicate",
        severity: "info",
      });
    }).toThrow(/UNIQUE constraint/);
  });

  it("allows same sequence number in different sessions", () => {
    db.insert("sessions", {
      id: "mig8-test-2",
      objective: "migration test 2",
      state: "active",
      started_at: new Date().toISOString(),
    });

    expect(() => {
      db.insert("audit_events", {
        id: "mig8-evt-3",
        sequence: 1,
        session_id: "mig8-test-2",
        timestamp: new Date().toISOString(),
        event_type: "tool_use",
        action: "same seq different session",
        severity: "info",
      });
    }).not.toThrow();
  });
});
