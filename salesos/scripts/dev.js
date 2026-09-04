/**
 * Development runner: starts the API and the Vite dev server together, seeding
 * the database first if it is empty. One command, no ordering to remember.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbFile = process.env.DATABASE_FILE || path.join(root, 'server/data/salesos.db');

const apiPort = Number(process.env.PORT || 4000);
const webPort = Number(process.env.WEB_PORT || 5173);

/**
 * Is anything already listening here?
 *
 * Worth checking before starting anything, because the failure it prevents is
 * genuinely baffling. The API would lose the bind, the web server would start
 * anyway and proxy to whatever else owns the port, and signing in would fail
 * with that service's 404 -- an error that says nothing about a port conflict.
 * The API also runs under --watch, which keeps the process alive after a fatal
 * startup error, so nothing else here would notice either.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

async function requireFreePorts() {
  const conflicts = [];
  if (await portInUse(apiPort)) conflicts.push(['API', apiPort, 'PORT']);
  if (await portInUse(webPort)) conflicts.push(['web app', webPort, 'WEB_PORT']);
  if (!conflicts.length) return;

  const lines = conflicts.map(([what, port]) => `  port ${port} (the ${what}) is already in use`);
  process.stderr.write(
    `\nSalesOS cannot start:\n${lines.join('\n')}\n\n`
    + `See what is using it:\n`
    + conflicts.map(([, port]) => `  lsof -i :${port}`).join('\n')
    + `\n\nThen either stop that process, or run SalesOS on a different port:\n`
    + `  ${conflicts.map(([, port, variable]) => `${variable}=${port + 1}`).join(' ')} npm run dev\n\n`,
  );
  process.exit(1);
}

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
  await requireFreePorts();

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

  process.stdout.write(`\nSalesOS is starting.\n  API  http://localhost:${apiPort}\n  App  http://localhost:${webPort}\n\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  shutdown(1);
});
