/**
 * Desktop notifications for session lifecycle events.
 *
 * Uses OS-native notification mechanisms:
 * - macOS: osascript (AppleScript)
 * - Linux: notify-send (libnotify)
 *
 * All calls are fire-and-forget with short timeouts to avoid
 * blocking hook execution.
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import type { NotificationsConfig } from "../models/config.js";

const NOTIFY_TIMEOUT_MS = 3_000;

export type SessionLifecycleEvent = "session_start" | "session_complete";

interface NotifyOpts {
  title: string;
  message: string;
}

function notifyMacOS(opts: NotifyOpts): void {
  const script = `display notification "${escapeAppleScript(opts.message)}" with title "${escapeAppleScript(opts.title)}"`;
  execFile("osascript", ["-e", script], { timeout: NOTIFY_TIMEOUT_MS }, () => {
    // fire-and-forget
  });
}

function notifyLinux(opts: NotifyOpts): void {
  execFile(
    "notify-send",
    ["--app-name=Khoregos", opts.title, opts.message],
    { timeout: NOTIFY_TIMEOUT_MS },
    () => {
      // fire-and-forget
    },
  );
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sendDesktopNotification(opts: NotifyOpts): void {
  const os = platform();
  if (os === "darwin") {
    notifyMacOS(opts);
  } else if (os === "linux") {
    notifyLinux(opts);
  }
  // Windows: not supported yet (no shell dependency).
}

/**
 * Send a desktop notification for a session lifecycle event.
 * Respects the notifications config — returns immediately if disabled.
 */
const DEFAULTS: NotificationsConfig = {
  session_lifecycle: true,
  desktop: true,
  dashboard: true,
};

export function notifySessionLifecycle(
  event: SessionLifecycleEvent,
  config: NotificationsConfig | undefined,
  details?: { sessionId?: string; objective?: string },
): void {
  const cfg = config ?? DEFAULTS;
  if (!cfg.session_lifecycle || !cfg.desktop) return;

  const shortId = details?.sessionId?.slice(0, 8) ?? "unknown";

  if (event === "session_start") {
    sendDesktopNotification({
      title: "Khoregos — Session Started",
      message: details?.objective
        ? `Session ${shortId}: ${details.objective}`
        : `Session ${shortId} started`,
    });
  } else if (event === "session_complete") {
    sendDesktopNotification({
      title: "Khoregos — Session Ended",
      message: `Session ${shortId} has ended`,
    });
  }
}
