import {build} from 'esbuild';
import {mkdir, copyFile} from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await build({entryPoints:['src/main.js'], bundle:true, outfile:'dist/bundle.js',
  platform:'browser', format:'iife', target:'safari15', sourcemap:false});
await copyFile('src/index.html','dist/index.html');
