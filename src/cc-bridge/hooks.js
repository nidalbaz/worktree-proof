/**
 * Hook pipeline engine — event-based pre/post tool hooks.
 *
 * Mirrors Command Code's hooks system. Hooks are loaded from host config
 * (OpenCode's settings.local.json, Command Code's .clauderc, etc.) and
 * executed at key lifecycle events.
 *
 * Supported events:
 *   - PreToolUse     — before a tool is called; can transform args
 *   - PostToolUse    — after a tool returns; can transform result
 *   - Stop           — when the agent signals it will stop
 *   - SessionStart   — at session begin (can inject context)
 *   - UserPrompt     — before user message is processed
 *
 * Hooks can be:
 *   - Command hooks: run a shell command
 *   - Function hooks: call a JS function (for programmatic mods)
 *   - Transform hooks: modify input/output before/after tool calls
 *
 * This engine is host-neutral. The host adapter provides:
 *   - runCommand(cmd, cwd): Promise<{stdout, stderr, exitCode}>
 *   - sessionID: string
 *   - getToolHistory(): array of past tool calls
 */

/**
 * Parse hook definitions from a host config.
 * Hooks config format (OpenCode/Command Code style):
 *
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "command": "echo before", "when": { "matcher": "edit_file" } },
 *       { "function": "myHook", "when": { "matcher": ["write_file", "edit_file"] } }
 *     ],
 *     "PostToolUse": [...]
 *   }
 * }
 */

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'UserPrompt'];

/**
 * @param {object} hooksConfig - Parsed hooks config from host settings
 * @returns {Map<event, Array>} Map of event -> hook definitions
 */
export function parseHooks(hooksConfig) {
  const hooks = new Map();

  for (const event of HOOK_EVENTS) {
    const defs = hooksConfig[event] || hooksConfig[event.toLowerCase()] || [];
    if (Array.isArray(defs)) {
      hooks.set(event, defs);
    }
  }

  return hooks;
}

/**
 * Determine if a hook should fire for a given tool call.
 *
 * @param {object} hook - Hook definition with optional `when.matcher`
 * @param {string} toolName - Name of the tool being called
 * @returns {boolean}
 */
export function shouldFireHook(hook, toolName) {
  if (!hook.when || !hook.when.matcher) return true;

  const matcher = hook.when.matcher;
  if (typeof matcher === 'string') {
    return matcher === toolName;
  }
  if (Array.isArray(matcher)) {
    return matcher.includes(toolName);
  }
  if (typeof matcher === 'object' && matcher.pattern) {
    const regex = new RegExp(matcher.pattern);
    return regex.test(toolName);
  }
  if (typeof matcher === 'function') {
    return matcher(toolName);
  }

  return false;
}

/**
 * Run all matching PreToolUse hooks for a tool call.
 * Hooks can return a modified args object.
 *
 * @param {object} params
 * @param {string} params.toolName - Tool being called
 * @param {object} params.args - Original arguments
 * @param {Map} params.hooksMap - Parsed hooks
 * @param {object} params.adapters - { runCommand, sessionID }
 * @returns {Promise<{args: object, outputs: Array}>}
 */
export async function runPreToolHooks({ toolName, args, hooksMap, adapters }) {
  const hooks = hooksMap.get('PreToolUse') || [];
  const outputs = [];
  let modifiedArgs = args;

  for (const hook of hooks) {
    if (!shouldFireHook(hook, toolName)) continue;

    if (hook.command) {
      const cmdResult = await adapters.runCommand(hook.command, {
        sessionID: adapters.sessionID,
        toolName,
        args: modifiedArgs,
      });
      outputs.push({ hook: hook.command, type: 'command', ...cmdResult });
    }

    if (typeof hook.function === 'function' || hook.function) {
      try {
        const fnResult = await hook.function({ toolName, args: modifiedArgs, sessionID: adapters.sessionID });
        if (fnResult && typeof fnResult === 'object' && fnResult.args) {
          modifiedArgs = fnResult.args;
        }
        outputs.push({ hook: hook.function?.name || 'fn', type: 'function', result: fnResult });
      } catch (error) {
        outputs.push({ hook: 'function', type: 'function', error: error.message });
      }
    }

    if (hook.transform) {
      const transformResult = await hook.transform({ toolName, args: modifiedArgs });
      if (transformResult && typeof transformResult === 'object') {
        modifiedArgs = { ...modifiedArgs, ...transformResult };
      }
    }
  }

  return { args: modifiedArgs, outputs };
}

/**
 * Run all matching PostToolUse hooks for a tool result.
 * Hooks can transform the result.
 *
 * @param {object} params
 * @param {string} params.toolName - Tool that was called
 * @param {object} params.result - Tool result
 * @param {number} params.duration - Execution duration in ms
 * @param {Map} params.hooksMap - Parsed hooks
 * @param {object} params.adapters - { runCommand, sessionID }
 * @returns {Promise<{result: object, outputs: Array}>}
 */
export async function runPostToolHooks({ toolName, result, duration, hooksMap, adapters }) {
  const hooks = hooksMap.get('PostToolUse') || [];
  const outputs = [];
  let modifiedResult = result;

  for (const hook of hooks) {
    if (!shouldFireHook(hook, toolName)) continue;

    if (hook.command) {
      const cmdResult = await adapters.runCommand(hook.command, {
        sessionID: adapters.sessionID,
        toolName,
        result: modifiedResult,
        duration,
      });
      outputs.push({ hook: hook.command, type: 'command', ...cmdResult });
    }

    if (hook.transform) {
      const transformResult = await hook.transform({ toolName, result: modifiedResult, duration });
      if (transformResult && typeof transformResult === 'object') {
        modifiedResult = transformResult;
      }
    }
  }

  return { result: modifiedResult, outputs };
}

/**
 * Run Stop hooks — executed when the agent signals it will stop.
 *
 * @param {Map} hooksMap - Parsed hooks
 * @param {object} adapters - { runCommand, sessionID }
 * @returns {Promise<Array>} Hook outputs
 */
export async function runStopHooks(hooksMap, adapters) {
  const hooks = hooksMap.get('Stop') || [];
  const outputs = [];

  for (const hook of hooks) {
    if (hook.command) {
      const cmdResult = await adapters.runCommand(hook.command, {
        sessionID: adapters.sessionID,
      });
      outputs.push({ hook: hook.command, type: 'command', ...cmdResult });
    }
  }

  return outputs;
}

/**
 * Run SessionStart hooks — fired at session begin.
 * Can inject instructions or context.
 *
 * @param {Map} hooksMap - Parsed hooks
 * @param {object} adapters - { runCommand, sessionID }
 * @returns {Promise<{injected: Array, outputs: Array}>}
 */
export async function runSessionStartHooks(hooksMap, adapters) {
  const hooks = hooksMap.get('SessionStart') || [];
  const outputs = [];
  const injected = [];

  for (const hook of hooks) {
    if (hook.command) {
      const cmdResult = await adapters.runCommand(hook.command, {
        sessionID: adapters.sessionID,
      });
      outputs.push({ hook: hook.command, type: 'command', ...cmdResult });
      if (cmdResult.stdout && cmdResult.stdout.trim()) {
        injected.push(cmdResult.stdout.trim());
      }
    }
  }

  return { injected, outputs };
}

/**
 * Run UserPrompt hooks — fired before user message is processed.
 * Can transform the user's input.
 *
 * @param {string} input - User input
 * @param {Map} hooksMap - Parsed hooks
 * @param {object} adapters - { runCommand, sessionID }
 * @returns {Promise<{input: string, outputs: Array}>}
 */
export async function runUserPromptHooks(input, hooksMap, adapters) {
  const hooks = hooksMap.get('UserPrompt') || [];
  let modifiedInput = input;
  const outputs = [];

  for (const hook of hooks) {
    if (hook.command) {
      const cmdResult = await adapters.runCommand(hook.command, {
        sessionID: adapters.sessionID,
        input: modifiedInput,
      });
      outputs.push({ hook: hook.command, type: 'command', ...cmdResult });
    }

    if (hook.transform) {
      const transformResult = await hook.transform({ input: modifiedInput });
      if (typeof transformResult === 'string') {
        modifiedInput = transformResult;
      }
    }
  }

  return { input: modifiedInput, outputs };
}

// --- Tool Call Repair Auto ---
// When a tool call fails, this subsystem analyses the error and the
// original arguments, produces a repaired parameter set, and retries — up
// to MAX_REPAIR_ATTEMPTS.  This mirrors Command Code's internal repair
// loop that runs silently inside agentLoop() before surfacing failures.

export const MAX_REPAIR_ATTEMPTS = 3;

// Common error patterns and their repair strategies
const REPAIR_RULES = [
  {
    // "No such file or directory" → try parent directory or search for the file
    pattern: /no such file or directory|ENOENT|file not found/i,
    repair: (toolName, args, error) => {
      const newArgs = { ...args };
      const filePathFields = ['filePath', 'file_path', 'file', 'path', 'filename', 'source', 'target'];
      for (const field of filePathFields) {
        if (newArgs[field] && typeof newArgs[field] === 'string') {
          // Try removing leading slashes and checking relative path
          newArgs[field] = newArgs[field].replace(/^(\/|\\)+/, '');
        }
      }
      return newArgs;
    },
  },
  {
    // "is a directory" → add a file extension or use parent
    pattern: /is a directory|EISDIR/i,
    repair: (toolName, args, error) => {
      const newArgs = { ...args };
      const dirFields = ['filePath', 'file_path', 'file', 'path'];
      for (const field of dirFields) {
        if (newArgs[field] && typeof newArgs[field] === 'string') {
          newArgs[field] = newArgs[field] + '.ts';
        }
      }
      return newArgs;
    },
  },
  {
    // "Permission denied" → suggest sudo or different path
    pattern: /permission denied|EPERM|EACCES/i,
    repair: (toolName, args, error) => {
      return { ...args, _repairNote: 'Permission denied — path may require elevated access' };
    },
  },
  {
    // JSON parse errors → fix formatting
    pattern: /invalid json|JSON\.parse|unexpected token/i,
    repair: (toolName, args, error) => {
      const newArgs = { ...args };
      for (const [key, val] of Object.entries(newArgs)) {
        if (typeof val === 'string') {
          try { JSON.parse(val); } catch {
            // Add closing braces/brackets
            if (val.trim()[0] === '{') {
              let fixed = val.trim();
              const openBraces = (fixed.match(/{/g) || []).length;
              const closeBraces = (fixed.match(/}/g) || []).length;
              for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}';
              newArgs[key] = fixed;
            }
          }
        }
      }
      return newArgs;
    },
  },
];

export async function runToolRepair({ toolName, args, error, attempt = 0, adapters, hooksMap }) {
  if (attempt >= MAX_REPAIR_ATTEMPTS) {
    return { repaired: false, args, repairedCount: attempt, error: error?.message || String(error) };
  }

  const errorMessage = error?.message || String(error) || '';
  let repairedArgs = args;

  for (const rule of REPAIR_RULES) {
    if (rule.pattern.test(errorMessage)) {
      repairedArgs = rule.repair(toolName, args, error);
      break;
    }
  }

  // Run PostToolUse hooks after a failed tool call (before repair)
  const postResult = await runPostToolHooks({
    toolName, result: { error: errorMessage, isRepairCandidate: true }, duration: 0,
    hooksMap, adapters,
  });

  if (postResult.outputs.length > 0) {
    for (const out of postResult.outputs) {
      if (out.result?.args && typeof out.result.args === 'object') {
        repairedArgs = { ...repairedArgs, ...out.result.args };
      }
    }
  }

  return {
    repaired: true,
    args: repairedArgs,
    repairedCount: attempt + 1,
    error: errorMessage,
  };
}
