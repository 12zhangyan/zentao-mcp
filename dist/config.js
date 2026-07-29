import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_RESPONSE_CHARS = 200_000;
function boundedInteger(value, fallback, minimum, maximum, fieldName) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`禅道本地配置中的 ${fieldName} 必须是 ${minimum}-${maximum} 的整数`);
    }
    return value;
}
/** 获取默认的用户级配置文件路径。 */
export function defaultConfigPath(homeDir = os.homedir()) {
    return path.join(homeDir, '.zentao-mcp', 'config.json');
}
/** 解析用户指定或默认的本地配置文件路径。 */
export function resolveConfigPath(env = process.env, homeDir = os.homedir()) {
    const configuredPath = env.ZENTAO_CONFIG_PATH?.trim();
    if (!configuredPath)
        return defaultConfigPath(homeDir);
    if (configuredPath === '~')
        return homeDir;
    if (configuredPath.startsWith(`~${path.sep}`) || configuredPath.startsWith('~/')) {
        return path.join(homeDir, configuredPath.slice(2));
    }
    return path.resolve(configuredPath);
}
/** 从用户指定或默认的本地 JSON 文件加载禅道连接配置。 */
export function loadZentaoConfig(env = process.env, homeDir = os.homedir()) {
    const configPath = resolveConfigPath(env, homeDir);
    let raw;
    try {
        raw = fs.readFileSync(configPath, 'utf8');
    }
    catch {
        throw new Error('未找到禅道本地配置，请先运行 npm run setup');
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('禅道本地配置不是有效 JSON，请重新运行 npm run setup');
    }
    const local = parsed.zentao;
    const urlValue = local?.baseUrl ?? local?.url;
    const url = typeof urlValue === 'string' ? urlValue.trim().replace(/\/+$/, '') : '';
    const account = typeof local?.account === 'string' ? local.account.trim() : '';
    const password = typeof local?.password === 'string' ? local.password : '';
    if (!url || !account || !password) {
        throw new Error('禅道本地配置缺少 baseUrl、account 或 password');
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch {
        throw new Error('禅道本地配置中的 baseUrl 不是有效 URL');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('禅道本地配置中的 baseUrl 仅支持 http 或 https');
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
        throw new Error('禅道本地配置中的 baseUrl 不得包含凭据、查询参数或片段');
    }
    const skipSsl = local?.skipSsl === true || local?.rejectUnauthorized === false;
    return {
        url,
        account,
        password,
        rejectUnauthorized: skipSsl ? false : undefined,
        timeoutMs: boundedInteger(local?.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000, 'timeoutMs'),
        maxRetries: boundedInteger(local?.maxRetries, DEFAULT_MAX_RETRIES, 0, 5, 'maxRetries'),
        maxPageSize: boundedInteger(local?.maxPageSize, DEFAULT_MAX_PAGE_SIZE, 1, 500, 'maxPageSize'),
        maxResponseChars: boundedInteger(local?.maxResponseChars, DEFAULT_MAX_RESPONSE_CHARS, 10_000, 1_000_000, 'maxResponseChars'),
        allowWrites: local?.allowWrites === true,
    };
}
//# sourceMappingURL=config.js.map