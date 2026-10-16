import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,sep,extname} from 'node:path';

// 仅发布浏览器实际使用的文件，禁止把源码、密钥和用户数据库当作静态资源。
export const PUBLIC_FILES=Object.freeze([
  'index.html','app.js','adaptive-plan.js','sw.js','styles.css','pantry.css',
  'onboarding.css','api.css','record-status.css','adaptive-plan.css','account-ui.js','account.css'
]);
const allowed=new Set(PUBLIC_FILES);
const root=realpathSync(fileURLToPath(new URL('.',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};

export function servePublicFile(req,res,pathname){
  const finish=(status,message,headers={})=>{
    res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff',...headers});
    res.end(req.method==='HEAD'?undefined:message);
  };
  if(req.method!=='GET'&&req.method!=='HEAD')return finish(405,'Method not allowed',{Allow:'GET, HEAD'});
  let name;
  try{name=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1))}catch{return finish(400,'Bad request')}
  if(!allowed.has(name))return finish(404,'Not found');
  let content;
  try{
    const path=realpathSync(resolve(root,name));
    if(!path.startsWith(root+sep))return finish(404,'Not found');
    content=readFileSync(path);
  }catch{return finish(404,'Not found')}
  res.writeHead(200,{'Content-Type':types[extname(name)],'Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
  res.end(req.method==='HEAD'?undefined:content);
}
