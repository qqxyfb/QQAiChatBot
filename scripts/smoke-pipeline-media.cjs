/**
 * 冒烟：链路级验证引用回复落点 + 表情包冷却/prompt 收敛。
 * 用一个假的 OpenAI 兼容服务返回固定内容，避免依赖真实模型。
 */
const http = require('node:http');
const { Pipeline } = require('../dist/pipeline');
const { ContextManager } = require('../dist/pipeline/context');
const { RateLimiter, TokenBudget } = require('../dist/pipeline/limits');
const { LlmGateway } = require('../dist/llm/gateway');

const REPLY = '好呀，我也这么觉得[sticker:开心]';
const prompts = [];
let failed = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failed += 1;
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      prompts.push(JSON.parse(body).messages?.[0]?.content ?? '');
    } catch {
      prompts.push('');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: REPLY } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      })
    );
  });
});

const chatBase = {
  mode: 'blacklist',
  groupList: [],
  userList: [],
  contextMaxMessages: 12,
  contextTtlMinutes: 5,
  dailyTokenBudget: 0,
  maxInputLen: 2000,
  floodThreshold: 10,
  rateLimit: { maxPerMinute: 0, minIntervalMs: 0 },
  budgetAlertPct: 80,
  trigger: 'at',
};

function makePipeline(persona, sent, emits = []) {
  return new Pipeline({
    connectionId: 'p1',
    chat: { ...chatBase },
    context: new ContextManager(12, 5),
    limiter: new RateLimiter(chatBase.rateLimit),
    tokenBudget: new TokenBudget({ get: () => 0, add: () => undefined }, 'p1', 0),
    sendReply: async (r) => sent.push(r),
    getPersona: () => persona,
    getBanwords: () => ({ in: new Set(), out: new Set(), both: new Set() }),
    createLlm: () =>
      new LlmGateway(
        { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k', model: 'm', temperature: 0.8, maxTokens: 64 },
        'p1',
        null,
        () => undefined
      ),
    sessionId: () => null,
    emit: (e) => emits.push(e),
    getStickerTags: () => ['开心'],
    getStickerIndex: () =>
      new Map([['default', new Map([['开心', [{ id: 's1', path: 'H:/x/s1.png', alt: '开心' }]]])]]),
    getGlobalTts: () => ({ provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural' }),
    synthesizeVoice: async () => null,
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ---- A. 引用回复 ----
  const sentA = [];
  const pipeA = makePipeline(
    { id: 'p', name: 'P', profilePrompt: '你是助手。\n用户：{user_message}\n请回复：' },
    sentA
  );
  await pipeA.handle({
    connectionId: 'p1', channel: 'group', fromId: 'u1', groupId: 'g1',
    messageId: '1001', content: '你好', atBot: true,
  });
  check('群聊被@ → 回复带 quoteMessageId', sentA[0]?.quoteMessageId === '1001', JSON.stringify(sentA[0]?.quoteMessageId));

  await pipeA.handle({
    connectionId: 'p1', channel: 'c2c', fromId: 'u1', messageId: '1002', content: '私聊', atBot: false,
  });
  check('私聊 → 不带引用', sentA[1] && sentA[1].quoteMessageId === undefined, JSON.stringify(sentA[1]?.quoteMessageId));

  // ---- B. 表情包频率 ----
  // B1: 概率 1 → 带图；B2: 立刻再来一条（冷却 120s）→ 只发文字，且 prompt 不再提供标签
  const sentB = [];
  const emitsB = [];
  prompts.length = 0;
  const pipeB = makePipeline(
    {
      id: 'p',
      name: 'P',
      profilePrompt: '你是助手。\n用户：{user_message}\n请回复：',
      sticker: { enabled: true, probability: 1, minIntervalSec: 120 },
    },
    sentB,
    emitsB
  );
  const groupMsg = { connectionId: 'p1', channel: 'group', fromId: 'u1', groupId: 'g2', atBot: true };

  await pipeB.handle({ ...groupMsg, messageId: '2001', content: '第一句' });
  const s1 = sentB[0];
  check(
    '概率1 → 分段为 文字 + 表情包',
    s1?.segments?.some((x) => x.type === 'sticker') && s1.segments.some((x) => x.type === 'text'),
    JSON.stringify(s1?.segments)
  );
  check('首条 prompt 提供表情包标签', prompts[0]?.includes('[sticker:标签]'));
  const msgB1 = emitsB.find((e) => e.kind === 'message');
  check(
    '聊天记录落库带表情包标签',
    String(msgB1?.reply ?? '').includes('[表情包:开心]'),
    JSON.stringify(msgB1?.reply)
  );

  await pipeB.handle({ ...groupMsg, messageId: '2002', content: '第二句' });
  const s2 = sentB[1];
  check('冷却内 → 不再发图', s2 && !s2.segments?.some((x) => x.type === 'sticker'), JSON.stringify(s2?.segments));
  check('冷却内 prompt 不再给标签（从源头降频）', !prompts[1]?.includes('[sticker:标签]'));
  const msgB2 = emitsB.filter((e) => e.kind === 'message')[1];
  check(
    '未发图时不落库表情包标记',
    msgB2 && !String(msgB2.reply).includes('[表情包:'),
    JSON.stringify(msgB2?.reply)
  );

  // B3: 关闭开关 → 永不带图
  const sentC = [];
  prompts.length = 0;
  const pipeC = makePipeline(
    {
      id: 'p',
      name: 'P',
      profilePrompt: '你是助手。\n用户：{user_message}\n请回复：',
      sticker: { enabled: false, probability: 1, minIntervalSec: 0 },
    },
    sentC
  );
  await pipeC.handle({ ...groupMsg, groupId: 'g3', messageId: '3001', content: '再来' });
  check('开关关闭 → 纯文字', sentC[0] && !sentC[0].segments.some((x) => x.type === 'sticker'));
  check('开关关闭 prompt 无标签说明', !prompts[0]?.includes('[sticker:标签]'));

  server.close();
  console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
