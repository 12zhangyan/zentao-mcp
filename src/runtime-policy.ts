const WRITE_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  zentao_bugs: new Set(['create', 'resolve', 'close']),
  zentao_stories: new Set(['create', 'close']),
  zentao_testcases: new Set(['create']),
  zentao_docs: new Set(['create', 'edit', 'createModule', 'editModule']),
};

/** 判断一次 MCP tool 调用是否会修改禅道数据。 */
export function isWriteAction(toolName: string, action: unknown): boolean {
  return typeof action === 'string' && Boolean(WRITE_ACTIONS[toolName]?.has(action));
}

/** 严格校验列表数量，避免静默截断或大响应占满上下文。 */
export function resolveLimit(
  value: unknown,
  maximum: number,
  fallback: number = 100,
): number {
  if (value === undefined) return Math.min(fallback, maximum);
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`limit 必须是 1-${maximum} 的整数`);
  }
  return value as number;
}

/** 序列化并限制单次 MCP 响应大小。 */
export function serializeToolResult(result: unknown, maximumChars: number): string {
  const text = JSON.stringify(result, null, 2);
  if (text.length > maximumChars) {
    throw new Error(
      `响应大小 ${text.length} 字符，超过上限 ${maximumChars}；请缩小 limit 或增加筛选条件`,
    );
  }
  return text;
}
