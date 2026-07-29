import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ZentaoClient } from '../dist/zentao-client.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}/zentao`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('禅道 21.x 登录直接提交原始密码，并保留部署子路径', async () => {
  const requests = [];

  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method,
        url: request.url,
        token: request.headers.token,
        body,
      });

      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/zentao/api.php/v1/products?limit=5') {
        response.end(JSON.stringify({ products: [{ id: 1, name: '测试产品' }] }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });

      const products = await client.getProducts(5);
      assert.equal(products.length, 1);
      assert.equal(products[0].name, '测试产品');
    },
  );

  assert.equal(requests.length, 2, '登录前不应额外 GET tokens');
  assert.deepEqual(
    JSON.parse(requests[0].body),
    { account: 'tester', password: 'plain-secret' },
  );
  assert.equal(requests[1].token, 'test-token');
});

test('Token 响应缺失时显式失败，且日志不输出请求对象', async () => {
  const logged = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    logged.push(String(chunk));
    return true;
  };

  try {
    await withServer(
      (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ status: 'success' }));
      },
      async (url) => {
        const client = new ZentaoClient({
          url,
          account: 'tester',
          password: 'do-not-log',
        });

        await assert.rejects(client.login(), /Token 接口未返回有效 token/);
      },
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(logged.length, 1);
  assert.match(logged[0], /zentao_login_failed/);
  assert.doesNotMatch(logged[0], /do-not-log/);
});

test('业务请求收到 401 时自动刷新 Token，并只重放一次请求', async () => {
  let loginCount = 0;
  const productTokens = [];

  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        loginCount += 1;
        response.end(JSON.stringify({ token: `token-${loginCount}` }));
        return;
      }
      if (request.method === 'GET' && request.url === '/zentao/api.php/v1/products?limit=5') {
        productTokens.push(request.headers.token);
        if (request.headers.token === 'token-1') {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: 'expired' }));
          return;
        }
        response.end(JSON.stringify({ products: [{ id: 1, name: '产品' }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      const products = await client.getProducts(5);
      assert.equal(products.length, 1);
    },
  );

  assert.equal(loginCount, 2);
  assert.deepEqual(productTokens, ['token-1', 'token-2']);
});

test('GET 遇到瞬时 503 时按配置重试并恢复', async () => {
  let productRequests = 0;

  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/zentao/api.php/v1/products?limit=5') {
        productRequests += 1;
        if (productRequests < 3) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: 'busy' }));
          return;
        }
        response.end(JSON.stringify({ products: [{ id: 1, name: '产品' }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
        maxRetries: 2,
      });
      const products = await client.getProducts(5);
      assert.equal(products.length, 1);
    },
  );

  assert.equal(productRequests, 3);
});

test('POST 写操作遇到 503 时不自动重试', async () => {
  let createRequests = 0;

  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/products/1/bugs') {
        createRequests += 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'busy' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
        maxRetries: 2,
      });
      await assert.rejects(
        client.createBug({
          product: 1,
          title: '测试',
          severity: 3,
          pri: 3,
          type: 'codeerror',
        }),
        /503/,
      );
    },
  );

  assert.equal(createRequests, 1);
});

test('详情查询仅将 404 转为空值，服务端错误继续向上抛出', async () => {
  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.url === '/zentao/api.php/v1/bugs/404') {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (request.url === '/zentao/api.php/v1/bugs/500') {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'server error' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      assert.equal(await client.getBug(404), null);
      await assert.rejects(client.getBug(500), /500/);
    },
  );
});

test('MCP 取消信号会中止当前调用链中的 HTTP 请求', async () => {
  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/zentao/api.php/v1/products?limit=5') {
        setTimeout(() => response.end(JSON.stringify({ products: [] })), 500);
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      const controller = new AbortController();
      const requestPromise = client.withAbortSignal(
        controller.signal,
        () => client.getProducts(5),
      );
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(requestPromise, /canceled/i);
    },
  );
});

test('禅道 21.x 我的任务接口可解包 data 字符串和对象型任务集合', async () => {
  const requests = [];

  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.setHeader('Content-Type', 'application/json');

      if (request.method === 'GET' && request.url === '/zentao/user-login.json') {
        response.setHeader('Set-Cookie', 'zentaosid=sid; Path=/');
        response.end(JSON.stringify({ data: JSON.stringify({ rand: 123 }) }));
        return;
      }
      if (request.method === 'POST' && request.url === '/zentao/user-login.json') {
        response.end(JSON.stringify({ status: 'success' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/zentao/my-work-task-assignedTo.json') {
        response.end(JSON.stringify({
          data: JSON.stringify({
            tasks: {
              42: { name: '只读任务', status: 'doing' },
            },
            pager: { recTotal: 1, recPerPage: 20, pageTotal: 1 },
          }),
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      const tasks = await client.getMyTasks('assignedTo', 20);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, 42);
      assert.equal(tasks[0].name, '只读任务');
    },
  );

  assert.equal(requests.length, 3);
  const loginBody = Object.fromEntries(new URLSearchParams(requests[1].body));
  assert.equal(loginBody.account, 'tester');
  assert.equal(loginBody.verifyRand, '123');
  assert.equal(loginBody.password.length, 32);
  assert.notEqual(loginBody.password, 'plain-secret');
});

test('HTTP 重定向只允许留在禅道同源地址', async () => {
  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.url === '/zentao/api.php/v1/products?limit=5') {
        response.statusCode = 302;
        response.setHeader('Location', '/zentao/redirected-products');
        response.end();
        return;
      }
      if (request.url === '/zentao/redirected-products') {
        response.end(JSON.stringify({ products: [{ id: 1, name: '产品' }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      assert.equal((await client.getProducts(5)).length, 1);
    },
  );
});

test('拒绝将禅道请求重定向到外部来源', async () => {
  await withServer(
    (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/zentao/api.php/v1/tokens') {
        response.end(JSON.stringify({ token: 'test-token' }));
        return;
      }
      if (request.url === '/zentao/api.php/v1/products?limit=5') {
        response.statusCode = 302;
        response.setHeader('Location', 'http://example.invalid/products');
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not found' }));
    },
    async (url) => {
      const client = new ZentaoClient({
        url,
        account: 'tester',
        password: 'plain-secret',
      });
      await assert.rejects(client.getProducts(5), /跨源 HTTP 重定向/);
    },
  );
});
