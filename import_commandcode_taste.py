#!/usr/bin/env python3
"""
Import CommandCode taste-1 data and provider into Hermes Agent.
Also adds WorktreeProof workflow as a skill.
"""

import json
import os
import shutil
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

COMMANDCODE_HOME = Path(r'C:\Users\Nedal\.commandcode')
COMMANDCODE_TASTE = COMMANDCODE_HOME / 'taste'
COMMANDCODE_CONFIG = COMMANDCODE_HOME / 'config.json'
COMMANDCODE_HISTORY = COMMANDCODE_HOME / 'history.jsonl'
COMMANDCODE_SETTINGS = COMMANDCODE_HOME / 'settings.json'

WORKTREE_PROOF = Path(r'C:\VectorHQ\worktree-proof-workflow')

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
# COMMANDCODE TASTE IMPORT
# ============================================================
def import_commandcode_taste():
    """Import CommandCode taste-1 learned preferences."""
    print("Importing CommandCode taste-1 data...")
    count = 0
    
    # Global taste packages
    global_taste = COMMANDCODE_TASTE / 'cli'
    if global_taste.exists():
        for taste_file in global_taste.glob('**/taste.md'):
            try:
                content = taste_file.read_text(encoding='utf-8')
                rel = taste_file.relative_to(COMMANDCODE_TASTE)
                category = str(rel.parent).replace('\\', '/')
                
                write_memory('commandcode-taste', f"## CommandCode Taste: {category}\n\n{content}", {
                    'source': 'commandcode-taste',
                    'category': category,
                    'type': 'global',
                })
                count += 1
            except Exception as e:
                print(f"  Error reading {taste_file}: {e}")
    
    # Project taste packages (vector-hq-agents)
    project_taste = COMMANDCODE_TASTE / 'vector-hq-agents' / '.commandcode' / 'taste'
    if project_taste.exists():
        for taste_file in project_taste.glob('**/taste.md'):
            try:
                content = taste_file.read_text(encoding='utf-8')
                rel = taste_file.relative_to(project_taste)
                category = str(rel.parent).replace('\\', '/')
                
                write_memory('commandcode-taste', f"## CommandCode Project Taste: {category}\n\n{content}", {
                    'source': 'commandcode-taste',
                    'category': category,
                    'type': 'project',
                    'project': 'vector-hq-agents',
                })
                count += 1
            except Exception as e:
                print(f"  Error reading {taste_file}: {e}")
    
    # Skills from taste
    skills_dir = COMMANDCODE_TASTE / 'vector-hq-agents' / 'skills' / 'skills'
    if skills_dir.exists():
        for skill_dir in skills_dir.iterdir():
            if skill_dir.is_dir():
                skill_md = skill_dir / 'SKILL.md'
                if skill_md.exists():
                    try:
                        content = skill_md.read_text(encoding='utf-8')
                        skill_name = skill_dir.name
                        
                        write_skill(f'commandcode-{skill_name}', 
                            f'CommandCode learned skill: {skill_name}', content, {
                            'source': 'commandcode-taste',
                            'original_skill': skill_name,
                        })
                        count += 1
                    except Exception as e:
                        print(f"  Error reading skill {skill_dir}: {e}")
    
    print(f"  Imported {count} CommandCode taste items")
    return count

def import_commandcode_config():
    """Import CommandCode config and history."""
    print("Importing CommandCode config...")
    count = 0
    
    # Config
    if COMMANDCODE_CONFIG.exists():
        try:
            content = COMMANDCODE_CONFIG.read_text(encoding='utf-8')
            write_memory('commandcode-config', f"## CommandCode Config\n\n```json\n{content}\n```", {
                'source': 'commandcode',
                'type': 'config',
            })
            count += 1
        except Exception as e:
            print(f"  Error reading config: {e}")
    
    # History
    if COMMANDCODE_HISTORY.exists():
        try:
            lines = COMMANDCODE_HISTORY.read_text(encoding='utf-8').splitlines()
            recent = lines[-50:]  # Last 50 entries
            content = f"## CommandCode History (last 50 entries)\n\n"
            for line in recent:
                try:
                    entry = json.loads(line)
                    content += f"- {entry.get('timestamp', '')}: {entry.get('type', '')} - {entry.get('message', '')[:200]}\n"
                except:
                    pass
            
            write_memory('commandcode-history', content, {
                'source': 'commandcode',
                'type': 'history',
            })
            count += 1
        except Exception as e:
            print(f"  Error reading history: {e}")
    
    # Settings
    if COMMANDCODE_SETTINGS.exists():
        try:
            content = COMMANDCODE_SETTINGS.read_text(encoding='utf-8')
            write_memory('commandcode-settings', f"## CommandCode Settings\n\n```json\n{content}\n```", {
                'source': 'commandcode',
                'type': 'settings',
            })
            count += 1
        except Exception as e:
            print(f"  Error reading settings: {e}")
    
    print(f"  Imported {count} CommandCode config items")
    return count

def add_commandcode_provider():
    """Add CommandCode provider to Hermes config."""
    print("Adding CommandCode provider to Hermes config...")
    
    config_path = HERMES_CONFIG
    if config_path.exists():
        content = config_path.read_text(encoding='utf-8')
    else:
        content = ""
    
    # Check if already present
    if 'commandcode' not in content:
        provider_config = """

# CommandCode Provider (from CommandCode CLI)
model_providers:
  commandcode:
    name: "CommandCode"
    base_url: "https://api.commandcode.ai/provider/v1"
    env_vars: ["COMMANDCODE_API_KEY", "COMMANDCODE_BASE_URL"]
    display_name: "CommandCode"
    description: "CommandCode - 20+ models via OpenAI-compatible API"
    signup_url: "https://commandcode.ai/"
    models_url: "https://api.commandcode.ai/provider/v1/models"
    fallback_models:
      - "deepseek/deepseek-v4-pro"
      - "deepseek/deepseek-v4-flash"
      - "Qwen/Qwen3.7-Max"
      - "Qwen/Qwen3.6-Plus"
      - "moonshotai/Kimi-K2.6"
      - "zai-org/GLM-5.1"
      - "MiniMaxAI/MiniMax-M2.7"
      - "stepfun/Step-3.5-Flash"
      - "xiaomi/mimo-v2.5-pro"
      - "google/gemini-3.5-flash"
      - "gpt-5.5"
    default_aux_model: "deepseek/deepseek-v4-flash"
  commandcode-anthropic:
    name: "CommandCode (Anthropic)"
    base_url: "https://api.commandcode.ai/provider/v1"
    env_vars: ["COMMANDCODE_API_KEY", "COMMANDCODE_ANTHROPIC_BASE_URL"]
    display_name: "CommandCode (Anthropic)"
    description: "CommandCode - Claude models via Anthropic Messages API"
    signup_url: "https://commandcode.ai/"
    models_url: "https://api.commandcode.ai/provider/v1/models"
    fallback_models:
      - "claude-sonnet-4-6"
      - "claude-opus-4-7"
      - "claude-haiku-4-5-20251001"
    default_aux_model: "claude-haiku-4-5-20251001"
"""
        with open(config_path, 'a', encoding='utf-8') as f:
            f.write(provider_config)
        print("  Added CommandCode providers to Hermes config")
    else:
        print("  CommandCode provider already in config")

# ============================================================
# WORKTREEPROOF WORKFLOW SKILL
# ============================================================
def import_worktreeproof_workflow():
    """Import WorktreeProof workflow as a Hermes skill."""
    print("Importing WorktreeProof workflow as skill...")
    
    # Read the workflow spec
    spec_path = WORKTREE_PROOF / 'docs' / 'WORKFLOW_SPEC.md'
    helper_policy = WORKTREE_PROOF / 'docs' / 'HELPER_POLICY.md'
    complete_workflow = WORKTREE_PROOF / 'docs' / 'COMPLETE-WORKFLOW.md'
    
    content = "# WorktreeProof Complete Workflow\n\n"
    
    if spec_path.exists():
        content += "## Workflow Specification\n\n"
        content += spec_path.read_text(encoding='utf-8')
        content += "\n\n---\n\n"
    
    if helper_policy.exists():
        content += "## Helper Policy\n\n"
        content += helper_policy.read_text(encoding='utf-8')
        content += "\n\n---\n\n"
    
    if complete_workflow.exists():
        content += "## Complete Workflow Mandate\n\n"
        content += complete_workflow.read_text(encoding='utf-8')
    
    write_skill('worktree-proof-workflow', 
        'Complete WorktreeProof V3 workflow with immutable task contracts, fixed terminal ledgers, SAFE-3 circuit breakers, and parallel helper delegation',
        content, {
        'source': 'worktree-proof',
        'version': 'V3',
        'category': 'workflow',
    })
    
    print("  Imported WorktreeProof workflow as skill")

# ============================================================
# MAIN
# ============================================================
def main():
    print("=" * 60)
    print("IMPORTING COMMANDCODE TASTE + WORKTREEPROOF TO HERMES")
    print("=" * 60)
    print(f"Hermes Home: {HERMES_HOME}")
    print()
    
    ensure_dirs()
    
    import_commandcode_taste()
    import_commandcode_config()
    add_commandcode_provider()
    import_worktreeproof_workflow()
    
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
    print("  4. Set COMMANDCODE_API_KEY env var to use CommandCode models")

if __name__ == '__main__':
    main()