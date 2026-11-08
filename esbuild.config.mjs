import esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
  ],
  bundle: true,
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('esbuild is watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('Build completed: dist/extension.cjs');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
