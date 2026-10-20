/**
 * C2C 触发回归：验证私聊不被 at 规则静默丢弃、限流按对象分桶、名单判定。
 * 用法：node scripts/smoke-c2c.cjs   （需先 npm run build:server）
 */
const { TriggerDecision, AccessControl } = require('../dist/pipeline/steps');
const { RateLimiter } = require('../dist/pipeline/limits');

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

const c2c = { connectionId: 'smoke', channel: 'c2c', fromId: 'u1', messageId: 'm1', content: '你好', atBot: false };
const group = { ...c2c, channel: 'group', groupId: 'g1' };

let failed = 0;
function expect(name, actual, want) {
  const ok = actual === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：实际 ${actual}，期望 ${want}`);
}

console.log('== 触发决策 ==');
expect('c2c + at 模式应放行', TriggerDecision.should(c2c, { ...chatBase, trigger: 'at' }), true);
expect('c2c + silent 仍静默', TriggerDecision.should(c2c, { ...chatBase, trigger: 'silent' }), false);
expect(
  'c2c + keyword 未命中仍拦截',
  TriggerDecision.should({ ...c2c, content: '随便聊聊' }, { ...chatBase, trigger: 'keyword', triggerKeywords: ['天气'] }),
  false
);
expect('group + at 未@ 仍拦截', TriggerDecision.should(group, { ...chatBase, trigger: 'at' }), false);
expect('group + at 已@ 放行', TriggerDecision.should({ ...group, atBot: true }, { ...chatBase, trigger: 'at' }), true);

console.log('== 早退原因 ==');
const r = TriggerDecision.evaluate(group, { ...chatBase, trigger: 'at' });
expect('未触发时带原因', typeof r.reason === 'string' && r.reason.includes('未 @'), true);

console.log('== 名单 ==');
expect(
  '黑名单命中拦截',
  AccessControl.allow({ ...group, fromId: 'bad' }, { ...chatBase, mode: 'blacklist', userList: ['bad'] }),
  false
);
expect(
  '白名单未命中拦截',
  AccessControl.allow({ ...group, fromId: 'other' }, { ...chatBase, mode: 'whitelist', userList: ['vip'] }),
  false
);
expect(
  '白名单命中放行',
  AccessControl.allow({ ...group, fromId: 'vip' }, { ...chatBase, mode: 'whitelist', userList: ['vip'] }),
  true
);

console.log('== 限流分桶 ==');
const byUser = new RateLimiter({ maxPerMinute: 2, minIntervalMs: 0, scope: 'user' });
expect('用户A 第1条', byUser.allow('a'), true);
expect('用户A 第2条', byUser.allow('a'), true);
expect('用户A 第3条被限流', byUser.allow('a'), false);
expect('用户B 不受 A 影响', byUser.allow('b'), true);

const byConn = new RateLimiter({ maxPerMinute: 1, minIntervalMs: 0, scope: 'connection' });
expect('连接级 用户A 第1条', byConn.allow('a'), true);
expect('连接级 用户B 共享配额被限', byConn.allow('b'), false);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
