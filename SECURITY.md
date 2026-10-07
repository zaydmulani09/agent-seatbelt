# Security

## What Agent Seatbelt protects, and what it does not

Agent Seatbelt is a gateway. It controls **only the tool calls that go through it**.

- It cannot see or stop anything an agent does outside proxied MCP tools: a built-in shell, a browser, direct file access, or an MCP server you did not wrap.
- Classifying a tool as "read", "money", "send" and so on uses MCP annotations, tool names, input schemas and descriptions. This is a heuristic. A tool with a misleading name can be misclassified. Use `classOverrides` and review the Rules tab for tools you care about. Strict mode denies tools it cannot classify.
- Spending caps only work when the amount can be found in the call arguments. If it cannot, the category action applies (ask, by default). Set `spend.amountPath` for unusual tools.
- It is not a substitute for limits at the provider: card limits, bank alerts, API budgets, least-privilege tokens. Use both.
- A determined attacker who already controls your user account can edit the config folder, the policy file or the database. The hash chain makes edits to the log detectable, not impossible: run `agent-seatbelt status` or press "Check the log is untampered" in the Receipt tab.
- A pending approval holds the agent's request open. If the client gives up earlier than your approval timeout, the call fails on the client side and the approval is denied.

## Data handling

- Everything is stored locally in the config folder (`%APPDATA%/agent-seatbelt`, `~/Library/Application Support/agent-seatbelt` or `~/.config/agent-seatbelt`).
- No telemetry, no accounts, no network calls from the gateway or dashboard. The dashboard loads no external fonts, scripts or images.
- Secrets (API keys, tokens, bearer headers, private keys, card numbers that pass a Luhn check, values under keys such as `password`) are redacted before anything is written. Redaction is pattern based and can miss unusual formats. Set `logArguments: hash` to store only a fingerprint of what was sent.
- The weekly receipt contains counts and amounts only.

## Dashboard hardening

- Binds to `127.0.0.1` only and rejects non-loopback peers.
- Requires a random 192 bit token, shown once in the start link and then kept in an `HttpOnly`, `SameSite=Strict` cookie.
- Rejects any `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), any foreign `Origin`, and cross-site fetches.
- State-changing requests also need a custom header, which browsers will not send cross-origin without a preflight that the server does not answer.
- Strict Content Security Policy, no inline scripts or styles, all agent-supplied text rendered as text.
- Anyone who can read your config folder can read the token. Treat it like a local password.

## Reporting a vulnerability

Open a private security advisory at <https://github.com/zaydmulani09/agent-seatbelt/security/advisories/new>. Please include steps to reproduce. I aim to reply within a week.
