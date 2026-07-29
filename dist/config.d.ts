import { ZentaoConfig } from './types.js';
/** 获取默认的用户级配置文件路径。 */
export declare function defaultConfigPath(homeDir?: string): string;
/** 解析用户指定或默认的本地配置文件路径。 */
export declare function resolveConfigPath(env?: NodeJS.ProcessEnv, homeDir?: string): string;
/**
 * 从用户目录的本地 JSON 文件加载禅道连接配置。
 * 配置文件可以复用 zentao-weekly 的 zentao.baseUrl/account/password 结构。
 */
export declare function loadZentaoConfig(env?: NodeJS.ProcessEnv, homeDir?: string): ZentaoConfig;
//# sourceMappingURL=config.d.ts.map