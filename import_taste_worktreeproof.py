#!/usr/bin/env python3
"""
Import ONLY CommandCode taste-1 learned preferences and WorktreeProof workflow into Hermes Agent.
"""

import json
import os
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

COMMANDCODE_TASTE = Path(r'C:\Users\Nedal\.commandcode\taste')
WORKTREE_PROOF = Path(r'C:\VectorHQ\worktree-proof-workflow')

# ============================================================
# HELPERS
# ============================================================
def ensure_dirs():
    HERMES_MEMORIES.mkdir(parents=True, exist_ok=True)
    HERMES_SKILLS.mkdir(parents=True, exist_ok=True)

def write_memory(category: str, content: str, metadata: dict | None = None):
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
# COMMANDCODE TASTE-1 ONLY
# ============================================================
def import_taste1():
    """Import only CommandCode taste-1 learned preferences."""
    print("Importing CommandCode taste-1 learned preferences...")
    count = 0
    
    # Global taste packages (~/.commandcode/taste/)
    global_taste = COMMANDCODE_TASTE
    if global_taste.exists():
        for taste_file in global_taste.glob('**/taste.md'):
            try:
                content = taste_file.read_text(encoding='utf-8')
                rel = taste_file.relative_to(global_taste)
                category = str(rel.parent).replace('\\', '/')
                
                write_memory('taste1', f"## taste-1 Global: {category}\n\n{content}", {
                    'source': 'commandcode-taste1',
                    'category': category,
                    'scope': 'global',
                })
                count += 1
            except Exception as e:
                print(f"  Error reading {taste_file}: {e}")
    
    # Project taste packages (vector-hq-agents/.commandcode/taste/)
    project_taste = COMMANDCODE_TASTE / 'vector-hq-agents' / '.commandcode' / 'taste'
    if project_taste.exists():
        for taste_file in project_taste.glob('**/taste.md'):
            try:
                content = taste_file.read_text(encoding='utf-8')
                rel = taste_file.relative_to(project_taste)
                category = str(rel.parent).replace('\\', '/')
                
                write_memory('taste1', f"## taste-1 Project: {category}\n\n{content}", {
                    'source': 'commandcode-taste1',
                    'category': category,
                    'scope': 'project',
                    'project': 'vector-hq-agents',
                })
                count += 1
            except Exception as e:
                print(f"  Error reading {taste_file}: {e}")
    
    print(f"  Imported {count} taste-1 preference files")
    return count

# ============================================================
# WORKTREEPROOF WORKFLOW
# ============================================================
def import_worktreeproof():
    """Import WorktreeProof V3 workflow as a Hermes skill."""
    print("Importing WorktreeProof V3 workflow...")
    
    spec_path = WORKTREE_PROOF / 'docs' / 'WORKFLOW_SPEC.md'
    helper_policy = WORKTREE_PROOF / 'docs' / 'HELPER_POLICY.md'
    complete_workflow = WORKTREE_PROOF / 'docs' / 'COMPLETE-WORKFLOW.md'
    
    content = "# WorktreeProof V3 Complete Workflow\n\n"
    content += "Self-contained workflow system with:\n"
    content += "- Immutable task contracts (§2)\n"
    content += "- Fixed terminal ledgers (§3)\n"
    content += "- SAFE-3 circuit breakers at lifecycle entry (§5)\n"
    content += "- Helper policy with terminal-first allocation (§§1-10)\n"
    content += "- Exact cleanup (§8) and crash recovery (§9)\n"
    content += "- No-output circuit breaker (F13/§5)\n\n"
    
    if spec_path.exists():
        content += "## WORKFLOW_SPEC.md\n\n"
        content += spec_path.read_text(encoding='utf-8')
        content += "\n\n---\n\n"
    
    if helper_policy.exists():
        content += "## HELPER_POLICY.md\n\n"
        content += helper_policy.read_text(encoding='utf-8')
        content += "\n\n---\n\n"
    
    if complete_workflow.exists():
        content += "## COMPLETE-WORKFLOW.md\n\n"
        content += complete_workflow.read_text(encoding='utf-8')
    
    write_skill('worktree-proof-v3', 
        'WorktreeProof V3: Immutable task contracts, fixed terminal ledgers, SAFE-3 circuit breakers, parallel helper delegation with terminal-first allocation',
        content, {
        'source': 'worktree-proof',
        'version': 'V3',
        'category': 'workflow',
    })
    
    print("  Imported WorktreeProof V3 as skill")

# ============================================================
# MAIN
# ============================================================
def main():
    print("=" * 60)
    print("IMPORTING: taste-1 + WorktreeProof V3 ONLY")
    print("=" * 60)
    print(f"Hermes Home: {HERMES_HOME}")
    print()
    
    ensure_dirs()
    
    import_taste1()
    import_worktreeproof()
    
    print()
    print("=" * 60)
    print("DONE")
    print("=" * 60)
    print(f"Memories: {HERMES_MEMORIES}")
    print(f"Skills: {HERMES_SKILLS}")
    print()
    print("Run: hermes")

if __name__ == '__main__':
    main()