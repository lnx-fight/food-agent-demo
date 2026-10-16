import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qwenChat} from '../server.mjs';

const ENV_KEYS=['DASHSCOPE_API_KEY','QWEN_BASE_URL','QWEN_REQUEST_TIMEOUT_MS','QWEN_REQUEST_RETRIES','QWEN_RETRY_BASE_MS'];
function saveEnvironment(){return Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]))}
function restoreEnvironment(saved){for(const key of ENV_KEYS){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]}}
function configureRequestTest(){
  process.env.DASHSCOPE_API_KEY='test-key';
  process.env.QWEN_BASE_URL='https://example.invalid/v1';
  process.env.QWEN_REQUEST_TIMEOUT_MS='1234';
  process.env.QWEN_REQUEST_RETRIES='1';
  process.env.QWEN_RETRY_BASE_MS='0';
}

test('千问瞬时网络错误会在超时边界内重试一次',async()=>{
  const saved=saveEnvironment(),originalFetch=globalThis.fetch;let calls=0,receivedSignal=null;
  configureRequestTest();
  globalThis.fetch=async(_url,options)=>{
    calls++;receivedSignal=options.signal;
    if(calls===1)throw new TypeError('fetch failed');
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{}'}}]})};
  };
  try{
    const response=await qwenChat({model:'test-model',messages:[]});
    assert.equal(calls,2);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(response.choices[0].message.content,'{}');
  }finally{globalThis.fetch=originalFetch;restoreEnvironment(saved)}
});

test('千问非瞬时4xx错误不重试',async()=>{
  const saved=saveEnvironment(),originalFetch=globalThis.fetch;let calls=0;
  configureRequestTest();
  globalThis.fetch=async()=>{calls++;return {ok:false,status:400,json:async()=>({error:{message:'bad request'}})}};
  try{
    await assert.rejects(()=>qwenChat({model:'test-model',messages:[]}),/1次尝试.*bad request/);
    assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;restoreEnvironment(saved)}
});
