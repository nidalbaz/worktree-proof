/**
 * Taste engine — continuously learned coding preferences.
 *
 * This is a portable, host-neutral implementation of Command Code's taste-1
 * system. It reads taste files from configurable paths and renders them as
 * XML blocks for injection into system prompts.
 *
 * Storage layout (mirrors Command Code):
 *   ~/.commandcode/taste/taste.md           — global preferences
 *   <project>/.commandcode/taste/taste.md   — project overrides
 *   <project>/.commandcode/taste/<category>/taste.md — category sub-files
 *
 * The engine does NOT know about OpenCode, Hermes, or WorktreeProof internals.
 * It takes a list of file paths and returns parsed/rendered taste content.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default taste file paths, searched in order.
 * First match wins for each file; the engine merges all found files.
 */
export function defaultTastePaths(projectRoot) {
  const paths = [];
  // Global taste
  paths.push(join(homedir(), '.commandcode', 'taste', 'taste.md'));
  // Project taste
  if (projectRoot) {
    paths.push(join(projectRoot, '.commandcode', 'taste', 'taste.md'));
  }
  return paths;
}

/**
 * Parse a taste.md file into structured entries.
 *
 * Taste file format (YAML frontmatter + markdown body with category sections):
 *
 * # Category Name
 * - Learning 1. Confidence: 0.90
 * - Learning 2. Confidence: 0.85
 *
 * # Category Name 2
 * See [category/taste.md](./category/taste.md)
 *
 * @param {string} content - Raw markdown content of a taste.md file
 * @param {string} sourcePath - Path to the file (for category resolution)
 * @returns {Array<{category: string, source: string, text: string, raw: string}>}
 */
export function parseTaste(content, sourcePath) {
  if (!content || !content.trim()) return [];

  const blocks = content.split(/^---\s*$/m);
  let frontmatter = '';
  let body = content;

  if (blocks.length >= 3) {
    frontmatter = blocks[1].trim();
    body = blocks.slice(2).join('---\n').trim();
  }

  const results = [];
  const categoryPattern = /^#\s+(.+)$/gm;
  let lastCategory = 'General';
  let lastIndex = 0;
  let match;

  while ((match = categoryPattern.exec(body)) !== null) {
    if (match.index > lastIndex) {
      const text = body.slice(lastIndex, match.index).trim();
      if (text) {
        results.push({
          category: lastCategory,
          source: sourcePath,
          text,
          raw: content,
        });
      }
    }
    lastCategory = match[1].trim();
    lastIndex = categoryPattern.lastIndex;
  }

  const remaining = body.slice(lastIndex).trim();
  if (remaining) {
    results.push({
      category: lastCategory,
      source: sourcePath,
      text: remaining,
      raw: content,
    });
  }

  return results;
}

/**
 * Resolve category references that point to sub-files.
 * When a category says "See [category/taste.md](./category/taste.md)",
 * read that file and include it as part of the taste.
 *
 * @param {Array} entries - Parsed taste entries
 * @param {object} adapters - Host adapter with readFile capability
 * @returns {Promise<Array>} entries with sub-file content resolved
 */
export async function resolveTasteRefs(entries, adapters) {
  const resolved = [];
  const seen = new Set();

  for (const entry of entries) {
    const key = `${entry.source}:${entry.category}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const refMatch = entry.text.match(/See\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (refMatch) {
      const refPath = refMatch[2];
      if (refPath.startsWith('./') || refPath.startsWith('../')) {
        const baseDir = entry.source ? join(entry.source, '..') : '.';
        const resolvedPath = join(baseDir, refPath.replace(/^\.\//, ''));
        try {
          const subContent = await adapters.readFile(resolvedPath);
          if (subContent && subContent.trim()) {
            const subEntries = parseTaste(subContent, resolvedPath);
            resolved.push(...await resolveTasteRefs(subEntries, adapters));
          }
        } catch {
          // Sub-file not available — keep the reference text
          resolved.push(entry);
        }
      } else {
        resolved.push(entry);
      }
    } else {
      resolved.push(entry);
    }
  }

  return resolved;
}

/**
 * Load and parse taste from configurable paths.
 *
 * @param {object} adapters - { readFile(path): Promise<string|null>, exists(path): Promise<boolean> }
 * @param {object} options
 * @param {string[]} options.paths - Explicit paths to search (overrides defaults)
 * @param {string} options.projectRoot - Project root for default path resolution
 * @param {boolean} options.resolveRefs - Whether to resolve category sub-file references
 * @returns {Promise<{entries: Array, raw: string, hasTaste: boolean}>}
 */
export async function loadTaste(adapters, options = {}) {
  const paths = options.paths || defaultTastePaths(options.projectRoot);
  const entries = [];
  const rawSections = [];
  let hasTaste = false;

  for (const path of paths) {
    try {
      const exists = await adapters.exists(path);
      if (!exists) continue;
      const content = await adapters.readFile(path);
      if (!content || !content.trim()) continue;

      hasTaste = true;
      rawSections.push(`\n<!-- Taste from ${path} -->\n${content}`);
      const parsed = parseTaste(content, path);
      entries.push(...parsed);
    } catch {
      // File not readable — skip
    }
  }

  if (options.resolveRefs !== false && entries.length > 0) {
    const resolved = await resolveTasteRefs(entries, adapters);
    return { entries: resolved, raw: rawSections.join('\n'), hasTaste };
  }

  return { entries, raw: rawSections.join('\n'), hasTaste };
}

/**
 * Render taste entries as an XML block for system prompt injection.
 *
 * Mirrors Command Code's renderTasteSection2.
 *
 * @param {Array} entries - Output from loadTaste()
 * @param {string} label - Label for the XML block
 * @returns {string} Rendered taste XML block
 */
export function renderTasteXML(entries, label = 'taste') {
  if (!entries || entries.length === 0) return '';

  const byCategory = new Map();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) || [];
    list.push(entry.text);
    byCategory.set(entry.category, list);
  }

  let xml = `<${label}>\n`;
  for (const [category, texts] of byCategory) {
    xml += `  <!-- ${category} -->\n`;
    for (const text of texts) {
      const cleaned = text
        .split('\n')
        .map((line) => line.replace(/^\s+/, ''))
        .join('\n')
        .trim();
      xml += `  ${cleaned.replace(/\n/g, '\n  ')}\n`;
    }
  }
  xml += `</${label}>\n`;

  return xml;
}

/**
 * Learn a new taste entry from user feedback.
 *
 * In Command Code this is triggered by accepts/rejects/edits.
 * Here it appends a learning to the appropriate taste file.
 *
 * @param {object} adapters - { readFile, writeFile, exists }
 * @param {string} category - Taste category (e.g., "JavaScript")
 * @param {string} learning - The learning to record
 * @param {number} confidence - Confidence 0.0–1.0
 * @param {string} globalPath - Path to write to (global or project taste.md)
 */
export async function learnTaste(adapters, category, learning, confidence = 0.9, globalPath) {
  const path = globalPath || join(homedir(), '.commandcode', 'taste', 'taste.md');
  const existing = await adapters.exists(path) ? await adapters.readFile(path) : '';
  const entry = `- ${learning}. Confidence: ${confidence.toFixed(2)}`;
  const hasCategory = existing.includes(`# ${category}`);
  let updated = existing;

  if (!hasCategory) {
    updated = (existing ? existing + '\n\n' : '') + `# ${category}\n${entry}\n`;
  } else {
    updated = existing.replace(
      new RegExp(`(#[\\s-]*${category}[\\s\\S]*?)(?=\n#\\s|\\n\\z)`, 'm'),
      `$1${entry}\n`,
    );
  }

  await adapters.writeFile(path, updated, { append: false });
}
