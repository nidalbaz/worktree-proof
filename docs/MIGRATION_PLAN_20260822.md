# Full Workflow Migration Plan — Command Code Desktop App
**Date:** 2026-08-22  
**Scope:** Migrate entire multi-agent workflow from all source environments into the Command Code desktop app
**Status:** Planning

---

## 0. Executive Summary

The Command Code desktop app is installed and partially configured at `C:\Users\Nedal\AppData\Local\Programs\Command Code\` with its `~/.commandcode/` config directory already created. Significant migration groundwork has been laid (config.toml, taste, session directory structure, hermes-harness-state.json) but the full migration is incomplete:

- **Chat history** from 6+ tools has NOT been imported
- **MCP servers** are only defined in config.toml (TOML), not in the `mcp.json` format the app uses for dynamic MCP management
- **Skills** from Claude Code (286 dirs), Hermes (43+ dirs), and Codex (16 dirs) need consolidation
- **API key pools** exist in Hermes `.env` but are not set as Windows environment variables
- **AGENTS.md / system instructions** need consolidation across all tools

---

## 1. Current State of Command Code Desktop App

### App Installation
- **Location:** `C:\Users\Nedal\AppData\Local\Programs\Command Code\resources\app`
- **Version:** 0.1.16
- **Underlying framework:** `@commandcode/harness` (fork of OpenCode harness)
- **App data dir:** `C:\Users\Nedal\AppData\Roaming\Command Code\`
  - `app-state.json` — Electron store (threads, projects, model, auth)
  - `thread-index.db` — SQLite database (sidebar thread index)
  - `main.log` — App logs
- **OpenCode-style data:** `C:\Users\Nedal\AppData\Roaming\ai.opencode.desktop\`
  - `opencode.global.dat` — Electron store (sessions, models, layout, notifications)
  - `opencode.settings` — Settings
  - `opencode.workspace.*.dat` — 4 workspace files (2 projects × 2 variants)

### Existing `~/.commandcode/` Config (already created)
- **`config.toml`** — Model providers, MCP servers, projects, desktop settings
  - `openai_base_url = "http://127.0.0.1:3462/v1"` (model_pool proxy)
  - MCP: `node_repl` configured in TOML
  - Model providers: `aihubmix`, `zenmux`, `opencode-go`, `baichat`, `nvidia`, `nous`, `model_pool`, `token_free_gateway`
  - Projects: `system-health-probe`, `worktree-proof-workflow` (both trusted)
- **`taste/taste.md`** — 7 taste rules already present
- **`history.jsonl`** — Session history (recent prompts)
- **`hermes-harness-state.json`** — Hermes-to-harness sync state (version 987256ab38bf7873, last applied 2026-08-22)
- **`projects/`** — Session storage directory structure:
  - `c-vector-hq-worktree-proof-workflow/` (active thread LTLqt1HXB14dII9YPumSS exists)
  - `c-users-nedal/` (multiple sessions with .jsonl, .meta.json, .checkpoints.jsonl, file-history/)
  - `c-vector-hq-repos-system-health-probe/`
  - `c-vector-hq-repos/`
- **`updates.json`** — Update state

### App Session Format
Command Code sessions are **JSONL** with this structure:
```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"C:\\..."}
{"type":"message","id":"<shortid>","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]},"meta":{"source":"user","createdAt":...,"messageId":"..."}}
{"type":"message","id":"<shortid>","parentId":"...","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":""},{"type":"text","text":"..."}]},"usage":{"inputTokens":...,"outputTokens":...,"model":"poolside/laguna-s-2.1-free"}}
```
- Session files: `<dir>/<uuid>.jsonl`
- Metadata: `<uuid>.meta.json` (title, traceIds, compaction info, entrypoint)
- Checkpoints: `<uuid>.checkpoints.jsonl`
- File history: `file-history/<uuid>/<content-hash>`
- Thread index (sidebar): SQLite at `thread-index.db`

### App User State
- **User:** Nedal (n.m.elbaz@xed.aucegypt.edu, username: Nedal7707)
- **Plan:** individual-go
- **Active thread:** `LTLqt1HXB14dII9YPumSS` at `C:\VectorHQ\worktree-proof-workflow`
- **Model:** `poolside/laguna-s-2.1-free` via `nous` provider
- **Subagent model:** `gpt-5.6-luna` at `max` reasoning with `fast` service tier
- **Permission mode:** auto (auto-accept)

---

## 2. Source Environment Inventory

### 2.1 Hermes Desktop App
**Location:** `C:\Users\Nedal\AppData\Local\hermes\` (app data) + `C:\Users\Nedal\AppData\Roaming\Hermes\` (session DB)

| Component | Files | Notes |
|-----------|-------|-------|
| **Config** | `config.yaml` (v37), `.env`, `auth.json` | 40+ config backups showing evolution |
| **Sessions** | `sessions/` (213 `request_dump_*.json`), `session.db` (SQLite in Roaming) | JSON request/response dumps |
| **Session Index** | `codex_session_index.jsonl` (944+ entries) | Tracks external session imports |
| **Session Imports** | `external_agent_session_imports.json` | Already tracked Claude Code imports |
| **Skills** | `skills/` (43+ directories) | Includes migration helpers |
| **MCP Tokens** | `mcp-tokens/` (sentry, supabase, verlify) | OAuth tokens for MCP servers |
| **API Keys** | `.env` | All key pools (see Section 2.7) |
| **Key Health** | `provider_key_health.json` | Rate-limited: baichat. OK: nvidia, opencode_go, aihubmix, zenmux |
| **Memories** | `memory_store.db` (SQLite), `.hermes/memory/` (AGENTS.md, etc.) | |
| **State** | `state.db`, `holographic_memory.db`, `projects.db`, `verification_evidence.db` | Multiple SQLite databases |

### 2.2 OpenAI Codex CLI
**Location:** `C:\Users\Nedal\.codex\`

| Component | Files | Notes |
|-----------|-------|-------|
| **Config** | `config.toml` (197 lines) | OpenAI base URL at port 10100 (TFG), MCP node_repl, model_providers.gateway, plugins, projects |
| **Sessions** | `sessions/2026/07/` + `sessions/2026/08/` (778 JSONL files) | `rollout-*.jsonl` format with session_meta, event_msg, response_item |
| **Session DB** | `sqlite/codex-dev.db`, `state_5.sqlite` | SQLite databases |
| **Session Index** | `session_index.jsonl` | |
| **Skills** | `skils/`, `skills-archive/` | |
| **Memories** | `memories/` | |
| **History** | `history.jsonl` | |
| **Models** | `models_cache.json` | |

### 2.3 Claude Code
**Location:** `C:\Users\Nedal\.claude\`

| Component | Files | Notes |
|-----------|-------|-------|
| **Config** | `settings.json`, `CLAUDE.md` | Claude Flow hooks, env vars, permissions, model: claude-opus-4-8 |
| **Sessions** | `projects/C--Users-Nedal-Documents-Vector/` (16 JSONL), `projects/C--VectorHQ-repos-system-health-probe/` (12 JSONL) | Claude native JSONL format |
| **Memories** | `projects/*/memory/` | |
| **Skills** | `skills/` (286 directories) | |
| **Commands** | `commands/` | claude-flow integration commands |
| **Agents** | `agents/` | Custom agents |
| **Plans** | `plans/` | Claude plans |

### 2.4 Claude Desktop (Store app)
**Location:** `C:\Users\Nedal\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`

| Component | Files | Notes |
|-----------|-------|-------|
| **Config** | `claude_desktop_config.json`, `config.json` | Preferences, account ID: cfa1add7-..., no MCP servers listed directly |
| **Sessions** | `claude-code-sessions/cfa1add7-.../de6b133d.../local_*.json` (37 JSON files) | Claude Desktop conversation format |
| **IndexedDB** | `IndexedDB/` | Conversation transcripts stored in IndexedDB |
| **Memory** | `memory/` | |

### 2.5 OpenCode Desktop (= Command Code Desktop app)
Already covered above. The Command Code desktop app IS the OpenCode desktop app (rebranded fork). Sessions are stored in `~/.commandcode/projects/<slug>/` as JSONL.

### 2.6 ChatGPT
**Location:** Chrome IndexedDB at `C:\Users\Nedal\AppData\Local\Google\Chrome\User Data\Default\IndexedDB\https_chatgpt.com_0.indexeddb.leveldb\`
- Binary leveldb format — requires LevelDB reader to extract
- No ChatGPT desktop app found in `Programs/`

### 2.7 API Key Pools (from Hermes `.env`)
```
AIHUBMIX_API_KEY_1 through 8 (sk-...)
BAICHAT_API_KEY (rate_limited)
NVIDIA_API_KEY_1 through 4
OPENCODE_API_KEY
OPENCODE_ZEN_1 through 8
ORCAROUTER_API_KEY_1 through 9
ZENMUX_API_KEY
CLOUDFLARE_API_KEY
COMMANDCODE_API_KEY
```
Model gateway ports:
- **Port 10100:** Token-Free Gateway (web-cracked models only)
- **Port 3457:** Command Code bridge (local)
- **Port 3458:** Cloudflare gateway
- **Port 3460:** OpenCode Go gateway
- **Port 3461:** OrcaRouter gateway
- **Port 3462:** Model Pool (Python proxy with key pool rotation)

### 2.8 Skills Inventory
| Source | Location | Count | Notes |
|--------|----------|-------|-------|
| Hermes | `AppData\Local\hermes\skills\` | 43+ | Includes migration helpers, opencode-session-reader, worktree-proof, complete-workflow |
| Claude Code | `~/.claude/skills/` | 286 | |
| Codex | `~/.codex/skils/` | 16 | Core skills (best-practice-guard, etc.) |
| Worktree-Proof | `C:\VectorHQ\worktree-proof-workflow\skills/` | ~10 | Vector HQ specific |

### 2.9 MCP Servers (across all sources)
| MCP Server | Source | Config Format |
|-----------|--------|---------------|
| node_repl | Codex CLI, Command Code | TOML `[mcp_servers.node_repl]` |
| sentry | Hermes, Claude Desktop | mcp-tokens/sentry.client.json |
| supabase | Hermes, Claude Desktop | mcp-tokens/supabase.client.json |
| vercel | Hermes, Claude Desktop | mcp-tokens/vercel.client.json |
| worktree-proof | Hermes config.yaml | Referenced in config |
| claude-flow | Claude Code | Via Claude Flow hooks |

---

## 3. Migration Phases

### Phase 1: Audit & Inventory (1-2 hours)
Complete gap analysis of what exists where.

**Deliverables:**
- [ ] Inventory all session files across all 6 sources (count, format, approximate content)
- [ ] Inventory all skills across all sources (with deduplication analysis)
- [ ] Inventory MCP server configurations with OAuth token locations
- [ ] Inventory API key usage (which keys are active, which are rate-limited)
- [ ] Document session format differences (source → Command Code JSONL mapping)

**Key Actions:**
1. Read `external_agent_session_imports.json` for existing import tracking
2. Read `codex_session_index.jsonl` (944+ entries) for session metadata
3. Read the Hermes migration skill files for format conversion logic
4. Sample-read one session from each source to map format differences
5. Count skills in each location and identify name conflicts

### Phase 2: Key Pools & Environment Variables (1-2 hours)
Set up API keys as Windows environment variables so the Command Code app can access them.

**Source:** Hermes `.env` file
**Target:** Windows user environment variables

**Deliverables:**
- [ ] Set all API key environment variables (AIHUBMIX, NVIDIA, OPENCODE, ORCAROUTER, ZENMUX, CLOUDFLARE, BAICHAT, COMMANDCODE_API_KEY)
- [ ] Verify key health against provider APIs (3-layer verification per taste)
- [ ] Generate `~/.commandcode/settings.json` with model selection config
- [ ] Verify model pool proxy at port 3462 is running and accessible

**Key Actions:**
1. Parse Hermes `.env` for all API keys
2. Set Windows environment variables via `setx` or PowerShell
3. Verify each key against its provider API (throwaway test scripts, cleaned up per taste)
4. Update `settings.json` with active model/provider defaults

### Phase 3: MCP Servers & Skills (3-4 hours)

#### 3A: MCP Server Configuration
**Source:** 
- `config.toml` `[mcp_servers.node_repl]`
- Hermes `mcp-tokens/` directory (sentry, supabase, vercel tokens)
- Claude Desktop `claude_desktop_config.json`
- Worktree-proof `.claude/settings.json` (hooks-based MCP)
- Hermes `config.yaml` (MCP server definitions)

**Target:** `~/.commandcode/mcp.json` (or update config.toml)

**Format:**
```json
{
  "mcpServers": {
    "server-name": {
      "command": "...",
      "args": [...],
      "env": {...},
      "url": "..." (for SSE)
    }
  }
}
```

**Deliverables:**
- [ ] Create `~/.commandcode/mcp.json` with all MCP servers consolidated
- [ ] Copy MCP OAuth tokens to `~/.commandcode/mcp-tokens.json`
- [ ] Verify each MCP server starts and provides tools
- [ ] Configure project-level MCP (worktree-proof-workflow, system-health-probe)

#### 3B: Skills Consolidation
**Source:** 286 Claude Code skills, 43+ Hermes skills, 16 Codex skills, ~10 worktree-proof skills

**Target:** `~/.commandcode/skills/`

**Deliverables:**
- [ ] Deduplicate skills by name (resolve conflicts — newer wins)
- [ ] Copy all unique skills to `~/.commandcode/skills/`
- [ ] Verify skill loading in the app
- [ ] Document any skills that failed to load

**Key Actions:**
1. Build skill manifest (name → source path → version)
2. For conflicts, prefer Hermes skills (most curated) over Claude Code
3. Copy skills using robocopy or PowerShell
4. Restart app and verify skill loading

### Phase 4: Chat History Import (4-6 hours)

This is the largest phase. Six source formats need conversion to Command Code JSONL format.

#### 4.1 Session Format Mapping

**Command Code JSONL format:**
```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"<path>"}
{"type":"message","id":"<shortid>","parentId":null,"timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]},"meta":{"source":"user","createdAt":<epoch>,"messageId":"..."}}
{"type":"message","id":"<shortid>","parentId":"...","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","signature":""},{"type":"text","text":"..."}]},"usage":{"inputTokens":N,"outputTokens":N,"model":"..."}}
{"type":"message","id":"<shortid>","parentId":"...","timestamp":"...","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"..."}]}]}}
```

**Source formats:**

1. **Claude Code JSONL** (`.claude/projects/*/UUID.jsonl`):
   - Entry types: `session_meta`, `response_item`, `event_msg`
   - Messages: `{"role":"user|assistant|system","content":[...]}`
   - Content items: `{"type":"text","text":"..."}`, `{"type":"tool_use",...}`, `{"type":"tool_result",...}`
   - **Conversion:** Map `role: "user"` → `role: "user"`, `role: "assistant"` → `role: "assistant"`, strip `session_meta` entries, map tool_result parent IDs

2. **Codex CLI JSONL** (`.codex/sessions/2026/08/14/rollout-*.jsonl`):
   - Entry types: `session_meta`, `event_msg`, `response_item`
   - `session_meta` has: `session_id`, `cwd`, `originator: "codex-tui"`, `model_provider`, `cli_version`
   - `response_item` has: `role: "developer|user|assistant"`, `content: [...]`
   - **Conversion:** Map role "developer" → "system", map session_meta to session header

3. **OpenCode SQLite** (`~/.local/share/opencode/opencode.db`):
   - Tables: `session` (id, slug, directory, title, model), `message` (id, session_id, data JSON), `part` (id, message_id, data JSON)
   - `message.data`: `{"role":"user|assistant|system","agent":"...","model":{...}}`
   - `part.data`: `{"type":"text","text":"..."}`
   - **Conversion:** Query SQLite, reconstruct message chains, convert to JSONL

4. **Hermes sessions** (`sessions/request_dump_*.json`):
   - JSON objects with request/response dumps
   - Need to parse conversation flow from request/response pairs
   - **Conversion:** Extract message roles and content, convert to JSONL

5. **Claude Desktop** (`claude-code-sessions/*/*.json`):
   - JSON files with conversation data
   - Need to map to Command Code JSONL format
   - **Conversion:** Parse JSON, extract message content, convert

6. **ChatGPT** (Chrome IndexedDB):
   - LevelDB binary format
   - Requires `level` npm package or `ldb` tool to read
   - **Conversion:** Read leveldb, extract ChatGPT conversations, convert to JSONL

#### 4.2 Project Mapping

| Source Project | Command Code Project Slug |
|----------------|--------------------------|
| `C:\VectorHQ\worktree-proof-workflow` | `c-vector-hq-worktree-proof-workflow` |
| `C:\Users\Nedal` (home) | `c-users-nedal` |
| `C:\VectorHQ\repos\system-health-probe` | `c-vector-hq-repos-system-health-probe` |
| `C:\Users\Nedal\Documents\Vector` | `c-users-nedal-documents-vector` |
| `C:\VectorHQ` (root) | `c-vector-hq` |

#### 4.3 Thread Index Updates

Each imported session needs to be registered in the thread index SQLite database (`C:\Users\Nedal\AppData\Roaming\Command Code\thread-index.db`). This requires:
- Inserting into the appropriate table (likely `threads` or `sessions`)
- Columns: id, project_path, title, last_message, model, created_at, updated_at, etc.
- Need to read existing schema from the DB

#### Deliverables:
- [ ] Import all Claude Code sessions (~38 files) → `~/.commandcode/projects/*/`
- [ ] Import all Codex CLI sessions (~778 files from archived + active) → `~/.commandcode/projects/*/`
- [ ] Import all OpenCode SQLite sessions (161 sessions, 15K+ messages) → `~/.commandcode/projects/*/`
- [ ] Import all Hermes sessions (213 request dumps) → `~/.commandcode/projects/*/`
- [ ] Import all Claude Desktop sessions (37 JSON files) → `~/.commandcode/projects/*/`
- [ ] Import all ChatGPT sessions (Chrome IndexedDB) → `~/.commandcode/projects/c-users-nedal/`
- [ ] Update thread-index.db for each imported session
- [ ] Create `.meta.json` files for each session

### Phase 5: Memories, Agents & System Instructions (2-3 hours)

#### 5A: Memories
- **Hermes:** `memory_store.db` (SQLite), `.hermes/memory/` (AGENTS.md, MEMORY.md)
- **Claude Code:** `memories/` in `.codex/`, project memory files
- **Codex:** `memories/` directory
- **Command Code target:** `~/.commandcode/memories/` or app-level memory storage

#### 5B: AGENTS.md Consolidation
Multiple AGENTS.md files exist:
- `C:\Users\Nedal\.claude\CLAUDE.md` — Ruflo integration instructions
- `C:\Users\Nedal\.codex\config.toml` — (no AGENTS.md)
- `C:\VectorHQ\worktree-proof-workflow\AGENTS.md` — The 50K+ byte Vector HQ AGENTS.md (canonical)
- `C:\VectorHQ\worktree-proof-workflow\CLAUDE.md` — CLAUDE.md for the repo
- Hermes `.hermes/memory/` files

**Target:** Consolidate into `~/.commandcode/AGENTS.md`

#### 5C: Custom Agents
- **Claude Code:** `~/.claude/agents/`
- **Command Code target:** `~/.commandcode/agents/`

#### Deliverables:
- [ ] Import all memories to `~/.commandcode/`
- [ ] Consolidate AGENTS.md from all sources
- [ ] Import custom agents
- [ ] Verify system prompt is correct in the app

### Phase 6: Verification & Testing (1-2 hours)

#### 6.1 Three-Layer Verification (per taste rules)
1. **Direct provider API verification** — Test each API key against its provider endpoint
2. **Proxy/gateway layer** — Verify requests route through ports 3462/10100 correctly
3. **End-to-end through Command Code** — Send a test message with tool use

#### 6.2 Session Verification
- [ ] Verify all imported sessions appear in the sidebar (thread index)
- [ ] Open 3 sample sessions from each source to verify conversation integrity
- [ ] Verify session timestamps and metadata are correct

#### 6.3 MCP Verification
- [ ] Verify each MCP server provides its tools in the Command Code app
- [ ] Test MCP tools are functional (not just listed)

#### 6.4 Skill Verification
- [ ] Verify all skills appear in the skills list
- [ ] Test 3-5 key skills for functionality

#### Deliverables:
- [ ] Verification report with pass/fail for each component
- [ ] Fix any issues discovered during verification
- [ ] Document final state of `~/.commandcode/`

---

## 4. Session Conversion Scripts

Per the taste rule "Writes throwaway test scripts for component-level verification and cleans them up afterward", I will create conversion scripts in the scratchpad directory:

| Source | Script | Output |
|--------|--------|--------|
| Claude Code JSONL | `convert_claudecode_jsonl.py` | Command Code JSONL |
| Codex JSONL → CC JSONL | `convert_codex_jsonl.py` | Command Code JSONL |
| OpenCode SQLite → CC JSONL | `convert_opencode_sqlite.py` | Command Code JSONL |
| Hermes dumps → CC JSONL | `convert_hermes_dumps.py` | Command Code JSONL |
| Claude Desktop → CC JSONL | `convert_claude_desktop.py` | Command Code JSONL |
| ChatGPT leveldb → CC JSONL | `convert_chatgpt_leveldb.py` | Command Code JSONL |
| Thread index updater | `update_thread_index.py` | SQLite inserts |

**Output locations:**
- Sessions: `C:\Users\Nedal\.commandcode\projects/<slug>/`
- Metadata: `<session_id>.meta.json` alongside each JSONL
- Thread index: `C:\Users\Nedal\AppData\Roaming\Command Code\thread-index.db`

---

## 5. Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| ChatGPT IndexedDB is unreadable (binary leveldb) | Try `level` npm package; if that fails, document as unrecoverable and archive |
| Claude Desktop IndexedDB is binary format | If JSON files parse correctly, that's sufficient; IndexedDB as fallback |
| OpenCode SQLite schema is unknown | Read schema via Python sqlite3 module before conversion |
| 778 Codex sessions may include duplicates with OpenCode DB | Deduplicate by session_id hash before import |
| MCP token auth for sentry/supabase/vercel | Copy from Hermes `mcp-tokens/` and test each |
| API keys may be expired | Test each key with 3-layer verification before relying on it |
| Thread index DB schema mismatch | Read existing schema before inserting; if incompatible, recreate |
| Environment variable changes need app restart | Plan for full app restart after key setup |

---

## 6. Execution Order

```
Phase 1: Audit & Inventory  →  Phase 2: Keys & Env Vars  →  Phase 3: MCP & Skills
     ↓
Phase 4: Chat History Import (largest) →  Phase 5: Memories & AGENTS  →  Phase 6: Verification
```

**Estimated total effort:** 11-18 hours of focused work
