#!/usr/bin/env python3
"""
Startup verification script — runs after config edits to confirm:
1. Enforcer is in system instructions
2. Model switched to deepseek-v4-pro
3. Reasoning effort is high
4. workflow-enforcer skill is discoverable
"""
import yaml, os, subprocess, sys

fp = os.path.join(os.environ['LOCALAPPDATA'], 'hermes', 'config.yaml')
with open(fp, 'r') as f:
    cfg = yaml.safe_load(f)

errors = []

# 1. Check enforcer injected
instructions = cfg.get('agent', {}).get('personalities', {}).get('default', {}).get('instructions', [])
enforcer_found = any('WORKFLOW ENFORCER' in line for line in instructions)
print(f"[{'OK' if enforcer_found else 'FAIL'}] Workflow enforcer in system instructions")
if not enforcer_found:
    errors.append("Enforcer not found in config.yaml")

# 2. Check model
model_default = cfg.get('model', {}).get('default', '')
print(f"[{'OK' if 'deepseek-v4-pro' in model_default else 'FAIL'}] Model = {model_default}")
if 'deepseek-v4-pro' not in model_default:
    errors.append(f"Model is {model_default}, expected deepseek-v4-pro")

# 3. Check reasoning
reasoning = cfg.get('agent', {}).get('reasoning_effort', '')
print(f"[{'OK' if reasoning == 'high' else 'FAIL'}] Reasoning effort = {reasoning}")
if reasoning != 'high':
    errors.append(f"Reasoning effort is {reasoning}, expected high")

# 4. Check workflow-enforcer skill accessible
enforcer_path = r"C:\VectorHQ\worktree-proof-workflow\skills\workflow-enforcer\SKILL.md"
exists = os.path.exists(enforcer_path)
print(f"[{'OK' if exists else 'FAIL'}] workflow-enforcer skill at {enforcer_path}")
if not exists:
    errors.append("workflow-enforcer SKILL.md not found")

# 5. Verify extra_skills_paths includes worktree-proof
extra_paths = cfg.get('skills', {}).get('extra_skills_paths', [])
wp_found = any('worktree-proof' in p for p in extra_paths)
print(f"[{'OK' if wp_found else 'FAIL'}] worktree-proof in extra_skills_paths")
if not wp_found:
    errors.append("worktree-proof not in extra_skills_paths")

print()
if errors:
    print(f"❌ {len(errors)} issue(s) found:")
    for e in errors:
        print(f"   - {e}")
    sys.exit(1)
else:
    print("✅ All checks passed — config is correct")
    sys.exit(0)
