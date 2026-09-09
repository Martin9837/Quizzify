/**
 * Fail on the mistakes that are legal JavaScript.
 *
 * A duplicate key in an object literal is valid code -- the last one silently
 * wins -- so `node --check` passes and the tests pass, and the discarded value
 * is simply never used. That is how a configurable STT timeout shipped as dead
 * code behind a second `signal` key. Only a real parser sees it.
 *
 * esbuild is used purely as that parser: the whole module graph is walked and
 * the output thrown away. It exits 0 on warnings by design, so the exit status
 * is decided here instead.
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  // The server's own dependencies are not the subject; our source is.
  external: ['express', 'cors', 'node:*'],
}).catch((error) => {
  for (const message of error.errors ?? []) {
    console.error(`error: ${message.text}\n  ${message.location?.file}:${message.location?.line}`);
  }
  process.exit(1);
});

const warnings = result.warnings ?? [];
for (const warning of warnings) {
  const where = warning.location
    ? `${warning.location.file}:${warning.location.line}:${warning.location.column}`
    : 'unknown location';
  console.error(`${warning.text} [${warning.id || 'warning'}]\n  at ${where}`);
  if (warning.notes?.length) {
    for (const note of warning.notes) {
      const at = note.location ? `${note.location.file}:${note.location.line}` : '';
      console.error(`  ${note.text}${at ? ` (${at})` : ''}`);
    }
  }
}

if (warnings.length) {
  console.error(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}; treating as failure.`);
  process.exit(1);
}
console.log('lint: no warnings');
