/**
 * CLI commands for the Command Code bridge.
 *
 * Provides `taste` and `skills` subcommands that work alongside the existing
 * WorktreeProof CLI commands. These commands mirror what Command Code's
 * taste tool and skill system do, but are portable across hosts.
 *
 * Commands:
 *   taste show [--json]              — Show current taste content
 *   taste learn <category> <learning> [--confidence 0.9] [--scope global|project] [--json]
 *   skills list [--json]             — List available skills
 *   skills expand <name> [--json]    — Show expanded skill content
 */

import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { listSkills, findSkillDir, loadSkillContent, defaultSkillPaths } from './cc-bridge/skills.js';
import { loadTaste, renderTasteXML, learnTaste, defaultTastePaths, parseTaste } from './cc-bridge/taste.js';

const FS_ADAPTERS = {
  readFile: async (p) => {
    try { return await readFile(p, 'utf8'); } catch { return null; }
  },
  exists: async (p) => {
    try { await access(p, constants.R_OK); return true; } catch { return false; }
  },
  readdir: async (p) => {
    try { return await readdir(p, { withFileTypes: true }); } catch { return []; }
  },
  writeFile: async (p, content) => {
    await mkdir(dirname(p), { recursive: true });
    return await writeFile(p, content);
  },
  sessionID: process.pid,
  projectRoot: process.cwd(),
};

/** @returns {Promise<{ok: boolean, code: number, result: object|null}>} */
export async function tasteShowCommand(payload) {
  const repo = payload.repo;
  const { content, hasTaste } = await loadTaste(FS_ADAPTERS, { projectRoot: repo });
  const xml = hasTaste ? renderTasteXML(content ? parseTaste(content, '') : []) : '';
  return {
    ok: true,
    code: 0,
    result: {
      hasTaste,
      content: hasTaste ? content : '',
      xml,
      paths: defaultTastePaths(repo),
    },
  };
}

/** @returns {Promise<{ok: boolean, code: number, result: object|null}>} */
export async function tasteLearnCommand(payload, input) {
  const { category, learning, confidence, scope } = payload.options;
  if (!category || !learning) {
    throw new Error('taste learn requires category and learning (use --category and --learning)');
  }
  const repo = payload.repo;
  const tastePath = scope === 'project'
    ? join(repo, '.commandcode', 'taste', 'taste.md')
    : join(homedir(), '.commandcode', 'taste', 'taste.md');

  await learnTaste(FS_ADAPTERS, category, learning, confidence || 0.9, tastePath);
  return {
    ok: true,
    code: 0,
    result: {
      category,
      learning,
      confidence: confidence || 0.9,
      scope: scope || 'global',
      path: tastePath,
    },
  };
}

/** @returns {Promise<{ok: boolean, code: number, result: object|null}>} */
export async function skillsListCommand(payload) {
  const repo = payload.repo;
  const searchPaths = defaultSkillPaths(repo);
  const skills = await listSkills(FS_ADAPTERS, searchPaths);
  return {
    ok: true,
    code: 0,
    result: { skills, count: skills.length },
  };
}

/** @returns {Promise<{ok: boolean, code: number, result: object|null}>} */
export async function skillsExpandCommand(payload, input) {
  const { name } = payload.options;
  if (!name) {
    throw new Error('skills expand requires a skill name');
  }
  const repo = payload.repo;
  const searchPaths = defaultSkillPaths(repo);
  const skillDir = await findSkillDir(FS_ADAPTERS, name, searchPaths);
  if (!skillDir) {
    return {
      ok: false,
      code: 1,
      result: { error: 'skill not found', name },
    };
  }
  const { content, frontmatter } = await loadSkillContent(FS_ADAPTERS, skillDir);
  const body = content ? content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '') : '';
  return {
    ok: true,
    code: 0,
    result: { name, path: skillDir, frontmatter, content: body },
  };
}
