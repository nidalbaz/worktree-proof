/**
 * Adds tool-call repair, dynamic orchestrator, and explore/plan sub-agents
 * instructions to the Hermes config without duplicating or overwriting
 * existing Hermes native features.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const configPath = join(homedir(), 'AppData', 'Local', 'hermes', 'config.yaml');

const NEW_INSTRUCTIONS = [
  'Native tool-call repair auto: When a tool call fails, automatically analyse the error, fix common issues (ENOENT paths, JSON parse errors, permission errors), and retry silently up to 3 times. Use cc_tool_repair MCP tool for explicit repair.',
  'Native dynamic orchestrator: When a task has parallelizable parts, use cc_orchestrate to decompose into sub-tasks and dispatch them via bridge messaging. The orchestrator analyzes the task, identifies parallelizable work, and manages sub-agent dispatch with lane reservation.',
  'Native explore/plan sub-agents: For complex tasks, spin up an explore sub-agent to gather codebase context (read-only), then a plan sub-agent to create a task breakdown, before the main agent starts implementing. Use cc_explore_mcp and cc_plan_mcp for explicit sub-agent invocation.',
];

const MARKER = 'Native tool-call repair auto';

async function main() {
  const content = await readFile(configPath, 'utf8');
  if (content.includes(MARKER)) {
    console.log('Tool repair + orchestrator + sub-agents already in Hermes config');
    return;
  }

  // Find the "Ultra swarm" instruction line and insert after it
  const ultraSwarmPattern = /(- \"- Ultra swarm: degrade to inline mode when free models are unreachable\")/;
  const match = content.match(ultraSwarmPattern);

  if (!match) {
    console.error('Could not find insertion point (Ultra swarm line)');
    process.exit(1);
  }

  const insertionPoint = match.index + match[0].length;
  const newLines = NEW_INSTRUCTIONS.map((instr) => '\n        - "' + instr.replace(/"/g, '\\"') + '"').join('');

  const updated = content.slice(0, insertionPoint) + newLines + content.slice(insertionPoint);
  await writeFile(configPath, updated);
  console.log('Added tool repair + orchestrator + sub-agent instructions to Hermes config');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
