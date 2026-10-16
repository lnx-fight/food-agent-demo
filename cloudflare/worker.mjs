import {httpServerHandler} from 'cloudflare:node';
import {server} from '../server.mjs';
import {requestContext} from './runtime.mjs';
import {PUBLIC_FILES} from '../public-files.mjs';

const handler=httpServerHandler(server);
const allowed=new Set(PUBLIC_FILES);
export default {
  async fetch(request,bindings,ctx){
    const path=new URL(request.url).pathname;
    if(!path.startsWith('/api/')){
      let name;
      try{name=path==='/'?'index.html':decodeURIComponent(path.slice(1))}catch{return new Response('Bad request',{status:400})}
      if(!allowed.has(name))return new Response('Not found',{status:404});
      if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
      return bindings.ASSETS.fetch(request);
    }
    if(!bindings.DB)return Response.json({error:'D1 binding DB is not configured'},{status:503});
    const db=bindings.DB.withSession('first-primary');
    return requestContext.run({env:bindings,db},()=>handler.fetch(request,bindings,ctx));
  }
};
