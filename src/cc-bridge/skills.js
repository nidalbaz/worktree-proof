/**
 * Progressive disclosure skills engine.
 *
 * This is a portable, host-neutral implementation of Command Code's skill
 * expansion system. When a user references `/skill-name` in their input,
 * the engine reads the skill's SKILL.md (or skill.md) file and inlines
 * the content directly into the user's message before it reaches the model.
 *
 * This is NOT tool-based loading — the instructions appear inline in the
 * conversation, so the model has them available immediately rather than
 * needing to call a tool to fetch them.
 *
 * Skills can live in multiple directories:
 *   ~/.commandcode/skills/            — global
 *   <project>/.commandcode/skills/   — project-specific
 *   <project>/skills/                 — worktree-proof-workflow local
 *
 * Skill reference syntax: /skill-name or /skill-name arguments
 * Expansion wraps content in <command-name> XML tags.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default skill search directories.
 * Searched in order — first match wins for each skill name.
 */
export function defaultSkillPaths(projectRoot) {
  const paths = [];
  // Global skills (Command Code + Claude Code convention)
  paths.push(join(homedir(), '.commandcode', 'skills'));
  paths.push(join(homedir(), '.claude', 'skills'));
  // Project skills
  if (projectRoot) {
    paths.push(join(projectRoot, '.commandcode', 'skills'));
    paths.push(join(projectRoot, 'skills'));
  }
  return paths;
}

/**
 * Find a skill directory by name across all configured paths.
 *
 * @param {object} adapters - { exists(path): Promise<boolean>, readdir(path): Promise<string[]> }
 * @param {string} name - Skill name (e.g., "complete-workflow")
 * @param {string[]} searchPaths - Directories to search (defaults to standard locations)
 * @returns {Promise<string|null>} - Full path to skill directory, or null
 */
export async function findSkillDir(adapters, name, searchPaths) {
  for (const base of searchPaths) {
    const candidate = join(base, name);
    if (await adapters.exists(candidate)) {
      // Check for SKILL.md or skill.md
      if (await adapters.exists(join(candidate, 'SKILL.md'))) return candidate;
      if (await adapters.exists(join(candidate, 'skill.md'))) return candidate;
    }
  }
  return null;
}

/**
 * Load a skill's manifest content.
 *
 * @param {object} adapters - { readFile(path): Promise<string|null> }
 * @param {string} skillDir - Path to skill directory
 * @returns {Promise<{content: string, frontmatter: object|null}>}
 */
export async function loadSkillContent(adapters, skillDir) {
  const candidates = ['SKILL.md', 'skill.md'];
  let content = null;
  let manifestPath = null;

  for (const candidate of candidates) {
    const path = join(skillDir, candidate);
    content = await adapters.readFile(path);
    if (content) {
      manifestPath = path;
      break;
    }
  }

  if (!content) return { content: '', frontmatter: null, manifestPath: null };

  return {
    content,
    frontmatter: parseFrontmatter(content),
    manifestPath,
  };
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Format: ---
 * key: value
 * ---
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  const lines = yaml.split('\n');
  for (const line of lines) {
    const kv = line.split(':');
    if (kv.length >= 2) {
      const key = kv[0].trim();
      let value = kv.slice(1).join(':').trim();
      // Handle quoted strings
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

/**
 * Regex for matching /skill-name references in user input.
 * Matches: /skill-name, /skill-name with args, /skill-name(args)
 */
const SKILL_REF_PATTERN = /\/(\w[\w-]*)\b([^{}]*?)(?:\{([^}]*)\})?/g;

/**
 * Extract all skill references from user input.
 *
 * @param {string} input - User input text
 * @returns {Array<{name: string, args: string, inlineArgs: string|null, index: number}>}
 */
export function extractSkillRefs(input) {
  const refs = [];
  let match;

  while ((match = SKILL_REF_PATTERN.exec(input)) !== null) {
    const fullRef = match[0];
    const name = match[1];
    const args = match[2] ? match[2].trim() : '';
    const inlineArgs = match[3] || null;

    // Skip common false positives (URLs, paths)
    if (fullRef.startsWith('http') || fullRef.startsWith('www.') || fullRef.includes('://')) {
      continue;
    }

    refs.push({
      name,
      args,
      inlineArgs,
      index: match.index,
      fullMatch: fullRef,
    });
  }

  return refs;
}

/**
 * Expand skill references in user input by inlining skill content.
 *
 * This mirrors Command Code's expandSkillReferences: when a user writes
 * /skill-name, the skill's SKILL.md body is wrapped in <command-name> tags
 * and inserted in place of the reference.
 *
 * @param {string} input - User input with possible /skill-name references
 * @param {object} options
 * @param {string[]} [options.searchPaths] - Skill search directories
 * @param {object} [options.adapters] - Host adapter for file I/O
 * @param {string} [options.projectRoot] - Project root for default paths
 * @param {string[]} [options.knownSkills] - Explicit list of known skill names (optimization)
 * @param {boolean} [options.dryRun] - If true, return expansion plan without mutating input
 * @returns {Promise<{expanded: string, expansions: Array, missing: Array}>}
 */
export async function expandSkillRefs(input, options = {}) {
  const adapters = options.adapters || { exists: () => Promise.resolve(false), readFile: () => Promise.resolve(null) };
  const searchPaths = options.searchPaths || defaultSkillPaths(options.projectRoot);
  const refs = extractSkillRefs(input);
  const expansions = [];
  const missing = [];

  if (refs.length === 0) {
    return { expanded: input, expansions: [], missing: [] };
  }

  // Build the replacement
  let result = input;
  let offset = 0;

  for (const ref of refs) {
    // Skip if in knownSkills but not actually a skill, or if it's a knownSkill
    if (options.knownSkills && !options.knownSkills.includes(ref.name)) {
      // Still check — knownSkills is an optimization hint, not a filter
    }

    const skillDir = await findSkillDir(adapters, ref.name, searchPaths);
    if (!skillDir) {
      missing.push(ref.name);
      continue;
    }

    const { content, frontmatter } = await loadSkillContent(adapters, skillDir);
    if (!content) {
      missing.push(ref.name);
      continue;
    }

    // Extract body (after frontmatter)
    const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

    // Build the expanded content
    const expanded = `<${ref.name}>\n${body.trim()}\n</${ref.name}>`;
    const fullRef = ref.fullMatch;

    // If there are inline args, include them
    if (ref.inlineArgs) {
      // Already consumed by regex - skip
    }

    result = result.slice(0, ref.index + offset) + expanded + result.slice(ref.index + offset + fullRef.length);
    offset += expanded.length - fullRef.length;

    expansions.push({
      name: ref.name,
      skillDir,
      contentLength: body.length,
      args: ref.args,
      hasInlineArgs: ref.inlineArgs !== null,
    });
  }

  return { expanded: result, expansions, missing };
}

/**
 * List all available skills across search paths.
 *
 * @param {object} adapters - { exists, readdir }
 * @param {string[]} searchPaths - Skill directories to scan
 * @returns {Promise<Array<{name: string, path: string, frontmatter: object|null}>>}
 */
export async function listSkills(adapters, searchPaths) {
  const results = [];
  const seen = new Set();

  for (const base of searchPaths) {
    let dirs;
    try {
      dirs = await adapters.readdir(base);
    } catch {
      continue;
    }

    for (const dir of dirs) {
      const skillName = dir.name;
      if (seen.has(skillName)) continue;
      const skillDir = join(base, dir.name);
      if (!dir.isDirectory) continue;

      // Check for manifest
      const manifestPath = join(skillDir, 'SKILL.md');
      const altManifestPath = join(skillDir, 'skill.md');
      const hasManifest = await adapters.exists(manifestPath) || await adapters.exists(altManifestPath);
      if (!hasManifest) continue;

      seen.add(skillName);
      const { frontmatter } = await loadSkillContent(adapters, skillDir);
      results.push({
        name: skillName,
        path: skillDir,
        frontmatter: frontmatter || {},
      });
    }
  }

  return results;
}
