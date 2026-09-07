/**
 * Mod system — loadable plugin modules that can modify any part of the agent loop.
 *
 * A "mod" (short for "modification") is a host-neutral plugin that can:
 *   - Add tools (cmd.addTool)
 *   - Add slash commands (cmd.addCommand)
 *   - Register hooks (onTurnStart, onTurnEnd, beforeToolCall, etc.)
 *   - Add model providers
 *   - Add system prompt segments
 *   - Add tool categories and tool filters
 *   - Intercept and transform user input
 *   - Intercept and transform tool arguments/results
 *
 * This mirrors Command Code's mod system but is portable across hosts.
 * Host adapters implement the integration points.
 *
 * A mod is a function: (ctx: ModContext) => ModRegistration | Promise<ModRegistration>
 *
 * ModContext provides:
 *   - cmd: { addTool, addCommand, addHook, addProvider, addSystemPrompt, setMode }
 *   - adapters: host adapter for file I/O, command execution, etc.
 *   - config: host-specific config
 *   - modDir: directory where this mod file lives
 */

/**
 * @typedef {object} ModTool
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {object} args - Zod-like schema (host adapter converts)
 * @property {function} execute - Tool handler
 * @property {boolean} [shouldDefer] - If true, only a hint is shown to the model
 * @property {string[]} [categories] - Tool categories for deferred search
 * @property {string[]} [searchTerms] - Search terms for deferred discovery
 */

/**
 * @typedef {object} ModCommand
 * @property {string} name - Command name (without leading /)
 * @property {string} description - Command description
 * @property {function} handler - Command handler
 */

/**
 * @typedef {object} ModHook
 * @property {string} event - Event name (PreToolUse, PostToolUse, Stop, SessionStart, TurnStart, TurnEnd, TransformContext, AppendSystemPrompt)
 * @property {string} [matcher] - Tool name or pattern to match
 * @property {function} handler - Hook handler
 */

/**
 * @typedef {object} ModProvider
 * @property {string} name - Provider name
 * @property {string} baseUrl - API base URL
 * @property {string} envKey - Environment variable for API key
 * @property {object} models - { [modelId]: { name, contextLength, maxTokens } }
 */

/**
 * ModContext — passed to each mod's setup function.
 */
export class ModContext {
  constructor(adapters, config, modDir) {
    this.adapters = adapters;
    this.config = config;
    this.modDir = modDir;

    this.tools = [];
    this.commands = [];
    this.hooks = [];
    this.providers = [];
    this.systemPromptSegments = [];
    this.modes = {};
    this.toolFilters = [];

    this.cmd = {
      addTool: (tool) => this.tools.push(tool),
      addCommand: (command) => this.commands.push(command),
      addHook: (hook) => this.hooks.push(hook),
      addProvider: (provider) => this.providers.push(provider),
      addSystemPrompt: (segment, where = 'append') => {
        this.systemPromptSegments.push({ segment, where });
      },
      setMode: (mode, config) => {
        this.modes[mode] = config;
      },
      addToolFilter: (filter) => this.toolFilters.push(filter),
    };
  }

  /**
   * Load a mod from a file path.
   * The mod file should export a default function or an object.
   */
  async loadMod(modPath) {
    try {
      const mod = await this.adapters.import(modPath);
      if (typeof mod === 'function') {
        const result = await mod(this.cmd);
        if (result && typeof result === 'object') {
          return result;
        }
      } else if (mod && typeof mod === 'object') {
        if (mod.setup) {
          const result = await mod.setup({ cmd: this.cmd, adapters: this.adapters, config: this.config });
          return result;
        }
      }
    } catch (error) {
      // Silently skip mods that fail to load
      if (this.adapters.onError) {
        this.adapters.onError(modPath, error);
      }
    }
    return null;
  }

  /**
   * Apply all registered tools, commands, hooks, etc. to the host session.
   * This is where the host adapter integrates the mod's contributions.
   */
  apply(hostSession) {
    for (const tool of this.tools) {
      hostSession.addTool(tool);
    }

    for (const command of this.commands) {
      hostSession.addCommand(command);
    }

    for (const hook of this.hooks) {
      hostSession.addHook(hook);
    }

    for (const provider of this.providers) {
      hostSession.addProvider(provider);
    }

    for (const segment of this.systemPromptSegments) {
      if (segment.where === 'prepend') {
        hostSession.prependSystemPrompt(segment.segment);
      } else {
        hostSession.appendSystemPrompt(segment.segment);
      }
    }

    for (const [mode, modeConfig] of Object.entries(this.modes)) {
      hostSession.setMode(mode, modeConfig);
    }
  }
}
