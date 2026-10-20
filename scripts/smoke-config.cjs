/**
 * 配置读写回归：验证「保存 → 回读 → 再保存」不会把密钥重复加密或丢值。
 * 这是 P1-1（API Key 回显 *** / 二次保存报错）的防回归用例。
 * 用法：node scripts/smoke-config.cjs   （需先 npm run build:server）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigService } = require('../dist/services/config.service');
const { SecretStore } = require('../dist/secret/secret-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqab-config-'));
const configFile = path.join(dir, 'config.json');
const secret = new SecretStore(path.join(dir, 'secrets.key'));
const snapshots = [];
const config = new ConfigService(configFile, secret, {
  insertConfig: (scope, json, reason) => snapshots.push({ scope, reason }),
});

let failed = 0;
function expect(name, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(want)}`);
}

const base = config.load();
const withKey = (key) => ({ ...base, llm: { ...base.llm, apiKey: key } });

// 1) 首次保存
config.save(withKey('sk-first-123'));
const stored1 = JSON.parse(fs.readFileSync(configFile, 'utf8')).llm.apiKey;
expect('落盘不是明文', stored1.startsWith('enc:v1:'), true);
expect('回读为明文', config.load().llm.apiKey, 'sk-first-123');

// 2) 连续保存 3 次同一值（模拟用户连点保存）
for (let i = 0; i < 3; i += 1) config.save(withKey('sk-first-123'));
const stored2 = JSON.parse(fs.readFileSync(configFile, 'utf8')).llm.apiKey;
expect('三次保存后仍只加密一层', stored2.startsWith('enc:v1:') && !stored2.includes('enc:v1:enc'), true);
expect('三次保存后回读仍正确', config.load().llm.apiKey, 'sk-first-123');

// 3) 换新 key
config.save(withKey('sk-second-456'));
expect('换 key 后回读', config.load().apiKey ?? config.load().llm.apiKey, 'sk-second-456');

// 4) 空 key 允许清空
config.save(withKey(''));
expect('清空 key', config.load().llm.apiKey, '');

// 5) 脱敏占位 *** 走兜底：保留旧值而不是写入 ***
config.save(withKey('sk-keep-me'));
config.save(withKey('***'));
expect('*** 兜底保留旧值', config.load().llm.apiKey, 'sk-keep-me');

// 6) 快照写失败不应让保存整体失败
const failing = new ConfigService(configFile, secret, {
  insertConfig: () => {
    throw new Error('database is locked');
  },
});
let threw = false;
try {
  failing.save(withKey('sk-after-fail'));
} catch {
  threw = true;
}
expect('快照失败不影响保存', threw, false);
expect('快照失败后仍可回读', failing.load().llm.apiKey, 'sk-after-fail');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
