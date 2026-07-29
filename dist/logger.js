import { redactSensitiveText } from './redaction.js';
/** 输出到 stderr 的结构化脱敏日志，不占用 MCP stdio 的 stdout。 */
export class SafeLogger {
    secrets;
    constructor(secrets = []) {
        this.secrets = secrets;
    }
    log(level, event, fields = {}) {
        const safeFields = this.sanitize(fields);
        process.stderr.write(`${JSON.stringify({
            timestamp: new Date().toISOString(),
            level,
            event,
            ...safeFields,
        })}\n`);
    }
    sanitize(value, key = '') {
        if (/password|passwd|token|authorization|cookie|zentaosid/i.test(key)) {
            return '<REDACTED>';
        }
        if (typeof value === 'string')
            return redactSensitiveText(value, this.secrets);
        if (value instanceof Error)
            return redactSensitiveText(value.message, this.secrets);
        if (Array.isArray(value))
            return value.map((item) => this.sanitize(item));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
                childKey,
                this.sanitize(childValue, childKey),
            ]));
        }
        return value;
    }
}
//# sourceMappingURL=logger.js.map