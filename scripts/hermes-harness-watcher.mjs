/**
 * hermes-harness-watcher.mjs — Version-aware harness installer for Hermes.
 *
 * Unlike a launch wrapper, this script DETECTS Hermes app updates by tracking
 * the version hash of the Hermes executable. When the version changes (i.e.,
 * Hermes was updated), it automatically re-applies the Command Code bridge
 * harness — taste injection, skills, plan mode, bridge messaging tools.
 *
 * Schedule this to run every 15 minutes (or on Windows startup):
 *   - Windows Task Scheduler: "at startup" + "every 15 min"
 *   - Or cron in the agent (cron_create)
 *
 * How it detects updates:
 *   1. Reads the Hermes executable file hash + last-write time
 *   2. Compares against stored hash in ~/.commandcode/hermes-harness-state.json
 *   3. If different → Hermes was updated → re-apply harness
 *   4. Also re-applies if config.yaml is missing CC_BRIDGE_NATIVITY marker
 */

import { readFile, writeFile, access, stat, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERMES_EXE = join(homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent', 'bin', 'hermes.exe');
const CONFIG_PATH = join(homedir(), 'AppData', 'Local', 'hermes', 'config.yaml');
const STATE_PATH = join(homedir(), '.commandcode', 'hermes-harness-state.json');
const BACKUP_DIR = join(homedir(), '.commandcode', 'hermes-backups');
const REPO_ROOT = process.cwd();
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts', 'restore-hermes-harness.mjs');

/** Compute a version fingerprint from the Hermes executable. */
async function computeVersionFingerprint() {
  try {
    const stats = await stat(HERMES_EXE);
    // Use file size + mtime as the fingerprint (fast, no file read needed)
    const fingerprint = createHash('sha256').update(String(stats.size)).update(String(stats.mtimeMs)).digest('hex').slice(0, 16);
    return fingerprint;
  } catch (error) {
    console.error('[watcher] Fingerprint error:', error.code, error.message);
    return 'not-installed';
  }
}

/** Load the stored state (last known version + config snapshot). */
async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: null, configHash: null };
  }
}

/** Save state. */
async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Compute a hash of the current Hermes config. */
async function computeConfigHash() {
  try {
    const content = await readFile(CONFIG_PATH, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

/** Check if the CC bridge harness is present in the config. */
async function isHarnessPresent() {
  try {
    const content = await readFile(CONFIG_PATH, 'utf8');
    return content.includes('CC_BRIDGE_NATIVITY')
      && content.includes('CC_BRIDGE_VERSION: 13')
      && content.includes('WORKFLOW ENFORCER (MANDATORY PRE-TURN INJECTION)');
  } catch {
    return false;
  }
}

/** Run the restoration script. */
async function restoreHarness() {
  const result = spawnSync(process.execPath, [RESTORE_SCRIPT], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  return result.status === 0;
}

/** Main watcher loop. */
async function main() {
  const fingerprint = await computeVersionFingerprint();
  const state = await loadState();
  const configHash = await computeConfigHash();
  const harnessPresent = await isHarnessPresent();

  const versionChanged = fingerprint !== state.version;
  const configChanged = configHash !== state.configHash;

  if (versionChanged || configChanged || !harnessPresent) {
    const reasons = [];
    if (versionChanged) reasons.push(`Hermes version changed (${state.version || 'none'} → ${fingerprint})`);
    if (configChanged) reasons.push('config.yaml changed');
    if (!harnessPresent) reasons.push('harness missing');

    console.log(`[watcher] Update detected: ${reasons.join(', ')}`);
    console.log('[watcher] Re-applying CC bridge harness...');

    const success = await restoreHarness();
    if (success) {
      console.log('[watcher] Harness re-applied successfully');
    } else {
      console.error('[watcher] Harness re-application reported errors');
    }

    // Update state
    const newConfigHash = await computeConfigHash();
    await saveState({
      version: fingerprint,
      configHash: newConfigHash,
      lastApplied: new Date().toISOString(),
      reason: reasons.join(', '),
    });
  } else {
    console.log('[watcher] No changes detected — harness is up to date');
  }
}

main().catch((error) => {
  console.error('[watcher] Error:', error.message);
  process.exit(1);
});
