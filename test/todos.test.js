import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpToolRegistry } from '../src/mcp/tools.js';

function makeTmpRoot() {
  return mkdtempSync(join(tmpdir(), 'wtp-todos-test-'));
}

test('cc_todos_update persists todos to disk that survive a fresh registry', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot, sessionID: 'test' };
    const registry = createMcpToolRegistry({ core: {} });

    const writeResult = await registry.call('cc_todos_update', {
      todos: [
        { content: 'First task', status: 'pending' },
        { content: 'Second task', status: 'in_progress' },
      ],
    }, ctx);
    assert.equal(writeResult.content[0].type, 'text');
    const parsed = JSON.parse(writeResult.content[0].text);
    assert.equal(parsed.todos.length, 2);
    assert.equal(parsed.todos[0].content, 'First task');
    assert.equal(parsed.todos[0].status, 'pending');
    assert.equal(parsed.todos[0].id, 1);
    assert.equal(parsed.todos[1].id, 2);

    // Create a NEW registry (simulates model change / session restart)
    const registry2 = createMcpToolRegistry({ core: {} });
    const listResult = await registry2.call('cc_todos_list', {}, ctx);
    const listed = JSON.parse(listResult.content[0].text);
    assert.equal(listed.todos.length, 2);
    assert.equal(listed.todos[0].content, 'First task');
    assert.equal(listed.todos[1].content, 'Second task');
    assert.equal(listed.count, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cc_todos_update merges new items with existing and assigns incrementing IDs', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot };
    const registry = createMcpToolRegistry({ core: {} });

    await registry.call('cc_todos_update', {
      todos: [{ content: 'Task A', status: 'pending' }],
    }, ctx);

    const result = await registry.call('cc_todos_update', {
      todos: [
        { id: 1, content: 'Task A updated', status: 'completed' },
        { content: 'Task B', status: 'pending' },
      ],
    }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.todos.length, 2);
    assert.equal(parsed.todos[0].content, 'Task A updated');
    assert.equal(parsed.todos[0].status, 'completed');
    assert.equal(parsed.todos[1].content, 'Task B');
    assert.equal(parsed.todos[1].status, 'pending');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cc_todos_clear removes only completed by default', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot };
    const registry = createMcpToolRegistry({ core: {} });

    await registry.call('cc_todos_update', {
      todos: [
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'pending' },
        { content: 'Task C', status: 'completed' },
      ],
    }, ctx);

    const clearResult = await registry.call('cc_todos_clear', {}, ctx);
    const cleared = JSON.parse(clearResult.content[0].text);
    assert.equal(cleared.cleared, 2);
    assert.equal(cleared.remaining, 1);

    const listResult = await registry.call('cc_todos_list', {}, ctx);
    const listed = JSON.parse(listResult.content[0].text);
    assert.equal(listed.todos.length, 1);
    assert.equal(listed.todos[0].content, 'Task B');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cc_todos_clear with completedOnly=false wipes all', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot };
    const registry = createMcpToolRegistry({ core: {} });

    await registry.call('cc_todos_update', {
      todos: [{ content: 'Task A', status: 'pending' }, { content: 'Task B', status: 'completed' }],
    }, ctx);

    const result = await registry.call('cc_todos_clear', { completedOnly: false }, ctx);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.cleared, 2);
    assert.equal(parsed.remaining, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cc_todos tools reject non-JSON-safe input', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot };
    const registry = createMcpToolRegistry({ core: {} });

    // Cyclic object in args should be rejected by JSON-safety check
    const cyclic = { todos: [] };
    cyclic.self = cyclic;
    await assert.rejects(
      () => registry.call('cc_todos_update', cyclic, ctx),
      /not JSON-safe|arguments must be JSON-safe/i,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cc_todos content is bounded and sanitized', async () => {
  const tmpRoot = makeTmpRoot();
  try {
    const ctx = { projectRoot: tmpRoot };
    const registry = createMcpToolRegistry({ core: {} });

    // Secrets should be redacted in stored content
    await registry.call('cc_todos_update', {
      todos: [{ content: 'Fix sk-test-secret-key bug', status: 'pending' }],
    }, ctx);

    const listResult = await registry.call('cc_todos_list', {}, ctx);
    const listed = JSON.parse(listResult.content[0].text);
    assert.doesNotMatch(JSON.stringify(listed), /sk-test-secret/);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
