/**
 * Development runner: starts the API and the Vite dev server together, seeding
 * the database first if it is empty. One command, no ordering to remember.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbFile = process.env.DATABASE_FILE || path.join(root, 'server/data/salesos.db');

const children = [];
function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`\n[${name}] exited with code ${code}\n`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  if (!fs.existsSync(dbFile)) {
    process.stdout.write('No database found -- seeding demo data first...\n');
    await new Promise((resolve, reject) => {
      const seeder = spawn('node', ['--no-warnings', 'src/db/seed.js', '--reset'], {
        cwd: path.join(root, 'server'),
        stdio: 'inherit',
      });
      seeder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed failed (${code})`))));
    });
  }

  run('api', 'node', ['--no-warnings', '--watch', 'src/index.js'], path.join(root, 'server'));
  run('web', 'npx', ['vite'], path.join(root, 'web'));

  process.stdout.write('\nSalesOS is starting.\n  API  http://localhost:4000\n  App  http://localhost:5173\n\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  shutdown(1);
});
