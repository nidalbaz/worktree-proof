---
name: worktree-proof
description: Coordinate bounded coding-agent lanes with explicit scopes, reservations, run records, and closure receipts. Use when parallel work needs conflict checks, auditable handoffs, stale-lane cleanup, or deterministic validation.
---

# WorktreeProof (Fable 5.1 & L99 Invariant)

Use WorktreeProof to make parallel work explicit, isolated, and terminally auditable. Keep the lane identifier, relative file scope, command outcome, and closure evidence together.

## Workflow

1. **Rehydrate & Doctor**: Inspect current task contract and run `worktree-proof doctor`.
2. **Pre-Task Interceptor**: Run the Self-Interrogation Loop (Task, specialized skills, guards) before code mutations.
3. **Plan & Bound**: Describe one bounded objective with `worktree-proof plan` using unique normalized lane IDs.
4. **Reserve & Isolate**: Reserve a unique lane and non-overlapping relative scope with `worktree-proof reserve`. Keep subagents isolated to separate worktrees.
5. **Execute Safely**: Run only reviewed commands through `worktree-proof run`; keep credentials out of arguments and output. Never enable arbitrary shells.
6. **Status & Circuit Breakers**: Use `worktree-proof status` to inspect active lanes. Enforce the F13 circuit breaker (freeze at 40 calls without terminal closure) and the 3-strike failure rule.
7. **Close with Evidence**: Attach deterministic checks and redacted evidence with `worktree-proof close`. A branch or commit is not a closure.
8. **Release & Clean**: Use `worktree-proof release` for abandoned work and `worktree-proof cleanup --dry-run` before removing stale state. Preserve dirty checkouts for rescue.

## Scope Discipline & Invariants

- Normalize scopes relative to the project root and reject traversal.
- Treat a file and its parent directory as overlapping; reject both while active.
- Keep one objective per lane and never infer ownership from a plan alone.
- Conductor dispatches, laborers type. Helpers never become authority gates or decision makers.
- Prefer JSON output for automation and human-readable output for review.

## Failure Handling & Autonomous Rollback

- **3-Strike Rollback Trigger**: On the third identical tool failure, stop, execute `git reset --hard` or delete the worktree cleanly, and report the root cause.
- If a reservation conflicts, a receipt is malformed, or state is stale, stop the lane and report the precise reason.
- Never force cleanup, rewrite another lane's receipt, or claim completion without validation evidence.
- Stop at permanent owner gates (credentials, live broker orders, billing); never guess.

## Command Code Harness & Plan Mode Discipline

- **Strict Plan Mode**: When in plan mode, work is strictly read-only. All modifying tools and commands are locked. The only writable target is `~/.commandcode/plans/<name>.md`.
- **5-Phase Execution Flow**:
  1. Explore: Windowed, AST-guided exploration (<=100 lines per file slice).
  2. Clarify: Mandatory requirement verification before design ("Grill Me" protocol).
  3. Design: Define architectural boundaries, minimal viable diff, and rollback plans.
  4. Plan: Write formal implementation plan with deterministic verification criteria.
  5. Exit & Handoff: Request user approval before beginning any implementation.
- **Tool Authority**: Trust tool output and state as authoritative; never simulate or assume.

## Taste Behavioral Adaptation System

- **Category Learnings**: Adhere to discovered owner preferences and repo facts (`# <category>` with confidence scores).
- **Target Account**: `nidalbaz` (git push targets `https://github.com/nidalbaz/<repo>.git`).
- **Live Verification First**: Desktop-app and live runtime evidence overrides synthetic assumptions.
- **Zero New Bills**: Token-waste is a defect; leverage free tiers and self-hosted runners.
