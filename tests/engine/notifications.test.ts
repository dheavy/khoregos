/**
 * Tests for session lifecycle desktop notifications.
 *
 * Note: This test mocks node:child_process.execFile (NOT exec) to verify
 * that notification commands are dispatched correctly. The production code
 * uses execFile which is safe from shell injection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { platform } from "node:os";

// Mock child_process.execFile to capture notification calls.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// We need to import after mocking.
const { notifySessionLifecycle } = await import(
  "../../src/engine/notifications.js"
);

const enabledConfig = {
  session_lifecycle: true,
  desktop: true,
  dashboard: true,
};

const disabledConfig = {
  session_lifecycle: false,
  desktop: true,
  dashboard: true,
};

const noDesktopConfig = {
  session_lifecycle: true,
  desktop: false,
  dashboard: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifySessionLifecycle", () => {
  it("does not call execFile when session_lifecycle is disabled", () => {
    notifySessionLifecycle("session_start", disabledConfig, {
      sessionId: "01ABCDEF",
      objective: "test",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not call execFile when desktop is disabled", () => {
    notifySessionLifecycle("session_start", noDesktopConfig, {
      sessionId: "01ABCDEF",
      objective: "test",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("calls execFile on session_start when enabled", () => {
    notifySessionLifecycle("session_start", enabledConfig, {
      sessionId: "01ABCDEFGHIJK",
      objective: "build the thing",
    });

    const os = platform();
    if (os === "darwin" || os === "linux") {
      expect(execFile).toHaveBeenCalledTimes(1);
      const args = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
      if (os === "darwin") {
        expect(args[0]).toBe("osascript");
        expect(args[1][1]).toContain("Session Started");
        expect(args[1][1]).toContain("build the thing");
      } else {
        expect(args[0]).toBe("notify-send");
        expect(args[1]).toContain("Khoregos — Session Started");
      }
    }
  });

  it("calls execFile on session_complete when enabled", () => {
    notifySessionLifecycle("session_complete", enabledConfig, {
      sessionId: "01XYZABC12345",
    });

    const os = platform();
    if (os === "darwin" || os === "linux") {
      expect(execFile).toHaveBeenCalledTimes(1);
      const args = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
      if (os === "darwin") {
        expect(args[0]).toBe("osascript");
        expect(args[1][1]).toContain("Session Ended");
        expect(args[1][1]).toContain("01XYZABC");
      } else {
        expect(args[0]).toBe("notify-send");
        expect(args[1]).toContain("Khoregos — Session Ended");
      }
    }
  });

  it("truncates session ID to 8 characters in notification", () => {
    notifySessionLifecycle("session_complete", enabledConfig, {
      sessionId: "01ABCDEFGHIJKLMNOP",
    });

    const os = platform();
    if (os === "darwin" || os === "linux") {
      const args = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
      if (os === "darwin") {
        expect(args[1][1]).toContain("01ABCDEF");
        expect(args[1][1]).not.toContain("GHIJKLMNOP");
      }
    }
  });
});
