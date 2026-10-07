# Decisions

Defaults picked without asking. One line each.

1. Name: `agent-seatbelt` (`seatbelt` and `flightrec` are taken on npm).
2. Storage: Node built-in `node:sqlite` (needs Node 22.13 or newer). No native build step, so install from GitHub is fast and works on Windows.
3. Process model: one gateway process per client entry (`proxy`), one dashboard process (`start`). They share state through SQLite (WAL) and a pause flag file, so the kill switch and approvals work across processes with no sockets.
4. `init` keeps tool names unchanged (one upstream per proxy, no namespace). Namespacing (`server__tool`) is used by `serve`, which merges several upstreams from `gateway.yaml`.
5. `stop` engages the kill switch (what a person means by stop). `resume` releases it. The dashboard process is stopped with Ctrl+C.
6. Wrapper entries use `npx -y github:zaydmulani09/agent-seatbelt` by default; `--local` uses `node <this install>/dist/cli.js`.
7. Money is currency-agnostic units, shown with a configurable symbol (default `$`).
8. Amount is read from `spend.amountPath` (per tool overrides in `spend.paths`), falling back to common argument names (`amount`, `price`, `total`, `cost`).
9. Money calls whose amount cannot be found fall back to the class action (ask by default).
10. Approval timeout 120 seconds, then deny. A STOP also denies every held approval.
11. Elicitation is used in parallel with the dashboard when the client advertises it. First answer wins.
12. Runaway: balanced preset trips at 40 calls in 10 seconds, or 8 identical calls in 60 seconds. A trip pauses everything until a person resumes.
13. Receipt: SVG card plus HTML page (no PNG, to avoid a native image dependency). SVG shares anywhere.
14. Dashboard auth: random token persisted in the config dir, delivered once in the URL, then an HttpOnly SameSite=Strict cookie. Mutating requests also need a custom header and a matching Origin.
15. Policy edits from the dashboard rewrite `policy.yaml` in full (comments are not preserved).
16. `readOnlyHint: true` is trusted only if name heuristics do not say money, send, delete or exec.
17. Resource reads are logged and honor pause and a `read: deny` policy. Prompts are passed through unlogged.
18. No LLM, no network calls from the gateway or dashboard. Summaries are templates.
19. No TaskCreate tool was available in this environment, so work was tracked in the session itself.
