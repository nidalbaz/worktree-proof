/**
 * @commandcode/harness — A portable command-code bridge for agent frameworks.
 *
 * This module collects the host-neutral pieces of Command Code's architecture
 * into a single importable library. It does NOT depend on OpenCode, Hermes,
 * WorktreeProof, or any specific host — all host interactions go through an
 * adapter object the host provides.
 *
 * Architecture:
 *   cc-bridge/
 *     taste.js   — continuously learned coding preferences (taste-1)
 *     skills.js  — progressive disclosure /skill-name expansion
 *     tools.js   — deferred tools catalog + mode-based tool filtering
 *     hooks.js   — event-based hook pipeline (PreToolUse, PostToolUse, etc.)
 *     mod.js     — loadable plugin system (addTool, addCommand, addHook, etc.)
 *     context.js — token budget tracking and context breakdown
 *     index.js   — facade + createHostBridge() integration helper
 *
 * Usage:
 *   import { createHostBridge, loadTaste, expandSkillRefs, filterToolsForMode } from '@worktreeproof/cc-bridge';
 *
 *   const bridge = createHostBridge({
 *     host: 'opencode',
 *     adapters: {
 *       readFile: (p) => Deno.readTextFile(p),
 *       exists: (p) => exists(p),
 *       runCommand: (cmd, ctx) => Deno.Command(cmd).output(),
 *       sessionID: 'abc123',
 *       projectRoot: '/home/user/projects/foo',
 *     },
 *   });
 *
 *   // Then use bridge.taste, bridge.skills, bridge.tools, etc.
 */

import * as taste from './taste.js';
import * as skills from './skills.js';
import * as tools from './tools.js';
import * as hooks from './hooks.js';
import * as ultra from './ultra.js';
import { ModContext } from './mod.js';
import * as context from './context.js';

export { taste, skills, tools, hooks, ultra, ModContext, context };

// Re-export key functions for convenience
export const {
  loadTaste,
  renderTasteXML,
  learnTaste,
  defaultTastePaths,
} = taste;

export const {
  expandSkillRefs,
  findSkill,
  listSkills,
  defaultSkillPaths,
} = skills;

export const {
  buildToolCatalog,
  createSearchToolsTool,
  filterToolsForMode,
  searchDeferredTools,
  renderDeferredToolsPrompt,
  PLAN_MODE_REMOVED_TOOLS,
  PLAN_MODE_REMOVED_PREFIXES,
} = tools;

export const {
  parseHooks,
  shouldFireHook,
  runPreToolHooks,
  runPostToolHooks,
  runStopHooks,
  runSessionStartHooks,
  runUserPromptHooks,
  HOOK_EVENTS,
} = hooks;

export const {
  analyzeContext,
  checkContextLimits,
} = context;

export const {
  FREE_PROVIDERS,
  FREE_MODELS,
  ultraConfig,
  detectUltraMode,
  selectFreeModel,
  buildUltraDispatchPlan,
  buildAuditPlan,
  buildUltraInstructions,
} = ultra;

/**
 * Create a host bridge that ties together all bridge components
 * with a host-specific adapter set.
 *
 * @param {object} params
 * @param {string} params.host - Host name ('opencode', 'hermes', 'codex', 'claude-code', 'hermes')
 * @param {object} params.adapters - Host adapter object
 * @param {object} [params.config] - Host-specific configuration
 * @returns {object} Bridge with taste, skills, tools, hooks, mods, context
 */
export function createHostBridge({ host, adapters, config = {} }) {
  // Default adapters
  const defaultAdapters = {
    readFile: async (path) => {
      try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    exists: async (path) => {
      try {
        const { access } = await import('node:fs/promises');
        const { constants } = await import('node:fs');
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    readdir: async (path) => {
      try {
        const { readdir } = await import('node:fs/promises');
        return await readdir(path, { withFileTypes: true });
      } catch {
        return [];
      }
    },
    writeFile: async (path, content) => {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });
      return await writeFile(path, content);
    },
    runCommand: async (cmd) => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status || 0,
      };
    },
    sessionID: `bridge-${host}-${Date.now()}`,
    projectRoot: config.projectRoot || (adapters && adapters.projectRoot) || process.cwd(),
    import: async (modPath) => {
      // Host-specific ES module import
      // In Node.js: import() works; in browser: not available
      try {
        const url = `file://${modPath}`;
        const mod = await import(url);
        return mod.default || mod;
      } catch {
        return null;
      }
    },
    ...adapters,
  };

  const projectRoot = defaultAdapters.projectRoot;
  const searchPaths = config.skillPaths || skills.defaultSkillPaths(projectRoot);
  const tastePaths = config.tastePaths || taste.defaultTastePaths(projectRoot);

  // Load all state asynchronously
  const state = {
    taste: { loaded: false, entries: [], raw: '', hasTaste: false },
    skills: { loaded: false, list: [] },
    hooks: { loaded: false, map: new Map() },
    mods: [],
    tools: { loaded: false, catalog: null },
  };

  return {
    host,
    adapters: defaultAdapters,
    config,

    // Lazy-load state
    async refresh() {
      state.taste = await taste.loadTaste(defaultAdapters, { projectRoot, paths: tastePaths });
      state.skills.list = await skills.listSkills(defaultAdapters, searchPaths);
      state.hooks.map = hooks.parseHooks(config.hooks || {});
      state.taste.loaded = true;
      state.skills.loaded = true;
      state.hooks.loaded = true;
      return state;
    },

    // Taste API
    taste: {
      load: () => taste.loadTaste(defaultAdapters, { projectRoot, paths: tastePaths }),
      renderXML: (entries, label) => taste.renderTasteXML(entries, label),
      learn: (category, learning, confidence, globalPath) =>
        taste.learnTaste(defaultAdapters, category, learning, confidence, globalPath),
      getPaths: () => tastePaths,
    },

    // Skills API
    skills: {
      expand: (input, opts) =>
        expandSkillRefs(input, { ...opts, adapters: defaultAdapters, searchPaths }),
      find: (name) => skills.findSkill(defaultAdapters, name, searchPaths),
      list: () => skills.listSkills(defaultAdapters, searchPaths),
      getPaths: () => searchPaths,
    },

    // Tools API
    tools: {
      buildCatalog: (toolList) => tools.buildToolCatalog(toolList),
      createSearchTool: (catalog) => tools.createSearchToolsTool(catalog),
      filterForMode: (toolMap, mode, extra) => tools.filterToolsForMode(toolMap, mode, extra),
      renderDeferred: (catalog, label) => tools.renderDeferredToolsPrompt(catalog, label),
    },

    // Hooks API
    hooks: {
      parse: (config) => hooks.parseHooks(config),
      pre: (toolName, args, hooksMap) =>
        hooks.runPreToolHooks({ toolName, args, hooksMap, adapters: defaultAdapters }),
      post: (toolName, result, duration, hooksMap) =>
        hooks.runPostToolHooks({ toolName, result, duration, hooksMap, adapters: defaultAdapters }),
      stop: (hooksMap) => hooks.runStopHooks(hooksMap, defaultAdapters),
      sessionStart: () => hooks.runSessionStartHooks(new Map(), defaultAdapters),
      userPrompt: (input, hooksMap) => hooks.runUserPromptHooks(input, hooksMap, defaultAdapters),
    },

    // Mods API
    mods: {
      createContext() {
        return new ModContext(defaultAdapters, config, config.modDir || process.cwd());
      },
      async loadMod(modPath) {
        const modCtx = new ModContext(defaultAdapters, config, config.modDir || process.cwd());
        return await modCtx.loadMod(modPath);
      },
    },

    // Context analysis
    analyzeContext: (params) => context.analyzeContext(params),
    checkContextLimits: (analysis, limit, threshold) =>
      context.checkContextLimits(analysis, limit, threshold),

    // Get current state
    get state() {
      return state;
    },

    // Convenience: render full system prompt additions
    async renderSystemAdditions() {
      if (!state.taste.loaded) await this.refresh();

      const additions = [];

      if (state.taste.hasTaste) {
        const xml = taste.renderTasteXML(state.taste.entries);
        if (xml) additions.push(xml);
      }

      if (state.tools.catalog?.deferred) {
        const prompt = tools.renderDeferredToolsPrompt(state.tools.catalog);
        if (prompt) additions.push(prompt);
      }

      return additions.join('\n');
    },
  };
}
