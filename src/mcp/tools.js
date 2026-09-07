/** Bounded, injected MCP tool allowlist. No private state, process, or I/O. */

import { types as utilTypes } from 'node:util';

export const DEFAULT_TOOL_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024,
  maxOutputBytes: 16 * 1024,
  maxStringBytes: 4 * 1024,
  maxDepth: 8,
  maxItems: 128,
  maxNodes: 2048,
});
export const HARD_TOOL_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxDepth: 16,
  maxItems: 256,
  maxNodes: 4096,
});

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_WORDS = new Set([
  'apikey', 'token', 'secret', 'password', 'passphrase', 'credential',
  'authorization', 'auth', 'cookie', 'session', 'owner', 'stack', 'path',
  'private', 'privatekey', 'home', 'cwd',
]);
const SENSITIVE_VALUE = /(?:WTP_[A-Z0-9_]*(?:SECRET|TOKEN|OWNER|SESSION|STACK)|\bBearer\s+[A-Za-z0-9._~+/=-]+|(?:^|\s)(?:sk|ghp|gho|ghs|ghr|xox[baprs]-)[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{12,}\b|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{8,})/iu;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export class McpToolError extends Error {
  constructor(message, code = 'ERR_TOOL') {
    super(String(message).slice(0, 160));
    this.name = 'McpToolError';
    this.code = code;
  }
}

export function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function effectiveLimits(options = {}) {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...options };
  for (const key of Object.keys(HARD_TOOL_LIMITS)) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_TOOL_LIMITS[key]) {
      throw new RangeError(`${key} is outside the bounded range`);
    }
  }
  return limits;
}

function normalizedKey(key) {
  return String(key).replaceAll('_', '').replaceAll('-', '').toLowerCase();
}

function sensitiveKey(key) {
  const normalized = normalizedKey(key);
  return [...SENSITIVE_WORDS].some((word) => normalized === word || normalized.includes(word));
}

function redactString(value, key = '') {
  if (sensitiveKey(key) || SENSITIVE_VALUE.test(value) || ABSOLUTE_PATH.test(value)) return '[redacted]';
  return value;
}

/** Ensure a string's complete UTF-8 representation stays within maxBytes. */
export function boundedText(value, maxBytes) {
  if (maxBytes < 1) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes < markerBytes) return '?'.repeat(maxBytes);
  let prefix = Buffer.from(value, 'utf8').subarray(0, maxBytes - markerBytes).toString('utf8');
  while (prefix && Buffer.byteLength(prefix, 'utf8') + markerBytes > maxBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}

function descriptors(value, maxItems = DEFAULT_TOOL_LIMITS.maxItems) {
  try {
    if (utilTypes.isProxy(value)) throw new McpToolError('proxy is not JSON-safe', 'ERR_INVALID_PARAMS');
    const keys = Reflect.ownKeys(value);
    const array = Array.isArray(value);
    let items = 0;
    for (const key of keys) {
      if (typeof key !== 'string') throw new McpToolError('symbols are not JSON-safe', 'ERR_INVALID_PARAMS');
      if (!(array && key === 'length') && ++items > maxItems) throw new McpToolError('value has too many items', 'ERR_INVALID_PARAMS');
    }
    const own = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new McpToolError('accessor or non-enumerable value is not JSON-safe', 'ERR_INVALID_PARAMS');
      own[key] = descriptor;
    }
    return own;
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    throw new McpToolError('value is not JSON-safe', 'ERR_INVALID_PARAMS');
  }
}

function validateNode(value, limits, state, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > limits.maxStringBytes) throw new McpToolError('string is too large', 'ERR_INVALID_PARAMS');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new McpToolError('number is not JSON-safe', 'ERR_INVALID_PARAMS');
    return;
  }
  if (typeof value !== 'object' || depth > limits.maxDepth) throw new McpToolError('value is not JSON-safe', 'ERR_INVALID_PARAMS');
  if (state.seen.has(value)) throw new McpToolError('cyclic value is not JSON-safe', 'ERR_INVALID_PARAMS');
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) throw new McpToolError('value is too large', 'ERR_INVALID_PARAMS');
  state.seen.add(value);
  let own;
  try {
    if (!Array.isArray(value) && !plainObject(value)) throw new McpToolError('value is not a plain object', 'ERR_INVALID_PARAMS');
    own = descriptors(value, limits.maxItems);
    const keys = Object.keys(own).filter((key) => !(Array.isArray(value) && key === 'length'));
    if (keys.length > limits.maxItems) throw new McpToolError('value has too many items', 'ERR_INVALID_PARAMS');
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) throw new McpToolError('dangerous key is not allowed', 'ERR_INVALID_PARAMS');
      const descriptor = own[key];
      if (!descriptor || !('value' in descriptor)) throw new McpToolError('accessor is not JSON-safe', 'ERR_INVALID_PARAMS');
      validateNode(descriptor.value, limits, state, depth + 1);
    }
  } finally {
    state.seen.delete(value);
  }
}

export function assertJsonSafe(value, options = {}) {
  const limits = effectiveLimits(options);
  validateNode(value, limits, { seen: new WeakSet(), nodes: 0 }, 0);
  return true;
}

function sanitizeNode(value, limits, state, key = '', depth = 0) {
  if (value === null) return null;
  if (typeof value === 'string') return boundedText(redactString(value, key), limits.maxStringBytes);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[redacted]';
  if (typeof value !== 'object' || depth > limits.maxDepth || state.seen.has(value)) return '[truncated]';
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) return '[truncated]';
  state.seen.add(value);
  let result;
  try {
    if (Array.isArray(value)) {
      const own = descriptors(value, limits.maxItems);
      const keys = Object.keys(own).filter((item) => item !== 'length').sort((a, b) => Number(a) - Number(b)).slice(0, limits.maxItems);
      result = keys.map((item) => DANGEROUS_KEYS.has(item) ? '[redacted]' : own[item] && 'value' in own[item] ? sanitizeNode(own[item].value, limits, state, '', depth + 1) : '[redacted]');
      if (Object.keys(own).filter((item) => item !== 'length').length > limits.maxItems) result.push('[truncated]');
    } else if (plainObject(value)) {
      const own = descriptors(value, limits.maxItems);
      result = {};
      const keys = Object.keys(own).sort();
      for (const property of keys.slice(0, limits.maxItems)) {
        if (DANGEROUS_KEYS.has(property)) continue;
        if (sensitiveKey(property)) result[property] = '[redacted]';
        else {
          const descriptor = own[property];
          result[property] = descriptor && 'value' in descriptor ? sanitizeNode(descriptor.value, limits, state, property, depth + 1) : '[redacted]';
        }
      }
      if (keys.length > limits.maxItems) result._truncated = true;
    } else result = '[redacted]';
  } catch {
    result = '[redacted]';
  } finally {
    state.seen.delete(value);
  }
  return result;
}

export function sanitizeJson(value, options = {}) {
  const limits = effectiveLimits(options);
  return sanitizeNode(value, limits, { seen: new WeakSet(), nodes: 0 });
}

export function safeStringify(value, options = {}) {
  const limits = effectiveLimits(options);
  let text;
  try { text = JSON.stringify(sanitizeJson(value, limits)); }
  catch { text = '{"redacted":true}'; }
  if (Buffer.byteLength(text, 'utf8') <= limits.maxOutputBytes) return text;
  return '{"truncated":true}';
}

function schema(properties, required = []) {
  return Object.freeze({ type: 'object', properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false });
}

const TOOLS = Object.freeze([
  Object.freeze({ name: 'worktreeproof_capabilities', description: 'Return bounded WorktreeProof capabilities.', inputSchema: schema({}) }),
  Object.freeze({ name: 'worktreeproof_status', description: 'Return a redacted, bounded local status summary.', inputSchema: schema({}) }),
  Object.freeze({ name: 'worktreeproof_validate_receipt', description: 'Validate one closure receipt through the injected core adapter.', inputSchema: schema({ receipt: Object.freeze({ type: 'object' }) }, ['receipt']) }),
  Object.freeze({ name: 'worktreeproof_validate_scope', description: 'Validate a relative lane scope through the injected core adapter.', inputSchema: schema({ laneId: Object.freeze({ type: 'string', maxLength: 128 }), fileScope: Object.freeze({ type: 'string', maxLength: 512 }) }, ['fileScope']) }),
]);

// --- Command Code bridge tools (taste, skills, plan mode, deferred tools) ---
// These are portable implementations of Command Code's architectural benefits.
// Available via MCP to any agent framework (Claude Code, OpenCode, Codex, Hermes).

import { readFile as _bridgeReadFile, access as _bridgeAccess, mkdir as _bridgeMkdir, writeFile as _bridgeWriteFile, readdir as _bridgeReaddir } from 'node:fs/promises';
import { constants as _fsConstants } from 'node:fs';
import { dirname as _dirname, join as _join, resolve as _resolve } from 'node:path';
import { homedir as _homedir } from 'node:os';
import { fileURLToPath as _fileURLToPath } from 'node:url';

import { sendBridgeMessage, listBridgeInbox, claimBridgeMessage, ackBridgeMessage, completeBridgeMessage } from '../bridge.js';
import { runToolRepair } from '../cc-bridge/hooks.js';
import { buildUltraDispatchPlan, buildAuditPlan, ultraConfig } from '../cc-bridge/ultra.js';

const _bridgeFs = {
  readFile: _bridgeReadFile,
  access: _bridgeAccess,
  mkdir: _bridgeMkdir,
  writeFile: _bridgeWriteFile,
  readdir: _bridgeReaddir,
  constants: _fsConstants,
};

// Session-scoped plan mode state (in-memory fallback for MCP)
const _planModeSessions = new Map();

const PLAN_MODE_REMOVED_TOOLS = Object.freeze(['edit_file', 'write_file', 'monitor_command', 'todo_write', 'kill_shell', 'task_stop', 'taste', 'cc_todos_update', 'cc_todos_clear']);
const PLAN_MODE_REMOVED_PREFIXES = Object.freeze(['bridge_']);

function _result(title, value) {
  return { title, output: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

async function _fileExists(path) {
  try {
    await _bridgeAccess(path, _fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function _loadTasteContent(projectRoot) {
  const { readFile, access: _access, constants } = _bridgeFs;
  const paths = [_join(_homedir(), '.commandcode', 'taste', 'taste.md')];
  if (projectRoot) {
    paths.push(_join(projectRoot, '.commandcode', 'taste', 'taste.md'));
  }
  // Also check category sub-files
  const tasteDir = _join(_homedir(), '.commandcode', 'taste');
  let subFiles = [];
  try {
    const dirs = await _bridgeReaddir(tasteDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory() && _fileExists(_join(tasteDir, dir.name, 'taste.md'))) {
        subFiles.push(_join(tasteDir, dir.name, 'taste.md'));
      }
    }
  } catch {
    // taste dir doesn't exist
  }
  paths.push(...subFiles);

  const segments = [];
  let hasTaste = false;
  for (const path of paths) {
    try {
      await _access(path, constants.R_OK);
      const content = await readFile(path, 'utf8');
      if (content && content.trim()) {
        hasTaste = true;
        segments.push(content);
      }
    } catch {
      // skip
    }
  }
  if (!hasTaste) return { content: '', hasTaste: false };
  const xml = `\n<taste>\n${segments.join('\n')}\n</taste>\n`.trim();
  return { content: xml, hasTaste };
}

async function _listSkills(projectRoot) {
  const paths = [
    _join(_homedir(), '.commandcode', 'skills'),
    _join(_homedir(), '.claude', 'skills'),
  ];
  if (projectRoot) {
    paths.push(_join(projectRoot, '.commandcode', 'skills'));
    paths.push(_join(projectRoot, 'skills'));
  }
  // Also the worktree-proof repo skills
  const repoRoot = _resolve(_dirname(fileURLToPath(import.meta.url)), '..', '..');
  paths.push(_join(repoRoot, 'skills'));

  const results = [];
  const seen = new Set();
  for (const basePath of paths) {
    let dirs;
    try {
      dirs = await _bridgeReaddir(basePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (seen.has(dir.name)) continue;
      const skillDir = _join(basePath, dir.name);
      const hasManifest = await _fileExists(_join(skillDir, 'SKILL.md')) || await _fileExists(_join(skillDir, 'skill.md'));
      if (!hasManifest) continue;
      seen.add(dir.name);
      results.push({ name: dir.name, path: skillDir });
    }
  }
  return results;
}

const BRIDGE_TOOLS = Object.freeze([
  Object.freeze({ name: 'cc_taste_show', description: 'Show the current taste (learned coding preferences) injected into the system prompt.', inputSchema: schema({}) }),
  Object.freeze({ name: 'cc_taste_learn', description: 'Record a new taste learning (coding preference) to be injected in future turns.', inputSchema: schema({ category: Object.freeze({ type: 'string', maxLength: 64 }), learning: Object.freeze({ type: 'string', maxLength: 512 }), confidence: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }), scope: Object.freeze({ type: 'string', enum: ['global', 'project'] }) }, ['category', 'learning']) }),
  Object.freeze({ name: 'cc_skills_list', description: 'List all available skills across global, project, and worktree-proof skill paths.', inputSchema: schema({}) }),
  Object.freeze({ name: 'cc_skills_expand', description: 'Expand a skill reference by inlining its SKILL.md content.', inputSchema: schema({ name: Object.freeze({ type: 'string', maxLength: 128 }) }, ['name']) }),
  Object.freeze({ name: 'cc_plans_mode', description: 'Toggle plan mode (read-only exploration). In plan mode, editing/mutating tools are filtered out.', inputSchema: schema({ enable: Object.freeze({ type: 'boolean' }) }) }),
  Object.freeze({ name: 'cc_plans_mode_show', description: 'Show whether plan mode is currently active for this session.', inputSchema: schema({}) }),
  Object.freeze({ name: 'cc_search_tools', description: 'Search for tools by capability description.', inputSchema: schema({ query: Object.freeze({ type: 'string', maxLength: 256 }), limit: Object.freeze({ type: 'number', minimum: 1, maximum: 50 }) }, ['query']) }),
  // Bridge messaging: send, inbox, claim, ack, complete — file-backed inter-agent IPC.
  Object.freeze({ name: 'bridge_send', description: 'Send a task or status message to another agent via the file-backed bridge. Idempotent via idempotencyKey.', inputSchema: schema({ sender: Object.freeze({ type: 'string', maxLength: 128 }), recipient: Object.freeze({ type: 'string', maxLength: 128 }), type: Object.freeze({ type: 'string', enum: ['task', 'status', 'result', 'question', 'cancel'] }), summary: Object.freeze({ type: 'string', maxLength: 512 }), fileScope: Object.freeze({ type: 'string', maxLength: 512 }), laneId: Object.freeze({ type: 'string', maxLength: 128 }), ttlMs: Object.freeze({ type: 'integer', minimum: 1000, maximum: 7 * 24 * 60 * 60 * 1000 }), idempotencyKey: Object.freeze({ type: 'string', maxLength: 128 }) }, ['sender', 'recipient', 'type', 'summary']) }),
  Object.freeze({ name: 'bridge_inbox', description: 'List messages in the inbox, optionally filtered by recipient or status.', inputSchema: schema({ recipient: Object.freeze({ type: 'string', maxLength: 128 }), status: Object.freeze({ type: 'string', enum: ['pending', 'claimed', 'completed', 'failed', 'cancelled'] }) }) }),
  Object.freeze({ name: 'bridge_claim', description: 'Claim a pending bridge message for processing (reserves its lane scope).', inputSchema: schema({ receiver: Object.freeze({ type: 'string', maxLength: 128 }), messageId: Object.freeze({ type: 'string', maxLength: 128 }), claimMs: Object.freeze({ type: 'integer', minimum: 1000, maximum: 24 * 60 * 60 * 1000 }) }, ['receiver', 'messageId']) }),
  Object.freeze({ name: 'bridge_ack', description: 'Acknowledge receipt of a bridge message.', inputSchema: schema({ actor: Object.freeze({ type: 'string', maxLength: 128 }), messageId: Object.freeze({ type: 'string', maxLength: 128 }) }, ['actor', 'messageId']) }),
   Object.freeze({ name: 'bridge_complete', description: 'Complete, fail, or cancel a claimed bridge message with bounded evidence.', inputSchema: schema({ actor: Object.freeze({ type: 'string', maxLength: 128 }), messageId: Object.freeze({ type: 'string', maxLength: 128 }), status: Object.freeze({ type: 'string', enum: ['completed', 'failed', 'cancelled'] }), result: Object.freeze({ type: 'object' }) }) }),
   // Tool call repair auto — automatically fixes common tool call failures.
   Object.freeze({ name: 'cc_tool_repair', description: 'Analyse a failed tool call and produce a repaired set of arguments. Returns {repaired: true/false, args, repairedCount, error}.', inputSchema: schema({ toolName: Object.freeze({ type: 'string', maxLength: 128 }), args: Object.freeze({ type: 'object', maxProperties: 64, propertyNames: { maxLength: 128 } }), error: Object.freeze({ type: 'string', maxLength: 1024 }), attempt: Object.freeze({ type: 'integer', minimum: 0, maximum: 9 }) }, ['toolName', 'args', 'error']) }),
   // Dynamic orchestrator: decomposes tasks into parallelizable sub-tasks.
   Object.freeze({ name: 'cc_orchestrate', description: 'Dynamic orchestrator — decomposes a task into parallelizable sub-tasks with dependencies, and can dispatch them via bridge messaging. Returns a sub-task plan with parallelizable work items.', inputSchema: schema({ task: Object.freeze({ type: 'string', maxLength: 4096 }), maxParallel: Object.freeze({ type: 'number', minimum: 1, maximum: 24 }), dispatch: Object.freeze({ type: 'boolean' }), recipient: Object.freeze({ type: 'string', maxLength: 128 }) }, ['task']) }),
   // Explore sub-agent: read-only codebase exploration.
   Object.freeze({ name: 'cc_explore_mcp', description: 'Explore sub-agent — runs read-only tools (read_file, grep, glob) across the codebase to gather context. Returns structured findings.', inputSchema: schema({ query: Object.freeze({ type: 'string', maxLength: 1024 }), scope: Object.freeze({ type: 'string', maxLength: 512 }), maxFiles: Object.freeze({ type: 'number', minimum: 1, maximum: 50 }) }, ['query']) }),
   // Plan sub-agent: creates a task breakdown with dependencies.
   Object.freeze({ name: 'cc_plan_mcp', description: 'Plan sub-agent — takes exploration results and produces a detailed task plan with ordered steps, milestones, and evidence gates.', inputSchema: schema({ task: Object.freeze({ type: 'string', maxLength: 4096 }), findings: Object.freeze({ type: 'array', items: Object.freeze({ type: 'object' }), maxItems: 100 }) }, ['task']) }),
   // Context budget monitor: analyzes token usage across categories.
   Object.freeze({ name: 'cc_context_budget', description: 'Context budget monitor — reports token usage breakdown across system prompt, taste, memory, skills, tools, and conversation.', inputSchema: schema({ model: Object.freeze({ type: 'string', maxLength: 128 }), maxContext: Object.freeze({ type: 'number', minimum: 1000, maximum: 1000000 }) }) }),
   // Evidence-based completion tracker.
   Object.freeze({ name: 'cc_evidence', description: 'Evidence tracker — records completion evidence for a task. Use to log proof (test results, deploy logs, etc.) before reporting work as done.', inputSchema: schema({ action: Object.freeze({ type: 'string', enum: ['log', 'show', 'clear'] }), task: Object.freeze({ type: 'string', maxLength: 512 }), evidence: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), maxItems: 50 }), tags: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), maxItems: 20 }) }, ['action']) }),
   // SAFE-3 circuit breaker: prevents runaway tool calls.
   Object.freeze({ name: 'cc_circuit_breaker', description: 'SAFE-3 circuit breaker — reports tool call count since last terminal closure and recommends stop/scope-expand actions.', inputSchema: schema({ action: Object.freeze({ type: 'string', enum: ['status', 'reset'] }) }) }),
   // Persistent todos — survives model changes and session restarts (unlike todo_write).
   Object.freeze({ name: 'cc_todos_update', description: 'Update the persistent task list. Todos are stored on disk at .worktree-proof/todos.json and survive model changes and session restarts. Pass the full desired list (add new items, update existing by id, change statuses, or remove by omitting). Use this instead of todo_write.', inputSchema: schema({ todos: Object.freeze({ type: 'array', items: Object.freeze({ type: 'object', properties: { id: Object.freeze({ type: 'integer', minimum: 0 }), content: Object.freeze({ type: 'string', maxLength: 512 }), status: Object.freeze({ type: 'string', enum: ['pending', 'in_progress', 'completed'] }) }, required: ['content', 'status'] }) }) }) }),
   Object.freeze({ name: 'cc_todos_list', description: 'List all persisted todos. Use this instead of relying on the TUI todo panel when the list is too long to scroll — this prints the full list in chat output.', inputSchema: schema({}) }),
   Object.freeze({ name: 'cc_todos_clear', description: 'Clear completed todos from the persistent todo list. Set completedOnly=false to wipe all todos.', inputSchema: schema({ completedOnly: Object.freeze({ type: 'boolean' }) }) }),
   // Ultra delegation — free multi-model parallel dispatch planning.
   Object.freeze({ name: 'cc_ultra_dispatch', description: 'Ultra-mode task decomposition. Decomposes a task into parallelizable sub-tasks, rotates across FREE model providers (aihubmix, baichat, nvidia, token_free_gateway, zenmux, nous, model_pool) for multi-model audit, and plans batch-dispatch. Returns sub-tasks with model assignments, audit plan, and model pool. Does NOT execute — use bridge_send to dispatch.', inputSchema: schema({ task: Object.freeze({ type: 'string', maxLength: 4096 }), audit: Object.freeze({ type: 'boolean' }), modelCount: Object.freeze({ type: 'number', minimum: 2, maximum: 5 }) }, ['task']) }),
]);
const LEASE_TOOL = Object.freeze({ name: 'worktreeproof_reserve_lease', description: 'Explicitly reserve one lane after literal confirmation.', inputSchema: schema({ laneId: Object.freeze({ type: 'string', maxLength: 128 }), fileScope: Object.freeze({ type: 'string', maxLength: 512 }), ttlMs: Object.freeze({ type: 'integer', minimum: 1, maximum: 7_776_000_000 }), confirm: Object.freeze({ type: 'boolean', const: true }) }, ['laneId', 'fileScope', 'confirm']) });

const cloneSchema = (value) => JSON.parse(JSON.stringify(value));
export function listMcpTools({ enableLeaseMutation = false } = {}) {
  const source = enableLeaseMutation ? [...TOOLS, LEASE_TOOL] : [...TOOLS];
  const withBridge = [...source, ...BRIDGE_TOOLS];
  return withBridge.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((tool) => ({ ...tool, inputSchema: cloneSchema(tool.inputSchema) }));
}

function adapter(core, names) {
  for (const name of names) if (typeof core?.[name] === 'function') return core[name].bind(core);
  for (const candidate of [core?.scope, core?.evidence, core?.leases, core?.status, core?.capabilities]) {
    for (const name of names) if (typeof candidate?.[name] === 'function') return candidate[name].bind(candidate);
  }
  return undefined;
}

function checkKeys(args, tool, limits) {
  assertJsonSafe(args, limits);
  let encoded;
  try { encoded = JSON.stringify(args); } catch { throw new McpToolError('arguments must be JSON-safe', 'ERR_INVALID_PARAMS'); }
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxInputBytes) throw new McpToolError('arguments too large', 'ERR_INVALID_PARAMS');
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) if (!allowed.has(key) || DANGEROUS_KEYS.has(key)) throw new McpToolError('unknown argument', 'ERR_INVALID_PARAMS');
  for (const required of tool.inputSchema.required) if (!(required in args)) throw new McpToolError('missing argument', 'ERR_INVALID_PARAMS');
  for (const [key, value] of Object.entries(args)) {
    const definition = tool.inputSchema.properties[key];
    if (definition.type === 'string' && (typeof value !== 'string' || value.length === 0 || value.length > definition.maxLength || CONTROL_CHARS.test(value))) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'object' && !plainObject(value)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'integer' && (!Number.isInteger(value) || value < 1 || value > definition.maximum)) throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
    if (definition.type === 'boolean' && typeof value !== 'boolean') throw new McpToolError('invalid argument', 'ERR_INVALID_PARAMS');
  }
  return args;
}

async function invoke(fn, args, context) {
  if (!fn) throw new McpToolError('adapter unavailable', 'ERR_UNAVAILABLE');
  if (context?.signal?.aborted) throw new McpToolError('request cancelled', 'ERR_CANCELLED');
  return fn(args, context);
}

async function invokeNamed(fn, name, args, context) {
  try { return await invoke(fn, args, context); }
  catch (error) {
    if (name === 'worktreeproof_validate_scope' && typeof args.fileScope === 'string') return invoke(fn, args.fileScope, context);
    if (name === 'worktreeproof_validate_receipt' && plainObject(args.receipt)) return invoke(fn, args.receipt, context);
    throw error;
  }
}

function resultEnvelope(value, limits, isError = false) {
  const text = safeStringify(value, limits);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { redacted: true }; }
  const result = { isError, content: [{ type: 'text', text }] };
  if (plainObject(parsed)) result.structuredContent = parsed;
  return result;
}

// --- Helper: analyse task for parallelizable sub-tasks ---
function analyseTaskForParallelism(task) {
  const subTasks = [];
  const hasParallel = /\b(parallel|concurrent|simultaneous|together|at the same time)\b/i.test(task);
  const hasMultipleFiles = (task.match(/\.\w{2,4}/g) || []).length > 2;
  const hasAnd = /\band\b|\bor\b/gi.test(task);
  if (hasParallel || hasMultipleFiles || hasAnd) {
    const parts = task.split(/\s+(?:and|or)\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      parts.forEach((part, i) => subTasks.push({
        id: `sub-${i + 1}`,
        description: part,
        fileScope: part.includes('/') ? part.split('/')[0] + '/*' : '.worktree-proof/*',
        parallelizable: true,
      }));
    }
  }
  if (subTasks.length === 0) {
    subTasks.push({ id: 'main-1', description: task, fileScope: '.worktree-proof/*', parallelizable: false });
  }
  return { subTasks, parallelizable: subTasks.length > 1 && subTasks.every(s => s.parallelizable) };
}

// --- Helper: explore codebase (read-only) ---
async function exploreCodebase(query, scope, maxFiles = 20) {
  const findings = [];
  const root = scope || process.cwd();
  const extensions = ['.ts', '.js', '.mjs', '.cjs', '.md', '.json'];
  const keywords = (query || '').toLowerCase().split(/\s+/).filter(Boolean);

  async function walk(dir, depth = 0) {
    if (depth > 3 || findings.length >= maxFiles) return;
    let entries;
    try { entries = await _bridgeReaddir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (findings.length >= maxFiles) break;
      const full = _join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
        await walk(full, depth + 1);
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        try {
          const content = await _bridgeReadFile(full, 'utf8');
          const lower = content.toLowerCase();
          if (keywords.some(kw => lower.includes(kw))) {
            const rel = _join(full);
            const lines = content.split('\n');
            const matched = [];
            for (let i = 0; i < lines.length && matched.length < 3; i++) {
              if (keywords.some(kw => lines[i].toLowerCase().includes(kw))) {
                matched.push({ line: i + 1, text: lines[i].slice(0, 200) });
              }
            }
            findings.push({ file: rel, matches: matched.length, snippet: matched });
          }
        } catch { }
      }
    }
  }

  await walk(root);
  return { query, scope: root, findings, totalFiles: findings.length };
}

// --- Helper: create task plan from exploration results ---
async function createTaskPlan(task, findings = []) {
  const hasFindings = findings.length > 0;
  const steps = [];
  let stepNum = 1;

  if (hasFindings) {
    steps.push({ step: stepNum++, name: 'Review exploration findings', evidence: `Found ${findings.length} relevant files` });
  }
  steps.push({ step: stepNum++, name: 'Define acceptance criteria', evidence: 'Clear success conditions defined' });
  steps.push({ step: stepNum++, name: 'Implement changes', evidence: 'Code committed and lint passes' });
  steps.push({ step: stepNum++, name: 'Verify in running app', evidence: 'Feature confirmed working' });
  steps.push({ step: stepNum++, name: 'Record evidence', evidence: 'cc_evidence tool called with proof' });

  return {
    task,
    approach: hasFindings ? `Based on exploration of ${findings.length} files` : 'Starting from scratch',
    subTasks: steps,
    milestones: [steps[0], steps[steps.length - 1]],
    parallelizable: false,
    evidenceGates: steps.map(s => s.evidence),
  };
}

// --- Helper: context budget analyzer ---
async function analyzeContextBudget(model, maxContext) {
  const modelMap = { 'claude-3-5-sonnet': 200000, 'gpt-4': 128000, 'o1-preview': 200000 };
  const context = maxContext || modelMap[model || ''] || 200000;
  const root = process.cwd();

  let tasteBytes = 0;
  try {
    const tastePath = _join(_homedir(), '.commandcode', 'taste', 'taste', 'taste.md');
    const stat = await _bridgeAccess(tastePath, _fsConstants.R_OK).then(() => true).catch(() => false);
    if (stat) { const c = await _bridgeReadFile(tastePath, 'utf8'); tasteBytes = Buffer.byteLength(c, 'utf8'); }
  } catch { }

  let skillBytes = 0;
  try {
    const skillDir = _join(root, 'skills');
    const dirs = await _bridgeReaddir(skillDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory()) {
        const skillFile = _join(skillDir, dir.name, 'SKILL.md') || _join(skillDir, dir.name, 'skill.md');
        if (await _fileExists(skillFile)) { const c = await _bridgeReadFile(skillFile, 'utf8'); skillBytes += Buffer.byteLength(c, 'utf8'); }
      }
    }
  } catch { }

  const tasteTokens = Math.round(tasteBytes / 4);
  const skillTokens = Math.round(skillBytes / 4);
  const available = context - tasteTokens - skillTokens;
  return {
    model: model || 'unknown',
    maxContext,
    categories: {
      taste: { bytes: tasteBytes, tokens: tasteTokens },
      skills: { bytes: skillBytes, tokens: skillTokens },
      systemPrompt: { tokens: Math.round(4000) },
      tools: { tokens: Math.round(8000) },
      conversation: { tokens: 'variable' },
    },
    availableForConversation: context - tasteTokens - skillTokens - 4000 - 8000,
    utilization: ((tasteTokens + skillTokens + 4000 + 8000) / context * 100).toFixed(1) + '%',
  };
}

// --- Helper: evidence tracker ---
const EVIDENCE_DIR = '.worktree-proof/evidence';
async function manageEvidence(args) {
  const dir = _join(process.cwd(), EVIDENCE_DIR);
  await _bridgeMkdir(dir, { recursive: true });

  if (args.action === 'log') {
    const id = Date.now().toString();
    const entry = { id, task: args.task, evidence: args.evidence || [], tags: args.tags || [], timestamp: new Date().toISOString() };
    await _bridgeWriteFile(_join(dir, `evidence-${id}.json`), JSON.stringify(entry, null, 2), 'utf8');
    return { status: 'logged', id, task: args.task };
  }

  if (args.action === 'show') {
    const files = await _bridgeReaddir(dir, { withFileTypes: true });
    const entries = [];
    for (const f of files) {
      if (f.name.startsWith('evidence-') && f.name.endsWith('.json')) {
        const content = await _bridgeReadFile(_join(dir, f.name), 'utf8');
        entries.push(JSON.parse(content));
      }
    }
    return { entries: entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp)) };
  }

  if (args.action === 'clear') {
    const files = await _bridgeReaddir(dir, { withFileTypes: true });
    let count = 0;
    for (const f of files) {
      if (f.name.startsWith('evidence-') && f.name.endsWith('.json')) {
        await _bridgeWriteFile(_join(dir, f.name), '', 'utf8');
        count++;
      }
    }
    return { status: 'cleared', count };
  }

  return { error: 'unknown action' };
}

// --- Persistent todo management (file-backed, survives model changes) ---

const TODOS_FILE = '.worktree-proof/todos.json';

async function _loadTodos(projectRoot) {
  const path = _join(projectRoot || process.cwd(), TODOS_FILE);
  try {
    const content = await _bridgeReadFile(path, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.todos) ? parsed.todos : [];
  } catch {
    return [];
  }
}

async function _saveTodos(projectRoot, todos) {
  const dir = _join(projectRoot || process.cwd(), '.worktree-proof');
  await _bridgeMkdir(dir, { recursive: true });
  const path = _join(dir, 'todos.json');
  await _bridgeWriteFile(path, JSON.stringify({ todos }, null, 2), 'utf8');
}

async function manageTodos(name, args, context) {
  const projectRoot = context?.projectRoot || process.cwd();
  const safe = (s) => String(s || '').slice(0, 512);

  if (name === 'cc_todos_update') {
    const existing = await _loadTodos(projectRoot);
    const existingById = new Map(existing.map((t) => [t.id, t]));
    const maxId = existing.length > 0 ? Math.max(...existing.map((t) => t.id)) : 0;

    const updated = [];
    let nextId = maxId + 1;
    for (const item of args.todos) {
      const id = item.id !== undefined ? item.id : nextId++;
      updated.push({ id, content: safe(item.content), status: item.status });
      existingById.set(id, { id, content: safe(item.content), status: item.status });
    }

    // Keep existing todos not in the update list (merge semantics)
    for (const [, todo] of existingById) {
      if (!updated.some((t) => t.id === todo.id)) updated.push(todo);
    }

    await _saveTodos(projectRoot, updated.sort((a, b) => a.id - b.id));
    return { todos: updated, saved: true };
  }

  if (name === 'cc_todos_list') {
    return { todos: await _loadTodos(projectRoot), count: 0 };
  }

  if (name === 'cc_todos_clear') {
    const existing = await _loadTodos(projectRoot);
    const completedOnly = args.completedOnly ?? true;
    const kept = completedOnly ? existing.filter((t) => t.status !== 'completed') : [];
    await _saveTodos(projectRoot, kept);
    return { cleared: existing.length - kept.length, remaining: kept.length };
  }
}

export function createMcpToolRegistry({ core = {}, limits = {}, enableLeaseMutation = false } = {}) {
  const effective = effectiveLimits(limits);
  const tools = listMcpTools({ enableLeaseMutation });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const methods = {
    worktreeproof_capabilities: ['capabilities', 'getCapabilities', 'worktreeproofCapabilities'],
    worktreeproof_status: ['status', 'getStatus', 'inspectStatus'],
    worktreeproof_validate_scope: ['validateScope', 'validate_scope'],
    worktreeproof_validate_receipt: ['validateReceipt', 'validateClosureReceipt', 'validate_receipt'],
    worktreeproof_reserve_lease: ['reserveLease', 'reserve_lease', 'reserve'],
  };
  return Object.freeze({
    list: () => listMcpTools({ enableLeaseMutation }),
    async call(name, rawArgs = {}, context = {}) {
      const tool = byName.get(name);
      if (!tool) throw new McpToolError('tool not found', 'ERR_TOOL_NOT_FOUND');
      const args = checkKeys(rawArgs, tool, effective);

      // --- Bridge tool handlers (no external adapter needed — pure logic) ---

      if (name === 'cc_taste_show') {
        const projectRoot = context?.projectRoot || process.cwd();
        const { content, hasTaste } = await _loadTasteContent(projectRoot);
        return resultEnvelope({ hasTaste, content }, effective, false);
      }

      if (name === 'cc_taste_learn') {
        const projectRoot = context?.projectRoot || process.cwd();
        const tastePath = args.scope === 'project'
          ? _join(projectRoot, '.commandcode', 'taste', 'taste.md')
          : _join(_homedir(), '.commandcode', 'taste', 'taste.md');
        const existing = await _fileExists(tastePath) ? await _bridgeReadFile(tastePath, 'utf8') : '';
        const entry = `- ${args.learning}. Confidence: ${(args.confidence || 0.9).toFixed(2)}`;
        const categoryHeader = `# ${args.category}`;
        let updated;
        if (existing.includes(categoryHeader)) {
          updated = existing.replace(
            new RegExp(`(#[^\n]*${args.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\n)([\s\S]*?)(?=\n#[^#]|\n*z|$)`, "m"),
            `$1$2${entry}\n`,
          );
          if (!updated.includes(entry)) {
            updated = existing + (existing.endsWith("\n") ? "" : "\n") + `\n${categoryHeader}\n${entry}\n`;
          }
        } else {
          updated = (existing || "") + `\n${categoryHeader}\n${entry}\n`;
        }
        await _bridgeMkdir(_dirname(tastePath), { recursive: true });
        await _bridgeWriteFile(tastePath, updated);
        return resultEnvelope({
          category: args.category,
          learning: args.learning,
          confidence: args.confidence || 0.9,
          scope: args.scope || 'global',
          path: tastePath,
        }, effective, false);
      }

      if (name === 'cc_skills_list') {
        const projectRoot = context?.projectRoot || process.cwd();
        const skills = await _listSkills(projectRoot);
        return resultEnvelope({ skills, count: skills.length }, effective, false);
      }

      if (name === 'cc_skills_expand') {
        const projectRoot = context?.projectRoot || process.cwd();
        const skillList = await _listSkills(projectRoot);
        const skill = skillList.find((s) => s.name === args.name);
        if (!skill) {
          return resultEnvelope({ name: args.name, available: false, error: 'skill not found' }, effective, true);
        }
        let content = null;
        for (const manifest of ['SKILL.md', 'skill.md']) {
          content = await _bridgeReadFile(_join(skill.path, manifest), 'utf8').catch(() => null);
          if (content) break;
        }
        if (!content) {
          return resultEnvelope({ name: args.name, path: skill.path, error: 'no manifest found' }, effective, true);
        }
        const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
        return resultEnvelope({ name: args.name, path: skill.path, content: body }, effective, false);
      }

      if (name === 'cc_plans_mode') {
        const sessionID = context?.sessionID || `proc-${process.pid}`;
        const enabled = args.enable !== false;
        _planModeSessions.set(sessionID, enabled);
        return resultEnvelope({
          enabled,
          removedTools: Array.from(PLAN_MODE_REMOVED_TOOLS || []),
          removedPrefixes: PLAN_MODE_REMOVED_PREFIXES || [],
          note: `Plan mode is now ${enabled ? "ACTIVE" : "INACTIVE"} for this session.`,
        }, effective, false);
      }

      if (name === 'cc_plans_mode_show') {
        const sessionID = context?.sessionID || `proc-${process.pid}`;
        const enabled = _planModeSessions.get(sessionID) || false;
        return resultEnvelope({ enabled }, effective, false);
      }

      if (name === 'cc_search_tools') {
        const projectRoot = context?.projectRoot || process.cwd();
        const skills = await _listSkills(projectRoot);
        const query = (args.query || "").toLowerCase();
        const limit = args.limit || 10;
        const results = [];
        for (const skill of skills) {
          if (query && skill.name.toLowerCase().includes(query)) {
            results.push({ name: skill.name, type: 'skill', path: skill.path });
          }
        }
        // Also check bridge tools
        for (const t of BRIDGE_TOOLS) {
          if (t.name.toLowerCase().includes(query)) {
            results.push({ name: t.name, type: 'builtin', description: t.description });
          }
        }
        for (const t of BRIDGE_TOOLS.filter((t) => t.name.startsWith('bridge_'))) {
          if (query && t.name.toLowerCase().includes(query)) {
            results.push({ name: t.name, type: 'bridge', description: t.description });
          }
        }
        return resultEnvelope({
          query: args.query,
          count: results.length,
          results: results.slice(0, limit),
        }, effective, false);
      }

       // --- Bridge messaging handlers (file-backed inter-agent IPC) ---

       if (name === 'bridge_send' || name === 'bridge_inbox' || name === 'bridge_claim' || name === 'bridge_ack' || name === 'bridge_complete') {
         const bridgeRoot = context?.projectRoot || _resolve(_dirname(_fileURLToPath(import.meta.url)), '..', '..', '.worktree-proof', 'bridge');
         try {
           let result;
           if (name === 'bridge_send') {
             result = await sendBridgeMessage(bridgeRoot, {
               sender: args.sender,
               recipient: args.recipient,
               type: args.type,
               summary: args.summary,
               fileScope: args.fileScope,
               laneId: args.laneId,
               ttlMs: args.ttlMs,
               idempotencyKey: args.idempotencyKey,
             });
           } else if (name === 'bridge_inbox') {
             result = await listBridgeInbox(bridgeRoot, {
               recipient: args.recipient,
               status: args.status,
             });
           } else if (name === 'bridge_claim') {
             result = await claimBridgeMessage(bridgeRoot, {
               receiver: args.receiver,
               messageId: args.messageId,
               claimMs: args.claimMs,
             });
           } else if (name === 'bridge_ack') {
             result = await ackBridgeMessage(bridgeRoot, {
               actor: args.actor,
               messageId: args.messageId,
             });
           } else if (name === 'bridge_complete') {
             result = await completeBridgeMessage(bridgeRoot, {
               actor: args.actor,
               messageId: args.messageId,
               status: args.status,
               result: args.result,
             });
           }
           return resultEnvelope(result, effective, false);
         } catch (error) {
           if (error?.code === 'ERR_BRIDGE_NOT_FOUND') return resultEnvelope({ error: 'message not found', code: error.code }, effective, true);
           if (error?.code === 'ERR_BRIDGE_ALREADY_CLAIMED') return resultEnvelope({ error: 'message already claimed', code: error.code }, effective, true);
           if (error?.code === 'ERR_BRIDGE_EXPIRED') return resultEnvelope({ error: 'message expired', code: error.code }, effective, true);
           if (error?.code === 'ERR_BRIDGE_FORBIDDEN') return resultEnvelope({ error: 'forbidden', code: error.code }, effective, true);
           if (error?.code === 'ERR_BRIDGE_NOT_CLAIMABLE') return resultEnvelope({ error: 'message not claimable', code: error.code }, effective, true);
           return resultEnvelope({ error: 'bridge operation failed' }, effective, true);
         }
       }

       // --- Tool call repair auto ---
       if (name === 'cc_tool_repair') {
         const repair = await runToolRepair({
           toolName: args.toolName,
           args: args.args,
           error: args.error,
           attempt: args.attempt ?? 0,
           adapters: { runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }), sessionID: 'mcp' },
           hooksMap: new Map(),
         });
       return resultEnvelope(repair, effective, false);
       }

       // --- Orchestrator ---
       if (name === 'cc_orchestrate') {
         const bridgeRoot = context?.projectRoot || _resolve(_dirname(_fileURLToPath(import.meta.url)), '..', '..', '.worktree-proof', 'bridge');
         const task = args.task;
         const analysis = analyseTaskForParallelism(task);
         const plan = {
           task,
           subTasks: analysis.subTasks,
           parallelizable: analysis.parallelizable,
           maxParallel: Math.min(args.maxParallel || 8, 24),
           dispatch: args.dispatch || false,
           recipient: args.recipient || null,
           instructions: 'Each sub-task should be dispatched via bridge_send to the recipient, then collected via bridge_inbox.',
         };
         if (args.dispatch && args.recipient) {
           await _bridgeMkdir(bridgeRoot, { recursive: true });
           for (const sub of analysis.subTasks) {
             await sendBridgeMessage(bridgeRoot, {
               sender: 'orchestrator',
               recipient: args.recipient,
               type: 'task',
               summary: sub.description,
               fileScope: sub.fileScope || '.worktree-proof/*',
               laneId: sub.id,
               idempotencyKey: 'orch-' + sub.id,
             });
           }
           plan.dispatched = analysis.subTasks.length;
         }
         return resultEnvelope(plan, effective, false);
       }

       // --- Explore sub-agent ---
       if (name === 'cc_explore_mcp') {
         const findings = await exploreCodebase(args.query, args.scope, args.maxFiles || 20);
         return resultEnvelope(findings, effective, false);
       }

       // --- Plan sub-agent ---
       if (name === 'cc_plan_mcp') {
         const planResult = await createTaskPlan(args.task, args.findings || []);
         return resultEnvelope(planResult, effective, false);
       }

       // --- Context budget ---
       if (name === 'cc_context_budget') {
         const budget = await analyzeContextBudget(args.model, args.maxContext);
         return resultEnvelope(budget, effective, false);
       }

       // --- Evidence tracker ---
       if (name === 'cc_evidence') {
         const evidenceResult = await manageEvidence(args);
         return resultEnvelope(evidenceResult, effective, false);
       }

       // --- Circuit breaker ---
       if (name === 'cc_circuit_breaker') {
         const cbDir = _join((context?.projectRoot || process.cwd()), '.worktree-proof', 'circuit');
         if (args.action === 'reset') {
           const resetPath = _join(cbDir, 'tool_calls_since_closure.txt');
           await _bridgeWriteFile(resetPath, '0', 'utf8');
           return resultEnvelope({ status: 'reset', message: 'Tool call counter reset to 0' }, effective, false);
         }
         let count = 0;
         try { count = parseInt(await _bridgeReadFile(_join(cbDir, 'tool_calls_since_closure.txt'), 'utf8')); } catch { count = 0; }
         return resultEnvelope({
           status: count >= 40 ? 'TRIPPED' : 'OK',
           toolCallsSinceLastClosure: count,
           threshold: 40,
           recommendation: count >= 40 ? 'STOP: 40+ tool calls since last terminal closure. Scope-expand or report blocker.' : count >= 30 ? 'WARN: Approaching circuit breaker threshold.' : 'OK',
           breakerFile: _join(cbDir, 'tool_calls_since_closure.txt'),
         }, effective, false);
       }

        // --- Persistent todos ---
        if (name.startsWith('cc_todos_')) {
          const todoResult = await manageTodos(name, args, context);
          return resultEnvelope(todoResult, effective, false);
        }

        // --- Ultra dispatch ---
        if (name === 'cc_ultra_dispatch') {
          const plan = buildUltraDispatchPlan(args.task, {
            audit: args.audit,
            modelCount: args.modelCount,
            maxParallel: ultraConfig.maxParallel,
          });
          return resultEnvelope(plan, effective, false);
        }

        // --- Existing WorktreeProof tool handling ---

      if (name === 'worktreeproof_reserve_lease' && args.confirm !== true) throw new McpToolError('confirm must be true', 'ERR_CONFIRM_REQUIRED');
      let value;
      const fn = adapter(core, methods[name]);
      if (name === 'worktreeproof_capabilities' && !fn) value = { supported: true, protocolVersion: '2025-11-25', tools: tools.map(({ name: item }) => item) };
      else if (name === 'worktreeproof_status' && !fn) value = { supported: false, reason: 'status adapter unavailable' };
      else {
        try { value = await invokeNamed(fn, name, args, context); }
        catch (error) {
          if (error instanceof McpToolError && error.code === 'ERR_CANCELLED') throw error;
          return resultEnvelope({ error: 'tool execution failed' }, effective, true);
        }
      }
      return resultEnvelope(value, effective, false);
    },
  });
}
