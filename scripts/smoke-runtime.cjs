/**
 * 运行态回归：验证配置热更新（T13 方案 A）真的改了运行中的参数，而不是只写库。
 * 用法：node scripts/smoke-runtime.cjs   （需先 npm run build:server）
 */
const { ConnectionRuntime } = require('../dist/manager/runtime');

const chat = {
  mode: 'blacklist',
  groupList: [],
  userList: [],
  contextMaxMessages: 12,
  contextTtlMinutes: 5,
  dailyTokenBudget: 50000,
  maxInputLen: 2000,
  floodThreshold: 10,
  rateLimit: { maxPerMinute: 20, minIntervalMs: 0 },
  budgetAlertPct: 80,
  trigger: 'at',
};

const config = {
  connectionId: 'rt_smoke',
  name: '运行态测试',
  type: 'official',
  official: { appId: 'appid', appSecret: 'secret' },
  riskConfirmed: true,
  personaId: 'p1',
  chat,
};

const events = [];
const deps = {
  personaRepo: {
    get: () => ({ content_json: JSON.stringify({ id: 'p1', name: '测试人格', profilePrompt: '你好' }) }),
  },
  banwordRepo: { getCache: () => ({ in: new Set(), out: new Set(), both: new Set() }) },
  tokenBudgetRepo: { get: () => 0, add: () => undefined },
  getGlobalLlm: () => ({ baseUrl: 'http://127.0.0.1:7999/v1', apiKey: '', model: 'm', temperature: 0.8, maxTokens: 32 }),
  emit: (e) => events.push(e),
};

let failed = 0;
function expect(name, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`);
}

const rt = new ConnectionRuntime(config, deps);

// 预置一段上下文（12 条），用于验证热更新后按新上限裁剪
const buf = rt.context.getOrCreate('group:g1');
for (let i = 0; i < 12; i += 1) buf.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
expect('热更新前上下文条数', buf.length, 12);

// 改配置：上下文 12 → 4，限流 20 → 1，预算 50000 → 1000
rt.updateConfig({
  ...config,
  chat: { ...chat, contextMaxMessages: 4, dailyTokenBudget: 1000, rateLimit: { maxPerMinute: 1, minIntervalMs: 0 } },
});

expect('热更新日志已发出', events.some((e) => e.msg && e.msg.includes('配置已热更新')), true);
expect('上下文按新上限裁剪', buf.length, 4);
expect('保留最近 4 条', buf.recent().map((x) => x.content), ['m8', 'm9', 'm10', 'm11']);
expect('限流按新配置生效（第1条放行）', rt.limiter.allow('u1'), true);
expect('限流按新配置生效（同一对象第2条拦截）', rt.limiter.allow('u1'), false);
expect('限流按对象分桶（另一对象不受影响）', rt.limiter.allow('u2'), true);
expect('token 预算按新配置生效', rt.tokenBudget.check('u1', 1500), false);

// 无变化时不应重复发日志
const before = events.length;
rt.updateConfig({ ...config, chat: { ...chat, contextMaxMessages: 4, dailyTokenBudget: 1000, rateLimit: { maxPerMinute: 1, minIntervalMs: 0 } } });
expect('配置未变化时不重复打日志', events.length, before);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
