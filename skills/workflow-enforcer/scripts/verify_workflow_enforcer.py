#!/usr/bin/env python3
"""
verify_workflow_enforcer.py
Run after config.yaml edits to confirm the workflow-enforcer injection is live.

Checks:
1. Enforcer preamble in agent.personalities.default.instructions
2. Model = deepseek-v4-pro (not the weak free tier)
3. reasoning_effort = high
4. workflow-enforcer skill discoverable
5. worktree-proof in extra_skills_paths
6. complete-workflow references workflow-enforcer (STEP 0)
"""
import yaml, os, sys

fp = os.path.join(os.environ['LOCALAPPDATA'], 'hermes', 'config.yaml')
with open(fp, 'r') as f:
    cfg = yaml.safe_load(f)

errors = []

# 1. Enforcer injected into system instructions
instructions = cfg.get('agent', {}).get('personalities', {}).get('default', {}).get('instructions', [])
enforcer_found = any('WORKFLOW ENFORCER' in line for line in instructions)
print(f"[{'OK' if enforcer_found else 'FAIL'}] Workflow enforcer in system instructions")
if not enforcer_found:
    errors.append("Enforcer not found in config.yaml agent.personalities.default.instructions")

# 2. Model switched to deepseek-v4-pro
model_default = cfg.get('model', {}).get('default', '')
model_provider = cfg.get('model', {}).get('provider', '')
print(f"[{'OK' if 'deepseek-v4-pro' in model_default else 'FAIL'}] Model = {model_default} (provider: {model_provider})")
if 'deepseek-v4-pro' not in model_default:
    errors.append(f"Model is {model_default}, expected deepseek-v4-pro")

# 3. Reasoning effort = high
reasoning = cfg.get('agent', {}).get('reasoning_effort', '')
print(f"[{'OK' if reasoning == 'high' else 'FAIL'}] Reasoning effort = {reasoning}")
if reasoning != 'high':
    errors.append(f"Reasoning effort is {reasoning}, expected high")

# 4. workflow-enforcer skill exists
enforcer_path = r"C:\VectorHQ\worktree-proof-workflow\skills\workflow-enforcer\SKILL.md"
exists = os.path.exists(enforcer_path)
print(f"[{'OK' if exists else 'FAIL'}] workflow-enforcer SKILL.md at {enforcer_path}")
if not exists:
    errors.append("workflow-enforcer SKILL.md not found")

# 5. worktree-proof in extra_skills_paths
extra_paths = cfg.get('skills', {}).get('extra_skills_paths', []) + cfg.get('extra_skills_paths', [])
wp_found = any('worktree-proof' in str(p) for p in extra_paths)
print(f"[{'OK' if wp_found else 'FAIL'}] worktree-proof in extra_skills_paths")
if not wp_found:
    errors.append("worktree-proof not in extra_skills_paths")

# 6. complete-workflow references workflow-enforcer
cw_path = r"C:\VectorHQ\worktree-proof-workflow\skills\complete-workflow\SKILL.md"
cw_exists = os.path.exists(cw_path)
if cw_exists:
    with open(cw_path, 'r') as f:
        cw_content = f.read()
    has_enforcer_ref = "skill_view(name='workflow-enforcer')" in cw_content
    print(f"[{'OK' if has_enforcer_ref else 'FAIL'}] complete-workflow references workflow-enforcer")
    if not has_enforcer_ref:
        errors.append("complete-workflow does not reference workflow-enforcer")
else:
    print(f"[FAIL] complete-workflow SKILL.md not found")
    errors.append("complete-workflow SKILL.md not found")

print()
if errors:
    print(f"❌ {len(errors)} issue(s) found:")
    for e in errors:
        print(f"   - {e}")
    sys.exit(1)
else:
    print("✅ All checks passed — workflow-enforcer is active")
    sys.exit(0)
