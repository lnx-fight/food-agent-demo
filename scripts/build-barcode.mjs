import {build} from 'esbuild';
await build({entryPoints:[new URL('../frontend/barcode-scanner.js',import.meta.url).pathname],outfile:new URL('../barcode-scanner.js',import.meta.url).pathname,bundle:true,format:'iife',platform:'browser',minify:true,target:'es2022',legalComments:'inline'});

await build({entryPoints:[new URL('../frontend/packaged-foods.js',import.meta.url).pathname],outfile:new URL('../packaged-foods.js',import.meta.url).pathname,bundle:true,format:'iife',platform:'browser',minify:true,target:'es2022'});
