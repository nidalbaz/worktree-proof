#!/usr/bin/env python3
"""
Import chat history from Codex, Claude Desktop, OpenCode into Hermes Agent.
Run after: hermes setup (to initialize Hermes home)
"""

import json
import os
import sqlite3
import glob
from pathlib import Path
from datetime import datetime
import uuid

# ============================================================
# PATHS
# ============================================================
HERMES_HOME = Path(os.environ.get('HERMES_HOME', r'C:\Users\Nedal\AppData\Local\hermes'))
HERMES_MEMORIES = HERMES_HOME / 'memories'
HERMES_SKILLS = HERMES_HOME / 'skills'
HERMES_CONFIG = HERMES_HOME / 'config.yaml'

CODEX_SESSIONS = Path(r'C:\Users\Nedal\.codex\sessions')
CODEX_CONFIG = Path(r'C:\Users\Nedal\.codex\config.toml')
CODEX_MODELS_CACHE = Path(r'C:\Users\Nedal\.codex\models_cache.json')

CLAUDE_SESSIONS = Path(r'C:\Users\Nedal\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code-sessions')

OPENCODE_LEVELDB = Path(r'C:\Users\Nedal\AppData\Roaming\ai.opencode.desktop\Local Storage\leveldb')

# ============================================================
# HELPERS
# ============================================================
def ensure_dirs():
    HERMES_MEMORIES.mkdir(parents=True, exist_ok=True)
    HERMES_SKILLS.mkdir(parents=True, exist_ok=True)

def write_memory(category: str, content: str, metadata: dict | None = None):
    """Write a memory file in Hermes format."""
    mem_id = uuid.uuid4().hex[:12]
    timestamp = datetime.now().isoformat().replace(':', '-')
    filename = f"{timestamp}_{category}_{mem_id}.md"
    path = HERMES_MEMORIES / filename
    
    meta = metadata or {}
    frontmatter = {
        'id': mem_id,
        'category': category,
        'timestamp': timestamp,
        'source': meta.get('source', 'unknown'),
        'session_id': meta.get('session_id', ''),
        'model': meta.get('model', ''),
        'cwd': meta.get('cwd', ''),
    }
    
    with open(path, 'w', encoding='utf-8') as f:
        f.write('---\n')
        for k, v in frontmatter.items():
            f.write(f'{k}: {v}\n')
        f.write('---\n\n')
        f.write(content)
    
    return path

def write_skill(name: str, description: str, content: str, metadata: dict | None = None):
    """Write a skill file in Hermes format."""
    skill_dir = HERMES_SKILLS / name.lower().replace(' ', '-')
    skill_dir.mkdir(parents=True, exist_ok=True)
    
    skill_file = skill_dir / 'skill.md'
    meta = metadata or {}
    with open(skill_file, 'w', encoding='utf-8') as f:
        f.write(f'# {name}\n\n')
        f.write(f'{description}\n\n')
        f.write('---\n')
        f.write(f'created: {datetime.now().isoformat()}\n')
        for k, v in meta.items():
            f.write(f'{k}: {v}\n')
        f.write('---\n\n')
        f.write(content)
    
    return skill_file

# ============================================================
# CODEX IMPORT
# ============================================================
def import_codex_sessions():
    """Import Codex CLI sessions from JSONL rollout files."""
    print("Importing Codex sessions...")
    count = 0
    
    for year_dir in sorted(CODEX_SESSIONS.glob('*')):
        if not year_dir.is_dir():
            continue
        for month_dir in sorted(year_dir.glob('*')):
            if not month_dir.is_dir():
                continue
            for day_dir in sorted(month_dir.glob('*')):
                if not day_dir.is_dir():
                    continue
                for rollout_file in day_dir.glob('rollout-*.jsonl'):
                    try:
                        with open(rollout_file, 'r', encoding='utf-8') as f:
                            lines = f.readlines()
                        
                        if not lines:
                            continue
                        
                        # Parse session metadata from first line
                        first = json.loads(lines[0])
                        session_id = first.get('payload', {}).get('session_id', rollout_file.stem)
                        cwd = first.get('payload', {}).get('cwd', '')
                        model = first.get('payload', {}).get('model', 'unknown')
                        
                        # Extract conversation
                        messages = []
                        for line in lines:
                            try:
                                entry = json.loads(line)
                                if entry.get('type') == 'response_item':
                                    payload = entry.get('payload', {})
                                    if payload.get('type') == 'message':
                                        role = payload.get('role', '')
                                        content_parts = payload.get('content', [])
                                        text = ' '.join([p.get('text', '') for p in content_parts if p.get('type') == 'input_text'])
                                        if text:
                                            messages.append(f"**{role}**: {text}")
                            except:
                                pass
                        
                        if messages:
                            content = f"## Codex Session: {session_id}\n\n"
                            content += f"**CWD**: {cwd}\n"
                            content += f"**Model**: {model}\n\n"
                            content += "---\n\n"
                            content += '\n\n'.join(messages)
                            
                            write_memory('codex-session', content, {
                                'source': 'codex-cli',
                                'session_id': session_id,
                                'model': model,
                                'cwd': cwd,
                            })
                            count += 1
                    except Exception as e:
                        print(f"  Error reading {rollout_file}: {e}")
    
    print(f"  Imported {count} Codex sessions")
    return count

def import_codex_models():
    """Import Codex models cache as a skill."""
    print("Importing Codex models...")
    try:
        with open(CODEX_MODELS_CACHE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        models = data.get('models', [])
        content = f"# Codex Available Models\n\n"
        content += f"Fetched: {data.get('fetched_at', 'unknown')}\n"
        content += f"Client Version: {data.get('client_version', 'unknown')}\n\n"
        
        for m in models:
            content += f"## {m.get('display_name', m.get('slug', 'Unknown'))}\n"
            content += f"- **Slug**: {m.get('slug', 'N/A')}\n"
            content += f"- **Description**: {m.get('description', 'N/A')}\n"
            content += f"- **Default Reasoning**: {m.get('default_reasoning_level', 'N/A')}\n"
            content += f"- **Context Window**: {m.get('context_window', 'N/A')}\n"
            content += f"- **Supports Search**: {m.get('supports_search_tool', False)}\n"
            content += f"- **Tool Mode**: {m.get('tool_mode', 'N/A')}\n\n"
        
        write_skill('codex-models', 'Catalog of all Codex CLI available models with capabilities', content, {
            'source': 'codex-cli',
            'fetched_at': data.get('fetched_at', ''),
        })
        print("  Imported Codex models as skill")
    except Exception as e:
        print(f"  Error: {e}")

def import_codex_config():
    """Import Codex config as memory."""
    print("Importing Codex config...")
    try:
        with open(CODEX_CONFIG, 'r', encoding='utf-8') as f:
            content = f.read()
        
        write_memory('codex-config', f"## Codex CLI Configuration\n\n```toml\n{content}\n```", {
            'source': 'codex-cli',
            'type': 'config',
        })
        print("  Imported Codex config")
    except Exception as e:
        print(f"  Error: {e}")

# ============================================================
# CLAUDE DESKTOP IMPORT
# ============================================================
def import_claude_sessions():
    """Import Claude Desktop (Windows Store) sessions."""
    print("Importing Claude Desktop sessions...")
    count = 0
    
    for session_dir in CLAUDE_SESSIONS.glob('*'):
        if not session_dir.is_dir():
            continue
        for conv_dir in session_dir.glob('*'):
            if not conv_dir.is_dir():
                continue
            for json_file in conv_dir.glob('local_*.json'):
                try:
                    with open(json_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    
                    session_id = data.get('sessionId', json_file.stem)
                    title = data.get('title', 'Untitled')
                    model = data.get('model', 'unknown')
                    cwd = data.get('cwd', '')
                    created = data.get('createdAt', 0)
                    
                    # Convert timestamp
                    if created:
                        created_str = datetime.fromtimestamp(created / 1000).isoformat()
                    else:
                        created_str = 'unknown'
                    
                    # The conversation is likely in a different field or file
                    # For now, store metadata
                    content = f"## Claude Desktop Session: {title}\n\n"
                    content += f"**Session ID**: {session_id}\n"
                    content += f"**Model**: {model}\n"
                    content += f"**CWD**: {cwd}\n"
                    content += f"**Created**: {created_str}\n"
                    content += f"**Permission Mode**: {data.get('permissionMode', 'unknown')}\n\n"
                    content += "### Enabled MCP Tools\n\n"
                    for tool, enabled in data.get('enabledMcpTools', {}).items():
                        if enabled:
                            content += f"- {tool}\n"
                    
                    write_memory('claude-session', content, {
                        'source': 'claude-desktop',
                        'session_id': session_id,
                        'model': model,
                        'cwd': cwd,
                    })
                    count += 1
                except Exception as e:
                    print(f"  Error reading {json_file}: {e}")
    
    print(f"  Imported {count} Claude Desktop sessions")
    return count

# ============================================================
# OPENCODE IMPORT (LevelDB - basic attempt)
# ============================================================
def import_opencode():
    """Attempt to import OpenCode desktop data from LevelDB."""
    print("Attempting OpenCode import (LevelDB)...")
    # LevelDB requires plyvel or similar - skip for now, note location
    content = f"## OpenCode Desktop Data Location\n\n"
    content += f"**Path**: {OPENCODE_LEVELDB}\n"
    content += f"**Format**: LevelDB (requires plyvel to read)\n"
    content += f"**Note**: Contains localStorage/sessionStorage from OpenCode desktop app\n"
    content += f"Files: {list(OPENCODE_LEVELDB.glob('*'))}\n"
    
    write_memory('opencode-location', content, {
        'source': 'opencode-desktop',
        'type': 'reference',
    })
    print("  Noted OpenCode location (LevelDB not parsed)")

# ============================================================
# HERMES CONFIG UPDATE
# ============================================================
def update_hermes_config():
    """Update Hermes config with imported providers/models."""
    print("Updating Hermes config...")
    
    # Read current config
    config_path = HERMES_HOME / 'config.yaml'
    if config_path.exists():
        with open(config_path, 'r', encoding='utf-8') as f:
            config_content = f.read()
    else:
        config_content = ""
    
    # Add Token-Free Gateway if not present
    if 'token-free' not in config_content.lower() and '3457' not in config_content:
        gateway_config = """
# Token-Free Gateway (from Codex config)
model_providers:
  token_free_gateway:
    name: "Token-Free Gateway"
    base_url: "http://127.0.0.1:3457/v1"
    bearer_token: "any-string"
    models:
      # Claude models
      "Claude Sonnet 4": "claude-sonnet-4-20250514"
      "Claude Sonnet 4 (latest)": "claude-sonnet-4-6"
      "Claude Opus 4": "claude-opus-4-20250514"
      "Claude Opus 4 (latest)": "claude-opus-4-6"
      "Claude Haiku 4": "claude-haiku-4-20250514"
      "Claude Haiku 4 (latest)": "claude-haiku-4-6"
      # OpenAI models
      "GPT-4": "gpt-4"
      "GPT-4 Turbo": "gpt-4-turbo"
      "GPT-3.5 Turbo": "gpt-3.5-turbo"
      # DeepSeek models
      "DeepSeek V3 (Chat)": "deepseek-chat"
      "DeepSeek R1 (Reasoner)": "deepseek-reasoner"
"""
        with open(config_path, 'a', encoding='utf-8') as f:
            f.write(gateway_config)
        print("  Added Token-Free Gateway to Hermes config")
    else:
        print("  Token-Free Gateway already in config")

# ============================================================
# MAIN
# ============================================================
def main():
    print("=" * 60)
    print("IMPORTING CHAT HISTORY TO HERMES AGENT")
    print("=" * 60)
    print(f"Hermes Home: {HERMES_HOME}")
    print()
    
    ensure_dirs()
    
    # Import from all sources
    import_codex_sessions()
    import_codex_models()
    import_codex_config()
    import_claude_sessions()
    import_opencode()
    update_hermes_config()
    
    print()
    print("=" * 60)
    print("IMPORT COMPLETE")
    print("=" * 60)
    print(f"Memories: {HERMES_MEMORIES}")
    print(f"Skills: {HERMES_SKILLS}")
    print(f"Config: {HERMES_CONFIG}")
    print()
    print("Next steps:")
    print("  1. Run: hermes")
    print("  2. Use /skills to see imported skills")
    print("  3. Use /memory to browse imported memories")

if __name__ == '__main__':
    main()