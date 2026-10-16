import files from 'virtual:source-files';
import {normalize} from 'node:path';

const key=path=>normalize(String(path));
export function readFileSync(path,encoding){
  const data=files[key(path)];
  if(data===undefined)throw new Error('Bundled file not found');
  return encoding?data:Buffer.from(data);
}
export const existsSync=path=>Object.hasOwn(files,key(path));
export const mkdirSync=()=>{};
export const realpathSync=path=>key(path);
export function readdirSync(path,options={}){
  const prefix=key(path).replace(/\/$/,'')+'/',entries=new Map();
  for(const file of Object.keys(files))if(file.startsWith(prefix)){
    const rest=file.slice(prefix.length),name=rest.split('/')[0];
    entries.set(name,rest.includes('/'));
  }
  return [...entries].map(([name,isDir])=>options.withFileTypes?{name,isDirectory:()=>isDir}:name);
}
