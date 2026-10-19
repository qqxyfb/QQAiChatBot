/* 通过 CDP 截图当前应用窗口，并读取页面文本，用于验证打包后的界面是否正常渲染 */
const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  const port = process.argv[2] || '9333';
  const out = process.argv[3] || '.tmp-window.png';
  const list = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await new Promise((r) => ws.once('open', r));

  const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const text = await send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0,400)',
    returnByValue: true,
  });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result || !shot.result.data) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 300));
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));

  console.log('title =', title.result && title.result.result && title.result.result.value);
  console.log('url   =', page.url);
  console.log('text  =', JSON.stringify(text.result && text.result.result && text.result.result.value));
  console.log('png   =', out, fs.statSync(out).size, 'bytes');
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
