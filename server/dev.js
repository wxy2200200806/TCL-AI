import { spawn } from 'node:child_process';

const commands = [
  ['node', ['server/index.js'], 'server'],
  ['npx', ['vite', '--host', '0.0.0.0', '--port', '5173'], 'client']
];

const children = commands.map(([cmd, args, name]) => {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[${name}] exited with code ${code}`);
  });
  return child;
});

process.on('SIGINT', () => {
  children.forEach((child) => child.kill('SIGINT'));
  process.exit(0);
});
