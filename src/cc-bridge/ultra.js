/**
 * @module ultra
 *
 * Ultra-mode delegation logic for free multi-model parallel dispatch.
 *
 * Unlike Command Code's internal Ultra (which routes through Luna/gpt-5.6-luna),
 * Hermes uses FREE models from ALL providers. This module provides the planning
 * and routing logic that the host (Hermes, OpenCode, Command Code) uses to
 * batch-dispatch sub-tasks across the free model pool.
 *
 * Core behaviors:
 * - detectUltraMode: recognize `No:ultra` opt-out / `Ultra:` opt-in prefixes
 * - selectFreeModel: rotate across providers (no single-provider lock-in)
 * - buildUltraDispatchPlan: decompose a task into parallelizable sub-tasks with model assignments
 * - buildAuditPlan: dispatch the SAME task to 2-N different free models for cross-review
 */

// Free model pool — rotated across ALL active free providers for parallel dispatch.
// The user has NO ChatGPT/Luna subscription, so we use free tiers only.
// Provider status per OPENCODE_KNOWLEDGE.md (2026-08-19):
//   KEPT:  nvidia, model_pool, baichat, nous (2 accounts: laguna-s-2.1, laguna-m.1),
//          aihubmix (glm-5.3, gemini-3.7-flash — API live as of 2026-08-19),
//          zenmux (deepseek-v4-flash — API live as of 2026-08-19)
//   REMOVED: token_free_gateway (port 3461 dead — use model_pool at port 10100 instead),
//            anthropic (0 keys), groq (0 keys)
//   RULE: When using a specific provider (NOT model_pool), NO fallback to other
//         models if it fails — work inline until verified back. Only model_pool
//         auto-routes to the best available provider. (user: never fallback from nous)
// Model IDs match the config.toml [model_providers.NAME.models] mappings.
// ACTIVE PROXY: port 10100 (OpenCodeX Pooled auto-router)
export const FREE_PROVIDERS = Object.freeze([
  'nvidia',
  'model_pool',
  'baichat',
  'nous',
  'aihubmix',
  'zenmux',
]);

export const FREE_MODELS = Object.freeze([
  // baichat (free only: deepseek-v4-flash; v4-pro/glm-5.2 return 403)
  { id: 'deepseek-v4-flash', provider: 'baichat', name: 'DeepSeek V4 Flash' },
  // nvidia (free tier: z-ai/glm-5.2, nemotron lightning)
  { id: 'z-ai/glm-5.2', provider: 'nvidia', name: 'GLM-5.2' },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', provider: 'nvidia', name: 'Nemotron 3.5 Lightning' },
  // model_pool (auto-route to best available free provider, port 10100 — OpenCodeX Pooled)
  { id: 'poolside/laguna-s-2.1:free', provider: 'model_pool', name: 'Laguna S 2.1 Free' },
  { id: 'deepseek-v4-flash', provider: 'model_pool', name: 'DeepSeek V4 Flash' },
  { id: 'deepseek-chat', provider: 'model_pool', name: 'DeepSeek Chat' },
  { id: 'glm-5.2-free', provider: 'model_pool', name: 'GLM 5.2 Free' },
  // nous (2 accounts: laguna-s-2.1 and laguna-m.1; stable provider — NEVER repoint or remove per user)
  { id: 'poolside/laguna-s-2.1:free', provider: 'nous', name: 'Laguna S 2.1 Free' },
  { id: 'poolside/laguna-m.1:free', provider: 'nous', name: 'Laguna M.1 Free' },
  // aihubmix (API live, free models: glm-5.3, gemini-3.7-flash-free)
  { id: 'glm-5.3', provider: 'aihubmix', name: 'GLM-5.3' },
  { id: 'gemini-3.7-flash', provider: 'aihubmix', name: 'Gemini 3.7 Flash' },
  // zenmux (API live, free models: deepseek-v4-flash)
  { id: 'deepseek-v4-flash', provider: 'zenmux', name: 'DeepSeek V4 Flash' },
  // token_free_gateway REMOVED — port 3461 is dead; use model_pool (port 10100) instead
]);

/**
 * Configuration for Ultra delegation.
 * No parallelism cap — always maximize sub-agents regardless of count.
 */
export const ultraConfig = Object.freeze({
  maxParallel: Infinity,     // no cap — always spawn as many as needed
  auditModels: 3,            // dispatch same task to 3 different free models for audit
  auditThresholdSteps: 3,    // tasks with >3 sub-steps get audited
  auditThresholdMinutes: 10, // tasks >10 min estimated get audited
  defaultProvider: 'model_pool', // fallback single-provider (active proxy at port 10100)
  freeModels: FREE_MODELS,
});

/**
 * Detect Ultra mode from a message.
 *
 * - `No:ultra` (exact prefix, case-sensitive) → Ultra DISABLED for this one task
 * - `Ultra:` (exact prefix, case-sensitive) → Ultra ENABLED for this one task
 * - Neither present → use default (host effort level determines auto-activation)
 *
 * @param {string} message - The user message to analyze
 * @returns {{ ultra: boolean, optOut: boolean, optIn: boolean, cleanedMessage: string }}
 */
export function detectUltraMode(message) {
  if (!message || typeof message !== 'string') {
    return { ultra: false, optOut: false, optIn: false, cleanedMessage: message || '' };
  }

  const trimmed = message.trim();

  // No:ultra — explicit opt-out for this one task
  if (trimmed.startsWith('No:ultra')) {
    return {
      ultra: false,
      optOut: true,
      optIn: false,
      cleanedMessage: trimmed.slice('No:ultra'.length).trim(),
    };
  }

  // Ultra: — explicit opt-in for this one task
  if (trimmed.startsWith('Ultra:')) {
    return {
      ultra: true,
      optOut: false,
      optIn: true,
      cleanedMessage: trimmed.slice('Ultra:'.length).trim(),
    };
  }

  // Default: Ultra is active by default (proactive delegation) unless opted out
  return { ultra: true, optOut: false, optIn: false, cleanedMessage: trimmed };
}

let _modelIndex = 0;

/**
 * Select the next free model in rotation, excluding any that are already in use.
 *
 * @param {string[]} [usedModels] - Model IDs already assigned in this batch
 * @param {number} [n=1] - How many models to select
 * @returns {Array<{id: string, provider: string, name: string}>}
 */
export function selectFreeModel(usedModels = [], n = 1) {
  const available = FREE_MODELS.filter((m) => !usedModels.includes(m.id));
  if (available.length === 0) {
    // All used — cycle back
    return Array.from({ length: n }, (_, i) => FREE_MODELS[(i + _modelIndex) % FREE_MODELS.length]);
  }
  const selected = [];
  for (let i = 0; i < n; i++) {
    const idx = (_modelIndex + i) % available.length;
    selected.push(available[idx]);
  }
  _modelIndex = (_modelIndex + n) % FREE_MODELS.length;
  return selected;
}

/**
 * Build an Ultra dispatch plan: decompose a task into parallelizable sub-tasks,
 * assign free models, and optionally create audit duplicates.
 *
 * @param {string} task - The task description
 * @param {object} [options]
 * @param {boolean} [options.audit=false] - Whether to include multi-model audit
 * @param {number} [options.modelCount] - Number of audit models (default: ultraConfig.auditModels)
 * @param {number} [options.maxParallel=Infinity] - Parallelism cap (default: no cap)
 * @returns {{ subTasks: Array, parallelizable: boolean, audit: object|null, modelPool: string[] }}
 */
export function buildUltraDispatchPlan(task, options = {}) {
  const { audit = false, modelCount = ultraConfig.auditModels, maxParallel = ultraConfig.maxParallel } = options;

  // Decompose: split on " and ", semicolons, numbered steps
  const subTaskTexts = task
    .split(/\s+(?:and|;)\s+|\d+\.\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  const subTasks = subTaskTexts.length > 1
    ? subTaskTexts.map((desc, i) => ({
        id: `ultra-${i + 1}`,
        description: desc,
        fileScope: '.worktree-proof/*',
        parallelizable: true,
        model: selectFreeModel([], 1)[0]?.id || 'deepseek-chat',
      }))
    : [{
        id: 'ultra-1',
        description: task,
        fileScope: '.worktree-proof/*',
        parallelizable: false,
        model: selectFreeModel([], 1)[0]?.id || 'deepseek-chat',
      }];

  const parallelizable = subTasks.length > 1 && subTasks.every((s) => s.parallelizable);
  const capped = Math.min(subTasks.length, maxParallel === Infinity ? subTasks.length : maxParallel);

  let auditPlan = null;
  if (audit || (subTasks.length >= ultraConfig.auditThresholdSteps)) {
    const auditModels = selectFreeModel(subTasks.map((s) => s.model), modelCount);
    auditPlan = {
      enabled: true,
      mainTask: task,
      models: auditModels.map((m) => ({
        id: m.id,
        provider: m.provider,
        name: m.name,
        laneId: `audit-${m.provider}-${m.id}`,
      })),
      instructions: 'Each model independently decomposes, plans, and reviews the same task. Results are compared for consensus.',
    };
  }

  return {
    subTasks,
    parallelizable,
    dispatched: capped,
    maxParallel,
    hasCap: maxParallel !== Infinity,
    audit: auditPlan,
    modelPool: FREE_MODELS.map((m) => `${m.provider}:${m.id}`),
  };
}

/**
 * Build a multi-model audit plan: dispatch the SAME task to N different free models
 * for cross-review. Each model gets a unique lane and provider.
 *
 * @param {string} task - The task to audit
 * @param {number} [n] - Number of models to dispatch (default: ultraConfig.auditModels)
 * @returns {{ models: Array, lanes: Array, instructions: string }}
 */
export function buildAuditPlan(task, n = ultraConfig.auditModels) {
  const models = selectFreeModel([], n);

  return {
    models: models.map((m) => ({
      id: m.id,
      provider: m.provider,
      name: m.name,
    })),
    lanes: models.map((m, i) => ({
      laneId: `audit-${m.provider}-${m.id}`,
      description: task,
      model: m.id,
      provider: m.provider,
      fileScope: '.worktree-proof/*',
      index: i,
    })),
    instructions: 'Dispatch this identical task to each model in parallel. Each model independently: (1) decomposes the task, (2) creates a plan, (3) reviews the other models\' outputs. Produce a consensus result.',
  };
}

/**
 * Generate Ultra mode instructions for injection into host system prompts.
 * These are the personality instructions that make delegation happen natively.
 *
 * @returns {string[]} Array of instruction strings
 */
export function buildUltraInstructions() {
  return [
    '- "Native Ultra delegation: Proactively spawn sub-agents for parallelizable work WITHOUT waiting to be asked. Batch-dispatch ALL independent items at once in one burst. No cap on sub-agent count."',
    '- "Free multi-model pool: Rotate sub-agents across ALL free model providers (baichat, nvidia, model_pool, nous with 2 accounts, aihubmix, zenmux). DO NOT use token_free_gateway (port 3461 dead) — NEVER fall back to it. When using a specific provider (NOT model_pool), NO fallback to other models if it fails — work inline until verified back. Fallback only happens on model_pool (port 10100, auto-router). Distribute risk across active providers."',
    '- "Multi-model audit: For complex tasks (>3 sub-steps or >10 min estimated), dispatch the SAME task to 2-3 different free models in parallel. Compare outputs, identify consensus, select the best result."',
    '- "Batch-dispatch: Select ALL genuinely independent open checklist items before starting. Dispatch them all at once, then backfill each returning slot immediately. Never finish one item then look for the next."',
    '- "No:ultra opt-out: A user message beginning with exactly \\"No:ultra\\" disables Ultra delegation for that one task and removes the prefix from the message."',
    '- "Ultra: opt-in: A user message beginning with exactly \\"Ultra:\\" enables this workflow for one task at any effort level. Neither prefix changes the selected parent effort."',
    '- "Resource gate: Before spawning, check provider/model availability. Skip unreachable free providers. If a model fails, immediately try the next in rotation — never retry the same failing model."',
    '- "Backfill immediately: When a sub-agent returns (success or failure), dispatch the next queued item into the freed slot in the same turn. Idle slots are a failure."',
  ];
}

export default {
  FREE_PROVIDERS,
  FREE_MODELS,
  ultraConfig,
  detectUltraMode,
  selectFreeModel,
  buildUltraDispatchPlan,
  buildAuditPlan,
  buildUltraInstructions,
};
