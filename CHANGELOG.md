# Changelog

## 0.1.0 (2026-10-06)

First release.

- Gateway: MCP server toward the agent, MCP client toward upstream servers over stdio or Streamable HTTP. Tools, resources and prompts are passed through, namespaced when several upstreams are merged.
- Policy engine: YAML config with strict, balanced and relaxed presets, tool classification (read, write, money, send, delete, exec) from MCP annotations and heuristics with overrides, per-tool and glob rules, argument regex guards, per-call and per-day spend caps, rate limits, runaway detection.
- Approvals: ask, approve, deny and "always allow this", 120 second timeout, MCP elicitation when the client supports it.
- Kill switch: dashboard button, `stop` and `resume` commands, `PAUSED` flag file.
- Black box: append-only, hash-chained SQLite with secret redaction and a hashes-only mode.
- Dashboard: loopback only, token, Host and Origin checks, live updates, light and dark, phone friendly.
- Weekly receipt as SVG and HTML.
- CLI: `init` (with diff, backup, dry run and undo), `start`, `stop`, `resume`, `status`, `receipt`, `demo`, `proxy`, `serve`.
