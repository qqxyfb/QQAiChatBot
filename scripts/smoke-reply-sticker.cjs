/**
 * 冒烟：群聊引用回复（OneBot reply 段）+ 表情包频率闸门。
 * 用法：node scripts/smoke-reply-sticker.cjs
 */
const { WebSocketServer } = require('ws');
const { AccountLoginConnector } = require('../dist/connectors/account');
const {
  MediaPlanner,
  normalizeStickerPolicy,
  stickerCooldownLeft,
} = require('../dist/pipeline/media-planner');
const { ReplyQuote } = require('../dist/pipeline/steps');

let failed = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failed += 1;
}

// ---------- 1. 引用回复决策 ----------
const baseChat = {
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
const groupAt = { connectionId: 'c', channel: 'group', fromId: 'u', groupId: 'g', messageId: '1', content: 'hi', atBot: true };
const groupNoAt = { ...groupAt, atBot: false };
const c2c = { connectionId: 'c', channel: 'c2c', fromId: 'u', messageId: '2', content: 'hi', atBot: false };

check('auto + 群被@ → 引用', ReplyQuote.should(groupAt, baseChat) === true);
check('auto + 群未@ → 不引用', ReplyQuote.should(groupNoAt, baseChat) === false);
check('auto + 私聊 → 不引用', ReplyQuote.should(c2c, baseChat) === false);
check('off + 群被@ → 不引用', ReplyQuote.should(groupAt, { ...baseChat, replyQuote: 'off' }) === false);
check('always + 群未@ → 引用', ReplyQuote.should(groupNoAt, { ...baseChat, replyQuote: 'always' }) === true);
check('always + 私聊 → 不引用', ReplyQuote.should(c2c, { ...baseChat, replyQuote: 'always' }) === false);

// ---------- 2. 表情包频率闸门 ----------
const indexPath = new Map([
  ['default', new Map([['开心', [{ id: 's1', path: 'H:/x/s1.png', alt: '开心' }]]])],
]);
const set = 'default';

const p1 = MediaPlanner.plan('好呀[sticker:开心]', set, indexPath, {
  policy: { enabled: true, probability: 1, minIntervalSec: 0 },
  random: () => 0,
});
check('概率=1 → 发图且保留文字', p1.sticker === true && p1.text === '好呀' && p1.segments.length === 2, JSON.stringify(p1.segments));

const p2 = MediaPlanner.plan('好呀[sticker:开心]', set, indexPath, {
  policy: { enabled: true, probability: 0.3, minIntervalSec: 0 },
  random: () => 0.99,
});
check('概率抽不中 → 只发文字', p2.sticker === false && p2.text === '好呀' && p2.segments.length === 1, p2.reason);

const p3 = MediaPlanner.plan('好呀[sticker:开心]', set, indexPath, {
  policy: { enabled: true, probability: 1, minIntervalSec: 120 },
  lastSentAt: Date.now() - 5000,
});
check('冷却内 → 不发图', p3.sticker === false && /冷却/.test(p3.reason || ''), p3.reason);

const p4 = MediaPlanner.plan('好呀[sticker:开心]', set, indexPath, {
  policy: { enabled: false, probability: 1, minIntervalSec: 0 },
});
check('总开关关闭 → 不发图', p4.sticker === false && p4.text === '好呀');

const p5 = MediaPlanner.plan('[sticker:开心]', set, indexPath, {
  policy: { enabled: true, probability: 0, minIntervalSec: 0 },
  random: () => 0.5,
});
check('只有标记 + 概率0 → 无任何段（由 pipeline 兜底占位）', p5.sticker === false && p5.segments.length === 0);

const p6 = MediaPlanner.plan('好呀[sticker:不存在]', set, indexPath, {
  policy: { enabled: true, probability: 1, minIntervalSec: 0 },
});
check('标签无图片 → 降级纯文字', p6.sticker === false && p6.text === '好呀', p6.reason);

const norm = normalizeStickerPolicy({ enabled: true, probability: 5, minIntervalSec: -3 });
check('策略归一化收敛越界值', norm.probability === 1 && norm.minIntervalSec === 0, JSON.stringify(norm));
check('缺失策略用默认 30%/120s', JSON.stringify(normalizeStickerPolicy(undefined)) === JSON.stringify({ enabled: true, probability: 0.3, minIntervalSec: 120 }));
check('冷却剩余计算', stickerCooldownLeft({ enabled: true, probability: 1, minIntervalSec: 120 }, Date.now() - 60000) === 60);

// ---------- 3. 连接器真的把 reply 段发出去 ----------
async function testConnector() {
  const wss = new WebSocketServer({ port: 39211, host: '127.0.0.1' });
  const received = [];
  const ready = new Promise((resolve) => wss.on('connection', (ws) => {
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    resolve();
  }));

  const conn = new AccountLoginConnector();
  await conn.connect({
    connectionId: 'c1',
    name: 't',
    type: 'account',
    account: { host: '127.0.0.1', port: 39211, wsMode: 'forward' },
    riskConfirmed: true,
    personaId: 'p',
    chat: { ...baseChat },
  });
  await ready;

  await conn.sendReply({
    messageId: '1001',
    content: '在的',
    segments: [{ type: 'text', text: '在的' }],
    quoteMessageId: '1001',
    channel: 'group',
    groupId: '555',
  });
  await conn.sendReply({
    messageId: '1002',
    content: '不带引用',
    segments: [{ type: 'text', text: '不带引用' }],
    channel: 'group',
    groupId: '555',
  });
  await conn.sendReply({
    messageId: '1003',
    content: '',
    segments: [{ type: 'sticker', stickerId: 's1', path: 'H:/x/s1.png', alt: '开心' }],
    quoteMessageId: '1003',
    channel: 'group',
    groupId: '555',
  });
  await new Promise((r) => setTimeout(r, 300));

  const [m1, m2, m3] = received;
  check('引用回复带 reply 段且在本条消息', m1 && Array.isArray(m1.params.message) && m1.params.message[0].type === 'reply' && m1.params.message[0].data.id === '1001', JSON.stringify(m1 && m1.params.message));
  check('不引用时仍用简单字符串（兼容）', m2 && m2.params.message === '不带引用', JSON.stringify(m2 && m2.params.message));
  check('表情包+引用：reply 占首段，image 保留', m3 && Array.isArray(m3.params.message) && m3.params.message[0].type === 'reply' && m3.params.message[1].type === 'image', JSON.stringify(m3 && m3.params.message));

  await conn.disconnect();
  wss.close();
}

testConnector()
  .catch((e) => {
    console.error('connector 测试异常：', e);
    failed += 1;
  })
  .finally(() => {
    console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
  });
