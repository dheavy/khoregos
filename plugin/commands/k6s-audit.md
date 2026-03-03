---
description: Show audit trail events for the current workspace governance.
---

# Audit trail

Run `k6s audit show` to display recent audit events.

If the user asks for filters, pass matching flags:

- `--severity critical` for security-sensitive events.
- `--agent <name>` for a specific agent's actions.
- `--type <type>` for specific event types (`tool_use`, `boundary_violation`, `gate_triggered`).

Summarize key findings instead of dumping raw output.
