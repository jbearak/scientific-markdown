import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  outdir: 'out',
  // Keep __dirname/__filename as runtime values (esbuild default for
  // platform:'node'), which csl-loader.ts relies on to find bundled
  // CSL styles relative to the output directory.
};

/** @type {import('esbuild').BuildOptions[]} */
const configs = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    external: ['vscode'],
    outbase: 'src',
  },
  {
    ...shared,
    entryPoints: ['src/lsp/server.ts'],
    // Flatten into out/server.js (not out/lsp/server.js) so the
    // extension can find it at context.asAbsolutePath('out/server.js').
    outbase: 'src/lsp',
    external: [],
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('[esbuild] watching for changes…');
} else {
  await Promise.all(configs.map(c => esbuild.build(c)));
}
