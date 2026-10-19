import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
];

for (const [from, to] of pairs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  console.log(`[copy] ${from} -> ${to}`);
}
