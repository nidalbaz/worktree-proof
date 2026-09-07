---
name: dynamic-orchestrator
description: Decompose complex tasks into parallelizable sub-tasks, dispatch them to sub-agents via bridge messaging, and collect results. Use when a task spans multiple files/directories or can benefit from parallel exploration. Respects max 24 concurrent lanes.
use_for: task decomposition, parallel execution, sub-agent coordination, multi-file tasks
category: workflow
---

# Dynamic Orchestrator

Decompose a task into independent, parallelizable sub-tasks. Each sub-task is dispatched as a **bridge message** to a sub-agent, which checks the inbox, claims the message, completes the work, and reports back.

## When to use

- Task spans multiple files or directories
- Task can be split into independent parts ("and", "parallel", "concurrent")
- Task requires sub-agent exploration before main implementation
- You need to respect the 24-lane concurrency limit

## How it works

1. **Analyze** — Call `cc_orchestrate` with the task description to get a breakdown
2. **Dispatch** — For each parallelizable sub-task, call `bridge_send` to dispatch a message
3. **Coordinate** — Sub-agents check `bridge_inbox`, `bridge_claim`, do work, `bridge_ack`, `bridge_complete`
4. **Collect** — Gather results from completed bridge messages

## Tool reference

- `cc_orchestrate` — Analyzes task text, returns `{ subTasks: [{id, description, fileScope, parallelizable}], parallelizable: bool }`
- `bridge_send` — Dispatch a sub-task message (`sender`, `recipient`, `type`, `summary`, `fileScope`, `laneId`, `ttlMs`)
- `bridge_inbox` — Check received messages (`recipient`)
- `bridge_claim` — Claim a message for processing (`receiver`, `messageId`, `claimMs`)
- `bridge_ack` — Acknowledge a message (`receiver`, `messageId`)
- `bridge_complete` — Mark a message as complete with result (`receiver`, `messageId`, `result`)

## L99 workflow integration

```
TASK → cc_orchestrate (decompose) → bridge_send (dispatch N sub-tasks)
          → [sub-agent: bridge_inbox → bridge_claim → work → bridge_ack → bridge_complete]
          → cc_evidence (collect proofs) → complete-workflow (merge + release)
```

## Constraints

- Max 24 concurrent lanes (hard limit)
- Each sub-task has a non-overlapping file scope
- Sub-tasks must have a named acceptance condition
- Use `cc_circuit_breaker` to monitor terminal closure progress
- Never merge branches that overlap with active sub-task worktrees

## Example

```
User: "Refactor the auth system and add tests for the payment module"

1. cc_orchestrate("Refactor the auth system and add tests for the payment module")
   → [{id: "sub-1", description: "Refactor the auth system", fileScope: "src/auth/*", parallelizable: true},
      {id: "sub-2", description: "Add tests for the payment module", fileScope: "src/payments/*", parallelizable: true}]

2. bridge_send({sender: "orchestrator", recipient: "auth-refactor-agent", type: "task", summary: "Sub-task: Refactor auth system", fileScope: "src/auth/*", laneId: "auth-refactor", ttlMs: 86400000})
3. bridge_send({sender: "orchestrator", recipient: "payment-test-agent", type: "task", summary: "Sub-task: Add payment tests", fileScope: "src/payments/*", laneId: "payment-tests", ttlMs: 86400000})

4. Wait for bridge_complete messages from both sub-agents
5. cc_evidence to verify both tasks are done with proof
```
