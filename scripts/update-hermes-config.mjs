import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const configPath = join(homedir(), 'AppData', 'Local', 'hermes', 'config.yaml');
const tastePath = join(homedir(), '.commandcode', 'taste', 'taste.md');

let tasteContent = '';
try {
  await access(tastePath, constants.R_OK);
  tasteContent = (await readFile(tastePath, 'utf8')).trim();
} catch {
  tasteContent = 'No taste file found at ~/.commandcode/taste/taste.md';
}

let content = await readFile(configPath, 'utf8');

// Check if already configured by looking for the specific marker
if (content.includes('CC_BRIDGE_NATIVITY')) {
  console.log('Already configured — skipping');
  process.exit(0);
}

// Update the existing personalities: {} field to include native taste/skills/plan-mode
// This updates the original harness, not a duplicate.
const ccBridgeBlock = `personalities:\n    default:\n      instructions:\n        - "CC_BRIDGE_NATIVITY"\n        - "${tasteContent.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"\n        - "Available skills: /skill-name inlines skills. Use cc_skills_list/cc_skills_expand MCP tools."\n        - "Plan mode: call cc_plans_mode(true) to enter read-only exploration. Editing tools are filtered out."\n        - "Tool search: call cc_search_tools to discover tools on demand."\n        - "Bridge messaging: bridge_send/inbox/claim/ack/complete for inter-agent IPC via worktree-proof MCP server."`;

// Replace the empty personalities: {} with the full personality
content = content.replace(
  /^  personalities: \{\}/m,
  `  ${ccBridgeBlock}`
);

await writeFile(configPath, content, 'utf8');
console.log('Updated Hermes agent harness with native CC bridge integration');
console.log('Added: taste injection, skills instructions, plan mode, deferred tool search, bridge messaging');
