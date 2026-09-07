#!/usr/bin/env python3
"""
Hermes Workflow Enforcer — Post-turn Validator

Monitors every model output for workflow step compliance.
If mandatory steps are missing, auto-injects them as next-turn instructions.

HOW TO USE:
  - Add to Hermes hooks: `hermes hook add post-turn python3 C:\VectorHQ\worktree-proof-workflow\scripts\workflow_enforcer.py`
  - Or run manually: python3 workflow_enforcer.py "<last_model_output>"

COMPLIANCE CHECKS:
  1. skill_view(name='workflow-enforcer')     — required every session
  2. skill_view(name='complete-workflow')     — required every session
  3. skills_list()                            — required every session
  4. goal_show or goal_set                    — required before mutation
  5. plan_create                              — required before parallel work
  6. wp_reserve                               — required before execution
  7. Evidence (task_done or wp_close)         — required at closure
"""
import sys
import json
import re
import os

def check_workflow_compliance(output_text: str) -> dict:
    """Check if the model output contains required workflow step calls."""
    results = {
        "workflow_enforcer_loaded": False,
        "complete_workflow_loaded": False,
        "skills_listed": False,
        "goal_accessed": False,
        "plan_created": False,
        "lane_reserved": False,
        "evidence_provided": False,
        "missing": [],
        "compliance_score": 0,
    }

    checks = [
        ("workflow_enforcer_loaded", r"skill_view\s*\(\s*name\s*=\s*['\"]workflow-enforcer['\"]", "Call `skill_view(name='workflow-enforcer')`"),
        ("complete_workflow_loaded", r"skill_view\s*\(\s*name\s*=\s*['\"]complete-workflow['\"]", "Call `skill_view(name='complete-workflow')`"),
        ("skills_listed", r"skills_list\s*\(", "Call `skills_list()`"),
        ("goal_accessed", r"(goal_show|goal_set|worktree-proof goal show|worktree-proof goal set)", "Access goal state (goal_show or goal_set)"),
        ("plan_created", r"(plan_create|worktree-proof plan create)", "Create plan (plan_create)"),
        ("lane_reserved", r"(wp_reserve|worktree-proof reserve)", "Reserve lane (wp_reserve)"),
        ("evidence_provided", r"(wp_close|wp_release|task_done|worktree-proof close)", "Provide evidence (wp_close or task_done)"),
    ]

    for key, pattern, required_action in checks:
        if re.search(pattern, output_text, re.IGNORECASE):
            results[key] = True
        else:
            results["missing"].append(required_action)

    passed = sum(1 for k in ["workflow_enforcer_loaded", "complete_workflow_loaded", "skills_listed", "goal_accessed", "plan_created", "lane_reserved", "evidence_provided"] if results[k])
    results["compliance_score"] = f"{passed}/7"

    return results


def generate_correction(missing: list) -> str:
    """Generate forced next-turn instructions for missing steps."""
    if not missing:
        return ""

    correction = "=== WORKFLOW ENFORCER: AUTOMATIC CORRECTION ===\n"
    correction += "The following mandatory workflow steps were NOT found in your last turn:\n\n"

    for i, step in enumerate(missing, 1):
        correction += f"{i}. ⚠️ **MUST DO THIS NOW**: {step}\n"

    correction += "\n"
    correction += "These are NOT optional. You are operating under the L99 complete-workflow harness.\n"
    correction += "If your model cannot make tool calls, convert to terminal commands:\n"
    correction += "```\n"
    if any("workflow-enforcer" in m for m in missing):
        correction += "hermes skill view workflow-enforcer\n"
    if any("complete-workflow" in m for m in missing):
        correction += "hermes skill view complete-workflow\n"
    if any("skills_list" in m for m in missing):
        correction += "hermes skills list\n"
    if any("goal" in m for m in missing):
        correction += "worktree-proof goal show  # or goal_set if no goal exists\n"
    if any("plan" in m for m in missing):
        correction += "worktree-proof plan create  # if no plan exists\n"
    if any("reserve" in m for m in missing):
        correction += "worktree-proof reserve <lane> <scope> --dry-run\n"
    correction += "```\n"
    correction += "=== END CORRECTION ===\n"
    correction += "\n"
    correction += "**FAILURE TO COMPLY WILL RESULT IN IMMEDIATE RETRY WITH CLI FALLBACK.**"

    return correction


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 workflow_enforcer.py <model_output_text>")
        print("Or: python3 workflow_enforcer.py --check <model_output> --inject")
        sys.exit(1)

    # Support --inject flag for testing correction generation
    inject_mode = "--inject" in sys.argv
    output_text = " ".join(sys.argv[1:])

    if inject_mode:
        output_text = output_text.replace("--inject", "").strip()

    results = check_workflow_compliance(output_text)

    print(json.dumps(results, indent=2))

    if results["missing"] and not inject_mode:
        correction = generate_correction(results["missing"])
        print("\n" + correction)
        sys.exit(1)  # Non-zero exit = enforcement triggered

    if results["compliance_score"] == "7/7":
        print("\n✅ FULL COMPLIANCE — all workflow steps present")
        sys.exit(0)


if __name__ == "__main__":
    main()
