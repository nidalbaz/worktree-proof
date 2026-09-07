/**
 * restore-hermes-harness.mjs — Natively integrate Command Code bridge features
 * into the Hermes Electron app's agent personality, preserving all native
 * Hermes capabilities (providers, platform toolsets, memory sharing, plugins,
 * compression, session reset, tool loop guardrails).
 *
 * This is idempotent and safe to run as a scheduled task or at startup.
 * It detects whether the CC_BRIDGE_NATIVITY marker exists in the config; if not,
 * it embeds taste, skill expansion, plan-mode behavior, deferred tools awareness,
 * bridge messaging, and agentic-behavior guidance directly into the personality
 * instructions so they feel NATIVE to Hermes — not add-on tools to call.
 *
 * If the harness IS present but stale (older version), it upgrades in place.
 */
import { readFile, writeFile, access, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const configPath = join(homedir(), 'AppData', 'Local', 'hermes', 'config.yaml');
const tasteDir = join(homedir(), '.commandcode', 'taste');
const tastePath = join(tasteDir, 'taste.md');           // pointer or content
const tasteSubPath = join(tasteDir, 'taste', 'taste.md'); // actual content
const backupDir = join(homedir(), '.commandcode', 'hermes-backups');

const HARNESS_VERSION = '14'; // v14=preserve token_free_gateway-first subagent config + OpenRouter (ox alpha) models

/** Read taste content: try pointer, then actual content, then subdirectory. */
async function loadTasteContent() {
  // Try the pointer file first
  try {
    await access(tastePath, constants.R_OK);
    const raw = (await readFile(tastePath, 'utf8')).trim();
    // If it's just a pointer (2 lines: "# Taste" + "See ..."), read the real content
    if (raw.split('\n').length <= 4 && raw.includes('See')) {
      try {
        await access(tasteSubPath, constants.R_OK);
        return (await readFile(tasteSubPath, 'utf8')).trim();
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    // Try subdirectory directly
    try {
      await access(tasteSubPath, constants.R_OK);
      return (await readFile(tasteSubPath, 'utf8')).trim();
    } catch {
      return 'No taste file found.';
    }
  }
}

/**
 * Build native personality instructions that embed Command Code behaviors
 * as first-class Hermes agent behaviors — not external tools to call.
 */
function buildNativeInstructions(tasteContent) {
  const instructions = [
    'CC_BRIDGE_NATIVITY',
    'CC_BRIDGE_VERSION: ' + HARNESS_VERSION,
    // === WORKFLOW ENFORCER (MANDATORY PRE-TURN INJECTION) ===
    '=== WORKFLOW ENFORCER (MANDATORY PRE-TURN INJECTION) ===',
    'Before EVERY turn, you MUST call skill_view(name=\'workflow-enforcer\') and skill_view(name=\'complete-workflow\').',
    'If the model cannot make tool calls (weak/free tier), convert to: hermes skill view workflow-enforcer && hermes skill view complete-workflow in terminal.',
    'Every turn must pass through: REHYDRATE → CONTRACT → PLAN → RESERVE → RUN → EVIDENCE → REVIEW → MERGE → RELEASE.',
    'No evidence from a step = immediate re-injection of that step as next-turn instruction.',
    '40 tool calls with zero terminal closures = FREEZE. Report ONE blocker. STOP.',
    '=== END ENFORCER ===',
  ];

  // --- Natively embedded taste (first priority) ---
  // Condense taste into key behavioral directives that the model follows
  // automatically, without needing to call a tool.
  if (tasteContent && !tasteContent.startsWith('No taste file found')) {
    // Include a condensed behavioral summary derived from the taste
    const tasteSummary = condenseTaste(tasteContent);
    instructions.push(tasteSummary);
  }

  // --- Native skill expansion ---
  // Teach the model to treat /skill-name references as native input
  // expansion — like Command Code does — rather than an external tool.
  instructions.push(
    'Native skill expansion: When the user references /skill-name, immediately ' +
    'inline the skill instructions from the worktree-proof skills directory ' +
    'into your response as <command-name> context. Do NOT treat this as a tool call; ' +
    'treat it as a native language feature. Use cc_skills_list to discover available ' +
    'skills and cc_skills_expand to expand them when MCP tools are preferred.',
  );

  // --- Native plan mode ---
  // When entering a new complex task, automatically enter a read-only exploration
  // phase: explore the codebase, gather context, present a plan, and only proceed
  // to editing after confirmation.
  instructions.push(
    'Native plan mode: Before any file edits on a new complex task, enter a ' +
    'read-only exploration phase (like a software architect). Explore, gather ' +
    'context, and present a plan. Only proceed to editing after user confirmation. ' +
    'Use cc_plans_mode(true) to toggle this explicitly when needed, but also do it ' +
    'automatically when starting a large/new task.',
  );

  // --- Native deferred tools ---
  // The model has many tools. Search for tools on demand rather than trying to
  // remember them all.
  instructions.push(
    'Native tool discovery: You have many tools across providers and MCP servers. ' +
    'Use cc_search_tools to find relevant tools on demand. Do not try to memorize ' +
    'all tools — search for what you need in the moment.',
  );

  // --- Native bridge messaging ---
  // Native inter-agent IPC behavior — check inbox at start, send messages as needed.
  instructions.push(
    'Native bridge messaging: Inter-agent messages arrive via the worktree-proof ' +
    'MCP server. At the start of each turn, check bridge_inbox for messages. ' +
    'When delegating sub-tasks, use bridge_send to dispatch a message and ' +
    'bridge_claim/ack/complete to manage the lifecycle. This is your native ' +
    'message-passing layer.',
  );

  // --- Native orchestrator (v3: includes full dispatch pipeline) ---
  instructions.push(
    'Native orchestrator: cc_orchestrate decomposes tasks into parallelizable ' +
    'sub-tasks; auto-dispatch via bridge_send. Respects max 24 concurrent lanes.',
  );
  instructions.push(
    'Dynamic orchestration: Use bridge_send to dispatch sub-tasks to parallel ' +
    'agents. Each sub-agent checks bridge_inbox, claims via bridge_claim, and ' +
    'reports via bridge_complete. Backfill freed slots immediately.',
  );

  // --- Native agentic behavior ---
  // Always work through tasks to completion without stopping to ask "continue?"
  instructions.push(
    'Native agentic persistence: Work CONTINUOUSLY until the task is complete. ' +
    'When a tool call finishes, evaluate whether the task is done. If not, make ' +
    'the next call immediately. Only stop when you have genuinely reached ' +
    'completion or hit a genuine blocker requiring owner input.',
  );

  // --- Native taste: preferences as behavioral guardrails ---
  // These are embedded so the model follows them without being told each time
  instructions.push(
    'Native taste guardrails (from learned preferences):',
  );
  // Add key taste-derived directives
  const keyDirectives = [
    '- Always verify fixes in the running app (not just config file parses)',
    '- Solve problems from the root — avoid surface-level patching',
    '- Treat stale model names as defects to eliminate',
    '- Require end-to-end live verification before reporting "done"',
    '- Prefer portable workflows across agent runtimes (Command Code, OpenCode, Hermes)',
    '- Run continuously until task completion (no single-call stops)',
    '- Keep each service/provider correctly labeled — do not merge distinct services',
    '- Auto-start local service stack via scheduled tasks for resilience',
    '- Use each model configuration maximum context window — never capped silently',
    '- Browser automation on personal Chrome port 9333 ONLY; ban port 9222',
    '- Tool-spawn ENOENT = PATH misconfiguration — fix the PATH, restart app',
    '- Retry empty/error completions once before reporting failure',
    '- Ultra swarm: degrade to inline mode when free models are unreachable',
  ];
  instructions.push(...keyDirectives);

  // --- Native tool-call repair, context budget, circuit breaker, evidence, L99 ---
  instructions.push(
    'Native tool-call repair auto: When a tool call fails, use cc_tool_repair to ' +
    'auto-repair and retry (fixes paths, params, args). Default 3 attempts.',
  );
  instructions.push(
    'Context budget: cc_context_budget shows token usage across taste, memory, ' +
    'tools, skills — search to discover, do not try to memorize all tools.',
  );
  instructions.push(
    'Circuit breaker (SAFE-3): cc_circuit_breaker prevents runaway work — stop ' +
    'spawning after 40 tool calls without terminal closure (merge + evidence).',
  );
  instructions.push(
    'Evidence-based delivery: verify task closure with proof (merge + tests + ' +
    'build + live check) before reporting done.',
  );
  instructions.push(
    'L99 complete-workflow: every task follows goal->plan->reserve->run->evidence->' +
    'review->close. Never skip steps.',
  );

  // --- Native Ultra delegation (free multi-model, no Luna subscription) ---
  // Proactively spawn sub-agents across ALL free model providers.
  instructions.push(
    'Native Ultra delegation: Proactively spawn sub-agents for parallelizable work WITHOUT waiting to be asked. ' +
    'Distribute sub-tasks across ALL free model providers (baichat, nvidia, model_pool, ' +
    'nous with 2 accounts, aihubmix, zenmux, opencode-go, openrouter/ox-alpha) — rotate across them, do NOT rely ' +
    'on a single provider. When using a specific provider (NOT model_pool), NO fallback to other models if it fails — work inline ' +
    'until verified back. Fallback only happens on model_pool (port 3463, Python proxy with key pool rotation). ' +
    'token_free_gateway (port 10100) is for cracked web models ONLY. Always ' +
    'maximize parallelism — no cap on sub-agent count.',
  );
  instructions.push(
    'Multi-model audit: For complex tasks (>3 sub-steps or >10 min estimated), dispatch the SAME task ' +
    'to 2-3 different free models in parallel. Compare outputs, identify consensus, select the best result. ' +
    'Use bridge_send to coordinate.',
  );
  instructions.push(
    'No:ultra opt-out: A user message beginning with exactly "No:ultra" disables Ultra delegation for ' +
    'that one task (and removes the prefix from the message). "Ultra:" opt-in enables it at any effort. ' +
    'Neither prefix changes the selected parent effort.',
  );
  instructions.push(
    'Resource gate: Before spawning, check provider/model availability. Skip unreachable free providers. ' +
    'If a model fails, immediately try the next in rotation — never retry the same failing model.',
  );

  // --- Native persistent todos (survives model changes) ---
  instructions.push(
    'Persistent task tracking: Use cc_todos_update instead of todo_write — your task list persists to ' +
    '.worktree-proof/todos.json and survives model changes and session restarts. todo_write resets on ' +
    'model switch. Run cc_todos_list to print the full list in chat when the TUI panel is too long to scroll.',
  );

  // --- OCR via Chrome/Computer Use (screenshot-reader skill) ---
  instructions.push(
    'OCR via screenshot-reader: The screenshot-reader skill (python C:/VectorHQ/screenshot-reader/reader.py) ' +
    'is installed in C:/VectorHQ/worktree-proof-workflow/skills. After every computer_screenshot or chrome_screenshot, ' +
    'run the reader on the saved image to get a text transcript with element coordinates BEFORE any click, ' +
    'drag, or keyboard action. Never guess UI state — always read the screenshot first.',
    'Chrome/Computer Use workflow: computer_use plugin and browser/browser_use are enabled in Hermes plugins. ' +
    'For browser tasks use chrome_connect → chrome_navigate → chrome_screenshot → read → chrome_click. ' +
    'For desktop tasks use computer_screenshot → read → computer_mouse_click. Never use Computer Use to click ' +
    'Chrome tabs — use chrome_click instead.',
    'Model selection: Free model providers are baichat, nvidia, model_pool, nous (2 accounts), ' +
    'aihubmix, zenmux, opencode-go, and openrouter (ox alpha) — all ' +
    'verified live. Use model_pool (port 3463, Python proxy with key pool rotation) ' +
    'for auto-routing to the best available free provider with key pool rotation. ' +
    'token_free_gateway (port 10100, Bun gateway) is for cracked web models ONLY. ' +
    'Default model: deepseek-v4-flash via provider model_pool. When using a specific ' +
    'provider (NOT model_pool), NO fallback to other models if it fails — work inline ' +
    'until verified back. Fallback only happens on model_pool (port 3463).',
  );

  return instructions;
}

/** Condense the full taste content into a concise behavioral summary. */
function condenseTaste(tasteContent) {
  // The taste file has 73 entries. We condense to key behavioral pillars.
  const lines = tasteContent.split('\n');
  const summaryLines = lines
    .filter(l => l.trim().startsWith('- '))
    .map(l => l.trim().slice(2))
    .slice(0, 12) // Take first 12 (highest confidence / most frequent)
    .map(l => `- ${l.slice(0, 200)}`);

  return [
    'Learned taste (coding preferences from past sessions):',
    ...summaryLines,
    '- Full taste: ~/.commandcode/taste/taste/taste.md',
  ].join('\\n');
}

/** Check if the harness is already present and current. */
function isConfigured(content) {
  return content.includes('CC_BRIDGE_NATIVITY') && content.includes('CC_BRIDGE_VERSION: ' + HARNESS_VERSION);
}

/** Build the personalities block with native instructions. */
function buildPersonalities(instructions) {
  const lines = ['personalities:', '    default:', '      instructions:'];
  for (const instr of instructions) {
    // Escape for YAML string
    const escaped = instr.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    lines.push(`        - "${escaped}"`);
  }
  return lines.join('\n');
}

/** Apply the harness to the config, updating personalities.
 * Uses line-by-line removal to robustly handle YAML personalities blocks
 * of any indentation depth. MERGE-PRESERVING: user-added instructions
 * (anything not starting with a harness marker) survive the rewrite and are
 * re-appended after the harness block — they are never wiped. */
function applyHarness(content, instructions) {
  // If already configured with current version, skip
  if (content.includes('CC_BRIDGE_VERSION: ' + HARNESS_VERSION)) {
    return { updated: false, reason: 'already configured (current version)' };
  }

  // Normalize line endings to LF for processing
  content = content.replace(/\r\n/g, '\n');

  // --- PRESERVE user-added instructions (merge, never clobber) ---
  // Harness-managed instruction lines start with one of these markers.
  const HARNESS_MARKERS = [
    'CC_BRIDGE', 'Learned taste', 'Native ', '- Always', '- Solve', '- Treat',
    '- Require', '- Prefer', '- Run continuously', '- Keep each', '- Auto-start',
    '- Use each', '- Browser automation', '- Tool-spawn', '- Retry empty',
    '- Ultra swarm', 'WORKFLOW ENFORCER', 'Before EVERY turn',
    'If the model cannot', 'Every turn must pass through', 'No evidence from',
    '40 tool calls with zero', '=== END ENFORCER ===',
  ];
  const preserved = [];
  {
    const lines = content.split('\n');
    let inBlock = false;
    let blockIndent = -1;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:\s+)personalities:\s*(?:$|\{\})/.test(line)) {
        inBlock = true;
        blockIndent = (line.match(/^\s*/) || [''])[0].length;
        continue;
      }
      if (inBlock) {
        const indent = (line.match(/^\s*/) || [''])[0].length;
        if (trimmed === '' || indent > blockIndent) {
          // Extract instruction text if this is a "- \"...\"" list item
          const m = line.match(/^\s*-\s*"?(.*?)"?\s*$/);
          if (m && m[1] && !HARNESS_MARKERS.some((mk) => m[1].startsWith(mk))) {
            preserved.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'));
          }
          continue;
        }
        inBlock = false;
      }
    }
  }

  const personalitiesBlock = buildPersonalities(instructions);

  // Remove any old personalities block (line-by-line, handles any indentation)
  let filtered = [];
  let skip = false;
  let skipIndent = -1;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect start of a personalities block
    if (/^(?:\s+)personalities:\s*$/.test(line) || /^(?:\s+)personalities:\s*\{\}/.test(line)) {
      // Check if it's empty (personalities: {})
      if (/\{\}\s*$/.test(line)) {
        // Empty personalities — keep it (we'll replace with our block)
        skip = false;
      } else {
        // Non-empty personalities — skip all following indented lines
        skip = true;
        skipIndent = (line.match(/^\s*/) || [''])[0].length;
      }
      continue; // Skip the personalities: line itself
    }

    if (skip) {
      const lineIndent = (line.match(/^\s*/) || [''])[0].length;
      if (trimmed === '' || lineIndent > skipIndent) {
        continue; // Inside personalities block — skip
      }
      // Line is at or below personalities indent — end of block
      skip = false;
    }

    filtered.push(line);
  }

  let newContent = filtered.join('\n');

  // Re-append preserved user instructions after the harness block
  const merged = [...instructions, ...preserved];
  const mergedBlock = buildPersonalities(merged);

  // Insert new personalities block after `agent:` line
  newContent = newContent.replace(
    /^agent:\n/m,
    `agent:\n  ${mergedBlock}\n`,
  );

  return { updated: true, content: newContent };
}

/** Ensure computer_use plugin and experimental.primary_tools are present in Hermes config. */
function ensureComputerUsePlugins(content) {
  let updated = content;

  // Ensure computer_use is in plugins.enabled
  if (!updated.includes('    - computer_use')) {
    const pluginMatch = updated.match(/plugins:\n  enabled:\n/);
    if (pluginMatch) {
      const index = updated.indexOf(pluginMatch[0]) + pluginMatch[0].length;
      updated = updated.slice(0, index) + '    - computer_use\n' + updated.slice(index);
    }
  }

  // Ensure experimental.primary_tools is present (activates chrome_* and computer_*)
  if (!updated.includes('experimental:')) {
    const primaryTools = [
      'chrome_connect', 'chrome_navigate', 'chrome_click', 'chrome_fill',
      'chrome_extract', 'chrome_screenshot', 'chrome_wait', 'chrome_tabs',
      'chrome_evaluate', 'chrome_console', 'chrome_network', 'chrome_scroll',
      'chrome_type', 'computer_active_window', 'computer_keyboard_press',
      'computer_keyboard_type', 'computer_mouse_click', 'computer_mouse_drag',
      'computer_mouse_move', 'computer_mouse_scroll', 'computer_screenshot',
      'computer_window_bounds', 'computer_window_focus', 'computer_window_list',
      'computer_wait',
    ];
    const toolsYaml = primaryTools.map((t) => `    - ${t}`).join('\n');
    updated = updated.replace(
      /$/m,
      `\nexperimental:\n  primary_tools:\n${toolsYaml}\n`,
    );
  }

  return updated;
}

/**
 * Ensure model settings are correct:
 * - nous keeps its own base_url (https://inference-api.nousresearch.com/v1)
 * - model_pool routes to port 3463 (Python proxy with key pool rotation)
 * - token_free_gateway routes to port 10100 (Bun gateway, cracked web models only)
 * - fallback is deepseek-v4-flash
 */
function ensureModelSettings(content) {
  let updated = content;

  // Ensure nous base_url is correct (do NOT override with gateway URL)
  // nous is a stable free provider — keep original base_url
  if (!updated.includes('base_url: https://inference-api.nousresearch.com/v1')) {
    updated = updated.replace(
      "  base_url: ''",
      '  base_url: https://inference-api.nousresearch.com/v1',
    );
  }

  // model_pool port: harness wants 3462, but user's live config uses 3463.
  // Only fix if port is the OLD dead port 3461 — do NOT override 3463 or 10100.
  updated = updated.split('base_url: http://127.0.0.1:3461/v1').join('base_url: http://127.0.0.1:3463/v1');

  // Ensure fallback is a free model (only fix if still gemini-pro on main thread)
  updated = updated.replace('  fallback: gemini-pro', '  fallback: deepseek-v4-flash');

  // Update model_pool description to reflect live providers
  updated = updated.replace(
    '(baichat, nvidia, token_free_gateway, opencodex, etc.)',
    '(baichat, nvidia, model_pool, opencode-go)',
  );
  updated = updated.replace(
    '(baichat, nvidia, model_pool, opencodex)',
    '(baichat, nvidia, model_pool, opencode-go)',
  );

  return updated;
}

/**
 * Remove the old `opencodex` provider block from both model_providers and
 * providers sections. The opencodex provider (local proxy at port 10100) is
 * being replaced by `opencode-go` (real API at https://opencode.ai/zen/go/v1
 * with a single OPENCODE_API_KEY). Without this removal, ensureProvidersRestored
 * would skip adding opencode-go because it would find the renamed opencodex entry.
 */
function removeOpenCodex(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;
  let skipIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of opencodex provider block (2-space indent under model_providers or providers)
    if (line.match(/^  opencodex:\s*$/)) {
      skip = true;
      skipIndent = (line.match(/^(\s*)/) || [''])[0].length;
      continue; // Skip this line
    }

    if (skip) {
      const lineIndent = (line.match(/^(\s*)/) || [''])[0].length;
      const trimmed = line.trim();

      // Skip blank lines while skipping
      if (trimmed === '') {
        // Peek ahead to see if the next non-blank line is still part of opencodex
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length) {
          const nextIndent = (lines[j].match(/^(\s*)/) || [''])[0].length;
          if (nextIndent > skipIndent) {
            continue; // Still inside opencodex block
          }
        }
        // Next non-blank line is at same or lower indent — end of block
        skip = false;
        // Don't skip this blank line — it belongs to the next provider
        result.push(line);
        continue;
      }

      // Skip lines that are part of the opencodex block (4+ space indent)
      if (lineIndent > skipIndent) {
        continue;
      }

      // Line is at or below opencodex indent — end of block
      skip = false;
    }

    result.push(line);
  }

  // Also clean up any double blank lines left behind
  return result.join('\n').replace(/\n\n\n+/g, '\n\n');
}

/**
 * inserted properties (name, base_url, key_env, model) with 4-space indentation
 * under commandcode_anthropic, creating duplicate YAML keys (last-wins clobbering
 * the real commandcode_anthropic values). This removes duplicate property keys,
 * keeping only the first (correct) occurrence.
 */
function fixMangledProviders(content) {
  const lines = content.split('\n');
  const result = [];
  let section = null;
  let inCca = false;
  let seenKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === 'model_providers:') {
      section = 'model_providers';
      result.push(line);
      continue;
    }
    if (line === 'providers:') {
      section = 'providers';
      result.push(line);
      continue;
    }

    const topKeyMatch = line.match(/^  (\w[\w-]*):\s*$/);
    if (topKeyMatch) {
      inCca = topKeyMatch[1] === 'commandcode_anthropic';
      seenKeys = new Set();
      result.push(line);
      continue;
    }

    if (inCca && section) {
      const propMatch = line.match(/^    (\w[\w-_]*):/);
      if (propMatch) {
        const key = propMatch[1];
        if (seenKeys.has(key)) {
          const indent = (line.match(/^(\s*)/) || [''])[0].length;
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed === '') {
              i++;
              continue;
            }
            const nextIndent = (nextLine.match(/^(\s*)/) || [''])[0].length;
            if (nextIndent > indent) {
              i++;
            } else {
              break;
            }
          }
          i--;
          continue;
        }
        seenKeys.add(key);
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Remove misplaced model entries from commandcode_anthropic.models that
 * were orphaned by the mangled provider restoration. Specifically, model_pool
 * models like poolside/* and laguna-* should not appear under commandcode_anthropic.
 */
function cleanCommandCodeModels(content) {
  const lines = content.split('\n');
  const result = [];
  let inCca = false;
  let inModels = false;
  const misplacedPrefixes = ['poolside/laguna', 'laguna-s-2.1'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect top-level provider key (2-space indent)
    const topKey = line.match(/^  (\w[\w-]*):\s*$/);
    if (topKey) {
      inCca = topKey[1] === 'commandcode_anthropic';
      inModels = false;
      result.push(line);
      continue;
    }

    if (inCca) {
      // Detect models: subsection (4-space indent)
      if (line.match(/^    models:\s*$/)) {
        inModels = true;
        result.push(line);
        continue;
      }

      if (inModels) {
        const lineIndent = (line.match(/^(\s*)/) || [''])[0].length;

        // Check for model entry (6-space indent)
        const modelMatch = line.match(/^      (\S[\w\/\.\-:]*):\s*$/);
        if (modelMatch) {
          const modelId = modelMatch[1];
          if (misplacedPrefixes.some(p => modelId.startsWith(p))) {
            const propIndent = lineIndent;
            i++;
            while (i < lines.length) {
              const nextLine = lines[i];
              const nextTrimmed = nextLine.trim();
              if (nextTrimmed === '') {
                let j = i + 1;
                while (j < lines.length && lines[j].trim() === '') j++;
                if (j < lines.length) {
                  const nextIndent = (lines[j].match(/^(\s*)/) || [''])[0].length;
                  if (nextIndent > propIndent) { i++; continue; }
                }
                break;
              }
              const nextIndent = (nextLine.match(/^(\s*)/) || [''])[0].length;
              if (nextIndent > propIndent) { i++; } else { break; }
            }
            i--;
            continue;
          }
        }

        // Exit models subsection when we see a 4-space property
        if (lineIndent === 4 && !line.startsWith('      ')) {
          inModels = false;
        }
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Remove duplicate model entries from model_pool.models section.
 * Keeps only the first occurrence of each model ID, deduplicating by
 * normalizing suffixes (:free, -free) so that e.g.
 * poolside/laguna-s-2.1:free, poolside/laguna-s-2.1-free, and
 * laguna-s-2.1-free are treated as the same model.
 */
function deduplicateModelPoolModels(content) {
  const lines = content.split('\n');
  const result = [];
  let inModelPoolModels = false;
  const seenModels = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect model_pool provider entry (2-space indent under model_providers or providers)
    if (line.match(/^  model_pool:\s*$/)) {
      inModelPoolModels = true;
      result.push(line);
      continue;
    }

    if (inModelPoolModels) {
      const lineIndent = (line.match(/^(\s*)/) || [''])[0].length;

      // Exit when we encounter a new top-level provider key (2-space indent, not model entry)
      if (lineIndent === 2 && line.match(/^  (\w[\w-]*):\s*$/)) {
        inModelPoolModels = false;
        result.push(line);
        continue;
      }

      // Check for model entry (6-space indent under model_pool.models)
      const modelMatch = line.match(/^      (\S[\w\/\.\-:]*):\s*$/);
      if (modelMatch) {
        const modelId = modelMatch[1];
        // Normalize: strip provider prefixes (poolside/, qwen/), and strip
        // suffixes (:free, -free, -MMDD date suffixes like -0731, -0813)
        const normalized = modelId
          .replace(/^poolside\//, '')
          .replace(/^qwen\//, '')
          .replace(/(:?)-?free$/, '')
          .replace(/-\d{4}$/, '');
        if (seenModels.has(modelId) || seenModels.has(normalized)) {
          // Skip this duplicate model entry and its properties (8-space indent)
          const propIndent = lineIndent;
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed === '') {
              // Peek: if next non-blank is still indented deeper, skip blank line
              let j = i + 1;
              while (j < lines.length && lines[j].trim() === '') j++;
              if (j < lines.length) {
                const nextIndent = (lines[j].match(/^(\s*)/) || [''])[0].length;
                if (nextIndent > propIndent) {
                  i++;
                  continue;
                }
              }
              break;
            }
            const nextIndent = (nextLine.match(/^(\s*)/) || [''])[0].length;
            if (nextIndent > propIndent) {
              i++;
            } else {
              break;
            }
          }
          i--;
          continue;
        }
        seenModels.add(modelId);
        seenModels.add(normalized);
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Remove dead/stale model providers from the Hermes config YAML.
 * aihubmix and zenmux are VERIFIED LIVE (2026-08-19) — do NOT remove them.
 * Only remove the old dead gateway provider if present.
 *
 * token_free_gateway stays at port 10100 (Bun gateway, cracked web models only).
 * model_pool stays at port 3463 (Python proxy, key pool rotation).
 */
function removeDeadProviders(content) {
  let updated = content;

  // Repoint token_free_gateway base_url from dead port 3461 to active port 10100
  updated = updated.split('base_url: http://127.0.0.1:3461/v1').join('base_url: http://127.0.0.1:10100/v1');

  // Do NOT change fallback_model provider — user wants token_free_gateway-first
  // Only normalize the model name if it's still deepseek-chat
  updated = updated.replace(
    /fallback_model:\n(\s*)model: deepseek-chat\n(\s*)provider: token_free_gateway/,
    'fallback_model:\n$1model: deepseek-v4-flash\n$2provider: token_free_gateway',
  );

  // Fix model aliases
  updated = updated.split('token_free_gateway/gemini-pro').join('model_pool/gemini-pro');
  updated = updated.split('token_free_gateway/gemini-ultra').join('model_pool/gemini-ultra');

  // Update descriptions
  updated = updated.replace(
    '(baichat, nvidia, token_free_gateway, opencodex, etc.)',
    '(baichat, nvidia, model_pool, opencode-go)',
  );
  updated = updated.split('nous, aihubmix, zenmux, opencodex)').join('nous, aihubmix, zenmux, opencode-go)');

  return updated;
}

/**
 * Remove commandcode_anthropic provider from both model_providers and
 * providers sections. The user has exactly ONE Command Code provider:
 * command-code (port 3457) in the OpenCode config. commandcode_anthropic
 * (api.commandcode.ai) is a redundant remote alias that creates a duplicate
 * "Command Code" entry in the provider list.
 */
function removeCommandCodeAnthropic(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;
  let skipIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of commandcode_anthropic block (2-space indent)
    if (line.match(/^  commandcode_anthropic:\s*$/)) {
      skip = true;
      skipIndent = (line.match(/^(\s*)/) || [''])[0].length;
      continue;
    }

    if (skip) {
      const lineIndent = (line.match(/^(\s*)/) || [''])[0].length;
      const trimmed = line.trim();

      if (trimmed === '') {
        // Peek ahead: if next non-blank line is still indented, skip this blank
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length) {
          const nextIndent = (lines[j].match(/^(\s*)/) || [''])[0].length;
          if (nextIndent > skipIndent) {
            continue;
          }
        }
        skip = false;
        result.push(line);
        continue;
      }

      if (lineIndent > skipIndent) {
        continue;
      }

      skip = false;
    }

    result.push(line);
  }

  return result.join('\n').replace(/\n\n\n+/g, '\n\n');
}

/**
 * Ensure the nous, aihubmix, and zenmux providers are present in config
 * (re-added if a prior script run removed them). Keeps original base_urls:
 *   - nous: base_url: '' (uses model section base_url → port 10100 via model_pool)
 *   - aihubmix: https://api.aihubmix.com/v1 (API live 2026-08-19)
 *   - zenmux: https://zenmux.ai/api/v1 (API live 2026-08-19)
 *
 * The user does NOT want fallbacks to these — personality instructions enforce
 * "no fallback when using a specific provider." Only model_pool does auto-routing.
 */
function ensureProvidersRestored(content) {
  let updated = content;

  // --- model_providers section ---

  // Re-add nous (stable provider — keep original base_url: '')
  if (!updated.match(/^  nous:\s*$/m)) {
    const nousMP = [
      '  nous:',
      "    base_url: ''",
      '    description: Free-tier models via Nous Portal',
      '    display_name: Nous Portal',
      '    env_vars: []',
      "    key_env: ''",
      '    models:',
      '      poolside/laguna-s-2.1:free:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      poolside/laguna-m.1:free:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '    name: Nous',
      '    signup_url: https://portal.nousresearch.com/',
      '',
    ];
    updated = updated.replace(/^  model_pool:/m, nousMP.join('\n').trimEnd() + '\n  model_pool:');
  }

  // Re-add aihubmix (API verified live 2026-08-19)
  if (!updated.match(/^  aihubmix:\s*$/m)) {
    const aihubmixMP = [
      '  aihubmix:',
      '    base_url: https://api.aihubmix.com/v1',
      '    description: 100+ free models via AIHubMix (API live 2026-08-19)',
      '    display_name: AIHubMix',
      '    env_vars:',
      '      - AIHUBMIX_API_KEY_1',
      '      - AIHUBMIX_API_KEY_2',
      '      - AIHUBMIX_API_KEY_3',
      '      - AIHUBMIX_API_KEY_4',
      '      - AIHUBMIX_API_KEY_5',
      '      - AIHUBMIX_API_KEY_6',
      '      - AIHUBMIX_API_KEY_7',
      '    key_env: AIHUBMIX_API_KEY_1',
      '    models:',
      '      glm-5.3:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      coding-glm-5.3:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      gemini-3.7-flash:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      gemini-3.7-flash-free:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '    name: AIHubMix',
      '    signup_url: https://aihubmix.com/',
      '',
    ];
    updated = updated.replace(/^  model_pool:/m, aihubmixMP.join('\n').trimEnd() + '\n  model_pool:');
  }

  // Re-add zenmux (API verified live 2026-08-19)
  if (!updated.match(/^  zenmux:\s*$/m)) {
    const zenmuxMP = [
      '  zenmux:',
      '    base_url: https://zenmux.ai/api/v1',
      '    description: Free models via ZenMux (API live 2026-08-19)',
      '    display_name: ZenMux',
      '    env_vars:',
      '      - ZENMUX_API_KEY',
      '    key_env: ZENMUX_API_KEY',
      '    models:',
      '      deepseek-v4-flash:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '    name: ZenMux',
      '    signup_url: https://zenmux.ai/',
      '',
    ];
    updated = updated.replace(/^  model_pool:/m, zenmuxMP.join('\n').trimEnd() + '\n  model_pool:');
  }

  // Re-add opencode-go (OpenCode Go — single OPENCODE_API_KEY, NOT a numbered pool)
  if (!updated.match(/^  opencode-go:\s*$/m)) {
    const openCodeGoMP = [
      '  opencode-go:',
      '    base_url: https://opencode.ai/zen/go/v1',
      '    description: OpenCode Go — subscription to 1 of 9 OpenCode Zen keys (single OPENCODE_API_KEY, NOT a numbered pool)',
      '    display_name: OpenCode Go',
      '    env_vars:',
      '      - OPENCODE_API_KEY',
      '    key_env: OPENCODE_API_KEY',
      '    models:',
      '      kimi-k2.7-code:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      kimi-k3:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      deepseek-v4-pro:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      deepseek-v4-flash:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      glm-5.2:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      minimax-m3:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '    name: OpenCode Go',
      '    signup_url: https://opencode.ai/zen/go',
      '',
    ];
    updated = updated.replace(/^  model_pool:/m, openCodeGoMP.join('\n').trimEnd() + '\n  model_pool:');
  }

  // Re-add openrouter (ox alpha — free OpenRouter models)
  if (!updated.match(/^  openrouter:\s*$/m)) {
    const openrouterMP = [
      '  openrouter:',
      '    base_url: https://openrouter.ai/api/v1',
      '    description: OpenRouter free-tier models (ox alpha)',
      '    display_name: OpenRouter (ox alpha)',
      '    env_vars:',
      '      - OPENROUTER_API_KEY',
      '    key_env: OPENROUTER_API_KEY',
      '    models:',
      '      openai/gpt-4o-mini:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      openai/gpt-4o:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      meta-llama/llama-4-scout:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      deepseek/deepseek-r1:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      google/gemini-2.0-flash:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      mistralai/mistral-7b-instruct:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '      anthropic/claude-3-5-sonnet:',
      '        type: chat',
      '        free: true',
      '        tier: 1',
      '    name: OpenRouter (ox alpha)',
      '    signup_url: https://openrouter.ai/keys',
      '',
    ];
    updated = updated.replace(/^  model_pool:/m, openrouterMP.join('\n').trimEnd() + '\n  model_pool:');
  }

  // --- providers section ---

  // Re-add nous in providers section
  if (!updated.match(/\n  nous:\n    name: Nous Portal/)) {
    const nousProv = [
      '  nous:',
      '    name: Nous Portal',
      "    base_url: ''",
      "    key_env: ''",
      '    model: poolside/laguna-s-2.1:free',
      '',
    ];
    updated = updated.replace(/\n  model_pool:\n    name: Model Pool/, '\n' + nousProv.join('\n').trimEnd() + '\n  model_pool:\n    name: Model Pool');
  }

  // Re-add aihubmix in providers section
  if (!updated.match(/\n  aihubmix:\n    name: AIHubMix/)) {
    const aihubmixProv = [
      '  aihubmix:',
      '    name: AIHubMix',
      '    base_url: https://api.aihubmix.com/v1',
      '    key_env: AIHUBMIX_API_KEY_1',
      '    model: glm-5.3',
      '',
    ];
    updated = updated.replace(/\n  model_pool:\n    name: Model Pool/, '\n' + aihubmixProv.join('\n').trimEnd() + '\n  model_pool:\n    name: Model Pool');
  }

  // Re-add zenmux in providers section
  if (!updated.match(/\n  zenmux:\n    name: ZenMux/)) {
    const zenmuxProv = [
      '  zenmux:',
      '    name: ZenMux',
      '    base_url: https://zenmux.ai/api/v1',
       '    key_env: ZENMUX_API_KEY',
      '    model: deepseek-v4-flash',
      '',
    ];
    updated = updated.replace(/\n  model_pool:\n    name: Model Pool/, '\n' + zenmuxProv.join('\n').trimEnd() + '\n  model_pool:\n    name: Model Pool');
  }

  // Re-add opencode-go in providers section (OpenCode Go — single OPENCODE_API_KEY)
  if (!updated.match(/\n  opencode-go:\n    name: OpenCode Go/)) {
    const opencodeGoProv = [
      '  opencode-go:',
      '    name: OpenCode Go',
      '    base_url: https://opencode.ai/zen/go/v1',
      '    key_env: OPENCODE_API_KEY',
      '    model: deepseek-v4-flash',
      '',
    ];
    updated = updated.replace(/\n  model_pool:\n    name: Model Pool/, '\n' + opencodeGoProv.join('\n').trimEnd() + '\n  model_pool:\n    name: Model Pool');
  }

  // Re-add openrouter in providers section (ox alpha)
  if (!updated.match(/\n  openrouter:\n    name: OpenRouter/)) {
    const openrouterProv = [
      '  openrouter:',
      '    name: OpenRouter (ox alpha)',
      '    base_url: https://openrouter.ai/api/v1',
      '    key_env: OPENROUTER_API_KEY',
      '    model: openai/gpt-4o-mini',
      '',
    ];
    updated = updated.replace(/\n  model_pool:\n    name: Model Pool/, '\n' + openrouterProv.join('\n').trimEnd() + '\n  model_pool:\n    name: Model Pool');
  }

  return updated;
}

/** NOTE: Do NOT delete state.db — it is the main Hermes database containing
 * chat history and running tasks, not a cache. Only clean JSON cache files
 * that can be safely regenerated from config.yaml on next launch.
 */
async function cleanCacheFiles() {
  const hermesDir = dirname(configPath);
  const cacheFiles = [
    join(hermesDir, 'provider_models_cache.json'),
    join(hermesDir, 'models_dev_cache.json'),
  ];
  for (const f of cacheFiles) {
    try {
      await access(f, constants.R_OK);
      const fileStat = await stat(f);
      if (fileStat.isFile()) {
        await unlink(f);
        console.log('Removed stale cache:', basename(f));
      }
    } catch { /* File doesn't exist — skip */ }
  }
}

/** Fixes provider configurations: ensures token_free_gateway port is 10100,
 * command-code provider is present, and model_pool has its models section. */
function fixProviderConfigs(content) {
  let updated = content;

  // 1. Fix token_free_gateway port: 3456 → 10100
  if (updated.includes('http://127.0.0.1:3456/v1')) {
    updated = updated.replace(/http:\/\/127\.0\.0\.1:3456\/v1/g, 'http://127.0.0.1:10100/v1');
  }

  // 2. Add command-code to model_providers if missing
  if (!updated.match(/^  command-code:\s*$/m)) {
    const ccMP = [
      '  command-code:',
      '    bearer_token: any-string',
      '    base_url: http://127.0.0.1:3457/v1',
      '    description: Command Code local bridge at port 3457 — the ONE canonical Command Code provider',
      '    display_name: Command Code',
      '    key_env: COMMANDCODE_API_KEY',
      '    models:',
      '      poolside/laguna-s-2.1:free:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      deepseek/deepseek-v4-flash:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '    name: Command Code',
    ].join('\n');
    // Insert before the first token_free_gateway in model_providers
    updated = updated.replace(/^  token_free_gateway:/m, ccMP + '\n  token_free_gateway:');
  }

  // 3. Add command-code to providers section if missing (second occurrence of token_free_gateway)
  if (!updated.match(/^  command-code:\s*\n    name: Command Code/m)) {
    const ccProv = [
      '  command-code:',
      '    name: Command Code',
      '    base_url: http://127.0.0.1:3457/v1',
      '    bearer_token: any-string',
      '    key_env: COMMANDCODE_API_KEY',
      '    model: poolside/laguna-s-2.1:free',
    ].join('\n');
    const matches = [...updated.matchAll(/^  token_free_gateway:/gm)];
    if (matches.length >= 2) {
      const insertPos = matches[1].index;
      updated = updated.slice(0, insertPos) + ccProv + '\n' + updated.slice(insertPos);
    }
  }

  // 4. Add models section to model_pool if missing
  const mpMatch = updated.match(/(^  model_pool:\n    model: poolside\/laguna-s-2\.1:free\n)(?!    models:)/m);
  if (mpMatch) {
    const models = [
      '      poolside/laguna-s-2.1:free:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      deepseek-v4-flash:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      deepseek-v4-pro:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      glm-5.2:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      glm-5.2-free:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      qwen3.5-plus:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      minimax-m3:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      kimi-k2.7-code:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      kimi-k3:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      z-ai/glm-5.2:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      nvidia/llama-3.3-nemotron-super-49b-v1.5:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      nemotron-3-ultra:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
      '      gemini-3.7-flash:',
      '        free: true',
      '        tier: 1',
      '        type: chat',
    ].join('\n');
    updated = updated.replace(mpMatch[1], mpMatch[1] + '    models:\n' + models + '\n');
  }

  return updated;
}

/** Main entry point. */
async function main() {
  try {
    await access(configPath, constants.R_OK);
  } catch {
    console.error('Hermes config not found at:', configPath);
    process.exit(1);
  }

  const content = await readFile(configPath, 'utf8');

  const tasteContent = await loadTasteContent();
  const instructions = buildNativeInstructions(tasteContent);

  let finalContent = content;
  let harnessUpdated = false;

  // Apply harness if not already at current version
  if (!isConfigured(content)) {
    const result = applyHarness(content, instructions);
    if (result.updated) {
      finalContent = result.content;
      harnessUpdated = true;
    } else {
      console.log(result.reason);
    }
  }

  // Always ensure computer_use plugin and experimental.toolkit are present
  finalContent = ensureComputerUsePlugins(finalContent);

  // Always ensure model settings route to the active free-model proxy
  finalContent = ensureModelSettings(finalContent);

  // Always remove dead providers (token_free_gateway only) and fix fallback_model
  finalContent = removeDeadProviders(finalContent);

  // Fix mangled provider entries (duplicate property keys under commandcode_anthropic)
  finalContent = fixMangledProviders(finalContent);

  // Remove commandcode_anthropic (redundant remote alias — user has ONE Command Code
  // provider: command-code at port 3457 in the OpenCode config)
  finalContent = removeCommandCodeAnthropic(finalContent);

  // Remove old opencodex provider (replaced by opencode-go)
  finalContent = removeOpenCodex(finalContent);

  // Remove duplicate model entries from model_pool.models
  finalContent = deduplicateModelPoolModels(finalContent);

  // Always ensure restored providers (nous, aihubmix, zenmux, opencode-go) are present
  finalContent = ensureProvidersRestored(finalContent);

  // Fix provider configs (command-code, token_free_gateway port/models, model_pool models)
  finalContent = fixProviderConfigs(finalContent);

  if (finalContent !== content) {
    // Back up before writing
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, `config.yaml.before-bridge-${Date.now()}`);
    await writeFile(backupPath, content);
    await writeFile(configPath, finalContent);
    console.log('Hermes config updated');
    if (harnessUpdated) {
      console.log('Native CC bridge harness installed in Hermes config');
      console.log('Instructions embedded:', instructions.length, 'items');
    } else {
      console.log('Hermes harness already present; plugins + model settings + provider cleanup ensured');
    }
    console.log('Backup saved to:', backupPath);
  } else {
    console.log('Hermes harness already present and current — no changes needed');
  }

  // Clean stale cache/state files that may hold old provider data
  await cleanCacheFiles();
}

main().catch((error) => {
  console.error('Failed to restore Hermes harness:', error.message);
  process.exit(1);
});
