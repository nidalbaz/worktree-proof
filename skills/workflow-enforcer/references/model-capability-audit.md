## Model Capability Audit & Skill/Plugin/MCP Catalog

**Last updated:** 2026-08-21 (session end)

### Problem
Weak/free-tier models (e.g. `poolside/laguna-s-2.1:free` via `nous` provider) silently drop `skill_view`, `skills_list`, and plugin/tool calls when under token pressure. Skills like `complete-workflow` only activate when the model emits the tool call — so they get skipped entirely.

### Solution: Runtime Injection Layer
The `workflow-enforcer` skill injects the complete-workflow preamble as a **system instruction** (not an optional tool call) on every turn. Models that skip native `skill_view` calls are caught by the post-turn validator.

### Config.yaml changes applied this session
1. **Injected enforcer preamble** into `agent.personalities.default.instructions` (first entries, before taste block)
2. **Switched model** from `poolside/laguna-s-2.1:free` → `deepseek-v4-pro` (provider: `opencode-go`) — better tool-call reliability
3. **Set reasoning_effort** from `medium` → `high` — stronger function-calling coherence
4. **Kept max_turns: 500** — long sessions persist without mid-session resets

### Model ranking for tool-calling reliability (free tier, most-recent first)
| Provider | Model | Tool-call reliability | Free tier | Notes |
|---|---|---|---|---|
| opencode-go | deepseek-v4-pro | ⭐⭐⭐⭐⭐ | ✅ | Best free tool calling |
| opencode-go | kimi-k3 | ⭐⭐⭐⭐ | ✅ | Strong, good fallback |
| baichat | deepseek-v4-pro | ⭐⭐⭐⭐ | ✅ | Via api.b.ai |
| aihubmix | gemini-3.7-flash | ⭐⭐⭐⭐ | ✅ | 3.9 GB context |
| zenmux | deepseek-v4-flash | ⭐⭐⭐ | ✅ | Decent |
| token_free_gateway | opencode-zen/* | ⭐⭐⭐ | ✅ | Pooled, web-cracked |
| nvidia | z-ai/glm-5.2 | ⭐⭐⭐ | ✅ | 128K context |
| nous | poolside/laguna-s-2.1:free | ⭐⭐ | ✅ | Drops tool calls under pressure |
| orcarouter | qwen3.5-flash | ⭐⭐ | ✅ | Weak tool calling |

### Skill catalog
| Skill name | Provider | Use case | Loaded this session? |
|---|---|---|---|
| complete-workflow | bundled | L99 workflow (goal→contract→plan→reserve→run→evidence→review→merge→release) | ✅ Updated |
| workflow-enforcer | curator (new) | Runtime injection layer forcing workflow on every turn | ✅ Created |
| worktree-proof-stack | worktree-proof-workflow | Safe parallel lane execution, reservation, closure | ✅ Read |
| hermes-config-yaml-management | hermes-agent | Config.yaml editing, MCP troubleshooting | ✅ Read |
| token-efficient-context | worktree-proof-workflow | Minimize context overhead | Referenced via extra_skills_paths |
| taste-integration | worktree-proof-workflow | Apply user taste preferences | Referenced via extra_skills_paths |
| screenshot-reader | worktree-proof-workflow | OCR via screenshot for UI state | Referenced via extra_skills_paths |
| tool-call-repair | worktree-proof-workflow | Auto-repair failed tool calls | Referenced via extra_skills_paths |
| dynamic-orchestrator | worktree-proof-workflow | Decompose tasks into parallelizable substeps | Referenced via extra_skills_paths |
| worktree-proof | worktree-proof-workflow | CLI lane management | Referenced via extra_skills_paths |
| protocol-client | worktree-proof-workflow | WorktreeProof manifest negotiation | Referenced via extra_skills_paths |
| ui-proof-loop | worktree-proof-workflow | Verify UI screens with recorded evidence | Referenced via extra_skills_paths |
| resource-efficient-coding | worktree-proof-workflow | Bounded CPU/RAM/disk/concurrency | Referenced via extra_skills_paths |
| safe-parallel-delegation | worktree-proof-workflow | Safe multi-agent delegation | Referenced via extra_skills_paths |
| best-practice-guard | worktree-proof-workflow | Stack-aware security/accessibility/compatibility | Referenced via extra_skills_paths |
| omnibus-maintainer | worktree-proof-workflow | Route OSS maintenance work | Referenced via extra_skills_paths |

### Plugin catalog
| Plugin | Type | Use case | Enabled? |
|---|---|---|---|
| browser/browser_use | MCP | Browser automation on port 9333 | ✅ |
| computer_use | native | Desktop GUI control (non-disruptive) | ✅ |
| google_meet | native | Google Meet integration | ✅ |
| web/ddgs | native | DuckDuckGo search | ✅ |
| web/firecrawl | native | Web scraping → readable text | ✅ |

### MCP server catalog
| Server | Transport | Use case | Enabled? | Token source |
|---|---|---|---|---|
| node_repl | stdio | Browser Use CLI relay on port 9333 | ✅ | — |
| sentry | OAuth/SSE | Sentry issue/event inspection | ✅ | oauth |
| supabase | OAuth/SSE | Supabase DB management + best practices | ✅ | oauth |
| vercel | OAuth/SSE | Vercel deployment + optimization | ✅ | oauth |
| worktree-proof | stdio | Lane management, goal/plan/reserve/run | ✅ | — |

### Swarm model routing (from config.yaml)
```
delegation.subagent_providers (priority order):
  1. command-code (port 3457)
  2. token_free_gateway (port 10100)
  3. model_pool (port 3462)
  4. baichat (api.b.ai)
  5. nous (inference-api.nousresearch.com)
  6. nvidia (integrate.api.nvidia.com)
  7. aihubmix (api.aihubmix.com)
  8. zenmux (zenmux.ai)
  9. opencode-go (opencode.ai/zen/go)
  10. orcarouter (api.orcarouter.ai)
```
Fallback model: `deepseek-v4-flash` via `model_pool`.

### Post-turn validator
The `workflow-enforcer` skill embeds a post-turn check: if `skill_view` calls for `complete-workflow` and `workflow-enforcer` are not present in the model's output, the harness re-injects:

> **MISSING WORKFLOW STEP DETECTED**: You must call `skill_view(name='complete-workflow')` and `skill_view(name='workflow-enforcer')` before proceeding. These are mandatory on every turn.
