import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactTask,
  isWriteAction,
  resolveLimit,
  resolvePage,
  serializeToolResult,
} from '../dist/runtime-policy.js';

test('只拦截统一工具中的写操作', () => {
  assert.equal(isWriteAction('zentao_bugs', 'create'), true);
  assert.equal(isWriteAction('zentao_docs', 'editModule'), true);
  assert.equal(isWriteAction('zentao_bugs', 'list'), false);
  assert.equal(isWriteAction('zentao_products', 'view'), false);
  assert.equal(isWriteAction('unknown', 'create'), false);
});

test('分页限制严格校验，不静默截断', () => {
  assert.equal(resolveLimit(undefined, 80, 20), 20);
  assert.equal(resolveLimit(80, 80), 80);
  assert.throws(() => resolveLimit(81, 80), /limit 必须是 1-80 的整数/);
  assert.throws(() => resolveLimit(1.5, 80), /limit 必须是 1-80 的整数/);
  assert.equal(resolvePage(undefined), 1);
  assert.equal(resolvePage(3), 3);
  assert.throws(() => resolvePage(0), /page 必须是大于等于 1 的整数/);
});

test('精简任务保留周报字段并移除大文本，100 条可安全序列化', () => {
  const full = {
    id: 42,
    name: '完成接口',
    project: 9,
    execution: 10,
    type: 'devel',
    status: 'done',
    consumed: 8,
    estimate: 12,
    realStarted: '2026-07-01',
    finishedDate: '2026-07-02',
    desc: 'x'.repeat(10_000),
  };
  const compact = compactTask(full);
  assert.equal(compact.id, 42);
  assert.equal(compact.project, 9);
  assert.equal('desc' in compact, false);
  assert.doesNotThrow(() => serializeToolResult(
    { page: 1, limit: 100, total: 100, hasMore: false, compact: true, tasks: Array(100).fill(compact) },
    200_000,
  ));
});

test('响应超过配置上限时显式失败', () => {
  assert.equal(serializeToolResult({ ok: true }, 100), '{\n  "ok": true\n}');
  assert.throws(
    () => serializeToolResult({ value: 'x'.repeat(50) }, 20),
    /超过上限 20/,
  );
});
