import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cosineSimilarity} from '../server.mjs';

test('相同向量相似度为1',()=>{
  assert.equal(cosineSimilarity([1,0,0],[1,0,0]),1);
});

test('正交向量相似度为0',()=>{
  assert.ok(Math.abs(cosineSimilarity([1,0,0],[0,1,0]))<1e-9);
});

test('长度不同返回0',()=>{
  assert.equal(cosineSimilarity([1,0],[1,0,0]),0);
});
