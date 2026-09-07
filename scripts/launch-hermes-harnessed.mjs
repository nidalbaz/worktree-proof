/**
 * launch-hermes-harnessed.mjs — Launcher wrapper for Hermes Electron app.
 *
 * Ensures the Command Code bridge harness (taste, skills, plan mode, bridge
 * messaging) is present in the Hermes config BEFORE launching the app.
 * Hermes updates normally; the harness survives because it's re-applied on
 * every launch from the backup/restore script.
 *
 * Usage:
 *   node scripts/launch-hermes-harnessed.mjs        # Launch Hermes with harness
 *   node scripts/launch-hermes-harnessed.mjs --check  # Just check/restore, don't launch
 *
 * Create a shortcut to:  node "C:\VectorHQ\worktree-proof-workflow\scripts\launch-hermes-harnessed.mjs"
 */

import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HERMEES_EXE = join(homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'bin', 'hermes.exe');
const REPO_ROOT = join(new URL('.', import.meta.url).pathname, '..');
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts', 'restore-hermes-harness.mjs');

const checkOnly = process.argv.includes('--check');

// Step 1: Run the restoration script (idempotent — safe to run every time)
console.log('[harness] Restoring CC bridge harness...');
const result = spawnSync(process.execPath, [RESTORE_SCRIPT], {
  stdio: 'inherit',
});
if (result.status !== 0) {
  console.error('[harness] Warning: harness restoration reported status', result.status);
}

// Step 2: Launch Hermes
if (checkOnly) {
  console.log('[harness] --check mode: harness verified, not launching Hermes');
  process.exit(0);
}

console.log('[harness] Launching Hermes...');
const child = spawn(HERMES_EXE, [], {
  stdio: 'inherit',
  cwd: REPO_ROOT,
});

child.on('error', (error) => {
  console.error('[harness] Failed to launch Hermes:', error.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
