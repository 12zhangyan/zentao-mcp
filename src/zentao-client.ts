/**
 * 禅道 API 客户端
 * 封装禅道 REST API 的调用，支持 Bug 和需求的增删改查
 */

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import https from 'https';
import FormData from 'form-data';
import { SafeLogger } from './logger.js';
import { redactSensitiveText } from './redaction.js';
import {
  ZentaoConfig,
  Bug,
  Story,
  Product,
  Project,
  CreateBugParams,
  ResolveBugParams,
  CloseBugParams,
  ActivateBugParams,
  UpdateBugParams,
  CreateStoryParams,
  CloseStoryParams,
  UpdateStoryParams,
  ChangeStoryParams,
  ApiResponse,
  TestCase,
  TestCaseListResponse,
  CreateTestCaseParams,
  Task,
  MyTaskPage,
  CreateTaskParams,
  UpdateTaskParams,
  User,
  CreateUserParams,
  UpdateUserParams,
  Program,
  CreateProgramParams,
  UpdateProgramParams,
  Plan,
  CreatePlanParams,
  UpdatePlanParams,
  Release,
  Build,
  CreateBuildParams,
  UpdateBuildParams,
  Execution,
  CreateExecutionParams,
  UpdateExecutionParams,
  CreateProductParams,
  UpdateProductParams,
  CreateProjectParams,
  UpdateProjectParams,
  Doc,
  DocLib,
  DocModule,
  DocSpaceData,
  CreateDocParams,
  EditDocParams,
  CreateDocModuleParams,
  EditDocModuleParams,
} from './types.js';

interface RetryableRequestConfig extends InternalAxiosRequestConfig {
  __zentaoAuthRetried?: boolean;
  __zentaoTransientRetries?: number;
}

interface LegacyTaskPage {
  tasks?: Task[] | Record<string, Task>;
  pager?: {
    recTotal?: number | string;
    recPerPage?: number | string;
    pageTotal?: number | string;
  };
}

interface RestTaskPage {
  page?: number;
  total?: number;
  limit?: number;
  tasks?: unknown;
}

/**
 * 禅道 API 客户端类
 * 提供与禅道系统交互的所有方法
 */
export class ZentaoClient {
  private config: ZentaoConfig;
  private http: AxiosInstance;
  private isLoggedIn: boolean = false;
  private loginPromise?: Promise<boolean>;
  private token: string = '';
  private readonly logger: SafeLogger;
  private readonly requestSignals = new AsyncLocalStorage<AbortSignal>();
  
  // 内置 API 认证相关属性
  private legacySessionID: string = '';
  private isLegacyLoggedIn: boolean = false;
  private legacyLoginPromise?: Promise<void>;
  private legacyCookies: string[] = [];

  /**
   * 创建禅道客户端实例
   * @param config - 禅道配置
   */
  constructor(config: ZentaoConfig) {
    this.config = config;
    this.logger = new SafeLogger([config.url, config.account, config.password]);

    // 规范化 URL
    const baseURL = config.url.endsWith('/') ? config.url.slice(0, -1) : config.url;
    const baseOrigin = new URL(baseURL).origin;

    // 创建 axios 实例配置
    const axiosConfig: Parameters<typeof axios.create>[0] = {
      baseURL,
      timeout: config.timeoutMs ?? 30000,
      maxRedirects: 3,
      beforeRedirect: (options, responseDetails) => {
        const target = new URL(String(options.href));
        if (target.origin !== baseOrigin) {
          throw new Error('拒绝跨源 HTTP 重定向');
        }
        this.storeLegacyCookies(responseDetails.headers['set-cookie']);
        if (this.legacyCookies.length > 0) {
          options.headers.Cookie = this.legacyCookies.join('; ');
        }
      },
      maxContentLength: 10 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      proxy: false,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; zentao-mcp/1.1.0)',
      },
    };

    // 如果配置跳过SSL验证，创建自定义 https agent
    if (config.rejectUnauthorized === false) {
      axiosConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
    }

    this.http = axios.create(axiosConfig);
    this.http.interceptors.request.use((requestConfig) => {
      const signal = this.requestSignals.getStore();
      if (signal && !requestConfig.signal) requestConfig.signal = signal;
      return requestConfig;
    });
    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => this.recoverRequest(error),
    );
  }

  private async recoverRequest(error: AxiosError): Promise<AxiosResponse> {
    const requestConfig = error.config as RetryableRequestConfig | undefined;
    if (!requestConfig) throw error;

    const status = error.response?.status;
    const isTokenRequest = requestConfig.url?.includes('/api.php/v1/tokens') === true;
    if (status === 401 && !isTokenRequest && !requestConfig.__zentaoAuthRetried) {
      requestConfig.__zentaoAuthRetried = true;
      this.isLoggedIn = false;
      this.token = '';
      delete this.http.defaults.headers.common['Token'];
      await this.login();
      requestConfig.headers.set('Token', this.token);
      this.logger.log('info', 'auth_token_refreshed');
      return this.http.request(requestConfig);
    }

    const retryCount = requestConfig.__zentaoTransientRetries ?? 0;
    if (this.shouldRetry(error, requestConfig) && retryCount < (this.config.maxRetries ?? 2)) {
      const nextRetry = retryCount + 1;
      requestConfig.__zentaoTransientRetries = nextRetry;
      const delayMs = this.retryDelayMs(error, nextRetry);
      this.logger.log('warn', 'http_request_retry', {
        attempt: nextRetry,
        status: status ?? null,
        code: error.code ?? null,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.http.request(requestConfig);
    }

    throw error;
  }

  private shouldRetry(error: AxiosError, config: RetryableRequestConfig): boolean {
    if (config.method?.toUpperCase() !== 'GET') return false;
    if (error.code === 'ERR_CANCELED') return false;
    const status = error.response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return !error.response && [
      'ECONNABORTED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
    ].includes(error.code ?? '');
  }

  private retryDelayMs(error: AxiosError, attempt: number): number {
    const retryAfter = error.response?.headers?.['retry-after'];
    if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
      return Math.min(Number(retryAfter) * 1000, 10_000);
    }
    return Math.min(250 * (2 ** (attempt - 1)), 2_000);
  }

  /** 记录不包含连接凭据的请求错误。 */
  private logRequestError(context: string, error: unknown): void {
    const message = redactSensitiveText(
      error instanceof Error ? error.message : '未知错误',
      [
        this.config.url,
        this.config.account,
        this.config.password,
        this.token,
      ],
    );
    this.logger.log('error', 'zentao_request_failed', { context, message });
  }

  private isNotFound(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 404;
  }

  private isForbidden(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 403;
  }

  /** 将 MCP 请求的取消信号安全地传递到当前异步调用链中的 HTTP 请求。 */
  async withAbortSignal<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!signal) return operation();
    return this.requestSignals.run(signal, operation);
  }

  /**
   * 登录禅道系统
   * @returns 是否登录成功
   */
  async login(): Promise<boolean> {
    if (this.isLoggedIn) return true;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.performLogin();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = undefined;
    }
  }

  private async performLogin(): Promise<boolean> {
    try {
      // REST API v1 直接使用账号和原始密码换取 Token。
      // 旧实现先 GET session 再提交 MD5 密码，与禅道 21.x 的 Token 契约不兼容。
      const response = await this.http.post('/api.php/v1/tokens', {
        account: this.config.account,
        password: this.config.password,
      });

      const token = response.data?.token || response.data?.data?.token;
      if (typeof token !== 'string' || !token) {
        throw new Error('Token 接口未返回有效 token');
      }

      this.token = token;
      this.http.defaults.headers.common['Token'] = this.token;
      this.isLoggedIn = true;
      return true;
    } catch (error) {
      const message = redactSensitiveText(
        error instanceof Error ? error.message : '未知错误',
        [this.config.url, this.config.account, this.config.password],
      );
      this.logger.log('error', 'zentao_login_failed', { message });
      throw new Error(`禅道登录失败: ${message}`);
    }
  }

  /**
   * 确保已登录
   */
  private async ensureLogin(): Promise<void> {
    if (!this.isLoggedIn) {
      await this.login();
    }
  }

  // ==================== Bug 相关方法 ====================

  /**
   * 获取 Bug 列表
   * @param productID - 产品 ID
   * @param browseType - 浏览类型: all-全部, unclosed-未关闭, unresolved-未解决, toclosed-待关闭, openedbyme-我创建, assigntome-指派给我
   * @param limit - 返回数量限制
   * @returns Bug 列表
   */
  async getBugs(productID: number, browseType?: string, limit?: number): Promise<Bug[]> {
    await this.ensureLogin();

    const params = new URLSearchParams();
    if (browseType) params.append('status', browseType);
    if (limit) params.append('limit', limit.toString());

    const queryString = params.toString();
    const url = `/api.php/v1/products/${productID}/bugs${queryString ? '?' + queryString : ''}`;
    const response: AxiosResponse<ApiResponse<Bug[]>> = await this.http.get(url);
    return response.data.data || (response.data as unknown as { bugs: Bug[] }).bugs || [];
  }

  /**
   * 获取指派给某人的 Bug
   * @param account - 用户账号
   * @param limit - 返回数量限制
   * @returns Bug 列表
   */
  async getAssignedBugs(account: string, limit: number = 100): Promise<Bug[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Bug[]>> = await this.http.get(
      `/api.php/v1/bugs?assignedTo=${account}&limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { bugs: Bug[] }).bugs || [];
  }

  /**
   * 获取 Bug 详情
   * @param bugID - Bug ID
   * @returns Bug 详情
   */
  async getBug(bugID: number): Promise<Bug | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Bug>> = await this.http.get(
        `/api.php/v1/bugs/${bugID}`
      );
      return response.data.data || (response.data as unknown as Bug);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建 Bug
   * @param params - 创建 Bug 参数
   * @returns 新创建的 Bug
   */
  async createBug(params: CreateBugParams): Promise<Bug> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      title: params.title,
      severity: params.severity,
      pri: params.pri,
      type: params.type,
    };

    // 可选参数，仅在有值时添加
    if (params.branch !== undefined) data.branch = params.branch;
    if (params.module !== undefined) data.module = params.module;
    if (params.execution !== undefined) data.execution = params.execution;
    if (params.keywords !== undefined) data.keywords = params.keywords;
    if (params.os !== undefined) data.os = params.os;
    if (params.browser !== undefined) data.browser = params.browser;
    if (params.steps !== undefined) data.steps = params.steps;
    if (params.task !== undefined) data.task = params.task;
    if (params.story !== undefined) data.story = params.story;
    if (params.deadline !== undefined) data.deadline = params.deadline;
    if (params.openedBuild !== undefined) data.openedBuild = params.openedBuild;
    if (params.assignedTo !== undefined) data.assignedTo = params.assignedTo;
    if (params.project !== undefined) data.project = params.project;

    const response: AxiosResponse<ApiResponse<Bug>> = await this.http.post(
      `/api.php/v1/products/${params.product}/bugs`,
      data
    );

    return response.data.data || (response.data as unknown as Bug);
  }

  /**
   * 解决 Bug
   * @param params - 解决 Bug 参数
   * @returns 操作结果
   */
  async resolveBug(params: ResolveBugParams): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/bugs/${params.id}/resolve`, {
        resolution: params.resolution,
        resolvedBuild: params.resolvedBuild || 'trunk',
        comment: params.comment || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('解决 Bug 失败', error);
      throw error;
    }
  }

  /**
   * 关闭 Bug
   * @param params - 关闭 Bug 参数
   * @returns 操作结果
   */
  async closeBug(params: CloseBugParams): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/bugs/${params.id}/close`, {
        comment: params.comment || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('关闭 Bug 失败', error);
      throw error;
    }
  }

  /**
   * 激活 Bug（重新打开）
   * @param params - 激活 Bug 参数
   * @returns 操作结果
   */
  async activateBug(params: ActivateBugParams): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/bugs/${params.id}/activate`, {
        assignedTo: params.assignedTo || '',
        comment: params.comment || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('激活 Bug 失败', error);
      throw error;
    }
  }

  /**
   * 确认 Bug
   * @param bugID - Bug ID
   * @param assignedTo - 指派给（可选）
   * @returns 操作结果
   */
  async confirmBug(bugID: number, assignedTo?: string): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/bugs/${bugID}/confirm`, {
        assignedTo: assignedTo || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('确认 Bug 失败', error);
      throw error;
    }
  }

  // ==================== 需求相关方法 ====================

  /**
   * 获取需求列表
   * @param productID - 产品 ID
   * @param browseType - 浏览类型: allstory-全部, unclosed-未关闭, draftstory-草稿, activestory-激活, reviewingstory-评审中, closedstory-已关闭, openedbyme-我创建
   * @param limit - 返回数量限制
   * @returns 需求列表
   */
  async getStories(productID: number, browseType?: string, limit?: number): Promise<Story[]> {
    await this.ensureLogin();

    const params = new URLSearchParams();
    if (browseType) params.append('status', browseType);
    if (limit) params.append('limit', limit.toString());

    const queryString = params.toString();
    const url = `/api.php/v1/products/${productID}/stories${queryString ? '?' + queryString : ''}`;
    const response: AxiosResponse<ApiResponse<Story[]>> = await this.http.get(url);
    return response.data.data || (response.data as unknown as { stories: Story[] }).stories || [];
  }

  /**
   * 获取需求详情
   * @param storyID - 需求 ID
   * @returns 需求详情
   */
  async getStory(storyID: number): Promise<Story | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Story>> = await this.http.get(
        `/api.php/v1/stories/${storyID}`
      );
      return response.data.data || (response.data as unknown as Story);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建需求
   * @param params - 创建需求参数
   * @returns 新创建的需求
   */
  async createStory(params: CreateStoryParams): Promise<Story> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      product: params.product,
      title: params.title,
      category: params.category,
      pri: params.pri,
      spec: params.spec,
      reviewer: params.reviewer,
    };
    if (params.verify !== undefined) data.verify = params.verify;
    if (params.estimate !== undefined) data.estimate = params.estimate;
    if (params.module !== undefined) data.module = params.module;
    if (params.plan !== undefined) data.plan = params.plan;
    if (params.source !== undefined) data.source = params.source;
    if (params.sourceNote !== undefined) data.sourceNote = params.sourceNote;
    if (params.keywords !== undefined) data.keywords = params.keywords;

    try {
      const response: AxiosResponse<ApiResponse<Story>> = await this.http.post(
        `/api.php/v1/products/${params.product}/stories`,
        data
      );
      
      // 尝试多种响应格式
      if (response.data.data) {
        return response.data.data;
      }
      if (response.data && typeof response.data === 'object' && 'id' in response.data) {
        return response.data as unknown as Story;
      }
      // 返回完整响应作为调试信息
      return response.data as unknown as Story;
    } catch (error: unknown) {
      this.logRequestError('创建需求失败', error);
      const message = redactSensitiveText(
        error instanceof Error ? error.message : '未知错误',
        [this.config.url, this.config.account, this.config.password],
      );
      throw new Error(`创建需求失败: ${message}`);
    }
  }

  /**
   * 关闭需求
   * @param params - 关闭需求参数
   * @returns 操作结果
   */
  async closeStory(params: CloseStoryParams): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/stories/${params.id}/close`, {
        closedReason: params.closedReason,
        comment: params.comment || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('关闭需求失败', error);
      throw error;
    }
  }

  /**
   * 激活需求
   * @param storyID - 需求 ID
   * @param assignedTo - 指派给（可选）
   * @param comment - 备注（可选）
   * @returns 操作结果
   */
  async activateStory(storyID: number, assignedTo?: string, comment?: string): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/stories/${storyID}/activate`, {
        assignedTo: assignedTo || '',
        comment: comment || '',
      });
      return true;
    } catch (error) {
      this.logRequestError('激活需求失败', error);
      throw error;
    }
  }

  // ==================== 产品和项目相关方法 ====================

  /**
   * 获取产品列表
   * @param limit - 返回数量限制
   * @returns 产品列表
   */
  async getProducts(limit: number = 100): Promise<Product[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Product[]>> = await this.http.get(
      `/api.php/v1/products?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { products: Product[] }).products || [];
  }

  /**
   * 获取项目列表
   * @param limit - 返回数量限制
   * @returns 项目列表
   */
  async getProjects(limit: number = 100): Promise<Project[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Project[]>> = await this.http.get(
      `/api.php/v1/projects?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { projects: Project[] }).projects || [];
  }

  /**
   * 获取执行列表（迭代）
   * @param projectID - 项目 ID
   * @param limit - 返回数量限制
   * @returns 执行列表
   */
  async getExecutions(projectID: number, limit: number = 100): Promise<Project[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Project[]>> = await this.http.get(
      `/api.php/v1/projects/${projectID}/executions?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { executions: Project[] }).executions || [];
  }

  // ==================== 测试用例相关方法 ====================

  /**
   * 获取测试用例列表
   * @param productID - 产品 ID
   * @param limit - 返回数量限制
   * @returns 测试用例列表响应
   */
  async getTestCases(productID: number, limit: number = 100): Promise<TestCaseListResponse> {
    await this.ensureLogin();

    const response: AxiosResponse<TestCaseListResponse> = await this.http.get(
      `/api.php/v1/products/${productID}/testcases?limit=${limit}`
    );
    return response.data;
  }

  /**
   * 获取测试用例详情
   * @param caseID - 用例 ID
   * @returns 测试用例详情
   */
  async getTestCase(caseID: number): Promise<TestCase | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<TestCase> = await this.http.get(
        `/api.php/v1/testcases/${caseID}`
      );
      return response.data;
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建测试用例
   * @param params - 创建测试用例参数
   * @returns 新创建的测试用例
   */
  async createTestCase(params: CreateTestCaseParams): Promise<TestCase> {
    await this.ensureLogin();

    const response: AxiosResponse<TestCase> = await this.http.post(
      `/api.php/v1/products/${params.product}/testcases`,
      {
        title: params.title,
        type: params.type,
        steps: params.steps,
        branch: params.branch || 0,
        module: params.module || 0,
        story: params.story || 0,
        stage: params.stage || '',
        precondition: params.precondition || '',
        pri: params.pri || 3,
        keywords: params.keywords || '',
      }
    );

    return response.data;
  }

  // ==================== Bug 更新相关方法 ====================

  /**
   * 更新 Bug
   * @param params - 更新 Bug 参数
   * @returns 更新后的 Bug
   */
  async updateBug(params: UpdateBugParams): Promise<Bug | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.title !== undefined) updateData.title = params.title;
    if (params.severity !== undefined) updateData.severity = params.severity;
    if (params.pri !== undefined) updateData.pri = params.pri;
    if (params.type !== undefined) updateData.type = params.type;
    if (params.module !== undefined) updateData.module = params.module;
    if (params.execution !== undefined) updateData.execution = params.execution;
    if (params.keywords !== undefined) updateData.keywords = params.keywords;
    if (params.os !== undefined) updateData.os = params.os;
    if (params.browser !== undefined) updateData.browser = params.browser;
    if (params.steps !== undefined) updateData.steps = params.steps;
    if (params.task !== undefined) updateData.task = params.task;
    if (params.story !== undefined) updateData.story = params.story;
    if (params.deadline !== undefined) updateData.deadline = params.deadline;
    if (params.openedBuild !== undefined) updateData.openedBuild = params.openedBuild;

    try {
      const response: AxiosResponse<ApiResponse<Bug>> = await this.http.put(
        `/api.php/v1/bugs/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Bug);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 需求更新/变更相关方法 ====================

  /**
   * 更新需求
   * @param params - 更新需求参数
   * @returns 更新后的需求
   */
  async updateStory(params: UpdateStoryParams): Promise<Story | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.module !== undefined) updateData.module = params.module;
    if (params.source !== undefined) updateData.source = params.source;
    if (params.sourceNote !== undefined) updateData.sourceNote = params.sourceNote;
    if (params.pri !== undefined) updateData.pri = params.pri;
    if (params.category !== undefined) updateData.category = params.category;
    if (params.estimate !== undefined) updateData.estimate = params.estimate;
    if (params.keywords !== undefined) updateData.keywords = params.keywords;

    try {
      const response: AxiosResponse<ApiResponse<Story>> = await this.http.put(
        `/api.php/v1/stories/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Story);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 变更需求（修改标题、描述、验收标准，会导致状态变为 changed）
   * @param params - 变更需求参数
   * @returns 变更后的需求
   */
  async changeStory(params: ChangeStoryParams): Promise<Story | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.title !== undefined) updateData.title = params.title;
    if (params.spec !== undefined) updateData.spec = params.spec;
    if (params.verify !== undefined) updateData.verify = params.verify;

    try {
      const response: AxiosResponse<ApiResponse<Story>> = await this.http.post(
        `/api.php/v1/stories/${params.id}/change`,
        updateData
      );
      return response.data.data || (response.data as unknown as Story);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 产品详情/创建/更新相关方法 ====================

  /**
   * 获取产品详情
   * @param productID - 产品 ID
   * @returns 产品详情
   */
  async getProduct(productID: number): Promise<Product | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Product>> = await this.http.get(
        `/api.php/v1/products/${productID}`
      );
      return response.data.data || (response.data as unknown as Product);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建产品
   * @param params - 创建产品参数
   * @returns 新创建的产品
   */
  async createProduct(params: CreateProductParams): Promise<Product> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      name: params.name,
      code: params.code,
    };
    if (params.program !== undefined) data.program = params.program;
    if (params.line !== undefined) data.line = params.line;
    if (params.PO !== undefined) data.PO = params.PO;
    if (params.QD !== undefined) data.QD = params.QD;
    if (params.RD !== undefined) data.RD = params.RD;
    if (params.type !== undefined) data.type = params.type;
    if (params.desc !== undefined) data.desc = params.desc;
    if (params.acl !== undefined) data.acl = params.acl;
    if (params.whitelist !== undefined) data.whitelist = params.whitelist;

    const response: AxiosResponse<ApiResponse<Product>> = await this.http.post(
      '/api.php/v1/products',
      data
    );
    return response.data.data || (response.data as unknown as Product);
  }

  /**
   * 更新产品
   * @param params - 更新产品参数
   * @returns 更新后的产品
   */
  async updateProduct(params: UpdateProductParams): Promise<Product | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.code !== undefined) updateData.code = params.code;
    if (params.program !== undefined) updateData.program = params.program;
    if (params.line !== undefined) updateData.line = params.line;
    if (params.type !== undefined) updateData.type = params.type;
    if (params.status !== undefined) updateData.status = params.status;
    if (params.desc !== undefined) updateData.desc = params.desc;
    if (params.PO !== undefined) updateData.PO = params.PO;
    if (params.QD !== undefined) updateData.QD = params.QD;
    if (params.RD !== undefined) updateData.RD = params.RD;
    if (params.acl !== undefined) updateData.acl = params.acl;
    if (params.whitelist !== undefined) updateData.whitelist = params.whitelist;

    try {
      const response: AxiosResponse<ApiResponse<Product>> = await this.http.put(
        `/api.php/v1/products/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Product);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 项目详情/创建/更新相关方法 ====================

  /**
   * 获取项目详情
   * @param projectID - 项目 ID
   * @returns 项目详情
   */
  async getProject(projectID: number): Promise<Project | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Project>> = await this.http.get(
        `/api.php/v1/projects/${projectID}`
      );
      return response.data.data || (response.data as unknown as Project);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      if (this.isForbidden(error)) {
        throw new Error(`项目 #${projectID} 无权查看（禅道返回 HTTP 403）`);
      }
      throw error;
    }
  }

  /**
   * 创建项目
   * @param params - 创建项目参数
   * @returns 新创建的项目
   */
  async createProject(params: CreateProjectParams): Promise<Project> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Project>> = await this.http.post(
      '/api.php/v1/projects',
      {
        name: params.name,
        code: params.code,
        begin: params.begin,
        end: params.end,
        products: params.products,
        model: params.model || 'scrum',
        parent: params.parent || 0,
      }
    );
    return response.data.data || (response.data as unknown as Project);
  }

  /**
   * 更新项目
   * @param params - 更新项目参数
   * @returns 更新后的项目
   */
  async updateProject(params: UpdateProjectParams): Promise<Project | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.code !== undefined) updateData.code = params.code;
    if (params.parent !== undefined) updateData.parent = params.parent;
    if (params.PM !== undefined) updateData.PM = params.PM;
    if (params.budget !== undefined) updateData.budget = params.budget;
    if (params.budgetUnit !== undefined) updateData.budgetUnit = params.budgetUnit;
    if (params.days !== undefined) updateData.days = params.days;
    if (params.desc !== undefined) updateData.desc = params.desc;
    if (params.acl !== undefined) updateData.acl = params.acl;
    if (params.whitelist !== undefined) updateData.whitelist = params.whitelist;
    if (params.auth !== undefined) updateData.auth = params.auth;

    try {
      const response: AxiosResponse<ApiResponse<Project>> = await this.http.put(
        `/api.php/v1/projects/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Project);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 任务相关方法 ====================

  /**
   * 获取执行的任务列表
   * @param executionID - 执行 ID
   * @param limit - 返回数量限制
   * @returns 任务列表
   */
  async getTasks(executionID: number, limit: number = 100): Promise<Task[]> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<unknown> = await this.http.get(
        `/api.php/v1/executions/${executionID}/tasks?limit=${limit}`
      );
      const tasks = this.extractTaskList(response.data);
      if (
        tasks
        && tasks.every((task) => {
          const taskExecutionID = this.getTaskExecutionID(task);
          return taskExecutionID === 0 || taskExecutionID === executionID;
        })
      ) {
        return tasks.slice(0, limit);
      }
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status !== 400 && status !== 403 && status !== 404) throw error;
    }

    return this.getTasksBySearch(executionID, limit);
  }

  /**
   * 禅道 21.7.x 在 Token 会话下可能把执行任务路由重定向到“添加执行”页。
   * 此时使用同版本官方 tasks 搜索接口分页读取，再按 execution ID 过滤。
   */
  private async getTasksBySearch(executionID: number, limit: number): Promise<Task[]> {
    const configuredPageSize = this.config.maxPageSize ?? 100;
    const pageSize = Math.min(
      configuredPageSize,
      Math.max(Math.min(100, configuredPageSize), limit * 20),
    );
    const maxPages = 20;
    const matches: Task[] = [];
    let total = Number.POSITIVE_INFINITY;
    let scannedAll = false;

    for (let page = 1; page <= maxPages && matches.length < limit; page += 1) {
      const response: AxiosResponse<RestTaskPage> = await this.http.get(
        `/api.php/v1/tasks?search=1&limit=${pageSize}&page=${page}&order=id_desc`,
      );
      const tasks = this.extractTaskList(response.data);
      if (!tasks) {
        throw new Error(`执行 #${executionID} 的任务搜索接口返回了非任务列表`);
      }

      const responseTotal = Number(response.data.total);
      if (Number.isFinite(responseTotal) && responseTotal >= 0) total = responseTotal;
      for (const task of tasks) {
        if (this.getTaskExecutionID(task) === executionID) matches.push(task);
        if (matches.length >= limit) break;
      }

      const scanned = page * pageSize;
      if (tasks.length < pageSize || scanned >= total) {
        scannedAll = true;
        break;
      }
    }

    if (!scannedAll && matches.length === 0) {
      throw new Error(
        `执行 #${executionID} 的嵌套任务接口不可用，且只读任务搜索在扫描上限内未找到任务`,
      );
    }
    return matches.slice(0, limit);
  }

  private extractTaskList(payload: unknown): Task[] | null {
    let candidate: unknown = payload;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const object = candidate as Record<string, unknown>;
      if ('tasks' in object) {
        candidate = object.tasks;
      } else if (
        'data' in object
        && object.data
        && typeof object.data === 'object'
      ) {
        return this.extractTaskList(object.data);
      }
    }

    if (!Array.isArray(candidate)) return null;
    if (!candidate.every((task) => (
      task
      && typeof task === 'object'
      && Number.isFinite(Number((task as { id?: unknown }).id))
      && typeof (task as { name?: unknown }).name === 'string'
    ))) {
      return null;
    }
    return candidate as Task[];
  }

  private getTaskExecutionID(task: Task): number {
    const execution = task.execution as number | { id?: number };
    return Number(
      execution && typeof execution === 'object'
        ? execution.id ?? 0
        : execution ?? 0,
    );
  }

  /**
   * 获取当前用户的任务列表，兼容禅道 21.x my-work 页面 JSON 接口。
   * @param browseType - assignedTo-指派给我，finishedBy-由我完成，closedBy-由我关闭
   * @param limit - 返回数量限制
   */
  async getMyTasks(
    browseType: 'assignedTo' | 'finishedBy' | 'closedBy' = 'assignedTo',
    limit: number = 100,
  ): Promise<Task[]> {
    const result = await this.getMyTasksPage(browseType, 1, limit);
    return result.tasks;
  }

  /**
   * 分页获取当前用户的任务。对外分页独立于禅道 Web 页大小，调用方可安全遍历全部结果。
   * @param browseType - assignedTo-指派给我，finishedBy-由我完成，closedBy-由我关闭
   * @param page - 从 1 开始的页码
   * @param limit - 每页返回数量
   */
  async getMyTasksPage(
    browseType: 'assignedTo' | 'finishedBy' | 'closedBy' = 'assignedTo',
    page: number = 1,
    limit: number = 50,
  ): Promise<MyTaskPage> {
    if (!Number.isInteger(page) || page < 1) throw new Error('page 必须是大于等于 1 的整数');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit 必须是大于等于 1 的整数');

    const first = await this.legacyGet<LegacyTaskPage>(
      `/my-work-task-${browseType}.json`,
    );
    const firstTasks = this.normalizeLegacyTasks(first.tasks);
    const rawTotal = Number(first.pager?.recTotal ?? firstTasks.length);
    const rawPageSize = Number(first.pager?.recPerPage ?? (firstTasks.length || 20));
    const rawPageTotal = Number(first.pager?.pageTotal ?? 1);
    const recTotal = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : firstTasks.length;
    const recPerPage = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? rawPageSize : (firstTasks.length || 20);
    const pageTotal = Number.isFinite(rawPageTotal) && rawPageTotal >= 1 ? rawPageTotal : 1;

    const offset = (page - 1) * limit;
    if (offset >= recTotal) {
      return { page, limit, total: recTotal, hasMore: false, tasks: [] };
    }

    const firstSourcePage = Math.floor(offset / recPerPage) + 1;
    const lastSourcePage = Math.min(
      pageTotal,
      Math.ceil(Math.min(recTotal, offset + limit) / recPerPage),
    );
    const collected: Task[] = [];
    for (let pageID = firstSourcePage; pageID <= lastSourcePage; pageID += 1) {
      if (pageID === 1) {
        collected.push(...firstTasks);
        continue;
      }
      const sourcePage = await this.legacyGet<LegacyTaskPage>(
        `/my-work-task-${browseType}--id_desc-${recTotal}-${recPerPage}-${pageID}.json`,
      );
      const sourceTasks = this.normalizeLegacyTasks(sourcePage.tasks);
      if (sourceTasks.length === 0) break;
      collected.push(...sourceTasks);
    }
    const withinCollected = offset - (firstSourcePage - 1) * recPerPage;
    const tasks = collected.slice(withinCollected, withinCollected + limit);
    if (tasks.length === 0 && offset < recTotal) {
      throw new Error(
        `禅道任务分页元数据不一致（page=${page}, limit=${limit}, total=${recTotal}）`,
      );
    }
    return {
      page,
      limit,
      total: recTotal,
      hasMore: offset + tasks.length < recTotal,
      tasks,
    };
  }

  private normalizeLegacyTasks(value: LegacyTaskPage['tasks']): Task[] {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value)
      .filter(([, task]) => task && typeof task === 'object')
      .map(([key, task]) => (
        task.id === undefined && /^\d+$/.test(key)
          ? { ...task, id: Number(key) }
          : task
      ));
  }

  /**
   * 获取任务详情
   * @param taskID - 任务 ID
   * @returns 任务详情
   */
  async getTask(taskID: number): Promise<Task | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Task>> = await this.http.get(
        `/api.php/v1/tasks/${taskID}`
      );
      return response.data.data || (response.data as unknown as Task);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建任务
   * @param params - 创建任务参数
   * @returns 新创建的任务
   */
  async createTask(params: CreateTaskParams): Promise<Task> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      name: params.name,
      type: params.type,
      assignedTo: params.assignedTo,
      estStarted: params.estStarted,
      deadline: params.deadline,
    };
    if (params.module !== undefined) data.module = params.module;
    if (params.story !== undefined) data.story = params.story;
    if (params.fromBug !== undefined) data.fromBug = params.fromBug;
    if (params.pri !== undefined) data.pri = params.pri;
    if (params.estimate !== undefined) data.estimate = params.estimate;
    if (params.desc !== undefined) data.desc = params.desc;

    const response: AxiosResponse<ApiResponse<Task>> = await this.http.post(
      `/api.php/v1/executions/${params.execution}/tasks`,
      data
    );
    return response.data.data || (response.data as unknown as Task);
  }

  /**
   * 更新任务
   * @param params - 更新任务参数
   * @returns 更新后的任务
   */
  async updateTask(params: UpdateTaskParams): Promise<Task | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.type !== undefined) updateData.type = params.type;
    if (params.assignedTo !== undefined) updateData.assignedTo = params.assignedTo;
    if (params.module !== undefined) updateData.module = params.module;
    if (params.story !== undefined) updateData.story = params.story;
    if (params.fromBug !== undefined) updateData.fromBug = params.fromBug;
    if (params.pri !== undefined) updateData.pri = params.pri;
    if (params.estimate !== undefined) updateData.estimate = params.estimate;
    if (params.estStarted !== undefined) updateData.estStarted = params.estStarted;
    if (params.deadline !== undefined) updateData.deadline = params.deadline;
    if (params.desc !== undefined) updateData.desc = params.desc;

    try {
      const response: AxiosResponse<ApiResponse<Task>> = await this.http.put(
        `/api.php/v1/tasks/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Task);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 用户相关方法 ====================

  /**
   * 获取用户列表
   * @param limit - 返回数量限制
   * @returns 用户列表
   */
  async getUsers(limit: number = 100): Promise<User[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<User[]>> = await this.http.get(
      `/api.php/v1/users?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { users: User[] }).users || [];
  }

  /**
   * 获取用户详情
   * @param userID - 用户 ID
   * @returns 用户详情
   */
  async getUser(userID: number): Promise<User | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<User>> = await this.http.get(
        `/api.php/v1/users/${userID}`
      );
      return response.data.data || (response.data as unknown as User);
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 获取当前登录用户信息
   * @returns 当前用户信息
   */
  async getMyProfile(): Promise<User | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<{ profile: User }>> = await this.http.get(
        '/api.php/v1/user'
      );
      return response.data.data?.profile || (response.data as unknown as { profile: User }).profile || null;
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建用户
   * @param params - 创建用户参数
   * @returns 新创建的用户
   */
  async createUser(params: CreateUserParams): Promise<User> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      account: params.account,
      password: params.password,
      gender: params.gender || 'm',
    };
    if (params.realname !== undefined) data.realname = params.realname;
    if (params.visions !== undefined) data.visions = params.visions;
    if (params.role !== undefined) data.role = params.role;
    if (params.dept !== undefined) data.dept = params.dept;
    if (params.email !== undefined) data.email = params.email;
    if (params.mobile !== undefined) data.mobile = params.mobile;
    if (params.phone !== undefined) data.phone = params.phone;
    if (params.weixin !== undefined) data.weixin = params.weixin;
    if (params.qq !== undefined) data.qq = params.qq;
    if (params.address !== undefined) data.address = params.address;
    if (params.join !== undefined) data.join = params.join;

    const response: AxiosResponse<ApiResponse<User>> = await this.http.post(
      '/api.php/v1/users',
      data
    );
    return response.data.data || (response.data as unknown as User);
  }

  /**
   * 更新用户
   * @param params - 更新用户参数
   * @returns 更新后的用户
   */
  async updateUser(params: UpdateUserParams): Promise<User | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.realname !== undefined) updateData.realname = params.realname;
    if (params.role !== undefined) updateData.role = params.role;
    if (params.dept !== undefined) updateData.dept = params.dept;
    if (params.email !== undefined) updateData.email = params.email;
    if (params.gender !== undefined) updateData.gender = params.gender;
    if (params.mobile !== undefined) updateData.mobile = params.mobile;
    if (params.phone !== undefined) updateData.phone = params.phone;
    if (params.weixin !== undefined) updateData.weixin = params.weixin;
    if (params.qq !== undefined) updateData.qq = params.qq;
    if (params.address !== undefined) updateData.address = params.address;
    if (params.join !== undefined) updateData.join = params.join;
    if (params.password !== undefined) updateData.password = params.password;

    try {
      const response: AxiosResponse<ApiResponse<User>> = await this.http.put(
        `/api.php/v1/users/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as User);
    } catch {
      return null;
    }
  }

  // ==================== 项目集相关方法 ====================

  /**
   * 获取项目集列表
   * @param limit - 返回数量限制
   * @returns 项目集列表
   */
  async getPrograms(limit: number = 100): Promise<Program[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Program[]>> = await this.http.get(
      `/api.php/v1/programs?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { programs: Program[] }).programs || [];
  }

  /**
   * 获取项目集详情
   * @param programID - 项目集 ID
   * @returns 项目集详情
   */
  async getProgram(programID: number): Promise<Program | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Program>> = await this.http.get(
        `/api.php/v1/programs/${programID}`
      );
      return response.data.data || (response.data as unknown as Program);
    } catch {
      return null;
    }
  }

  /**
   * 创建项目集
   * @param params - 创建项目集参数
   * @returns 新创建的项目集
   */
  async createProgram(params: CreateProgramParams): Promise<Program> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      name: params.name,
      begin: params.begin,
      end: params.end,
      parent: params.parent || 0,
    };
    if (params.PM !== undefined) data.PM = params.PM;
    if (params.budget !== undefined) data.budget = params.budget;
    if (params.budgetUnit !== undefined) data.budgetUnit = params.budgetUnit;
    if (params.desc !== undefined) data.desc = params.desc;
    if (params.acl !== undefined) data.acl = params.acl;
    if (params.whitelist !== undefined) data.whitelist = params.whitelist;

    const response: AxiosResponse<ApiResponse<Program>> = await this.http.post(
      '/api.php/v1/programs',
      data
    );
    return response.data.data || (response.data as unknown as Program);
  }

  /**
   * 更新项目集
   * @param params - 更新项目集参数
   * @returns 更新后的项目集
   */
  async updateProgram(params: UpdateProgramParams): Promise<Program | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.parent !== undefined) updateData.parent = params.parent;
    if (params.PM !== undefined) updateData.PM = params.PM;
    if (params.budget !== undefined) updateData.budget = params.budget;
    if (params.budgetUnit !== undefined) updateData.budgetUnit = params.budgetUnit;
    if (params.desc !== undefined) updateData.desc = params.desc;
    if (params.begin !== undefined) updateData.begin = params.begin;
    if (params.end !== undefined) updateData.end = params.end;
    if (params.acl !== undefined) updateData.acl = params.acl;
    if (params.whitelist !== undefined) updateData.whitelist = params.whitelist;

    try {
      const response: AxiosResponse<ApiResponse<Program>> = await this.http.put(
        `/api.php/v1/programs/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Program);
    } catch {
      return null;
    }
  }

  // ==================== 计划相关方法 ====================

  /**
   * 获取产品计划列表
   * @param productID - 产品 ID
   * @param limit - 返回数量限制
   * @returns 计划列表
   */
  async getPlans(productID: number, limit: number = 100): Promise<Plan[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Plan[]>> = await this.http.get(
      `/api.php/v1/products/${productID}/plans?limit=${limit}`
    );
    return response.data.data || (response.data as unknown as { plans: Plan[] }).plans || [];
  }

  /**
   * 获取计划详情
   * @param planID - 计划 ID
   * @returns 计划详情
   */
  async getPlan(planID: number): Promise<Plan | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Plan>> = await this.http.get(
        `/api.php/v1/productplans/${planID}`
      );
      return response.data.data || (response.data as unknown as Plan);
    } catch {
      return null;
    }
  }

  /**
   * 创建计划
   * @param params - 创建计划参数
   * @returns 新创建的计划
   */
  async createPlan(params: CreatePlanParams): Promise<Plan> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      title: params.title,
    };
    if (params.begin !== undefined) data.begin = params.begin;
    if (params.end !== undefined) data.end = params.end;
    if (params.branch !== undefined) data.branch = params.branch;
    if (params.parent !== undefined) data.parent = params.parent;
    if (params.desc !== undefined) data.desc = params.desc;

    const response: AxiosResponse<ApiResponse<Plan>> = await this.http.post(
      `/api.php/v1/products/${params.product}/plans`,
      data
    );
    return response.data.data || (response.data as unknown as Plan);
  }

  /**
   * 更新计划
   * @param params - 更新计划参数
   * @returns 更新后的计划
   */
  async updatePlan(params: UpdatePlanParams): Promise<Plan | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.title !== undefined) updateData.title = params.title;
    if (params.begin !== undefined) updateData.begin = params.begin;
    if (params.end !== undefined) updateData.end = params.end;
    if (params.branch !== undefined) updateData.branch = params.branch;
    if (params.desc !== undefined) updateData.desc = params.desc;

    try {
      const response: AxiosResponse<ApiResponse<Plan>> = await this.http.put(
        `/api.php/v1/productplans/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Plan);
    } catch {
      return null;
    }
  }

  /**
   * 计划关联需求
   * @param planID - 计划 ID
   * @param stories - 需求 ID 列表
   * @returns 是否成功
   */
  async linkStoriesToPlan(planID: number, stories: number[]): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/productplans/${planID}/linkstories`, { stories });
      return true;
    } catch (error) {
      this.logRequestError('计划关联需求失败', error);
      return false;
    }
  }

  /**
   * 计划取消关联需求
   * @param planID - 计划 ID
   * @param stories - 需求 ID 列表
   * @returns 是否成功
   */
  async unlinkStoriesFromPlan(planID: number, stories: number[]): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/productplans/${planID}/unlinkstories`, { stories });
      return true;
    } catch (error) {
      this.logRequestError('计划取消关联需求失败', error);
      return false;
    }
  }

  /**
   * 计划关联 Bug
   * @param planID - 计划 ID
   * @param bugs - Bug ID 列表
   * @returns 是否成功
   */
  async linkBugsToPlan(planID: number, bugs: number[]): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/productplans/${planID}/linkbugs`, { bugs });
      return true;
    } catch (error) {
      this.logRequestError('计划关联 Bug 失败', error);
      return false;
    }
  }

  /**
   * 计划取消关联 Bug
   * @param planID - 计划 ID
   * @param bugs - Bug ID 列表
   * @returns 是否成功
   */
  async unlinkBugsFromPlan(planID: number, bugs: number[]): Promise<boolean> {
    await this.ensureLogin();

    try {
      await this.http.post(`/api.php/v1/productplans/${planID}/unlinkbugs`, { bugs });
      return true;
    } catch (error) {
      this.logRequestError('计划取消关联 Bug 失败', error);
      return false;
    }
  }

  // ==================== 发布相关方法 ====================

  /**
   * 获取项目发布列表
   * @param projectID - 项目 ID
   * @returns 发布列表
   */
  async getProjectReleases(projectID: number): Promise<Release[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Release[]>> = await this.http.get(
      `/api.php/v1/projects/${projectID}/releases`
    );
    return response.data.data || (response.data as unknown as { releases: Release[] }).releases || [];
  }

  /**
   * 获取产品发布列表
   * @param productID - 产品 ID
   * @returns 发布列表
   */
  async getProductReleases(productID: number): Promise<Release[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Release[]>> = await this.http.get(
      `/api.php/v1/products/${productID}/releases`
    );
    return response.data.data || (response.data as unknown as { releases: Release[] }).releases || [];
  }

  // ==================== 版本相关方法 ====================

  /**
   * 获取项目版本列表
   * @param projectID - 项目 ID
   * @returns 版本列表
   */
  async getProjectBuilds(projectID: number): Promise<Build[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Build[]>> = await this.http.get(
      `/api.php/v1/projects/${projectID}/builds`
    );
    return response.data.data || (response.data as unknown as { builds: Build[] }).builds || [];
  }

  /**
   * 获取执行版本列表
   * @param executionID - 执行 ID
   * @returns 版本列表
   */
  async getExecutionBuilds(executionID: number): Promise<Build[]> {
    await this.ensureLogin();

    const response: AxiosResponse<ApiResponse<Build[]>> = await this.http.get(
      `/api.php/v1/executions/${executionID}/builds`
    );
    return response.data.data || (response.data as unknown as { builds: Build[] }).builds || [];
  }

  /**
   * 获取版本详情
   * @param buildID - 版本 ID
   * @returns 版本详情
   */
  async getBuild(buildID: number): Promise<Build | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Build>> = await this.http.get(
        `/api.php/v1/builds/${buildID}`
      );
      return response.data.data || (response.data as unknown as Build);
    } catch {
      return null;
    }
  }

  /**
   * 创建版本
   * @param params - 创建版本参数
   * @returns 新创建的版本
   */
  async createBuild(params: CreateBuildParams): Promise<Build> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      name: params.name,
      execution: params.execution,
      product: params.product,
      builder: params.builder,
    };
    if (params.branch !== undefined) data.branch = params.branch;
    if (params.date !== undefined) data.date = params.date;
    if (params.scmPath !== undefined) data.scmPath = params.scmPath;
    if (params.filePath !== undefined) data.filePath = params.filePath;
    if (params.desc !== undefined) data.desc = params.desc;

    const response: AxiosResponse<ApiResponse<Build>> = await this.http.post(
      `/api.php/v1/projects/${params.project}/builds`,
      data
    );
    return response.data.data || (response.data as unknown as Build);
  }

  /**
   * 更新版本
   * @param params - 更新版本参数
   * @returns 更新后的版本
   */
  async updateBuild(params: UpdateBuildParams): Promise<Build | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.scmPath !== undefined) updateData.scmPath = params.scmPath;
    if (params.filePath !== undefined) updateData.filePath = params.filePath;
    if (params.desc !== undefined) updateData.desc = params.desc;
    if (params.builder !== undefined) updateData.builder = params.builder;
    if (params.date !== undefined) updateData.date = params.date;

    try {
      const response: AxiosResponse<ApiResponse<Build>> = await this.http.put(
        `/api.php/v1/builds/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Build);
    } catch {
      return null;
    }
  }

  // ==================== 执行（迭代）相关方法 ====================

  /**
   * 获取执行详情
   * @param executionID - 执行 ID
   * @returns 执行详情
   */
  async getExecution(executionID: number): Promise<Execution | null> {
    await this.ensureLogin();

    try {
      const response: AxiosResponse<ApiResponse<Execution>> = await this.http.get(
        `/api.php/v1/executions/${executionID}`
      );
      return response.data.data || (response.data as unknown as Execution);
    } catch {
      return null;
    }
  }

  /**
   * 创建执行
   * @param params - 创建执行参数
   * @returns 新创建的执行
   */
  async createExecution(params: CreateExecutionParams): Promise<Execution> {
    await this.ensureLogin();

    const data: Record<string, unknown> = {
      name: params.name,
      code: params.code,
      begin: params.begin,
      end: params.end,
    };
    if (params.days !== undefined) data.days = params.days;
    if (params.lifetime !== undefined) data.lifetime = params.lifetime;
    if (params.PO !== undefined) data.PO = params.PO;
    if (params.PM !== undefined) data.PM = params.PM;
    if (params.QD !== undefined) data.QD = params.QD;
    if (params.RD !== undefined) data.RD = params.RD;
    if (params.teamMembers !== undefined) data.teamMembers = params.teamMembers;
    if (params.desc !== undefined) data.desc = params.desc;
    if (params.acl !== undefined) data.acl = params.acl;
    if (params.whitelist !== undefined) data.whitelist = params.whitelist;

    const response: AxiosResponse<ApiResponse<Execution>> = await this.http.post(
      `/api.php/v1/projects/${params.project}/executions`,
      data
    );
    return response.data.data || (response.data as unknown as Execution);
  }

  /**
   * 更新执行
   * @param params - 更新执行参数
   * @returns 更新后的执行
   */
  async updateExecution(params: UpdateExecutionParams): Promise<Execution | null> {
    await this.ensureLogin();

    const updateData: Record<string, unknown> = {};
    if (params.name !== undefined) updateData.name = params.name;
    if (params.code !== undefined) updateData.code = params.code;
    if (params.begin !== undefined) updateData.begin = params.begin;
    if (params.end !== undefined) updateData.end = params.end;
    if (params.days !== undefined) updateData.days = params.days;
    if (params.lifetime !== undefined) updateData.lifetime = params.lifetime;
    if (params.PO !== undefined) updateData.PO = params.PO;
    if (params.PM !== undefined) updateData.PM = params.PM;
    if (params.QD !== undefined) updateData.QD = params.QD;
    if (params.RD !== undefined) updateData.RD = params.RD;
    if (params.teamMembers !== undefined) updateData.teamMembers = params.teamMembers;
    if (params.desc !== undefined) updateData.desc = params.desc;
    if (params.acl !== undefined) updateData.acl = params.acl;
    if (params.whitelist !== undefined) updateData.whitelist = params.whitelist;

    try {
      const response: AxiosResponse<ApiResponse<Execution>> = await this.http.put(
        `/api.php/v1/executions/${params.id}`,
        updateData
      );
      return response.data.data || (response.data as unknown as Execution);
    } catch {
      return null;
    }
  }

  // ==================== 内置 API 认证方法 ====================

  /**
   * 确保内置 API 已登录
   * 禅道 21.x Web JSON 使用表单登录并通过 Cookie 维持会话。
   */
  private async ensureLegacyLogin(): Promise<void> {
    if (this.isLegacyLoggedIn) return;
    if (this.legacyLoginPromise) return this.legacyLoginPromise;
    this.legacyLoginPromise = this.performLegacyLogin();
    try {
      await this.legacyLoginPromise;
    } finally {
      this.legacyLoginPromise = undefined;
    }
  }

  private async performLegacyLogin(): Promise<void> {
    try {
      const loginPageResp = await this.http.get('/user-login.json', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      this.handleLegacyCookies(loginPageResp);
      const loginPage = this.unwrapLegacyPayload<{ rand?: string | number }>(
        loginPageResp.data,
      );
      let verifyRand = String(loginPage.rand ?? '');
      try {
        const refreshRandResp = await this.http.get('/user-refreshRandom.json', {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': this.legacyCookies.join('; '),
          },
        });
        this.handleLegacyCookies(refreshRandResp);
        const refreshedRand = String(refreshRandResp.data ?? '').trim();
        if (/^\d+$/.test(refreshedRand)) verifyRand = refreshedRand;
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
      }
      const password = verifyRand
        ? this.md5(`${this.md5(this.config.password)}${verifyRand}`)
        : this.config.password;

      const loginResp = await this.http.post(
        '/user-login.json',
        new URLSearchParams({
          account: this.config.account,
          password,
          passwordStrength: '3',
          referer: '/my/',
          verifyRand,
          keepLogin: '1',
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': this.legacyCookies.join('; '),
          },
        }
      );
      this.handleLegacyCookies(loginResp);
      const loginData = (
        typeof loginResp.data === 'string'
          ? JSON.parse(loginResp.data)
          : loginResp.data
      ) as Record<string, unknown>;
      let nestedLoginData: unknown = loginData.data;
      if (typeof nestedLoginData === 'string') {
        try {
          nestedLoginData = JSON.parse(nestedLoginData);
        } catch {
          nestedLoginData = undefined;
        }
      }
      const returnedLoginPage = Boolean(
        nestedLoginData
        && typeof nestedLoginData === 'object'
        && 'rand' in nestedLoginData,
      );
      const loginSucceeded = (
        !returnedLoginPage
        && (
          loginData.result === 'success'
          || loginData.status === 'success'
          || Boolean(loginData.user)
          || Boolean(loginData.userID)
        )
      );
      if (!loginSucceeded) {
        const status = typeof loginData.status === 'string' ? loginData.status : 'missing';
        const result = typeof loginData.result === 'string' ? loginData.result : 'missing';
        const responseUrl = (
          loginResp.request as { res?: { responseUrl?: string } } | undefined
        )?.res?.responseUrl;
        const finalPath = responseUrl ? new URL(responseUrl).pathname : 'unknown';
        throw new Error(
          `内置 API 拒绝登录（status=${status}, result=${result}, path=${finalPath}）`,
        );
      }

      this.isLegacyLoggedIn = true;
    } catch (error) {
      this.logRequestError('内置 API 登录失败', error);
      const message = redactSensitiveText(
        error instanceof Error ? error.message : '未知错误',
        [this.config.url, this.config.account, this.config.password],
      );
      throw new Error(`内置 API 登录失败: ${message}`);
    }
  }

  private md5(value: string): string {
    return createHash('md5').update(value, 'utf8').digest('hex');
  }

  /**
   * 处理内置 API 响应中的 cookies
   */
  private handleLegacyCookies(response: AxiosResponse): void {
    this.storeLegacyCookies(response.headers['set-cookie']);
  }

  private storeLegacyCookies(header: string | string[] | undefined): void {
    if (!header) return;
    const setCookies = Array.isArray(header)
      ? header
      : header.split(/,(?=[^;,]+=)/);
    for (const cookie of setCookies) {
      const name = cookie.split('=')[0]?.trim();
      const value = cookie.split(';')[0]?.trim();
      if (!name || !value) continue;
      const index = this.legacyCookies.findIndex((item) => item.startsWith(`${name}=`));
      if (index >= 0) {
        this.legacyCookies[index] = value;
      } else {
        this.legacyCookies.push(value);
      }
    }
  }

  /**
   * 内置 API GET 请求
   * @param path - 请求路径
   * @returns 响应数据
   */
  private async legacyGet<T = unknown>(path: string): Promise<T> {
    await this.ensureLegacyLogin();
    const response = await this.http.get(
      this.withLegacySession(path),
      {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': this.legacyCookies.join('; '),
        },
      }
    );
    this.handleLegacyCookies(response);
    return this.unwrapLegacyPayload<T>(response.data);
  }

  /** 解包禅道 Web JSON 常见的 data 字符串/对象包装。 */
  private unwrapLegacyPayload<T>(payload: unknown): T {
    if (typeof payload === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new Error(
          '内置 API 返回了非 JSON 响应（可能是登录失效、权限不足或接口路由不兼容）',
        );
      }
      return this.unwrapLegacyPayload<T>(parsed);
    }
    if (payload && typeof payload === 'object') {
      const object = payload as {
        data?: unknown;
        result?: unknown;
        status?: unknown;
        message?: unknown;
        load?: unknown;
      };
      if (object.result === false || object.result === 'fail' || object.status === 'fail') {
        const message = typeof object.message === 'string'
          ? object.message
          : '请求失败';
        const suffix = object.load === 'login' ? '（会话已失效）' : '';
        throw new Error(`内置 API ${message}${suffix}`);
      }
      if (!('data' in object)) return payload as T;

      const data = object.data;
      if (typeof data === 'string') {
        return this.unwrapLegacyPayload<T>(data);
      }
      if (data && typeof data === 'object') return data as T;
    }
    return payload as T;
  }

  private withLegacySession(path: string): string {
    if (!this.legacySessionID) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}zentaosid=${encodeURIComponent(this.legacySessionID)}`;
  }

  /**
   * 内置 API POST 请求 (JSON 格式)
   * @param path - 请求路径
   * @param data - 请求数据
   * @returns 响应数据
   */
  private async legacyPost<T = unknown>(path: string, data: Record<string, unknown>): Promise<T> {
    await this.ensureLegacyLogin();
    const response = await this.http.post(
      this.withLegacySession(path),
      data,
      {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': this.legacyCookies.join('; '),
          'Referer': this.config.url,
        },
      }
    );
    this.handleLegacyCookies(response);
    return response.data;
  }

  /**
   * 内置 API POST 请求 (multipart/form-data 格式)
   * @param path - 请求路径
   * @param form - FormData 对象
   * @returns 响应数据
   */
  private async legacyPostForm<T = unknown>(path: string, form: FormData): Promise<T> {
    await this.ensureLegacyLogin();
    const response = await this.http.post(
      this.withLegacySession(path),
      form,
      {
        headers: {
          ...form.getHeaders(),
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': this.legacyCookies.join('; '),
          'Referer': this.config.url,
        },
      }
    );
    this.handleLegacyCookies(response);
    return response.data;
  }

  // ==================== 文档相关方法（内置 API）====================

  /**
   * 获取文档空间数据（文档库、目录树、文档列表）
   * @param type - 空间类型: product 或 project
   * @param spaceID - 空间 ID（产品或项目 ID）
   * @returns 文档空间数据
   */
  async getDocSpaceData(type: 'product' | 'project', spaceID: number): Promise<DocSpaceData> {
    await this.ensureLogin();

    const libsResponse: AxiosResponse<{ libs?: unknown }> = await this.http.get(
      `/api.php/v1/doclibs?type=${type}&objectID=${spaceID}`,
    );
    if (!Array.isArray(libsResponse.data.libs)) {
      throw new Error(
        `${type === 'product' ? '产品' : '项目'} #${spaceID} 的文档库接口返回了非结构化数据`,
      );
    }

    const libs = libsResponse.data.libs.map((lib) => ({
      ...(lib as Record<string, unknown>),
      type,
      [type]: spaceID,
    })) as unknown as DocLib[];
    const trees = await Promise.all(libs.map(async (lib) => {
      const response: AxiosResponse<{ docs?: unknown }> = await this.http.get(
        `/api.php/v1/doclibs/${lib.id}`,
      );
      if (!Array.isArray(response.data.docs)) {
        throw new Error(`文档库 #${lib.id} 返回了非结构化文档树`);
      }
      return response.data.docs;
    }));

    return {
      spaceID,
      libs,
      docs: trees.flat() as Doc[],
    };
  }

  /**
   * 获取文档详情
   * @param docID - 文档 ID
   * @param version - 版本号（0 表示最新版本）
   * @returns 文档详情
   */
  async getDoc(docID: number, version: number = 0): Promise<Doc | null> {
    if (version !== 0) {
      return this.legacyGet<Doc>(
        `/doc-ajaxGetDoc-${docID}-${version}.html`,
      );
    }

    await this.ensureLogin();
    try {
      const response: AxiosResponse<ApiResponse<Doc> | Doc> = await this.http.get(
        `/api.php/v1/docs/${docID}`,
      );
      const payload: unknown = response.data;
      const data =
        payload !== null && typeof payload === 'object' && 'data' in payload
          ? (payload as { data: unknown }).data
          : payload;
      if (
        !data
        || typeof data !== 'object'
        || !Number.isFinite(Number((data as Doc).id))
        || typeof (data as Doc).title !== 'string'
      ) {
        throw new Error(`文档 #${docID} 接口返回了非结构化详情`);
      }
      return data as Doc;
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 创建文档
   * @param params - 创建文档参数
   * @returns 创建结果
   */
  async createDoc(params: CreateDocParams): Promise<{ id: number; doc: Doc }> {
    const form = new FormData();
    form.append('title', params.title);
    form.append('content', params.content || '');
    form.append('lib', String(params.lib));
    form.append('module', String(params.module || 0));
    form.append('parent', 'm_0');
    form.append('status', 'normal');
    form.append('contentType', 'doc');
    form.append('type', params.type || 'text');
    form.append('acl', 'open');
    form.append('space', 'product');
    form.append('product', '1');
    form.append('uid', `doc${Date.now()}`);
    form.append('template', '0');
    form.append('mailto[]', '');
    form.append('contactList', '');
    form.append('groups[]', '');
    form.append('users[]', '');

    if (params.keywords) form.append('keywords', params.keywords);

    const result = await this.legacyPostForm<{
      result: string;
      message: string;
      id: number;
      doc: Doc;
    }>(`/index.php?m=doc&f=create&objectType=product&objectID=1&libID=${params.lib}&moduleID=${params.module || 0}`, form);

    if (result.result !== 'success') {
      throw new Error(result.message || '创建文档失败');
    }

    return { id: result.id, doc: result.doc };
  }

  /**
   * 编辑文档
   * @param params - 编辑文档参数
   * @returns 更新后的文档
   */
  async editDoc(params: EditDocParams): Promise<Doc | null> {
    const form = new FormData();

    if (params.title !== undefined) form.append('title', params.title);
    if (params.content !== undefined) form.append('content', params.content);
    if (params.keywords !== undefined) form.append('keywords', params.keywords);

    // 必需的字段
    form.append('lib', '1');
    form.append('module', '0');
    form.append('parent', '0');
    form.append('status', 'normal');
    form.append('contentType', 'doc');
    form.append('type', 'text');
    form.append('acl', 'open');
    form.append('space', 'product');
    form.append('uid', `doc${params.id}`);
    form.append('files', '');
    form.append('fromVersion', '1');

    try {
      const result = await this.legacyPostForm<{
        result: string;
        message: string;
        doc: Doc;
      }>(`/index.php?m=doc&f=edit&docID=${params.id}`, form);

      if (result.result !== 'success') {
        throw new Error(result.message || '编辑文档失败');
      }

      return result.doc || null;
    } catch (error) {
      this.logRequestError('编辑文档失败', error);
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  // ==================== 文档目录相关方法（内置 API）====================

  /**
   * 创建文档目录
   * @param params - 创建目录参数
   * @returns 创建结果
   */
  async createDocModule(params: CreateDocModuleParams): Promise<{ id: number; name: string }> {
    const form = new FormData();
    form.append('name', params.name);
    form.append('libID', String(params.libID));
    form.append('parentID', String(params.parentID || 0));
    form.append('objectID', String(params.objectID));
    form.append('moduleType', 'doc');
    form.append('isUpdate', 'false');
    form.append('createType', 'child');

    const result = await this.legacyPostForm<{
      result: string;
      message?: string;
      module?: { id: number; name: string };
    }>('/index.php?m=tree&f=ajaxCreateModule', form);

    if (result.result !== 'success') {
      throw new Error(result.message || '创建目录失败');
    }

    return { 
      id: result.module?.id || 0, 
      name: result.module?.name || params.name 
    };
  }

  /**
   * 编辑文档目录
   * @param params - 编辑目录参数
   * @returns 操作结果
   */
  async editDocModule(params: EditDocModuleParams): Promise<boolean> {
    const form = new FormData();
    form.append('root', String(params.root));
    form.append('parent', String(params.parent || 0));
    form.append('name', params.name);

    try {
      const result = await this.legacyPostForm<{
        result: string;
        message?: string;
      }>(`/index.php?m=doc&f=editCatalog&moduleID=${params.moduleID}&type=doc`, form);

      return result.result === 'success';
    } catch (error) {
      this.logRequestError('编辑文档目录失败', error);
      throw error;
    }
  }

}

