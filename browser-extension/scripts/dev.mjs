import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');

function start(name, args) {
  const child = spawn(process.execPath, [viteBin, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.error(`[dev] ${name} exited with code ${code}`);
    process.exit(code ?? 1);
  });
  return child;
}

const main = start('main', ['build', '--watch']);
const content = start('content', ['build', '--watch', '--mode', 'content']);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    main.kill(signal);
    content.kill(signal);
    process.exit(0);
  });
}
