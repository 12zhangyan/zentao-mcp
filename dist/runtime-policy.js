const WRITE_ACTIONS = {
    zentao_bugs: new Set(['create', 'resolve', 'close']),
    zentao_stories: new Set(['create', 'close']),
    zentao_testcases: new Set(['create']),
    zentao_docs: new Set(['create', 'edit', 'createModule', 'editModule']),
};
/** 判断一次 MCP tool 调用是否会修改禅道数据。 */
export function isWriteAction(toolName, action) {
    return typeof action === 'string' && Boolean(WRITE_ACTIONS[toolName]?.has(action));
}
/** 严格校验列表数量，避免静默截断或大响应占满上下文。 */
export function resolveLimit(value, maximum, fallback = 100) {
    if (value === undefined)
        return Math.min(fallback, maximum);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(`limit 必须是 1-${maximum} 的整数`);
    }
    return value;
}
/** 严格校验从 1 开始的页码。 */
export function resolvePage(value, fallback = 1) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < 1) {
        throw new Error('page 必须是大于等于 1 的整数');
    }
    return value;
}
/** 去掉描述等大字段，保留周报归档和项目映射所需字段。 */
export function compactTask(task) {
    const keys = [
        'id', 'name', 'project', 'execution', 'type', 'status',
        'estimate', 'consumed', 'assignedTo', 'realStarted',
        'finishedBy', 'finishedDate', 'closedBy', 'closedDate',
    ];
    const compact = {};
    for (const key of keys) {
        const value = task[key];
        if (value !== undefined)
            compact[key] = value;
    }
    return compact;
}
/** 序列化并限制单次 MCP 响应大小。 */
export function serializeToolResult(result, maximumChars) {
    const text = JSON.stringify(result, null, 2);
    if (text.length > maximumChars) {
        throw new Error(`响应大小 ${text.length} 字符，超过上限 ${maximumChars}；请缩小 limit 或增加筛选条件`);
    }
    return text;
}
//# sourceMappingURL=runtime-policy.js.map