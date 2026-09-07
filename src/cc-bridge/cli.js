/**
 * cc-bridge CLI command handlers — invoked by the WorktreeProof CLI
 * (worktree-proof taste show|learn, worktree-proof skills list|expand).
 *
 * Each handler receives a `payload` object from the CLI:
 *   { repo, config, options, positionals, dryRun, submit, configPath }
 */

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

import { loadTaste, renderTasteXML, learnTaste, parseTaste, resolveTasteRefs } from './taste.js';
import { findSkillDir, loadSkillContent, listSkills, defaultSkillPaths } from './skills.js';

const adapter = {
  readFile: async (path) => {
    try { return await readFile(path, 'utf8'); } catch { return null; }
  },
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    return await writeFile(path, content, 'utf8');
  },
  exists: async (path) => {
    try { await access(path, constants.F_OK); return true; } catch { return false; }
  },
  readdir: async (path) => {
    try { return await readdir(path, { withFileTypes: true }); } catch { return []; }
  },
};

/**
 * taste show — render current taste as XML for system-prompt injection.
 */
export async function tasteShowCommand(payload) {
  const projectRoot = payload.repo;
  const tastePaths = [
    join(homedir(), '.commandcode', 'taste', 'taste.md'),
    join(projectRoot, '.commandcode', 'taste', 'taste.md'),
  ];

  const { entries, hasTaste, raw } = await loadTaste(adapter, { paths: tastePaths, resolveRefs: true });

  if (!hasTaste) {
    return { hasTaste: false, content: '', raw: '', entries: [] };
  }

  const xml = renderTasteXML(entries);
  return { hasTaste, content: xml, raw, entries: entries.map((e) => ({ category: e.category, text: e.text })) };
}

/**
 * taste learn — append a new learning to the taste file.
 */
export async function tasteLearnCommand(payload) {
  const { category, learning, confidence, scope } = payload.options;
  if (!category || !learning) {
    throw new Error("taste learn requires <category> <learning>");
  }
  const conf = confidence !== undefined ? (confidence / 100 > 1 ? confidence / 100 : confidence) : 0.9;
  const targetPath = scope === 'project'
    ? join(payload.repo, '.commandcode', 'taste', 'taste.md')
    : join(homedir(), '.commandcode', 'taste', 'taste.md');

  if (payload.dryRun) {
    return { dryRun: true, targetPath, category, learning, confidence: conf, scope: scope || 'global' };
  }

  await learnTaste(adapter, category, learning, conf, targetPath);
  return { targetPath, category, learning, confidence: conf, scope: scope || 'global', written: true };
}

/**
 * skills list — enumerate available skills.
 */
export async function skillsListCommand(payload) {
  const paths = defaultSkillPaths(payload.repo);
  const all = await listSkills(adapter, paths);
  return { skills: all, count: all.length };
}

/**
 * skills expand — inline a skill's SKILL.md body.
 */
export async function skillsExpandCommand(payload) {
  const name = payload.options.name;
  if (!name) {
    throw new Error("skills expand requires a skill name");
  }
  const paths = defaultSkillPaths(payload.repo);
  const skillDir = await findSkillDir(adapter, name, paths);
  if (!skillDir) {
    return { name, available: false, error: 'skill not found' };
  }
  const content = await loadSkillContent(adapter, skillDir);
  if (!content) {
    return { name, path: skillDir, available: true, content: '', error: 'no manifest found' };
  }
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
  return { name, path: skillDir, available: true, content: body };
}

// Also re-export the core library for programmatic use
export { loadTaste, renderTasteXML, learnTaste, parseTaste, resolveTasteRefs } from './taste.js';
export { expandSkillRefs, findSkillDir, loadSkillContent, listSkills, defaultSkillPaths } from './skills.js';
export {
  buildToolCatalog,
  createSearchToolsTool,
  filterToolsForMode,
  searchDeferredTools,
  renderDeferredToolsPrompt,
  PLAN_MODE_REMOVED_TOOLS,
  PLAN_MODE_REMOVED_PREFIXES,
} from './tools.js';
export {
  FREE_MODELS,
  ultraConfig,
  detectUltraMode,
  selectFreeModel,
  buildUltraDispatchPlan,
  buildAuditPlan,
  buildUltraInstructions,
} from './ultra.js';
export { createHostBridge } from './index.js';
