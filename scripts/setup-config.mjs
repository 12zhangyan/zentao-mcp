#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

const configPath = path.join(os.homedir(), '.zentao-mcp', 'config.json');

function createMutedOutput() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  return {
    output,
    setMuted(value) {
      muted = value;
    },
  };
}

async function questionHidden(rl, mute, label) {
  process.stdout.write(label);
  mute.setMuted(true);
  const answer = await rl.question('');
  mute.setMuted(false);
  process.stdout.write('\n');
  return answer;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('配置初始化需要在交互式终端运行');
  }

  const mute = createMutedOutput();
  const rl = readline.createInterface({
    input: process.stdin,
    output: mute.output,
    terminal: true,
  });

  try {
    if (fs.existsSync(configPath)) {
      const overwrite = (await rl.question('本地配置已存在，是否覆盖？[y/N] ')).trim().toLowerCase();
      if (overwrite !== 'y' && overwrite !== 'yes') {
        process.stdout.write('已取消，现有配置未修改。\n');
        return;
      }
    }

    const baseUrl = (await rl.question('禅道访问根地址（例如 http://zentao.example.local/zentao）：')).trim();
    const account = (await rl.question('禅道账号：')).trim();
    const password = await questionHidden(rl, mute, '禅道密码（输入内容不回显）：');
    const skipSslAnswer = (await rl.question('是否跳过 SSL 证书验证？[y/N] ')).trim().toLowerCase();
    const skipSsl = skipSslAnswer === 'y' || skipSslAnswer === 'yes';
    const allowWritesAnswer = (
      await rl.question('是否允许创建、编辑、关闭等写操作？默认只读 [y/N] ')
    ).trim().toLowerCase();
    const allowWrites = allowWritesAnswer === 'y' || allowWritesAnswer === 'yes';

    const parsedUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('访问根地址仅支持 http 或 https');
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new Error('访问根地址不得包含凭据、查询参数或片段');
    }
    if (!account || !password) {
      throw new Error('账号和密码不能为空');
    }

    const directory = path.dirname(configPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(directory, `.config-${process.pid}.tmp`);
    const content = `${JSON.stringify({
      zentao: {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        account,
        password,
        skipSsl,
        allowWrites,
        timeoutMs: 30000,
        maxRetries: 2,
        maxPageSize: 100,
        maxResponseChars: 200000,
      },
    }, null, 2)}\n`;

    fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Windows ACL 不完全映射 POSIX mode；文件仍保存在当前用户目录。
    }
    process.stdout.write('本地配置已保存，敏感值未输出。\n');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  process.stderr.write(`配置失败：${error instanceof Error ? error.message : '未知错误'}\n`);
  process.exit(1);
});
