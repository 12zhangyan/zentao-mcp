import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSensitiveText } from '../dist/redaction.js';

test('错误文本中的连接信息和常见凭据字段会被清洗', () => {
  const result = redactSensitiveText(
    'POST http://zentao.example.local/zentao failed account=tester password="secret" Token: abc Cookie=zentaosid=xyz',
    ['http://zentao.example.local/zentao', 'tester', 'secret', 'abc', 'xyz'],
  );

  assert.doesNotMatch(result, /zentao\.example\.local|tester|secret|abc|xyz/);
  assert.match(result, /<REDACTED>/);
});
