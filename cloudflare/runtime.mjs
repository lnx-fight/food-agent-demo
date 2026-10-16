import {AsyncLocalStorage} from 'node:async_hooks';

export const isCloudflare=true;
export const requestContext=new AsyncLocalStorage();
const defaults={NODE_ENV:'production',COOKIE_SECURE:'true'};
// Secrets and bindings stay inside their request; never mutate process.env.
export const env=new Proxy(defaults,{get:(target,key)=>requestContext.getStore()?.env[key]??target[key]});

export class DatabaseSync{
  isD1=true;
  connection(){
    const db=requestContext.getStore()?.db;
    if(!db)throw new Error('D1 request context is missing');
    return db;
  }
  prepare(sql){
    const bind=params=>this.connection().prepare(sql).bind(...params.map(value=>typeof value==='bigint'?Number(value):value));
    return {
      get:async(...params)=>(await bind(params).first())??undefined,
      all:async(...params)=>(await bind(params).all()).results,
      run:async(...params)=>{
        const result=await bind(params).run();
        return {changes:result.meta.changes,lastInsertRowid:result.meta.last_row_id};
      }
    };
  }
  batch(statements){return this.connection().batch(statements.map(([sql,params=[]])=>this.connection().prepare(sql).bind(...params)))}
  exec(){throw new Error('Run schema migrations before deploying Pages')}
}
