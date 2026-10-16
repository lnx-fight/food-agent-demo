import {build} from 'esbuild';
import {readFile,readdir,mkdir,rm,copyFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PUBLIC_FILES} from '../public-files.mjs';

const root=resolve(import.meta.dirname,'..'),out=resolve(root,'dist');
const files={};
async function include(dir){
  for(const entry of await readdir(resolve(root,dir),{withFileTypes:true})){
    const path=`${dir}/${entry.name}`;
    if(entry.isDirectory())await include(path);
    else if(entry.name.endsWith('.md'))files[`/app/${path}`]=await readFile(resolve(root,path),'utf8');
  }
}
files['/app/data/foods.json']=await readFile(resolve(root,'data/foods.json'),'utf8');
await include('skills');
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
await Promise.all(PUBLIC_FILES.map(name=>copyFile(resolve(root,name),resolve(out,name))));
await writeFile(resolve(out,'_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]}));
await build({
  entryPoints:[resolve(root,'cloudflare/worker.mjs')],outfile:resolve(out,'_worker.js'),bundle:true,
  format:'esm',platform:'neutral',target:'es2022',minify:true,
  external:['node:*','cloudflare:*'],define:{'import.meta.url':JSON.stringify('file:///app/server.mjs')},
  plugins:[{name:'cloudflare-runtime',setup(builder){
    builder.onResolve({filter:/^\.\/runtime\.mjs$/},args=>args.importer.endsWith('/server.mjs')||args.importer.endsWith('/accounts.mjs')?{path:resolve(root,'cloudflare/runtime.mjs')}:undefined);
    builder.onResolve({filter:/^node:sqlite$/},()=>({path:resolve(root,'cloudflare/runtime.mjs')}));
    builder.onResolve({filter:/^node:fs$/},()=>({path:resolve(root,'cloudflare/virtual-fs.mjs')}));
    builder.onResolve({filter:/^virtual:source-files$/},()=>({path:'source-files',namespace:'virtual'}));
    builder.onLoad({filter:/.*/,namespace:'virtual'},()=>({contents:`export default ${JSON.stringify(files)}`,loader:'js'}));
  }}]
});
console.log(`Pages build: ${PUBLIC_FILES.length} public files + bundled API; secrets and SQLite files excluded.`);
