import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWriteAction,
  resolveLimit,
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
});

test('响应超过配置上限时显式失败', () => {
  assert.equal(serializeToolResult({ ok: true }, 100), '{\n  "ok": true\n}');
  assert.throws(
    () => serializeToolResult({ value: 'x'.repeat(50) }, 20),
    /超过上限 20/,
  );
});
