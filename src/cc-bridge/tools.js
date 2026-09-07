/**
 * Tool catalog and plan-mode filter engine.
 *
 * Implements Command Code's deferred-tools pattern and mode-based tool filtering.
 *
 * Deferred tools: tools with `shouldDefer: true` don't send their full JSON
 * schema to the model. Instead, only a text hint is provided. The model uses
 * a search tool to discover them on demand.
 *
 * Plan mode: a read-only mode where editing/mutating tools are filtered out.
 */

/**
 * Default plan-mode tool restrictions.
 * These are removed from the tool set in plan mode.
 */
export const PLAN_MODE_REMOVED_TOOLS = new Set([
  'edit_file',
  'write_file',
  'todo_write',
  'monitor_command',
  'kill_shell',
  'task_stop',
  'taste',
  'cron_create',
  'cron_delete',
  'run_command',
  'enter_worktree',
  'exit_worktree',
  'shell_command',
]);

/**
 * Tools that are ALWAYS removed in plan mode (MCP + mutating built-ins).
 * This mirrors Command Code's getToolsForMode behavior.
 */
export const PLAN_MODE_REMOVED_PREFIXES = [
  'mcp_',
  'edit_',
  'write_',
  'delete_',
  'create_',
  'update_',
  'remove_',
  'kill_',
  'task_',
  'monitor_',
  'cron_',
  'run_',
  'enter_worktree',
  'exit_worktree',
];

/**
 * Build a tool catalog from a list of tool definitions.
 * Tools can optionally be marked as deferred (lazy loading).
 *
 * @param {object} tools - Map of tool name -> tool definition
 * @returns {object} catalog with full and deferred tool sets
 */
export function buildToolCatalog(tools) {
  const full = {};
  const deferred = {};
  const all = {};

  for (const [name, def] of Object.entries(tools)) {
    const entry = { name, description: def.description || '', ...def };
    all[name] = entry;

    if (def.shouldDefer === true) {
      deferred[name] = {
        name,
        description: def.description || '',
        hint: def.hint || def.description || '',
        searchTerms: def.searchTerms || [],
      };
    } else {
      full[name] = entry;
    }
  }

  return { full, deferred, all };
}

/**
 * Generate the deferred tools hint text for system prompt injection.
 * Mirrors Command Code's buildDeferredToolsPrompt.
 *
 * @param {object} catalog - Output from buildToolCatalog
 * @param {string} label - Label for the section
 * @returns {string} Markdown-formatted deferred tools list
 */
export function renderDeferredToolsPrompt(catalog, label = 'Deferred Tools') {
  if (!catalog || !catalog.deferred || Object.keys(catalog.deferred).length === 0) {
    return '';
  }

  let prompt = `## ${label}\n\nThe following tools are available but their full schemas are not loaded. Use the search_tools function to discover and load them on demand.\n\n`;

  for (const [name, tool] of Object.entries(catalog.deferred)) {
    prompt += `- **${name}**: ${tool.hint}\n`;
    if (tool.searchTerms && tool.searchTerms.length > 0) {
      prompt += `  Search terms: ${tool.searchTerms.join(', ')}\n`;
    }
  }

  return prompt;
}

/**
 * Filter tools for a specific mode.
 * Mirrors Command Code's getToolsForMode.
 *
 * @param {object} tools - Map of tool name -> tool definition
 * @param {string} mode - 'default' | 'auto-accept' | 'bypass' | 'dont-ask' | 'plan'
 * @param {string[]} extraRemoved - Additional tool names to remove
 * @returns {object} Filtered tool map
 */
export function filterToolsForMode(tools, mode = 'default', extraRemoved = []) {
  const removalSet = new Set(extraRemoved);

  if (mode === 'default') {
    // Remove plan-specific tools in default mode
    removalSet.add('enter_plan_mode');
  }

  if (mode === 'plan') {
    // Remove all editing/mutating tools
    for (const tool of PLAN_MODE_REMOVED_TOOLS) removalSet.add(tool);
    const allNames = Object.keys(tools);
    for (const name of allNames) {
      for (const prefix of PLAN_MODE_REMOVED_PREFIXES) {
        if (name.startsWith(prefix) || name === prefix) {
          removalSet.add(name);
          break;
        }
      }
    }
    removalSet.add('exit_plan_mode');
  }

  const filtered = {};
  for (const [name, def] of Object.entries(tools)) {
    if (removalSet.has(name)) continue;
    filtered[name] = def;
  }

  return filtered;
}

/**
 * Search deferred tools by keyword.
 * Mirrors Command Code's search_tools tool.
 *
 * @param {object} catalog - Output from buildToolCatalog
 * @param {string} query - Search term
 * @param {number} limit - Max results
 * @param {string[]} allowedCategories - Optional category filter
 * @returns {Array} Matching deferred tool definitions
 */
export function searchDeferredTools(catalog, query, limit = 10, allowedCategories = null) {
  if (!catalog || !catalog.deferred) return [];

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (const [name, tool] of Object.entries(catalog.deferred)) {
    const searchable = [
      name,
      tool.hint || '',
      ...(tool.searchTerms || []),
      ...(tool.categories || []),
    ].join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score += 1;
    }

    if (score > 0) {
      results.push({
        name,
        description: tool.hint || tool.description,
        score,
        categories: tool.categories || [],
        fullSchema: tool,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Build a search_tools tool definition that can be called by the model
 * to discover deferred tools on demand.
 *
 * @param {object} catalog - Output from buildToolCatalog
 * @returns {object} Tool definition for search_tools
 */
export function createSearchToolsTool(catalog) {
  return {
    name: 'search_tools',
    description: `Search for tools by capability. Use this when you need to find a specific tool or explore available tools. Returns tool names, descriptions, and full signatures for tools that match your query.

Example: If you need to "navigate to a URL" or "click a button on a webpage", search for "browser" or "navigate" or "click". If you need to "take a screenshot of the desktop", search "screenshot" or "desktop".`,
    args: {
      query: {
        type: 'string',
        description: 'Search query — describe what you need the tool to do, e.g. "navigate to URL", "screenshot desktop", "create file"',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 10, max 50)',
      },
      type: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode (default: content)',
      },
    },
    shouldDefer: false,
    execute: async ({ query, limit = 10, type = 'content' }) => {
      const results = searchDeferredTools(catalog, query, Math.min(limit, 50));

      if (type === 'count') {
        return { output: String(results.length) };
      }

      const formatted = results.map((r) => ({
        name: r.name,
        description: r.description,
        fullSchema: r.fullSchema,
      }));

      return {
        output: JSON.stringify(formatted, null, 2),
      };
    },
    fullSchema: {
      name: 'search_tools',
      description: 'Search for tools by capability',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
          type: { type: 'string', enum: ['content', 'files_with_matches', 'count'], default: 'content' },
        },
        required: ['query'],
      },
    },
  };
}
