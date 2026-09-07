---
name: tool-call-repair
description: Auto-repair failed tool calls with up to 3 retry attempts. Fixes common errors: path typos, missing parameters, wrong argument types, non-existent files. Uses cc_tool_repair MCP tool. Follows the F2 rule (no retry loop).
use_for: tool failure retry, parameter correction, path fixing, argument repair
category: workflow
---

# Tool Call Repair

When a tool call fails, automatically diagnose and repair it before giving up. Follows the F2 rule: **3-strike stop** — if a tool fails 3 times with the same error class, stop retrying and report the blocker.

## When to use

- A file operation fails (file not found, permission denied)
- A parameter validation fails (wrong type, missing required field)
- A command fails with a syntax or path error
- A tool returns an error that looks fixable

## How it works

1. **Detect failure** — The tool call returned an error
2. **Analyze** — Call `cc_tool_repair` with the failed tool name, args, and error
3. **Repair** — The function returns repaired args or null if unrepairable
4. **Retry** — Call the original tool with repaired args (if returned)
5. **Stop** — If repair returns null or after 3 attempts (F2 rule), report the blocker

## Tool reference

- `cc_tool_repair` — Diagnoses failed tool calls and suggests repairs
  - Input: `{ toolName, args, error }`
  - Output: `{ reparable: bool, repairedArgs: object, reason: string, attempts: number }`

## Error patterns covered

| Error pattern | Repair strategy |
|---|---|
| File not found | Check common path typos, look for similar file names, check wrong directory |
| Missing parameter | Infer from context, use defaults, prompt reasoning |
| Wrong argument type | Cast/coerce (string↔number, array↔object) |
| Permission denied | Check path is within project root, try read-only alternative |
| Non-existent tool | Search for similar tool names via `cc_search_tools` |
| Invalid JSON in args | Parse and fix bracket/quote mismatches |

## Rules (F2)

1. **3-strike stop** — If the same tool fails 3 times with the same error class, STOP retrying
2. **One correction round** — Make one repair attempt, then retry. If it fails again, report.
3. **No retry on non-repairable** — If `cc_tool_repair` returns `reparable: false`, report immediately
4. **Track attempts** — Use the `attempts` field to enforce the 3-strike limit

## Example

```
Tool call: read_file("sr/auth/login.ts")
Error: "File not found: sr/auth/login.ts"

1. cc_tool_repair({ toolName: "read_file", args: { file_path: "sr/auth/login.ts" }, error: "File not found" })
   → { reparable: true, repairedArgs: { file_path: "src/auth/login.ts" }, reason: "Fixed typo: 'sr/' → 'src/'", attempts: 1 }

2. read_file("src/auth/login.ts")  ← Retry with repaired path
```

## Integration with Hermes

In the Hermes app, the personality instruction tells the agent: "When a tool call fails, use cc_tool_repair to auto-repair and retry (fixes paths, params, args). Default 3 attempts." The agent should call cc_tool_repair automatically before reporting a tool failure to the user.
