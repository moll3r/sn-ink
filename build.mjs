import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const res = await build({
  entryPoints: ['src/main.js'],
  bundle: true, minify: true, write: false, outdir: 'out',
  format: 'iife', target: ['safari15'],
});
const js = res.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = res.outputFiles.find((f) => f.path.endsWith('.css')).text;
const html = readFileSync('src/index.html', 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => js.replace(/<\/script/gi, '<\\/script'));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', html.length, 'bytes');
