/**
 * 端到端联调检查（不碰真实数据）：用临时数据目录拉起 dist/main.js，验证
 * 1) 服务可启动、健康检查正常
 * 2) 配置保存回显明文、连续保存不报错（P1-1）
 * 3) LLM 不可达时启动被预检拦截（P0-3 的启动前置校验）
 * 4) 连接配置修改后热更新日志（T13）
 * 5) 日志目录不再嵌套 server/server（T06）
 *
 * 用法：node scripts/e2e-check.cjs   （需先 npm run build:server）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.QQAB_E2E_PORT || 8720);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqab-e2e-'));

let failed = 0;
function expect(name, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const resp = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: resp.status, json, text };
}

async function main() {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/main.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, QQAICHATBOT_DATA_DIR: dataDir, QQAICHATBOT_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));
  child.stdout.on('data', () => undefined);

  try {
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await api('GET', '/api/health');
        if (r.json?.code === 0) {
          up = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(500);
    }
    if (!up) throw new Error(`服务未启动：${stderr.join('').slice(0, 400)}`);
    console.log('PASS  服务启动 + /api/health');

    // 1) 配置：保存后回读明文，连续保存 3 次
    const cfg = (await api('GET', '/api/config')).json.data;
    const withKey = { ...cfg, llm: { ...cfg.llm, apiKey: 'sk-e2e-123' } };
    const put1 = await api('PUT', '/api/config', withKey);
    expect('首次保存配置 HTTP 200', put1.status, 200);
    expect('保存后回读明文', (await api('GET', '/api/config')).json.data.llm.apiKey, 'sk-e2e-123');
    let codes = [];
    for (let i = 0; i < 3; i += 1) codes.push((await api('PUT', '/api/config', withKey)).status);
    expect('连续保存 3 次均 200', codes, [200, 200, 200]);
    const exportCfg = JSON.parse((await api('GET', '/api/config/export')).text);
    expect('导出默认脱敏', exportCfg.llm.apiKey, '***');
    const revealCfg = JSON.parse((await api('GET', '/api/config/export?reveal=1')).text);
    expect('导出 reveal=1 为明文', revealCfg.llm.apiKey, 'sk-e2e-123');

    // 2) 建连接 + 修改聊天配置（热更新）
    const created = await api('POST', '/api/connections', { name: 'E2E', type: 'official' });
    const cid = created.json.data.connectionId;
    const detail = (await api('GET', `/api/connections/${cid}`)).json.data;
    const updated = {
      ...detail,
      chat: { ...detail.chat, contextMaxMessages: 6, trigger: 'at' },
    };
    const putConn = await api('PUT', `/api/connections/${cid}`, updated);
    expect('修改连接配置 HTTP 200', putConn.status, 200);
    const after = (await api('GET', `/api/connections/${cid}`)).json.data;
    expect('新配置已落库', after.chat.contextMaxMessages, 6);
    // 注意：热更新的运行态效果（上下文裁剪/限流/预算）由 scripts/smoke-runtime.cjs 覆盖，
    // 这里未启动连接（没有真实凭据），manager 里没有 runtime，不会产生热更新日志。

    // 3) LLM 不可达 → 预检阻塞
    await api('PUT', '/api/config', {
      ...withKey,
      llm: { ...withKey.llm, baseUrl: 'http://127.0.0.1:7999/v1', apiKey: 'sk-e2e-123' },
    });
    const pre = (await api('GET', `/api/connections/${cid}/precheck`)).json.data;
    const llmItem = pre.items.find((i) => i.key === 'llm');
    expect('LLM 不可达 → block/fail', [llmItem.level, llmItem.status], ['block', 'fail']);
    const start = (await api('POST', `/api/connections/${cid}/start`)).json.data;
    expect('启动被拦截', start.ok, false);

    // 4) 日志目录结构
    const logDirs = fs.readdirSync(path.join(dataDir, 'logs'));
    expect('logs 下无 server/server 嵌套', logDirs.includes('server'), true);
    const nested = fs.existsSync(path.join(dataDir, 'logs', 'server', 'server'));
    expect('不存在 logs/server/server', nested, false);
  } finally {
    child.kill();
    await sleep(500);
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 失败：', e.message);
  process.exit(1);
});
