import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultConfigPath,
  loadZentaoConfig,
  resolveConfigPath,
} from '../dist/config.js';

test('默认配置位于当前用户目录，不依赖仓库文件', () => {
  const home = path.join(path.sep, 'users', 'tester');
  assert.equal(defaultConfigPath(home), path.join(home, '.zentao-mcp', 'config.json'));
  assert.equal(resolveConfigPath({}, home), defaultConfigPath(home));
});

test('可读取本地配置，并兼容 zentao 节点配置结构', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    zentao: {
      baseUrl: 'http://zentao.example.local/zentao/',
      account: 'tester',
      password: 'local-secret',
      skipSsl: true,
    },
    weeklyReport: {
      lookbackMonths: 3,
    },
  }));

  try {
    const config = loadZentaoConfig({ ZENTAO_CONFIG_PATH: configPath });
    assert.deepEqual(config, {
      url: 'http://zentao.example.local/zentao',
      account: 'tester',
      password: 'local-secret',
      rejectUnauthorized: false,
      timeoutMs: 30000,
      maxRetries: 2,
      maxPageSize: 100,
      maxResponseChars: 200000,
      allowWrites: false,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('配置默认只读，且生产参数可在受控范围内覆盖', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    zentao: {
      baseUrl: 'https://zentao.example.local/zentao',
      account: 'tester',
      password: 'local-secret',
      timeoutMs: 45000,
      maxRetries: 3,
      maxPageSize: 80,
      maxResponseChars: 120000,
      allowWrites: true,
    },
  }));

  try {
    const config = loadZentaoConfig({ ZENTAO_CONFIG_PATH: configPath });
    assert.equal(config.allowWrites, true);
    assert.equal(config.timeoutMs, 45000);
    assert.equal(config.maxRetries, 3);
    assert.equal(config.maxPageSize, 80);
    assert.equal(config.maxResponseChars, 120000);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('拒绝带凭据或查询参数的 baseUrl', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    zentao: {
      baseUrl: 'https://tester:secret@zentao.example.local/zentao?token=secret',
      account: 'tester',
      password: 'local-secret',
    },
  }));

  try {
    assert.throws(
      () => loadZentaoConfig({ ZENTAO_CONFIG_PATH: configPath }),
      /不得包含凭据、查询参数或片段/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('拒绝越界的超时和分页参数', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    zentao: {
      baseUrl: 'https://zentao.example.local/zentao',
      account: 'tester',
      password: 'local-secret',
      maxRetries: 99,
    },
  }));

  try {
    assert.throws(
      () => loadZentaoConfig({ ZENTAO_CONFIG_PATH: configPath }),
      /maxRetries 必须是 0-5 的整数/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('专用配置不存在时不得读取 zentao-weekly 凭据', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-home-'));
  const weeklyDirectory = path.join(home, '.zentao-weekly');
  fs.mkdirSync(weeklyDirectory);
  fs.writeFileSync(path.join(weeklyDirectory, 'config.json'), JSON.stringify({
    zentao: {
      baseUrl: 'http://zentao.example.local/zentao',
      account: 'tester',
      password: 'weekly-local-secret',
    },
  }));

  try {
    assert.throws(
      () => loadZentaoConfig({}, home),
      /未找到禅道本地配置/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('配置缺少凭据时显式失败，错误不包含文件内容', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zentao-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    zentao: { baseUrl: 'http://zentao.example.local/zentao', account: 'tester' },
  }));

  try {
    assert.throws(
      () => loadZentaoConfig({ ZENTAO_CONFIG_PATH: configPath }),
      /缺少 baseUrl、account 或 password/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
