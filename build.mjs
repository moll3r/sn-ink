import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.js'], bundle: true, minify: true, outfile: 'dist/app.js',
  format: 'iife', target: ['safari15'], loader: { '.css': 'text', '.html': 'text' },
});
copyFileSync('src/index.html', 'dist/index.html');
console.log('built dist/index.html + dist/app.js');
