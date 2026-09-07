# Graphify + WorktreeProof Integration

> Reference for the graphify skill (installed in both Hermes and OpenCode).
> Created during: "Install graphify and create vector map" session (2026-08-19).

## Background execution (critical)

`graphify . --code-only` on large repos (>5000 files) **times out in foreground** because the 22K-node build plus clustering takes 5-15 minutes. Always run in background:

```bash
# Start in background
uv run --no-project graphify . --code-only

# Poll with wait
process(action='wait', session_id='<id>', timeout=300)
```

Or via terminal tool:
```bash
cd /c/VectorHQ/repos/system-health-probe
uv run --no-project graphify . --code-only  # returns job id
# Then poll process(action='wait', session_id='...')
```

## Two-repo workflow pattern

```
repoA (VectorHQ / system-health-probe)   ← graphify runs here
repoB (worktree-proof-workflow)           ← skills + CLI live here
```

- Register both as Hermes projects: `project_create` for each
- graphify skill installed to BOTH agents via `graphify install hermes` and `graphify install opencode`
- Graph output lives in `repoA/graphify-out/` — committed or cached per lane
- Session index lives in `repoB/docs/SESSION_INDEX.md` — lists all chats by category

## CLI patterns

| Command | Purpose |
|---------|---------|
| `uv run --no-project graphify . --code-only` | Build graph, skip LLM doc extraction |
| `uv run --no-project graphify cluster-only .` | Regenerate communities + report |
| `uv run --no-project graphify query "node"` | BFS traversal for context |
| `uv run --no-project graphify path "A" "B"` | Shortest path between concepts |
| `uv run --no-project graphify explain "node"` | Plain-language node description |
| `uv run --no-project graphify update .` | Incremental — re-extract only changed |

## Installation

```bash
git clone https://github.com/Graphify-Labs/graphify
cd graphify-repo
uv pip install -e ".[sql]"   # [sql] for tree-sitter-sql (335 SQL files in VectorHQ)
graphify install hermes      # installs skill to Hermes
graphify install opencode    # installs skill to OpenCode
```

## Integration with worktree-proof lanes

When opening a worktree-proof lane:
1. `graphify . --code-only` builds the knowledge graph (background)
2. `graphify query "thndr"` or `graphify path "worktree" "vectorhq"` navigates
3. `graphify cluster-only .` generates community report
4. `worktree-proof close` receipt can include a `graphify` summary
5. `fact_store` / `memory` persist any findings from the graph
