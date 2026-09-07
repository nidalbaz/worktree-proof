# CLAUDE.md — WorktreeProof (Worktree Proof Workflow V3)

**Repo:** `C:\VectorHQ\worktree-proof-workflow` · GitHub `Nedal7707/worktree-proof` · npm `worktree-proof`
**Tagline:** "Vibe fast. Ship with proof." — scoped, evidence-backed AI coding-agent work.

## Why the owner built it

After 341 registered worktrees (205 untouched for a week+) ate all free disk and regrew the same
failure, the owner needed agents to have **a beginning (plan), a safe working surface (reserve),
bounded checks (run), and a verifiable end (close with receipt)**. It is workflow infrastructure
for the Vector stack: the proof domain (contracts, breakers, ledger) is deliberately independent of
Git/shells/browsers/providers; adapters make external observations explicit and auditable.

## What it is

Open-source toolkit (Apache-2.0), zero runtime deps, local-first, model-agnostic:

```sh
worktree-proof plan <name> --scope docs/ --json     # beginning
worktree-proof reserve <name> --scope docs/ --json  # safe worktree surface
worktree-proof run <name> --json -- <command>       # argv only, no shell
worktree-proof close <name> --json --receipt '<json>' # verifiable end; never invents evidence
worktree-proof doctor --json                        # health check
```

Same `.worktree-proof/` state + schemas for Codex AND Claude Code skills
(`skills/worktree-proof-stack`). OpenCode plugins vendored in `integrations/`
(chrome-use on port 9333 normal profile, computer-use via nut-js).

## The V3 amendment (CW-3/CW-4) — what got installed into live config

- **Immutable task contract (§2):** unique taskId/threadId, one outcome, named terminal gates,
  fixed denominator, baseline SHA, relative file scope, deadline or none. Frozen before first
  mutation; changing it = new versioned contract.
- **Fixed terminal ledger (§3):** progress = terminal_closed / terminal_total ONLY. Research,
  plans, tests-that-aren't-gates, commits, branches, PRs = useful but ZERO terminal progress.
- **SAFE-3 circuit breaker at lifecycle entry (§5):** every `npm run agent:worktree` call must
  carry a valid `--circuit-breaker-json` receipt or fail closed before branch/worktree creation.
- **Helper policy (§§1–10):** requested ceiling 20 concurrent lanes; unique laneId + non-empty
  relative fileScope per BUILD dispatch; terminal-first allocation (dirty recovery first;
  100% integration while any backlog exists; exact 50/50 build vs integrate after); idle slot OK
  when no independent item exists — spawning to fill capacity is a violation.
- **Exact cleanup (§8):** validate registered root, handle changes, prune in-session. Dirty
  checkout never removed with --force — preserved for bounded rescue.
- **Crash rehydration (§9):** after crash/restart/compaction re-read owner request, contract,
  ledger, checklist, branch/worktree state, origin/main BEFORE any mutation; summaries are hints,
  never authority.
- **No-output breaker:** 40 tool calls since last terminal closure with zero closures → freeze
  spawns/scope, secure dirty work, report one blocker, end turn.

Spec source of truth: `docs\WORKFLOW_SPEC.md` + `docs\HELPER_POLICY.md`, verified by
`scripts/spec-audit.mjs`. Canonical rules live in `C:\Users\Nedal\.codex\AGENTS.md`; tracked
mirror `docs/codex-global-AGENTS.md` stays byte-identical.

## Done vs not done

DONE (0.4.x era): CLI plan/reserve/run/close/status/doctor with JSON receipts; Codex+Claude skill
adapters; OpenCode chrome-use/computer-use plugins; MCP stdio surface; CI (ci.yml, CodeQL,
dependency-review, release-integrity) green on GitHub; V3 amendment installed into Codex config +
Command Code session tools (`mcp__worktree-proof__*`: bridge_send/inbox/claim/complete,
cc_orchestrate, cc_plan_mcp, cc_circuit_breaker, cc_evidence, worktreeproof_status/capabilities/
validate_receipt/validate_scope).

NOT DONE (from ROADMAP "only with evidence"): additional client adapters (needs public contract +
fixtures first); richer receipt/reporting views (needs clear consumer, no secrets); network or
telemetry features (blocked behind opt-in data-flow design + threat model + rollback plan).
Explicitly OUT OF SCOPE forever: hosted coordination service, security sandbox, autonomous
merging, guaranteed correctness, live-trading/payment workflows.

## Gotchas

- `ll/` dir and stray `msg-*.json`, `*.log` files in repo root are runtime residue — don't treat
  as product code.
- The 9222 debug-port "Chrome portal" is RETIRED for browser automation; Token-Free Gateway owns
  9222 now; Chrome bridge is extension relay on 9333 (extension ID epppjbfmmabiphlgeokdichnhhklabep).
- Roadmap is evidence-gated: a proposed item is NOT complete until focused change + tests +
  reviewable terminal record exist.
