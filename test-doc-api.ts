/**
 * 禅道文档 API 只读诊断脚本。
 *
 * 先运行 npm run build，再使用本机 ~/.zentao-mcp/config.json：
 * npx ts-node --esm test-doc-api.ts <product|project> <spaceID> [docID]
 *
 * 本脚本不创建或编辑目录、文档，也不会输出账号、Token、Cookie 或业务内容。
 */

import { loadZentaoConfig } from './src/config.js';
import { ZentaoClient } from './src/zentao-client.js';

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const spaceType = process.argv[2];
  if (spaceType !== 'product' && spaceType !== 'project') {
    throw new Error('spaceType 必须是 product 或 project');
  }

  const spaceID = positiveInteger(process.argv[3], 'spaceID');
  const docID = process.argv[4] === undefined
    ? undefined
    : positiveInteger(process.argv[4], 'docID');

  const client = new ZentaoClient(loadZentaoConfig());
  const tree = await client.getDocSpaceData(spaceType, spaceID);
  const result: Record<string, unknown> = {
    authenticated: true,
    spaceType,
    spaceID,
    libraries: Array.isArray(tree?.libs) ? tree.libs.length : 0,
  };

  if (docID !== undefined) {
    result.docID = docID;
    result.docReadable = Boolean(await client.getDoc(docID));
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : '未知错误';
  process.stderr.write(`只读诊断失败：${message}\n`);
  process.exitCode = 1;
});
