/** 判断一次 MCP tool 调用是否会修改禅道数据。 */
export declare function isWriteAction(toolName: string, action: unknown): boolean;
/** 严格校验列表数量，避免静默截断或大响应占满上下文。 */
export declare function resolveLimit(value: unknown, maximum: number, fallback?: number): number;
/** 序列化并限制单次 MCP 响应大小。 */
export declare function serializeToolResult(result: unknown, maximumChars: number): string;
//# sourceMappingURL=runtime-policy.d.ts.map