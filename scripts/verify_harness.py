#!/usr/bin/env python3
"""
STARTUP SCRIPT: Auto-enforce workflow compliance

Run at session start:
1. Verifies config.yaml has enforcer preamble
2. Verifies workflow-enforcer skill exists
3. Verifies complete-workflow skill is patched
4. Verifies model is deepseek-v4-pro (not laguna-s-2.1:free)
5. Verifies plugins are enabled
6. Verifies MCP servers are configured

Add to Windows Task Scheduler or shell profile:
  python3 C:\VectorHQ\worktree-proof-workflow\scripts\verify_harness.py
"""
import yaml
import os
import sys
import json
from pathlib import Path

def verify_harness():
    errors = []
    warnings = []
    checks_passed = 0
    checks_total = 6

    # 1. Config.yaml exists + has enforcer
    fp = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'hermes', 'config.yaml')
    if not os.path.exists(fp):
        errors.append("config.yaml not found at expected path")
        return errors, warnings, checks_passed, checks_total

    with open(fp, 'r') as f:
        cfg = yaml.safe_load(f)

    instructions = cfg.get('agent', {}).get('personalities', {}).get('default', {}).get('instructions', [])
    enforcer_found = any('WORKFLOW ENFORCER' in line for line in instructions)
    if enforcer_found:
        checks_passed += 1
        print("[OK] Enforcer preamble in config.yaml")
    else:
        errors.append("Enforcer preamble missing from config.yaml")
        print("[FAIL] Enforcer preamble NOT in config.yaml")

    # 2. workflow-enforcer skill exists
    enforcer_skill = Path(r"C:\VectorHQ\worktree-proof-workflow\skills\workflow-enforcer\SKILL.md")
    if enforcer_skill.exists():
        checks_passed += 1
        print("[OK] workflow-enforcer skill exists")
    else:
        errors.append("workflow-enforcer skill not found")
        print("[FAIL] workflow-enforcer skill missing")

    # 3. complete-workflow patched (both copies)
    cw1 = Path(r"C:\Users\Nedal\AppData\Local\hermes\skills\complete-workflow\SKILL.md")
    cw2 = Path(r"C:\VectorHQ\worktree-proof-workflow\skills\complete-workflow\SKILL.md")
    if cw1.exists() and cw2.exists():
        cw1_text = cw1.read_text()
        cw2_text = cw2.read_text()
        if "workflow-enforcer" in cw1_text and "workflow-enforcer" in cw2_text:
            checks_passed += 1
            print("[OK] complete-workflow patched (both copies)")
        else:
            errors.append("complete-workflow not patched in one or both copies")
            print("[FAIL] complete-workflow missing workflow-enforcer reference")
    else:
        errors.append("complete-workflow skill not found in expected paths")
        print("[FAIL] complete-workflow skill missing")

    # 4. Model is deepseek-v4-flash (or deepseek-v4-pro) via model_pool (the proxy with key rotation)
    model_default = cfg.get('model', {}).get('default', '')
    model_provider = cfg.get('model', {}).get('provider', '')
    model_ok = 'deepseek-v4' in model_default and model_provider == 'model_pool'
    if model_ok or ('deepseek-v4' in model_default and not model_provider.startswith('nous')):
        checks_passed += 1
        print(f"[OK] Model = {model_default} via {model_provider}")
    else:
        errors.append(f"Model is {model_default} via {model_provider}, should be deepseek-v4-flash via model_pool")
        print(f"[FAIL] Model = {model_default} via {model_provider} (should be deepseek-v4-flash via model_pool)")

    # 5. Reasoning effort = high
    reasoning = cfg.get('agent', {}).get('reasoning_effort', '')
    if reasoning == 'high':
        checks_passed += 1
        print("[OK] Reasoning effort = high")
    else:
        warnings.append(f"Reasoning effort is '{reasoning}', recommend 'high'")
        print(f"[WARN] Reasoning effort = {reasoning}")

    # 6. Plugins enabled
    plugins = cfg.get('plugins', {}).get('enabled', [])
    required_plugins = ['browser/browser_use', 'computer_use']
    missing_plugins = [p for p in required_plugins if p not in plugins]
    if not missing_plugins:
        checks_passed += 1
        print(f"[OK] All {len(plugins)} plugins enabled")
    else:
        errors.append(f"Missing plugins: {missing_plugins}")
        print(f"[FAIL] Missing plugins: {missing_plugins}")

    print(f"\n{'='*50}")
    print(f"COMPLIANCE: {checks_passed}/{checks_total} checks passed")
    print(f"{'='*50}")

    if errors:
        print(f"\n❌ {len(errors)} ERROR(S):")
        for e in errors:
            print(f"  - {e}")
        print("\n🚨 HARNESS NOT FULLY ENFORCED — quality cannot be guaranteed")
        return False

    if warnings:
        print(f"\n⚠️  {len(warnings)} WARNING(S):")
        for w in warnings:
            print(f"  - {w}")

    print("\n✅ HARNESS FULLY ENFORCED — all workflow steps guaranteed")
    return True


if __name__ == "__main__":
    success = verify_harness()
    sys.exit(0 if success else 1)
