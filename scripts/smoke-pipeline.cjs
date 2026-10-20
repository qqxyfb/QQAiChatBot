/**
 * Pipeline 冒烟脚本（不连 QQ）：验证上下文入栈、安全过滤、LLM 演示 stub、打点。
 * 用法：node scripts/smoke-pipeline.cjs
 */
const path = require('node:path');
const { Database } = require('../dist/db');
const { TokenBudgetRepo } = require('../dist/db/repos');
const { ContextManager } = require('../dist/pipeline/context');
const { RateLimiter, TokenBudget } = require('../dist/pipeline/limits');
const { Pipeline } = require('../dist/pipeline');
const { LlmGateway } = require('../dist/llm/gateway');

const db = Database.open(path.join(__dirname, '..', 'data', 'client.db'));
const tbRepo = new TokenBudgetRepo(db);
const context = new ContextManager(12, 5);

let replied = '';
const events = [];

const pipeline = new Pipeline({
  connectionId: 'smoke',
  chat: {
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
  },
  context,
  limiter: new RateLimiter({ maxPerMinute: 20, minIntervalMs: 0 }),
  tokenBudget: new TokenBudget(tbRepo, 'smoke', 50000),
  sendReply: async (r) => {
    replied = r.content;
  },
  getPersona: () => ({
    id: 'p',
    name: '测试人格',
    profilePrompt: '你是测试助手。\n\n用户：{user_message}\n请回复：',
  }),
  getBanwords: () => ({ in: new Set(['敏感词']), out: new Set(), both: new Set() }),
  createLlm: () =>
    new LlmGateway(
      { baseUrl: '', apiKey: '', model: 'stub', temperature: 0.8, maxTokens: 64 },
      'smoke',
      null,
      (e) => events.push(e)
    ),
  sessionId: () => null,
  emit: (e) => events.push(e),
});

async function main() {
  const base = { connectionId: 'smoke', channel: 'group', fromId: 'u1', groupId: 'g1', atBot: true };

  await pipeline.handle({ ...base, messageId: 'm1', content: '你好' });
  console.log('1) 首次对话 reply =', replied);

  await pipeline.handle({ ...base, messageId: 'm2', content: '再说一句' });
  console.log('2) 第二轮 reply =', replied);

  const buf = context.get('group:g1');
  console.log('3) 上下文条数 =', buf ? buf.length : 0, '(期望 4：两轮 user+assistant)');

  await pipeline.handle({ ...base, messageId: 'm3', content: '这里有敏感词' });
  console.log('4) 敏感词拦截 reply =', replied);

  await pipeline.handle({ ...base, messageId: 'm4', content: '未@消息', atBot: false });
  console.log('5) 未@消息（应无新回复）reply 仍为 =', replied);

  console.log('6) 事件类型 =', [...new Set(events.map((e) => e.kind))].join(', '));

  // 6.1) 链路日志：未@ 被拦也必须有可读原因，不能静默
  const logs = events.filter((e) => e.kind === 'log');
  const silentReasons = logs.filter((e) => e.msg.includes('触发未通过'));
  console.log('6.1) 运行日志条数 =', logs.length, '，其中「触发未通过」=', silentReasons.length, '(期望 ≥1)');

  // 6.2) 私聊（c2c + at 模式）必须回复
  replied = '';
  await pipeline.handle({
    connectionId: 'smoke',
    channel: 'c2c',
    fromId: 'u2',
    messageId: 'm5',
    content: '私聊你好',
    atBot: false,
  });
  console.log('6.2) 私聊回复 =', replied ? '有回复' : '无回复', '(期望 有回复)');

  // 7) 触发规则（P1）
  const { TriggerDecision } = require('../dist/pipeline/steps');
  const chatBase = {
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
  const noAt = { ...base, content: '今天天气不错', atBot: false };
  const at = { ...noAt, atBot: true };
  console.log('7) 触发规则：');
  console.log('   at + 未@ =', TriggerDecision.should(noAt, { ...chatBase, trigger: 'at' }), '(期望 false)');
  console.log('   at + @   =', TriggerDecision.should(at, { ...chatBase, trigger: 'at' }), '(期望 true)');
  console.log(
    '   keyword 命中 =',
    TriggerDecision.should(noAt, { ...chatBase, trigger: 'keyword', triggerKeywords: ['天气'] }),
    '(期望 true)'
  );
  console.log(
    '   keyword 未命中 =',
    TriggerDecision.should({ ...noAt, content: '随便聊聊' }, { ...chatBase, trigger: 'keyword', triggerKeywords: ['天气'] }),
    '(期望 false)'
  );
  console.log('   silent =', TriggerDecision.should(at, { ...chatBase, trigger: 'silent' }), '(期望 false)');
  console.log(
    '   random p=1 =',
    TriggerDecision.should(noAt, { ...chatBase, trigger: 'random', randomProbability: 1 }),
    '(期望 true)'
  );

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
