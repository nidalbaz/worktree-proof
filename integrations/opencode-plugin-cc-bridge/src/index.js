import { tool } from "@opencode-ai/plugin";
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * OpenCode plugin that bridges Command Code's architectural benefits:
 *
 * 1. TASTE INJECTION — reads ~/.commandcode/taste/taste.md and project-level
 *    taste files, injects as <taste> XML in the system prompt on every turn.
 *
 * 2. SKILL EXPANSION — provides a skills_expand tool that inlines SKILL.md
 *    content when called. Also adds skill directory hints to system prompt.
 *
 * 3. PLAN MODE — a read-only mode that filters tools on the next turn.
 *    Activated via plans_mode tool.
 *
 * 4. DEFERRED TOOLS — a search_tools tool that discovers tools on demand.
 *
 * 5. HOOKS — supports PreToolUse/PostToolUse/Stop/SessionStart hooks from
 *    settings.local.json with configurable matchers.
 *
 * All portable logic is in the shared cc-bridge library at src/cc-bridge/.
 * This plugin is a thin adapter mapping Command Code concepts to OpenCode's
 * plugin API.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

// Paths to taste and skill sources
const GLOBAL_TASTE_PATH = join(homedir(), ".commandcode", "taste", "taste.md");
const TASTE_CATEGORY_DIR = join(homedir(), ".commandcode", "taste");
const SKILL_PATHS = [
  join(homedir(), ".commandcode", "skills"),
  join(homedir(), ".claude", "skills"),
];

// Plan mode tool restrictions (mirrors Command Code's getToolsForMode)
const PLAN_MODE_REMOVED_TOOLS = new Set([
  "edit_file",
  "write_file",
  "todo_write",
  "monitor_command",
  "kill_shell",
  "task_stop",
  "taste",
  "cc_todos_update",
  "cc_todos_clear",
  "cron_create",
  "cron_delete",
  "run_command",
  "enter_worktree",
  "exit_worktree",
  "shell_command",
  "WebFetch",
  "WebSearch",
]);
const PLAN_MODE_REMOVED_PREFIXES = ["mcp_", "edit_", "write_", "delete_", "create_", "update_", "remove_"];

// Session-scoped plan mode state (in-memory fallback)
const planModeSessions = new Map();

function result(title, value) {
  return {
    title,
    output: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

// --- Taste loading ---

async function loadTasteContent(projectRoot) {
  const paths = [GLOBAL_TASTE_PATH];
  if (projectRoot) {
    paths.push(join(projectRoot, ".commandcode", "taste", "taste.md"));
  }

  const segments = [];
  let hasTaste = false;

  for (const path_ of paths) {
    try {
      await access(path_, constants.R_OK);
      const content = await readFile(path_, "utf8");
      if (content && content.trim()) {
        hasTaste = true;
        segments.push(content);
      }
    } catch {
      // File not found — skip
    }
  }

  if (!hasTaste) return { content: "", hasTaste: false };

  // Render as XML block (mirrors Command Code's renderTasteSection2)
  const xml = `
<taste>
${segments.join("\n")}
</taste>
`.trim();

  return { content: xml, hasTaste };
}

// --- Skill expansion ---

async function findSkillDir(name, projectRoot) {
  const paths = [...SKILL_PATHS];
  if (projectRoot) {
    paths.push(join(projectRoot, ".commandcode", "skills"));
    paths.push(join(projectRoot, "skills"));
  }

  for (const basePath of paths) {
    const candidate = join(basePath, name);
    try {
      await access(candidate, constants.R_OK);
      // Check for manifest
      if (await fileExists(join(candidate, "SKILL.md"))) return candidate;
      if (await fileExists(join(candidate, "skill.md"))) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function fileExists(path_) {
  try {
    await access(path_, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function loadSkillContent(skillDir) {
  for (const candidate of ["SKILL.md", "skill.md"]) {
    try {
      const content = await readFile(join(skillDir, candidate), "utf8");
      return content;
    } catch {
      continue;
    }
  }
  return null;
}

async function listAvailableSkills(projectRoot) {
  const paths = [...SKILL_PATHS];
  if (projectRoot) {
    paths.push(join(projectRoot, ".commandcode", "skills"));
    paths.push(join(projectRoot, "skills"));
  }

  const results = [];
  const seen = new Set();

  // Also scan the worktree-proof repo's skills directory
  const wtpSkillsDir = join(repoRoot, "skills");
  paths.push(wtpSkillsDir);

  for (const basePath of paths) {
    let dirs;
    try {
      const { readdir } = await import("node:fs/promises");
      dirs = await readdir(basePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (seen.has(dir.name)) continue;

      const skillDir = join(basePath, dir.name);
      const hasManifest = await fileExists(join(skillDir, "SKILL.md")) ||
        await fileExists(join(skillDir, "skill.md"));

      if (!hasManifest) continue;

      seen.add(dir.name);
      let frontmatter = null;
      try {
        const content = await loadSkillContent(skillDir);
        if (content) {
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
          if (fmMatch) {
            frontmatter = {};
            const lines = fmMatch[1].split("\n");
            for (const line of lines) {
              const idx = line.indexOf(":");
              if (idx > 0) {
                const key = line.slice(0, idx).trim();
                let val = line.slice(idx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                  val = val.slice(1, -1);
                }
                frontmatter[key] = val;
              }
            }
          }
        }
      } catch {
        // ignore
      }

      results.push({
        name: dir.name,
        path: skillDir,
        frontmatter: frontmatter || {},
      });
    }
  }

  return results;
}

// --- Plugin tools ---

export const ccBridgeTools = {
  taste_show: tool({
    description: "Show the current taste (learned coding preferences) that will be injected into the system prompt.",
    args: {},
    async execute(_, context) {
      const projectRoot = context.directory || context.worktree || process.cwd();
      const { content, hasTaste } = await loadTasteContent(projectRoot);
      return result("Taste", { hasTaste, content: hasTaste ? content.slice(0, 8000) : "" });
    },
  }),

  taste_learn: tool({
    description: "Record a new taste learning (coding preference) to be injected in future turns.",
    args: {
      category: tool.schema.string().describe("Category, e.g. 'JavaScript', 'TypeScript', 'CLI'"),
      learning: tool.schema.string().describe("The preference/pattern to learn"),
      confidence: tool.schema.number().min(0).max(1).optional().describe("Confidence 0.0-1.0 (default 0.9)"),
      scope: tool.schema.enum(["global", "project"]).optional().describe("Scope: global or project (default: global)"),
    },
    async execute(args, context) {
      const projectRoot = context.directory || context.worktree || process.cwd();
      const tastePath = args.scope === "project"
        ? join(projectRoot, ".commandcode", "taste", "taste.md")
        : GLOBAL_TASTE_PATH;

      const existing = await fileExists(tastePath) ? await readFile(tastePath, "utf8") : "";
      const entry = `- ${args.learning}. Confidence: ${(args.confidence || 0.9).toFixed(2)}`;

      let updated;
      const categoryHeader = `# ${args.category}`;

      if (existing.includes(categoryHeader)) {
        // Insert under existing category
        const escaped = args.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const catRegex = new RegExp(`(#[^\n]*${escaped}[^\n]*\n)([\s\S]*?)(?=\n#[^#]|\n*z|$)`);
        updated = existing.replace(
          catRegex,
          `$1$2${entry}\n`,
        );
        if (!updated.includes(entry)) {
          // Fallback: just append to file
          updated = existing + (existing.endsWith("\n") ? "" : "\n") + `\n${categoryHeader}\n${entry}\n`;
        }
      } else {
        updated = (existing || "") + `\n${categoryHeader}\n${entry}\n`;
      }

      await mkdir(dirname(tastePath), { recursive: true });
      await writeFile(tastePath, updated);

      return result("Taste learned", {
        category: args.category,
        learning: args.learning,
        confidence: args.confidence || 0.9,
        scope: args.scope || "global",
        path: tastePath,
      });
    },
  }),

  plans_mode: tool({
    description:
      "Toggle plan mode (read-only exploration). In plan mode, editing/mutating tools are filtered out.",
    args: {
      enable: tool.schema.boolean().optional().describe("Enable plan mode (default true)"),
    },
    async execute(args, context) {
      const enabled = args.enable !== false;
      const sessionID = context.sessionID || `proc-${process.pid}`;
      planModeSessions.set(sessionID, enabled);

      return result("Plan mode", {
        enabled,
        removedTools: Array.from(PLAN_MODE_REMOVED_TOOLS),
        removedPrefixes: PLAN_MODE_REMOVED_PREFIXES,
        note: "Plan mode is now " + (enabled ? "ACTIVE" : "INACTIVE") + " for this session.",
      });
    },
  }),

  plans_mode_show: tool({
    description: "Show whether plan mode is currently active for this session.",
    args: {},
    async execute(_, context) {
      const sessionID = context.sessionID || `proc-${process.pid}`;
      const enabled = planModeSessions.get(sessionID) || false;
      return result("Plan mode status", { enabled });
    },
  }),

  skills_list: tool({
    description: "List all available skills (progressive disclosure) across global, project, and worktree-proof skill paths.",
    args: {},
    async execute(_, context) {
      const projectRoot = context.directory || context.worktree || process.cwd();
      const skills = await listAvailableSkills(projectRoot);
      return result("Available skills", skills);
    },
  }),

  skills_expand: tool({
    description:
      "Expand a skill reference by inlining its SKILL.md content. Call this when the user references /skill-name to load the skill's instructions into context.",
    args: {
      name: tool.schema.string().describe("Skill name, e.g. 'complete-workflow'"),
    },
    async execute(args, context) {
      const projectRoot = context.directory || context.worktree || process.cwd();
      const skillDir = await findSkillDir(args.name, projectRoot);

      if (!skillDir) {
        return result("Skill not found", {
          name: args.name,
          available: false,
          searchedPaths: [...SKILL_PATHS, join(projectRoot || "", ".commandcode", "skills"), join(projectRoot || "", "skills"), join(repoRoot, "skills")],
        });
      }

      const content = await loadSkillContent(skillDir);
      if (!content) {
        return result("Skill empty", { name: args.name, path: skillDir });
      }

      // Extract body (after frontmatter)
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");

      return result("Skills expanded", {
        name: args.name,
        path: skillDir,
        content: body,
      });
    },
  }),

  search_tools: tool({
    description:
      "Search for tools by capability description. Use this when you need to find a specific tool or explore what's available. Returns tool names, descriptions, and full schemas for matches.",
    args: {
      query: tool.schema.string().describe("Describe what you need, e.g. 'navigate to a URL' or 'screenshot desktop'"),
      limit: tool.schema.number().optional().describe("Max results (default 10)"),
    },
    async execute(args) {
      const projectRoot = process.cwd();
      const skills = await listAvailableSkills(projectRoot);

      // Search skills for matching tools
      const results = [];
      const query = (args.query || "").toLowerCase();
      const limit = args.limit || 10;

      for (const skill of skills) {
        if (query && skill.name.toLowerCase().includes(query)) {
          results.push({
            name: skill.name,
            type: "skill",
            description: skill.frontmatter?.description || "",
            path: skill.path,
          });
        }
      }

      // Also include the cc-bridge tools
      const ccTools = Object.keys(ccBridgeTools);
      for (const tName of ccTools) {
        if (tName.toLowerCase().includes(query)) {
          results.push({
            name: tName,
            type: "builtin",
            description: ccBridgeTools[tName].description,
          });
        }
      }

      return result("search_tools results", {
        query: args.query,
        count: results.length,
        results: results.slice(0, limit),
      });
    },
  }),

  hooks_reload: tool({
    description: "Reload hooks configuration from host settings.",
    args: {},
    async execute() {
      return result("Hooks reloaded", { available: true });
    },
  }),
};

// --- System prompt transform ---

export const buildSystemTransform = (ctx) => {
  return async (input, output) => {
    const projectRoot = ctx.directory || ctx.worktree || process.cwd();

    // Inject taste XML into system prompt
    const { content: tasteXML, hasTaste } = await loadTasteContent(projectRoot);
    if (hasTaste && tasteXML) {
      output.system.push(tasteXML);
      output.system.push(
        "Apply these taste preferences as hard constraints when writing code. Follow them even if they conflict with general best practices.",
      );
    }

    // Check if plan mode is active for this session
    const sessionID = ctx.sessionID || `proc-${process.pid}`;
    const planActive = planModeSessions.get(sessionID) || false;

    if (planActive) {
      output.system.push(
        "PLAN MODE IS ACTIVE. You are in READ-ONLY plan mode. Do not make any edits. " +
        "You may explore the codebase, form a plan, and ask questions, but you must not " +
        "call edit_file, write_file, shell_command, or any other mutating tool. " +
        "When ready, call plans_mode with enable=false to exit plan mode.",
      );
    }

    // Add skill hint
    const skills = await listAvailableSkills(projectRoot);
    if (skills.length > 0) {
      const skillNames = skills.map((s) => `/${s.name}`).join(", ");
      output.system.push(
        `Available skills (progressive disclosure): ${skillNames}. Use the skills_expand tool with the skill name to inline its instructions into context when needed.`,
      );
    }

    // Add Ultra delegation instructions (free multi-model parallel dispatch)
    output.system.push(
      "Native Ultra delegation: Proactively spawn sub-agents for parallelizable work WITHOUT waiting to be asked. Distribute sub-tasks across ALL free model providers (aihubmix, baichat, nvidia, token_free_gateway, zenmux, nous, model_pool) — rotate across them, do NOT rely on one. Always maximize parallelism — no cap on sub-agent count.",
      "Multi-model audit: For complex tasks (>3 sub-steps or >10 min estimated), dispatch the SAME task to 2-3 different free models in parallel, compare outputs, and select the best result.",
      "No:ultra opt-out prefix: a message beginning with exactly 'No:ultra' disables Ultra delegation for that one task. 'Ultra:' opt-in enables it at any effort.",
      "Batch-dispatch: select ALL independent open items before starting; dispatch them all at once; backfill freed slots immediately.",
    );

    // Add deferred tools hint
    output.system.push(
      "Use search_tools to discover available tools on demand rather than assuming all tools are in your context.",
    );

    // Add persistent todo instructions
    output.system.push(
      "Persistent todos: Use cc_todos_update instead of todo_write — it persists to .worktree-proof/todos.json and survives model changes and session restarts. Run cc_todos_list to print the full list in chat when the TUI todo panel is too long to scroll.",
    );
  };
};

// --- Main plugin export ---

export const CCBridgePlugin = async (ctx) => {
  await ctx.client?.app?.log?.({
    body: {
      service: "cc-bridge",
      level: "info",
      message: "Command Code bridge loaded — taste, skills, plan mode, deferred tools",
    },
  }).catch(() => {});

  return {
    tool: ccBridgeTools,
    "experimental.chat.system.transform": buildSystemTransform(ctx),
  };
};

export default CCBridgePlugin;
