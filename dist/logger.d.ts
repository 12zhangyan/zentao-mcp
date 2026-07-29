export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** 输出到 stderr 的结构化脱敏日志，不占用 MCP stdio 的 stdout。 */
export declare class SafeLogger {
    private readonly secrets;
    constructor(secrets?: Array<string | undefined>);
    log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
    private sanitize;
}
//# sourceMappingURL=logger.d.ts.map