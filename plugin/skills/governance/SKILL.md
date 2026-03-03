---
description: Governance framework for AI agent team coordination, audit trails, and boundary enforcement.
globs:
  - 'k6s.yaml'
  - '.khoregos/**'
---

# Khoregos governance

You are working in a project governed by Khoregos (k6s), an enterprise governance layer for Claude Code Agent Teams.

## Always do these things

1. Log significant actions using the `k6s_log` MCP tool before and after creating, modifying, or deleting files.
2. Check your boundaries at the start of your work using `k6s_get_boundaries` to understand which paths you are allowed to modify.
3. Before modifying a file, call `k6s_check_path` to verify you have permission.
4. Acquire locks using `k6s_acquire_lock` before modifying files that other agents might also be editing. Release locks with `k6s_release_lock` when done.
5. Save context using `k6s_save_context` when you make important decisions, complete milestones, or before ending your session. Save the rationale, not just the outcome.

## Available MCP tools

- `k6s_log`: Log an action to the audit trail.
- `k6s_save_context`: Save persistent context that survives session restarts.
- `k6s_load_context`: Load previously saved context.
- `k6s_acquire_lock`: Acquire an exclusive file lock.
- `k6s_release_lock`: Release a file lock.
- `k6s_get_boundaries`: Get your boundary rules (allowed or forbidden paths).
- `k6s_check_path`: Check if you are allowed to modify a specific file.
- `k6s_task_update`: Update task state and progress.

## If no active session

If the Khoregos MCP server is not responding (no active session), continue your work normally. The hooks still capture tool invocations for audit purposes. When the operator starts a session with `k6s team start`, full governance including boundaries and context persistence activates.
