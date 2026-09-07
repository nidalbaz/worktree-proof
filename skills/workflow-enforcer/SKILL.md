---
name: workflow-enforcer
description: Forces complete-workflow chain on every turn for ALL models, even those lacking native skill/tool-calling. Injects system-level workflow steps as prompts the model MUST follow.
tags: [workflow, enforcement, harness, guardrail]
license: Apache-2.0
---

# Workflow Enforcer (L99-Hardened)

## Problem
Weak/free-tier models (e.g. `poolside/laguna-s-2.1:free`) silently drop `skill_view`, `skills_list`, and plugin/tool calls. The complete-workflow and worktree-proof-stack skills only activate when the model *chooses* to call them — so they get skipped.

## Solution: Runtime Injection Layer
This skill operates AT THE HARNESS LEVEL — it wraps every turn with mandatory workflow steps injected as **system instructions**, not optional tool calls.

### How it works
1. **Pre-turn injection**: Before the model sees any user prompt, a system preamble is injected that *names* the required workflow steps as immutable actions.
2. **Post-turn validation**: After model output, the harness checks whether the required steps were attempted (even if the model failed to call the tool). If missing, the harness re-injects them as explicit next-turn instructions.
3. **Fallback to native tools**: If the model cannot call `skill_view`/`wp_run` natively, the enforcer converts each workflow step into a `terminal` call using the CLI equivalents.

### Injected preamble (appended to system prompt every turn)
```
=== WORKFLOW ENFORCER (MANDATORY) ===
You are operating under the complete-workflow L99 harness. EVERY turn must pass through these steps IN ORDER:

1. REHYDRATE — Read current state:
   • `goal_show` (or `worktree-proof goal show`)
   • `plan_show` (or `worktree-proof plan`)
   • `worktree-proof status`
   • Current git branch + origin/main SHA

2. CONTRACT — If no active goal, call `goal_set` with:
   • One outcome
   • Named terminal gates (G-01..G-20)
   • Fixed denominator
   • scope, baseline SHA, deadline or `none`

3. PLAN — Call `plan_create` with NON-overlapping tasks. Each task has:
   • Unique normalized lane ID
   • One non-empty relative scope
   • Named acceptance condition

4. RESERVE — Call `wp_reserve` (preview --dry-run first, then reserve).

5. EXECUTE — Use the RIGHT tool:
   • Browser → chrome_* on port 9333 ONLY
   • Desktop → computer_*
   • Lanes/commands → wp_run (argv only, NO shell)
   • Skills/knowledge → skill_view (mandatory at step start)

6. EVIDENCE — Close every task with `task_done` + explicit evidence.
   Close lanes with `wp_close` + receipt. No evidence = NOT done.

7. REVIEW — `review_gate` then `review_summary`. Report terminalClosed/terminalTotal.

8. MERGE & RELEASE — One PR per gate. CI green. Activity-log row. Cleanup.

FAILURE RULES:
• 3 strikes on same tool error → stop, fix, skip, or report.
• 40 tool calls with zero terminal closures → FREEZE. Report ONE blocker. STOP.
• No silent waits → TRUE BLOCKER / OWNER ACTION REQUIRED, then STOP.
• NO DAEMONS. NO SCHEDULERS. NO BACKGROUND SWEEPS.

You MUST call skill_view(name='complete-workflow') and skill_view(name='workflow-enforcer') before any substantive action. Failing to do so is an immediate retry trigger.
=== END ENFORCER ===
```

### CLI fallback mapping (when model can't call tools)
| Skill step | CLI command |
|---|---|
| skill_view | `hermes skill view <name>` |
| skills_list | `hermes skills list` |
| goal_show | `worktree-proof goal show` |
| goal_set | `worktree-proof goal set "<json>"` |
| plan_create | `worktree-proof plan create "<json>"` |
| plan_show | `worktree-proof plan show` |
| wp_reserve | `worktree-proof reserve <lane> <scope> --dry-run` |
| wp_run | `worktree-proof run <lane> --argv-only` |
| wp_close | `worktree-proof close <lane> --evidence "<json>"` |
| review_gate | `worktree-proof review <lane>` |

## Enforcement mechanism
This skill is loaded by the `complete-workflow` skill via `skill_view(name='workflow-enforcer')`. The Hermes runtime concatenates the preamble above into the system prompt for every turn. Models that skip `skill_view` calls are caught by the post-turn validator, which auto-injects:

> **MISSING WORKFLOW STEP DETECTED**: You must call `skill_view(name='complete-workflow')` and `skill_view(name='workflow-enforcer')` before proceeding. These are mandatory on every turn.

## Integration
```yaml
# In config.yaml, under agent.personalities.default.instructions:
- "SYSTEM: Inject workflow-enforcer preamble before every turn"
- "SYSTEM: Post-turn validator checks for workflow step completion"
- "SYSTEM: Auto-retry failed workflow steps via CLI fallback"
```

## References
- `references/model-capability-audit.md` — Full model capability ranking, skill/plugin/MCP catalog, swarm routing priority, and post-turn validator details.

## Scripts
- `scripts/verify_workflow_enforcer.py` — Run after config.yaml edits to confirm the enforcer is wired correctly (enforcer injected, model switched, reasoning=high, skill discoverable, extra_skills_paths includes worktree-proof, complete-workflow references workflow-enforcer).
