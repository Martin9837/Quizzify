/**
 * Fail on the client-side mistakes that are legal JavaScript and legal JSX.
 *
 * A duplicate JSX attribute compiles fine -- the last one silently wins -- so
 * the build only warns and `vite build` still succeeds. That is how a duplicate
 * `rowKey` sat in Team.jsx: harmless because both copies were identical, but
 * the same pattern hid a real defect in the server, where a second `signal` key
 * made a configurable timeout dead code.
 *
 * esbuild is used purely as a parser here; the output is discarded. It exits 0
 * on warnings by design, so the exit status is decided below.
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['web/src/main.jsx'],
  bundle: true,
  write: false,
  format: 'esm',
  jsx: 'automatic',
  // Every .js in this client contains JSX. Assets are discarded: this run only
  // ever parses, so nothing needs an output path.
  loader: {
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'empty',
    '.svg': 'empty',
    '.png': 'empty',
    '.webmanifest': 'empty',
  },
  logLevel: 'silent',
  // Dependencies are not the subject; our source is.
  external: ['react', 'react-dom', 'react-dom/*', 'react/*', 'react-router-dom'],
}).catch((error) => {
  for (const message of error.errors ?? []) {
    const at = message.location
      ? `${message.location.file}:${message.location.line}:${message.location.column}`
      : 'unknown location';
    console.error(`error: ${message.text}\n  at ${at}`);
  }
  process.exit(1);
});

const warnings = result.warnings ?? [];
for (const warning of warnings) {
  const at = warning.location
    ? `${warning.location.file}:${warning.location.line}:${warning.location.column}`
    : 'unknown location';
  console.error(`${warning.text} [${warning.id || 'warning'}]\n  at ${at}`);
}

if (warnings.length) {
  console.error(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}; treating as failure.`);
  process.exit(1);
}
console.log('lint (web): no warnings');
