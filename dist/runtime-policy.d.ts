/** 判断一次 MCP tool 调用是否会修改禅道数据。 */
export declare function isWriteAction(toolName: string, action: unknown): boolean;
/** 严格校验列表数量，避免静默截断或大响应占满上下文。 */
export declare function resolveLimit(value: unknown, maximum: number, fallback?: number): number;
/** 严格校验从 1 开始的页码。 */
export declare function resolvePage(value: unknown, fallback?: number): number;
/** 去掉描述等大字段，保留周报归档和项目映射所需字段。 */
export declare function compactTask(task: Task): CompactTask;
/** 序列化并限制单次 MCP 响应大小。 */
export declare function serializeToolResult(result: unknown, maximumChars: number): string;
import type { CompactTask, Task } from './types.js';
//# sourceMappingURL=runtime-policy.d.ts.map