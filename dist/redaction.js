const SENSITIVE_ASSIGNMENT = /((?:"|')?(?:password|passwd|token|authorization|cookie|zentaosid)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s&}]+)/gi;
/** 清洗错误和诊断文本中的连接凭据。 */
export function redactSensitiveText(value, secrets = []) {
    let text = value instanceof Error ? value.message : String(value ?? '');
    for (const secret of secrets) {
        if (!secret)
            continue;
        text = text.split(secret).join('<REDACTED>');
    }
    return text.replace(SENSITIVE_ASSIGNMENT, '$1<REDACTED>');
}
//# sourceMappingURL=redaction.js.map