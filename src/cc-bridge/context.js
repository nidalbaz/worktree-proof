/**
 * Context analyzer — token budget tracking and context breakdown.
 *
 * Mirrors Command Code's analyzeContext which breaks down token usage
 * across categories: system prompt, memory, taste, tools, MCP, skills, subagents.
 */

/**
 * Analyze context composition and estimate token usage.
 * Returns a breakdown similar to Command Code's context analysis.
 *
 * @param {object} params
 * @param {string} params.systemPrompt - Current system prompt content
 * @param {string} params.taste - Taste content (if any)
 * @param {string} params.memory - Memory content (if any)
 * @param {object[]} params.tools - Available tools with schemas
 * @param {object[]} params.mcpTools - MCP-provided tools
 * @param {object[]} params.skills - Loaded skills
 * @param {object[]} params.agents - Loaded sub-agents
 * @returns {object} Context analysis with per-category token estimates
 */
export function analyzeContext(params) {
  const breakdown = {};
  const estimates = {};

  // System prompt (identity + taste)
  const systemText = params.systemPrompt || '';
  const tasteText = params.taste || '';
  breakdown.systemPrompt = {
    name: 'System Prompt (identity)',
    tokens: estimateTokens(systemText),
    chars: systemText.length,
  };
  estimates.systemPrompt = breakdown.systemPrompt.tokens;

  if (tasteText) {
    breakdown.taste = {
      name: 'Taste (taste.md)',
      tokens: estimateTokens(tasteText),
      chars: tasteText.length,
    };
    estimates.taste = breakdown.taste.tokens;
  }

  // Memory
  const memoryText = params.memory || '';
  if (memoryText) {
    breakdown.memory = {
      name: 'Memory',
      tokens: estimateTokens(memoryText),
      chars: memoryText.length,
    };
    estimates.memory = breakdown.memory.tokens;
  }

  // Built-in tools
  if (params.tools && params.tools.length > 0) {
    const totalChars = params.tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    breakdown.systemTools = {
      name: 'System Tools',
      tokens: estimateTokens(JSON.stringify(params.tools)),
      chars: totalChars,
      count: params.tools.length,
    };
    estimates.systemTools = breakdown.systemTools.tokens;
  }

  // MCP tools
  if (params.mcpTools && params.mcpTools.length > 0) {
    const totalChars = params.mcpTools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    breakdown.mcp = {
      name: 'MCP',
      tokens: estimateTokens(JSON.stringify(params.mcpTools)),
      chars: totalChars,
      count: params.mcpTools.length,
    };
    estimates.mcp = breakdown.mcp.tokens;
  }

  // Skills
  if (params.skills && params.skills.length > 0) {
    const totalChars = params.skills.reduce((sum, s) => sum + (s.content?.length || 0), 0);
    breakdown.skills = {
      name: 'Skills (progressive disclosure)',
      tokens: estimateTokens(
        params.skills.map((s) => s.content || '').join('\n')
      ),
      chars: totalChars,
      count: params.skills.length,
    };
    estimates.skills = breakdown.skills.tokens;
  }

  // Sub-agents
  if (params.agents && params.agents.length > 0) {
    const totalChars = params.agents.reduce((sum, a) => sum + JSON.stringify(a).length, 0);
    breakdown.subagents = {
      name: 'Subagents',
      tokens: estimateTokens(JSON.stringify(params.agents)),
      chars: totalChars,
      count: params.agents.length,
    };
    estimates.subagents = breakdown.subagents.tokens;
  }

  const total = Object.values(estimates).reduce((sum, val) => sum + val, 0);

  return {
    breakdown,
    totalTokens: total,
    totalChars: total * 4, // rough estimate
    categories: Object.keys(breakdown),
    largestCategory: Object.entries(estimates).reduce((max, [k, v]) =>
      v > (estimates[max] || 0) ? k : max, ''
    ),
  };
}

/**
 * Estimate token count from text.
 * Uses a 4-character-per-token heuristic (rough approximation).
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.round(text.length / 4);
}

/**
 * Check if context is approaching limits and recommend actions.
 *
 * @param {object} analysis - Output from analyzeContext
 * @param {number} modelContextLimit - Model's context window in tokens
 * @param {number} threshold - Fraction of context at which to warn (default 0.7)
 * @returns {object} { approaching: boolean, recommendations: string[] }
 */
export function checkContextLimits(analysis, modelContextLimit, threshold = 0.7) {
  const recommendations = [];
  const usage = analysis.totalTokens / modelContextLimit;

  if (usage > 0.9) {
    recommendations.push('Critical: context nearly full. Use auto-compaction.');
  } else if (usage > threshold) {
    recommendations.push('Approaching context limit. Consider pruning tool history.');
  }

  // Check for largest categories that could be pruned
  if (analysis.breakdown.mcp && analysis.breakdown.mcp.tokens / modelContextLimit > 0.15) {
    recommendations.push('MCP tools are large. Consider deferring unused MCP tools.');
  }

  if (analysis.breakdown.skills && analysis.breakdown.skills.tokens / modelContextLimit > 0.15) {
    recommendations.push('Skills content is large. Consider unloading inactive skills.');
  }

  if (analysis.breakdown.systemTools && analysis.breakdown.systemTools.tokens / modelContextLimit > 0.15) {
    recommendations.push('Tool schemas are large. Use deferred tools pattern.');
  }

  return {
    approaching: usage > threshold,
    usageFraction: usage,
    recommendations,
  };
}
