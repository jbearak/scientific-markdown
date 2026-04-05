#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'out');
const isWatch = process.argv.includes('--watch');

function cleanOutput() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, 'lsp'), { recursive: true });
}

function copyDirectory(sourceRelativePath, destinationRelativePath) {
  const sourcePath = path.join(repoRoot, sourceRelativePath);
  const destinationPath = path.join(repoRoot, destinationRelativePath);
  rmSync(destinationPath, { recursive: true, force: true });
  cpSync(sourcePath, destinationPath, { recursive: true });
}

function copyStaticAssets() {
  copyDirectory('src/csl-styles', 'out/csl-styles');
  copyDirectory('src/csl-locales', 'out/csl-locales');
}

function copyAssetsPlugin() {
  return {
    name: 'copy-static-assets',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          copyStaticAssets();
        }
      });
    },
  };
}

const sharedOptions = {
  absWorkingDir: repoRoot,
  bundle: true,
  charset: 'utf8',
  external: ['vscode'],
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
  platform: 'node',
  target: 'node20',
  tsconfig: path.join(repoRoot, 'tsconfig.json'),
};

const buildOptions = [
  {
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    plugins: [copyAssetsPlugin()],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/lsp/server.ts'],
    outfile: 'out/lsp/server.js',
  },
];

async function main() {
  cleanOutput();
  copyStaticAssets();

  if (isWatch) {
    const contexts = await Promise.all(buildOptions.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching extension bundles...');
    process.stdin.resume();
    return;
  }

  for (const options of buildOptions) {
    await esbuild.build(options);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
