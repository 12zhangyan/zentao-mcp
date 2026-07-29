#!/usr/bin/env node
/**
 * 禅道 MCP Server
 * 提供 Bug 和需求的增删改查工具给 AI 使用
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { loadZentaoConfig } from './config.js';
import { SafeLogger } from './logger.js';
import { redactSensitiveText } from './redaction.js';
import {
  isWriteAction,
  resolveLimit,
  serializeToolResult,
} from './runtime-policy.js';
import { ZentaoClient } from './zentao-client.js';
import {
  BugType,
  BugSeverity,
  TestCaseType,
  TestCaseStep,
  StoryCategory,
  ZentaoConfig,
} from './types.js';

const SERVER_NAME = 'zentao-mcp';
const SERVER_VERSION = '1.1.0';

// 环境变量仅用于指定本地配置文件路径，不再承载账号密码。
dotenv.config({ quiet: true });

let zentaoConfig: ZentaoConfig;
try {
  zentaoConfig = loadZentaoConfig();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'config_load_failed',
    message: redactSensitiveText(error),
  })}\n`);
  process.exit(1);
  throw error;
}

// 创建禅道客户端
const zentaoClient = new ZentaoClient(zentaoConfig);
const sensitiveValues = [
  zentaoConfig.url,
  zentaoConfig.account,
  zentaoConfig.password,
];
const logger = new SafeLogger(sensitiveValues);
if (zentaoConfig.url.startsWith('http://')) {
  logger.log('warn', 'insecure_http_transport', {
    message: '当前禅道连接未使用 TLS，传输安全依赖内网边界',
  });
}

// ==================== 工具定义 ====================

const tools: Tool[] = [
  // Bug 工具
  {
    name: 'zentao_bugs',
    description: 'Bug 操作。支持：查询列表、查询详情、创建、解决、关闭',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view', 'create', 'resolve', 'close'],
          description: '操作类型: list-列表, view-详情, create-创建, resolve-解决, close-关闭',
        },
        // 查询参数
        bugID: { type: 'number', description: 'Bug ID（view/resolve/close 时使用）' },
        productID: { type: 'number', description: '产品 ID（list/create 时使用）' },
        browseType: {
          type: 'string',
          enum: ['all', 'unclosed', 'unresolved', 'toclosed', 'openedbyme', 'assigntome', 'resolvedbyme', 'assigntonull'],
          description: '浏览类型(list): all-全部, unclosed-未关闭(默认), unresolved-未解决, toclosed-待关闭, openedbyme-我创建, assigntome-指派给我, resolvedbyme-我解决, assigntonull-未指派',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 20，最大 ${zentaoConfig.maxPageSize}`,
        },
        // 创建参数
        title: { type: 'string', description: 'Bug 标题（create 时必填）' },
        severity: { type: 'number', enum: [1, 2, 3, 4], description: '严重程度: 1-致命, 2-严重, 3-一般, 4-轻微' },
        pri: { type: 'number', enum: [1, 2, 3, 4], description: '优先级: 1-紧急, 2-高, 3-中, 4-低' },
        type: {
          type: 'string',
          enum: ['codeerror', 'config', 'install', 'security', 'performance', 'standard', 'automation', 'designdefect', 'others'],
          description: 'Bug 类型: codeerror-代码错误, config-配置相关, install-安装部署, security-安全相关, performance-性能问题, standard-标准规范, automation-测试脚本, designdefect-设计缺陷, others-其他',
        },
        steps: { type: 'string', description: '重现步骤 (支持 HTML 格式)' },
        assignedTo: { type: 'string', description: '指派给（用户账号）' },
        openedBuild: { type: 'array', items: { type: 'string' }, description: '影响版本，如 ["trunk"]' },
        module: { type: 'number', description: '模块 ID' },
        story: { type: 'number', description: '相关需求 ID' },
        project: { type: 'number', description: '项目 ID' },
        // 解决/关闭参数
        resolution: {
          type: 'string',
          enum: ['bydesign', 'duplicate', 'external', 'fixed', 'notrepro', 'postponed', 'willnotfix'],
          description: '解决方案（resolve 时必填）: fixed-已修复, bydesign-设计如此, duplicate-重复, external-外部原因, notrepro-无法重现, postponed-延期, willnotfix-不予解决',
        },
        comment: { type: 'string', description: '备注（resolve/close 时使用）' },
      },
      required: ['action'],
    },
  },

  // 需求工具
  {
    name: 'zentao_stories',
    description: '需求操作。支持：查询列表、查询详情、创建、关闭',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view', 'create', 'close'],
          description: '操作类型: list-列表, view-详情, create-创建, close-关闭',
        },
        // 查询参数
        storyID: { type: 'number', description: '需求 ID（view/close 时使用）' },
        productID: { type: 'number', description: '产品 ID（list/create 时使用）' },
        browseType: {
          type: 'string',
          enum: ['allstory', 'unclosed', 'draftstory', 'activestory', 'reviewingstory', 'changingstory', 'closedstory', 'openedbyme', 'assignedtome', 'reviewbyme'],
          description: '浏览类型(list): allstory-全部, unclosed-未关闭(默认), draftstory-草稿, activestory-激活, reviewingstory-评审中, changingstory-变更中, closedstory-已关闭, openedbyme-我创建, assignedtome-指派给我, reviewbyme-我评审',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 20，最大 ${zentaoConfig.maxPageSize}`,
        },
        // 创建参数
        title: { type: 'string', description: '需求标题（create 时必填）' },
        category: {
          type: 'string',
          enum: ['feature', 'interface', 'performance', 'safe', 'experience', 'improve', 'other'],
          description: '需求类型: feature-功能, interface-接口, performance-性能, safe-安全, experience-体验, improve-改进, other-其他',
        },
        pri: { type: 'number', enum: [1, 2, 3, 4], description: '优先级: 1-紧急, 2-高, 3-中, 4-低' },
        spec: {
          type: 'string',
          description: `需求描述（create 时必填）。建议按以下禅道模板格式填写：

【目标】要达到的结果（例如：用户能在X页面完成Y操作）

【范围】包含/不包含（例如：仅支持A端，不支持B端）

【约束】兼容性、权限、性能、依赖系统、上线时间等限制条件

【验收标准】可检查的标准（尽量可量化/可点检）

【风险点】可能翻车的地方（初版可先写1-2条）

【信息来源】相关文档/截图/旧需求链接/接口文档链接`,
        },
        reviewer: { type: 'array', items: { type: 'string' }, description: '评审人账号列表（create 时必填），如 ["reviewer1", "reviewer2"]' },
        verify: { type: 'string', description: '验收标准' },
        estimate: { type: 'number', description: '预估工时（小时）' },
        module: { type: 'number', description: '模块 ID' },
        // 关闭参数
        closedReason: {
          type: 'string',
          enum: ['done', 'subdivided', 'duplicate', 'postponed', 'willnotdo', 'cancel', 'bydesign'],
          description: '关闭原因（close 时必填）: done-已完成, subdivided-已细分, duplicate-重复, postponed-延期, willnotdo-不做, cancel-取消, bydesign-设计如此',
        },
        comment: { type: 'string', description: '备注（close 时使用）' },
      },
      required: ['action'],
    },
  },

  // 测试用例工具
  {
    name: 'zentao_testcases',
    description: '测试用例操作。支持：查询列表、查询详情、创建',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view', 'create'],
          description: '操作类型: list-列表, view-详情, create-创建',
        },
        // 查询参数
        caseID: { type: 'number', description: '用例 ID（view 时使用）' },
        productID: { type: 'number', description: '产品 ID（list/create 时使用）' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 100，最大 ${zentaoConfig.maxPageSize}`,
        },
        // 创建参数
        title: { type: 'string', description: '用例标题（create 时必填）' },
        type: {
          type: 'string',
          enum: ['feature', 'performance', 'config', 'install', 'security', 'interface', 'unit', 'other'],
          description: '用例类型: feature-功能测试, performance-性能测试, config-配置相关, install-安装部署, security-安全相关, interface-接口测试, unit-单元测试, other-其他',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              desc: { type: 'string', description: '步骤描述' },
              expect: { type: 'string', description: '期望结果' },
            },
            required: ['desc', 'expect'],
          },
          description: '用例步骤（create 时必填）',
        },
        pri: { type: 'number', enum: [1, 2, 3, 4], description: '优先级: 1-高, 2-中, 3-低, 4-最低' },
        precondition: { type: 'string', description: '前置条件' },
        story: { type: 'number', description: '相关需求 ID' },
      },
      required: ['action'],
    },
  },

  // 产品工具
  {
    name: 'zentao_products',
    description: '产品操作。支持：查询列表、查询详情',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view'],
          description: '操作类型: list-列表, view-详情',
        },
        productID: { type: 'number', description: '产品 ID（view 时使用）' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 100，最大 ${zentaoConfig.maxPageSize}`,
        },
      },
      required: ['action'],
    },
  },

  // 项目工具
  {
    name: 'zentao_projects',
    description: '项目操作。支持：查询列表、查询详情',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view'],
          description: '操作类型: list-列表, view-详情',
        },
        projectID: { type: 'number', description: '项目 ID（view 时使用）' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 100，最大 ${zentaoConfig.maxPageSize}`,
        },
      },
      required: ['action'],
    },
  },

  // 任务工具
  {
    name: 'zentao_tasks',
    description: '只读任务查询。支持：我的任务、执行任务列表、任务详情',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['my', 'execution', 'view'],
          description: '操作类型: my-我的任务, execution-执行任务列表, view-任务详情',
        },
        browseType: {
          type: 'string',
          enum: ['assignedTo', 'finishedBy', 'closedBy'],
          description: '我的任务类型: assignedTo-指派给我(默认), finishedBy-由我完成, closedBy-由我关闭',
        },
        executionID: { type: 'number', description: '执行 ID（execution 时必填）' },
        taskID: { type: 'number', description: '任务 ID（view 时必填）' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 20，最大 ${zentaoConfig.maxPageSize}`,
        },
      },
      required: ['action'],
    },
  },

  // 用户工具
  {
    name: 'zentao_users',
    description: '用户操作。支持：查询列表、查询详情、查询当前用户',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view', 'me'],
          description: '操作类型: list-列表, view-详情, me-当前用户',
        },
        userID: { type: 'number', description: '用户 ID（view 时使用）' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: zentaoConfig.maxPageSize,
          description: `返回数量限制，默认 100，最大 ${zentaoConfig.maxPageSize}`,
        },
      },
      required: ['action'],
    },
  },

  // 运行状态工具
  {
    name: 'zentao_system',
    description: '检查 MCP 与禅道的只读连接状态，不返回账号、地址或业务数据',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['health'],
          description: '操作类型: health-检查连接状态',
        },
      },
      required: ['action'],
    },
  },

  // 文档工具
  {
    name: 'zentao_docs',
    description: '文档操作。支持：获取文档空间树、获取文档详情、创建/编辑文档、创建/编辑目录',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tree', 'view', 'create', 'edit', 'createModule', 'editModule'],
          description: '操作类型: tree-获取文档空间树（包含目录和文档）, view-文档详情, create-创建文档, edit-编辑文档, createModule-创建目录, editModule-编辑目录',
        },
        // 空间查询参数
        spaceType: { type: 'string', enum: ['product', 'project'], description: '空间类型（tree 时使用）' },
        spaceID: { type: 'number', description: '空间 ID - 产品或项目 ID（tree 时使用）' },
        // 文档参数
        libID: { type: 'number', description: '文档库 ID（create/createModule 时使用）' },
        docID: { type: 'number', description: '文档 ID（view/edit 时使用）' },
        moduleID: { type: 'number', description: '目录 ID（editModule/create 时指定所属目录）' },
        // 创建/编辑文档参数
        title: { type: 'string', description: '文档标题（create/edit 时使用）' },
        content: { type: 'string', description: '文档内容（HTML 格式）' },
        keywords: { type: 'string', description: '关键词' },
        type: { type: 'string', enum: ['text', 'url'], description: '文档类型: text-富文本(默认), url-链接' },
        url: { type: 'string', description: '外部链接（type=url 时使用）' },
        // 目录参数
        moduleName: { type: 'string', description: '目录名称（createModule/editModule 时使用）' },
        parentID: { type: 'number', description: '父目录 ID（createModule 时使用，0 表示根目录）' },
      },
      required: ['action'],
    },
  },
];

// ==================== 创建 MCP Server ====================

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出所有可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  const action = (args as Record<string, unknown>).action;
  const startedAt = Date.now();

  try {
    if (extra.signal.aborted) {
      return { content: [{ type: 'text', text: '操作已取消' }], isError: true };
    }
    if (!zentaoConfig.allowWrites && isWriteAction(name, action)) {
      logger.log('warn', 'write_action_blocked', { tool: name, action });
      return {
        content: [{
          type: 'text',
          text: '当前为只读模式；如确需写入，请在本地配置中显式设置 allowWrites: true',
        }],
        isError: true,
      };
    }

    return await zentaoClient.withAbortSignal(extra.signal, async () => {
      logger.log('info', 'tool_call_started', { tool: name, action });
      let result: unknown;

    switch (name) {
      // Bug 操作
      case 'zentao_bugs': {
        const {
          action, bugID, productID, browseType, limit,
          title, severity, pri, type, steps, assignedTo, openedBuild, module, story, project,
          resolution, comment,
        } = args as {
          action: string;
          bugID?: number;
          productID?: number;
          browseType?: string;
          limit?: number;
          title?: string;
          severity?: BugSeverity;
          pri?: number;
          type?: BugType;
          steps?: string;
          assignedTo?: string;
          openedBuild?: string[];
          module?: number;
          story?: number;
          project?: number;
          resolution?: 'bydesign' | 'duplicate' | 'external' | 'fixed' | 'notrepro' | 'postponed' | 'willnotfix';
          comment?: string;
        };

        switch (action) {
          case 'list':
            if (!productID) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID' }], isError: true };
            }
            result = await zentaoClient.getBugs(
              productID,
              browseType,
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100, 20),
            );
            break;

          case 'view':
            if (!bugID) {
              return { content: [{ type: 'text', text: '缺少必要参数: bugID' }], isError: true };
            }
            result = await zentaoClient.getBug(bugID);
            if (!result) {
              return { content: [{ type: 'text', text: `Bug #${bugID} 不存在或无权限查看` }], isError: true };
            }
            break;

          case 'create':
            if (!productID || !title || !severity || !pri || !type) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID, title, severity, pri, type' }], isError: true };
            }
            result = await zentaoClient.createBug({
              product: productID, title, severity, pri, type, steps, assignedTo, openedBuild, module, story, project,
            });
            break;

          case 'resolve':
            if (!bugID) {
              return { content: [{ type: 'text', text: '缺少必要参数: bugID' }], isError: true };
            }
            if (!resolution) {
              return { content: [{ type: 'text', text: '缺少必要参数: resolution' }], isError: true };
            }
            const resolveSuccess = await zentaoClient.resolveBug({ id: bugID, resolution, comment });
            result = { success: resolveSuccess, message: resolveSuccess ? `Bug #${bugID} 已解决` : `Bug #${bugID} 解决失败` };
            break;

          case 'close':
            if (!bugID) {
              return { content: [{ type: 'text', text: '缺少必要参数: bugID' }], isError: true };
            }
            const closeSuccess = await zentaoClient.closeBug({ id: bugID, comment });
            result = { success: closeSuccess, message: closeSuccess ? `Bug #${bugID} 已关闭` : `Bug #${bugID} 关闭失败` };
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 需求操作
      case 'zentao_stories': {
        const {
          action, storyID, productID, browseType, limit,
          title, category, pri, spec, reviewer, verify, estimate, module,
          closedReason, comment,
        } = args as {
          action: string;
          storyID?: number;
          productID?: number;
          browseType?: string;
          limit?: number;
          title?: string;
          category?: StoryCategory;
          pri?: number;
          spec?: string;
          reviewer?: string[];
          verify?: string;
          estimate?: number;
          module?: number;
          closedReason?: 'done' | 'subdivided' | 'duplicate' | 'postponed' | 'willnotdo' | 'cancel' | 'bydesign';
          comment?: string;
        };

        switch (action) {
          case 'list':
            if (!productID) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID' }], isError: true };
            }
            result = await zentaoClient.getStories(
              productID,
              browseType,
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100, 20),
            );
            break;

          case 'view':
            if (!storyID) {
              return { content: [{ type: 'text', text: '缺少必要参数: storyID' }], isError: true };
            }
            result = await zentaoClient.getStory(storyID);
            if (!result) {
              return { content: [{ type: 'text', text: `需求 #${storyID} 不存在或无权限查看` }], isError: true };
            }
            break;

          case 'create':
            if (!productID || !title || !category || !pri || !spec || !reviewer) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID, title, category, pri, spec, reviewer' }], isError: true };
            }
            result = await zentaoClient.createStory({
              product: productID, title, category, pri, spec, reviewer, verify, estimate, module,
            });
            break;

          case 'close':
            if (!storyID) {
              return { content: [{ type: 'text', text: '缺少必要参数: storyID' }], isError: true };
            }
            if (!closedReason) {
              return { content: [{ type: 'text', text: '缺少必要参数: closedReason' }], isError: true };
            }
            const success = await zentaoClient.closeStory({ id: storyID, closedReason, comment });
            result = { success, message: success ? `需求 #${storyID} 已关闭` : `需求 #${storyID} 关闭失败` };
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 测试用例操作
      case 'zentao_testcases': {
        const {
          action, caseID, productID, limit,
          title, type, steps, pri, precondition, story,
        } = args as {
          action: string;
          caseID?: number;
          productID?: number;
          limit?: number;
          title?: string;
          type?: TestCaseType;
          steps?: TestCaseStep[];
          pri?: number;
          precondition?: string;
          story?: number;
        };

        switch (action) {
          case 'list':
            if (!productID) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID' }], isError: true };
            }
            result = await zentaoClient.getTestCases(
              productID,
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100),
            );
            break;

          case 'view':
            if (!caseID) {
              return { content: [{ type: 'text', text: '缺少必要参数: caseID' }], isError: true };
            }
            result = await zentaoClient.getTestCase(caseID);
            if (!result) {
              return { content: [{ type: 'text', text: `测试用例 #${caseID} 不存在或无权限查看` }], isError: true };
            }
            break;

          case 'create':
            if (!productID || !title || !type || !steps) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID, title, type, steps' }], isError: true };
            }
            result = await zentaoClient.createTestCase({
              product: productID, title, type, steps, pri, precondition, story,
            });
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 产品操作
      case 'zentao_products': {
        const { action, productID, limit } = args as {
          action: string;
          productID?: number;
          limit?: number;
        };

        switch (action) {
          case 'list':
            result = await zentaoClient.getProducts(
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100),
            );
            break;

          case 'view':
            if (!productID) {
              return { content: [{ type: 'text', text: '缺少必要参数: productID' }], isError: true };
            }
            result = await zentaoClient.getProduct(productID);
            if (!result) {
              return { content: [{ type: 'text', text: `产品 #${productID} 不存在或无权限查看` }], isError: true };
            }
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 项目操作
      case 'zentao_projects': {
        const { action, projectID, limit } = args as {
          action: string;
          projectID?: number;
          limit?: number;
        };

        switch (action) {
          case 'list':
            result = await zentaoClient.getProjects(
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100),
            );
            break;

          case 'view':
            if (!projectID) {
              return { content: [{ type: 'text', text: '缺少必要参数: projectID' }], isError: true };
            }
            result = await zentaoClient.getProject(projectID);
            if (!result) {
              return { content: [{ type: 'text', text: `项目 #${projectID} 不存在或无权限查看` }], isError: true };
            }
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 任务操作
      case 'zentao_tasks': {
        const { action, browseType, executionID, taskID, limit } = args as {
          action: string;
          browseType?: 'assignedTo' | 'finishedBy' | 'closedBy';
          executionID?: number;
          taskID?: number;
          limit?: number;
        };

        switch (action) {
          case 'my':
            result = await zentaoClient.getMyTasks(
              browseType,
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100, 20),
            );
            break;

          case 'execution':
            if (!executionID) {
              return { content: [{ type: 'text', text: '缺少必要参数: executionID' }], isError: true };
            }
            result = await zentaoClient.getTasks(
              executionID,
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100, 20),
            );
            break;

          case 'view':
            if (!taskID) {
              return { content: [{ type: 'text', text: '缺少必要参数: taskID' }], isError: true };
            }
            result = await zentaoClient.getTask(taskID);
            if (!result) {
              return { content: [{ type: 'text', text: `任务 #${taskID} 不存在或无权限查看` }], isError: true };
            }
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 用户操作
      case 'zentao_users': {
        const { action, userID, limit } = args as {
          action: string;
          userID?: number;
          limit?: number;
        };

        switch (action) {
          case 'list':
            result = await zentaoClient.getUsers(
              resolveLimit(limit, zentaoConfig.maxPageSize ?? 100),
            );
            break;

          case 'view':
            if (!userID) {
              return { content: [{ type: 'text', text: '缺少必要参数: userID' }], isError: true };
            }
            result = await zentaoClient.getUser(userID);
            if (!result) {
              return { content: [{ type: 'text', text: `用户 #${userID} 不存在或无权限查看` }], isError: true };
            }
            break;

          case 'me':
            result = await zentaoClient.getMyProfile();
            if (!result) {
              return { content: [{ type: 'text', text: '获取当前用户信息失败' }], isError: true };
            }
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      // 运行状态
      case 'zentao_system': {
        const { action } = args as { action: string };
        if (action !== 'health') {
          return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        const profile = await zentaoClient.getMyProfile();
        result = {
          status: profile ? 'ok' : 'degraded',
          serverVersion: SERVER_VERSION,
          mode: zentaoConfig.allowWrites ? 'read-write' : 'read-only',
          transportSecurity: zentaoConfig.url.startsWith('https://') ? 'tls' : 'insecure-http',
        };
        break;
      }

      // 文档操作
      case 'zentao_docs': {
        const {
          action, spaceType, spaceID, libID, docID, moduleID,
          title, content, keywords, type, url, moduleName, parentID
        } = args as {
          action: string;
          spaceType?: 'product' | 'project';
          spaceID?: number;
          libID?: number;
          docID?: number;
          moduleID?: number;
          title?: string;
          content?: string;
          keywords?: string;
          type?: string;
          url?: string;
          moduleName?: string;
          parentID?: number;
        };

        switch (action) {
          case 'tree':
            // 获取文档空间树（包含文档库、目录和文档）
            if (!spaceType || !spaceID) {
              return { content: [{ type: 'text', text: '缺少必要参数: spaceType 和 spaceID' }], isError: true };
            }
            result = await zentaoClient.getDocSpaceData(spaceType, spaceID);
            break;

          case 'view':
            if (!docID) {
              return { content: [{ type: 'text', text: '缺少必要参数: docID（文档 ID）' }], isError: true };
            }
            result = await zentaoClient.getDoc(docID);
            if (!result) {
              return { content: [{ type: 'text', text: `文档 #${docID} 不存在或无权限查看` }], isError: true };
            }
            break;

          case 'create':
            if (!libID || !title) {
              return { content: [{ type: 'text', text: '缺少必要参数: libID（文档库 ID）和 title（标题）' }], isError: true };
            }
            result = await zentaoClient.createDoc({
              lib: libID,
              title,
              type: type as 'text' | 'url' | undefined,
              content,
              url,
              keywords,
              module: moduleID,
            });
            break;

          case 'edit':
            if (!docID) {
              return { content: [{ type: 'text', text: '缺少必要参数: docID（文档 ID）' }], isError: true };
            }
            result = await zentaoClient.editDoc({ id: docID, title, content, keywords });
            if (!result) {
              return { content: [{ type: 'text', text: `编辑文档 #${docID} 失败` }], isError: true };
            }
            break;

          case 'createModule':
            // 创建文档目录
            if (!libID || !moduleName || !spaceID) {
              return { content: [{ type: 'text', text: '缺少必要参数: libID（文档库 ID）、moduleName（目录名称）和 spaceID（产品/项目 ID）' }], isError: true };
            }
            result = await zentaoClient.createDocModule({
              name: moduleName,
              libID,
              parentID: parentID || 0,
              objectID: spaceID,
            });
            break;

          case 'editModule':
            // 编辑文档目录
            if (!moduleID || !moduleName || !libID) {
              return { content: [{ type: 'text', text: '缺少必要参数: moduleID（目录 ID）、moduleName（目录名称）和 libID（文档库 ID）' }], isError: true };
            }
            result = await zentaoClient.editDocModule({
              moduleID,
              name: moduleName,
              root: libID,
              parent: parentID,
            });
            if (!result) {
              return { content: [{ type: 'text', text: `编辑目录 #${moduleID} 失败` }], isError: true };
            }
            break;

          default:
            return { content: [{ type: 'text', text: `未知操作类型: ${action}` }], isError: true };
        }
        break;
      }

      default:
        return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
    }

    const text = serializeToolResult(result, zentaoConfig.maxResponseChars ?? 200_000);
    logger.log('info', 'tool_call_succeeded', {
      tool: name,
      action,
      durationMs: Date.now() - startedAt,
      responseChars: text.length,
    });
      return { content: [{ type: 'text', text }] };
    });
  } catch (error) {
    const errorMessage = redactSensitiveText(
      error instanceof Error ? error.message : '未知错误',
      sensitiveValues,
    );
    logger.log('error', 'tool_call_failed', {
      tool: name,
      action,
      durationMs: Date.now() - startedAt,
      message: errorMessage,
    });
    return { content: [{ type: 'text', text: `操作失败: ${errorMessage}` }], isError: true };
  }
});

// ==================== 启动服务器 ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.log('info', 'server_started', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    mode: zentaoConfig.allowWrites ? 'read-write' : 'read-only',
  });
}

let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log('info', 'server_stopping', { reason, exitCode });
  try {
    await server.close();
  } catch (error) {
    logger.log('error', 'server_close_failed', { message: error });
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('uncaughtException', (error) => {
  logger.log('error', 'uncaught_exception', { message: error });
  void shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', (error) => {
  logger.log('error', 'unhandled_rejection', { message: error });
  void shutdown('unhandledRejection', 1);
});

main().catch((error) => {
  logger.log('error', 'server_start_failed', { message: error });
  void shutdown('startupFailure', 1);
});
