# taste-integration

**WorktreeProof + CommandCode taste-1 Integration**

Bring the taste-1 meta neuro-symbolic AI continuous learning loop into WorktreeProof V3 workflow.

## What is taste-1?

From CommandCode: A meta neuro-symbolic AI model with continuous reinforcement learning that:
- **Learns from you** - every accept, reject, edit becomes a signal
- **Thinks like you** - learns patterns and micro-decisions you'd never document
- **Grows with you** - continuous learning loop that never goes stale
- **Portable** - taste packages transfer across projects, teams, machines

## Integration Points in WorktreeProof V3

### 1. Task Contract Enhancement (§2)
```yaml
taskContract:
  tasteProfile:
    enabled: true
    scope: "project|global|team"
    packages: ["cli", "typescript", "architecture", "testing"]
    learningMode: "continuous"  # or "session-only"
```

### 2. Terminal Ledger with Taste Signals (§3)
Each terminal gate closure emits taste signals:
```json
{
  "gate": "CW-3",
  "terminalEvidence": "...",
  "tasteSignals": {
    "acceptedPatterns": ["pattern-id-1", "pattern-id-2"],
    "rejectedPatterns": ["pattern-id-3"],
    "microDecisions": [...]
  }
}
```

### 3. Helper Policy with Taste-Aware Allocation (HELPER_POLICY §§1-10)
Helpers inherit taste context:
```yaml
lane:
  tasteContext:
    packages: ["architecture", "testing"]
    mode: "apply-and-learn"
```

### 4. SAFE-3 Circuit Breaker with Taste (§5)
Taste learns from circuit breaker trips:
- Which patterns cause repeated failures
- Which recovery strategies work
- Auto-adjusts lane allocation based on learned patterns

### 5. Crash Recovery with Taste (§9)
Rehydration includes taste state:
```json
{
  "recoveryReceipt": {...},
  "tasteState": {
    "activePackages": [...],
    "learnedPatterns": {...},
    "sessionSignals": [...]
  }
}
```

## Taste Package Structure in WorktreeProof

```
project/
├── .worktree-proof/
│   └── taste/
│       ├── taste.md              # Main taste file
│       ├── workflow/
│       │   └── taste.md          # Workflow-specific learnings
│       ├── helpers/
│       │   └── taste.md          # Helper delegation patterns
│       ├── contracts/
│       │   └── taste.md          # Task contract patterns
│       └── recovery/
│           └── taste.md          # Recovery patterns
```

## Commands

```bash
# Enable taste learning for current WorktreeProof project
hermes taste enable

# Disable taste learning
hermes taste disable

# Push taste to remote (team sharing)
hermes taste push --all

# Pull taste from team
hermes taste pull team/worktree-proof

# List available taste packages
hermes taste list

# Open taste in editor
hermes taste open workflow
```

## Configuration

Add to WorktreeProof config:
```yaml
# In .worktree-proof/config.yaml or global config
taste:
  enabled: true
  provider: "commandcode"  # or "local" for offline
  apiKey: "${TASTE_API_KEY}"
  baseUrl: "https://api.commandcode.ai/provider/v1"
  packages:
    - workflow
    - helpers
    - contracts
    - recovery
  learningMode: "continuous"
  shareWithTeam: true
```

## Taste Signals Emitted by WorktreeProof Events

| Event | Signal Type | Payload |
|-------|-------------|---------|
| `lane.reserve` | `delegation-pattern` | scope, files, resources |
| `lane.run` | `execution-pattern` | commands, tools, duration |
| `lane.close` | `terminal-pattern` | gate, evidence, success |
| `circuit_breaker.trip` | `failure-pattern` | error, context, recovery |
| `recovery.rehydrate` | `recovery-pattern` | receipt, tasteState |
| `helper.spawn` | `parallel-pattern` | count, scopes, allocation |
| `merge.conflict` | `conflict-pattern` | files, resolution |

## Local-First Option

If no CommandCode API key, taste runs locally:
- Stores in `.worktree-proof/taste/`
- Uses local embedding/model for pattern matching
- No external calls
- Full privacy

## Benefits

1. **Workflow learns your patterns** - How you structure tasks, delegate, recover
2. **Helpers get smarter** - Learn which scopes work, which tools you prefer
3. **Faster recovery** - Taste predicts best recovery strategy from history
4. **Team consistency** - Shared taste = consistent workflow execution
5. **Portable** - Take your workflow taste to any project

---

*Integrates CommandCode taste-1 continuous RL learning into WorktreeProof V3 immutable contracts, terminal ledgers, SAFE-3 breakers, and helper delegation.*