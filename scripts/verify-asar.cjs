/* 校验 asar 内是否包含最新构建产物（发布前检查，严格前缀匹配，避免 node_modules 误判） */
const asar = require('@electron/asar');

const file = process.argv[2] || 'release/win-unpacked/resources/app.asar';
const list = asar.listPackage(file).map((p) => '/' + p.replace(/\\/g, '/').replace(/^\//, ''));
console.log('entries =', list.length);

const want = ['/dist/main.js', '/dist/services/update.service.js', '/dist/db/migrations/001_init.sql', '/web/dist/index.html', '/electron/main.cjs'];
let missing = 0;
for (const w of want) {
  const found = list.includes(w);
  if (!found) missing += 1;
  console.log((found ? 'OK   ' : 'MISS ') + w);
}

const norm = (p) => p.replace(/^\//, '').replace(/\//g, '\\');
if (!missing) {
  const upd = asar.extractFile(file, norm('/dist/services/update.service.js')).toString();
  console.log('update.service: package.json fallback =', upd.includes('../../package.json'));

  const html = asar.extractFile(file, norm('/web/dist/index.html')).toString();
  const m = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  console.log('web bundle =', m ? m[0] : '(none)');

  const pkg = JSON.parse(asar.extractFile(file, norm('/package.json')).toString());
  console.log('asar package.json version =', pkg.version);
}

const nm = list.filter((p) => p.startsWith('/node_modules/')).length;
console.log('node_modules entries =', nm, `(${((nm / list.length) * 100).toFixed(0)}% of archive)`);
process.exit(missing ? 1 : 0);
