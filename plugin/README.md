# Khoregos Claude Code plugin

Khoregos plugin for Claude Code Agent Teams. This plugin wires hooks, an MCP server entry, governance skills, and helper slash commands.

## Requirements

- `k6s` must be available on `PATH`.
- Khoregos should be initialized in the project (`k6s.yaml` and `.khoregos/`).

## Install

Inside Claude Code:

```text
/plugin marketplace add sibyllai/khoregos
/plugin install khoregos@sibyllai
```

## What the plugin provides

- Hook registrations for tool and subagent lifecycle events.
- MCP server registration for governance tools.
- Always-on governance skill activation in Khoregos projects.
- Slash commands: `/k6s-start`, `/k6s-status`, `/k6s-audit`, `/k6s-stop`.

## Operational model

- Plugin layer: always-on wiring and baseline governance behavior.
- CLI workspace governance layer: `k6s team start` adds workspace governance-specific context, trace identifiers, and boundary details.
