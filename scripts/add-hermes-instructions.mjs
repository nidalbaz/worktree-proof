import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const configPath = join(homedir(), 'AppData', 'Local', 'hermes', 'config.yaml');
const backupDir = join(homedir(), '.commandcode', 'hermes-backups');

let c = await readFile(configPath, 'utf8');
c = c.replace(/\r\n/g, '\n');

// Check if already configured (v3 restore includes all these)
if (c.includes('Native Ultra delegation') && c.includes('Persistent task tracking')) {
  console.log('Already has v3 Ultra + todo instructions');
  process.exit(0);
}
if (c.includes('cc_orchestrate decomposes')) {
  console.log('Already has orchestrator instructions');
  process.exit(0);
}

// Find the Ultra swarm instruction (last CC bridge instruction)
const insertAfter = '- "- Ultra swarm: degrade to inline mode when free models are unreachable"';
const idx = c.indexOf(insertAfter);
if (idx === -1) {
  console.log('Could not find Ultra swarm instruction');
  // Try alternate format
  const altIdx = c.indexOf('Ultra swarm');
  if (altIdx === -1) {
    console.log('Could not find any insert point');
    process.exit(1);
  }
  console.log('Found alternate at:', altIdx);
}

// Find the end of this line
const lineEnd = c.indexOf('\n', idx);
const currentLine = c.slice(idx, lineEnd);

const newInstructions = [
  '        - "Native tool-call repair auto: When a tool call fails, use cc_tool_repair to auto-repair and retry (fixes paths, params, args). Default 3 attempts."',
  '        - "Orchestrator: cc_orchestrate decomposes tasks into parallelizable sub-tasks; auto-dispatch via bridge_send. Respects max 24 concurrent lanes."',
  '        - "Dynamic orchestration: Use bridge_send to dispatch sub-tasks to parallel agents. Each sub-agent checks bridge_inbox, claims via bridge_claim, and reports via bridge_complete."',
  '        - "Context budget: cc_context_budget shows token usage across taste, memory, tools, skills — search to discover, dont try to memorize all tools."',
  '        - "Circuit breaker (SAFE-3): cc_circuit_breaker prevents runaway work — stop spawning after 40 tool calls without terminal closure (merge + evidence)."',
  '        - "Evidence-based delivery: verify task closure with proof (merge + tests + build + live check) before reporting done."',
  '        - "L99 complete-workflow: every task follows goal->plan->reserve->run->evidence->review->close. Never skip steps."',
];

// Insert after the current line
const afterInsert = currentLine + '\n' + newInstructions.join('\n') + '\n';
c = c.replace(currentLine, afterInsert);

// Backup
await mkdir(backupDir, { recursive: true });
await writeFile(join(backupDir, `config.yaml.cc-bridge-v3-${Date.now()}`), await readFile(configPath));

// Write with CRLF (Hermes convention on Windows)
await writeFile(configPath, c.replace(/\n/g, '\r\n'));
console.log('Added tool repair, orchestrator, context budget, circuit breaker, and evidence instructions to Hermes config');
