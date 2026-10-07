# Research

Checked on 2026-10-06. Sources are linked inline.

## 1. MCP facts

- Latest spec revision: 2025-11-25. Earlier: 2024-11-05, 2025-03-26, 2025-06-18. 2025-03-26 added Streamable HTTP (replacing HTTP+SSE) and tool annotations. 2025-06-18 added structured output and elicitation. 2025-11-25 added Tasks, URL-mode elicitation and sampling with tools. ([overview](https://higress.ai/en/blog/a-comprehensive-analysis-and-implementation-practices-of-the-new-features-in-mcp-specification), [changelog](https://modelcontextprotocol.io/specification/2025-03-26/changelog))
- Transports: stdio and Streamable HTTP. This project uses both on the upstream side (stdio from init-wrapped configs, HTTP via `--url`) and stdio toward the agent.
- Tool annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. They are hints from the server and must not be trusted blindly, so the classifier takes the stricter of annotation and name heuristics.
- Elicitation: a server can ask the client to collect user input mid call. Used here as an optional second approval channel when the client advertises the capability.
- Official TypeScript SDK: `@modelcontextprotocol/sdk` 1.32.1 (npm, verified). Low level `Server` and `Client` classes, `StdioClientTransport`, `StreamableHTTPClientTransport`, `Server.elicitInput`.

## 2. Client configuration

- Claude Desktop: `claude_desktop_config.json`. macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%/Claude/`, Linux `~/.config/Claude/`. Top level `mcpServers` object. ([guide](https://docs.cognee.ai/cognee-mcp/integrations/claude-desktop))
- Claude Code: `.mcp.json` in a project (team scope) and `~/.claude.json` (user and local scope), same `mcpServers` shape. Entries may be `stdio` (command, args, env) or `http`/`sse` (url, headers). ([guide](https://www.host-tracker.com/en/learn/ai-assistants/claude-code-mcp-json-config))
- `init` rewrites each stdio or http entry into a stdio entry that launches `agent-seatbelt proxy`, with a backup and a diff.

## 3. Prior art (honest check)

A bare "MCP proxy with policy" gap does not exist. Many exist:

| Project | What it is | Gap versus this project |
|---|---|---|
| [SpendShield](https://pypi.org/project/spendshield/) | Python policy layer for agent payments: allow, approval, deny, budgets, tamper-evident audit log | Payments only, library oriented |
| [PolicyLayer](https://policylayer.com/blog/cli-init-mcp-server) | Non-custodial spend controls, proxy and kill switch, CLI init | Wallet and payments focus, developer UX |
| [ressl/mcp-firewall](https://github.com/ressl/mcp-firewall) | Security gateway, policy, dashboard on localhost:9090, kill switch, optional approval | Enterprise and compliance framing, threat detection |
| [agentwall](https://github.com/vishalmurugan1986/agentwall) | Zero dependency stdio proxy, tamper-evident chained audit log | CLI and log, no consumer UI |
| Aegis (via [directory](https://glama.ai/mcp/servers/sgqqtsxge0)) | Signed hash-chained logs, compliance dashboard, approvals queue, kill switch | Compliance cockpit for teams |
| [Agent-Firewall](https://github.com/KaranVashisht888/Agent-Firewall) | Provenance tracking and policy blocking | Security research oriented |
| WAIaaS, HUMAN AgenticTrust | Wallet as a service, merchant side trust | Different side of the transaction |

Pieces overlap heavily: proxying, allow/ask/deny, hash-chained logs, kill switch, localhost dashboards. What none of the ones found do together: a neutral, cross-agent, non-technical product with a plain-English timeline (templates, no LLM), a one-command `init` for Claude Desktop and Claude Code configs, presets a normal person can pick, and a shareable weekly "agent receipt".

## 4. Failure modes that shape default rules

- Destructive actions with borrowed credentials: a coding agent deleted a production database and its backups in about nine seconds in April 2026 after finding an unrelated token ([report](https://www.bankinfosecurity.com/ai-agent-wipes-startups-data-in-9-second-api-call-a-31521)). A Replit agent deleted a live database during a code freeze in 2025. Default: delete and exec ask.
- Runaway loops: retries and replans burn money unnoticed, one account describes over four thousand dollars over a weekend ([survey](https://pub.towardsai.net/i-read-every-post-mortem-on-agent-failures-this-year-heres-the-pattern-af67da08e3af)). Default: rate limit, repeat detection and a volume trip that pauses everything.
- Silent exfiltration through sending tools (email, post, message). Default: send asks.
- Money: any spend asks, per call and per day caps deny outright, with a message telling the agent not to split the purchase.
- Cover-ups after failure ([writeup](https://medium.com/@autonobotsai/the-ai-agent-deleted-the-database-then-it-generated-4-000-fake-records-to-cover-what-it-had-done-e60c3b9ebc6c)). Hence the tamper-evident log: the record of what happened must be independent of what the agent says happened.

## Verdict

The generic gap is not real: several MCP policy proxies with dashboards and kill switches exist (mcp-firewall, agentwall, Aegis, SpendShield, PolicyLayer). The consumer gap is real but narrow: none found targets a non-technical person with plain-English output, presets, a one-step Claude config wrap and a shareable receipt. Agent Seatbelt differentiates on exactly that, plus being neutral across agents and fully local with no telemetry.

## Name

`agent-seatbelt`: free on npm (404) and free under github.com/zaydmulani09. `seatbelt` and `flightrec` are taken on npm.
