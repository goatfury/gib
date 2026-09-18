import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonMetadata, socketMetadata, withinComparisonBudget } from '../m1/promotions-transport-compare.mjs';
const meta={arm:'A',nodeVersion:'v22.0.0',undiciVersion:'6.27.0',context:'deploy-preview',region:'us-east-1',deploymentId:'a'.repeat(24),instanceId:'b'.repeat(24),
  invocation:1,warm:false,endpointHash:'c'.repeat(64),deadlineMs:25000,maxResponseBytes:1000000,redirectLimit:20,errorCode:'none'};
test('comparison metadata rejects raw/private fields and preserves only exact safe schemas',()=>{
  assert.deepEqual(comparisonMetadata(JSON.stringify(meta)),meta);
  for(const value of [{...meta,url:'PRIVATE'},{...meta,errorCode:'PRIVATE'},{...meta,region:'PRIVATE'},{...meta,endpointHash:'PRIVATE'},{...meta,nodeVersion:'PRIVATE'}]) assert.equal(comparisonMetadata(JSON.stringify(value)),null);
  const hop={hop:1,dnsMs:2,connectMs:3,tlsMs:8,headersMs:20,reused:false,errorCode:'none'};
  assert.deepEqual(socketMetadata(JSON.stringify([hop])),[hop]);
  for(const value of [{...hop,url:'PRIVATE'},{...hop,errorCode:'PRIVATE'},{...hop,tlsMs:-1}])assert.equal(socketMetadata(JSON.stringify([value])),null);
});
test('comparison stops at either request or elapsed-time boundary without resetting the budget',()=>{
  assert.equal(withinComparisonBudget({attempts:11,startedAt:1000},900999),true);
  assert.equal(withinComparisonBudget({attempts:12,startedAt:1000},2000),false);
  assert.equal(withinComparisonBudget({attempts:1,startedAt:1000},901000),false);
});
