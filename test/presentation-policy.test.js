import test from 'node:test'
import assert from 'node:assert/strict'
import {reviewVisualProse,proseDocument} from '../src/presentation-policy.js'

test('visual prose is reviewed before serialization while source and data remain exact',async()=>{
  const input={version:1,title:'Original title',description:'DRAFT',controls:[{id:'count',type:'slider',label:'Original control',min:0,max:10,value:2}],blocks:[{type:'text',text:'DRAFT'},{type:'cards',items:[{title:'Original card',text:'DRAFT'}]},{type:'metrics',items:[{label:'Original metric',value:42,unit:'units',hint:'DRAFT'}]},{type:'flow',items:[{title:'Original step',text:'DRAFT'}]},{type:'svg',source:'<svg><text>DRAFT</text></svg>',caption:'DRAFT'},{type:'table',columns:['Value'],rows:[['DRAFT'],[4]]}],sources:['https://example.org/DRAFT']}
  const original=JSON.stringify(input),seen=[]
  const result=await reviewVisualProse(input,async value=>{seen.push(value);return 'REVIEWED'})
  assert.deepEqual(seen,['DRAFT']);assert.equal(JSON.stringify(input),original)
  assert.equal(result.description,'REVIEWED');assert.equal(result.blocks[0].text,'REVIEWED');assert.equal(result.blocks[1].items[0].text,'REVIEWED');assert.equal(result.blocks[2].items[0].hint,'REVIEWED');assert.equal(result.blocks[3].items[0].text,'REVIEWED');assert.equal(result.blocks[4].caption,'REVIEWED')
  assert.equal(result.blocks[4].source,input.blocks[4].source);assert.deepEqual(result.blocks[5],input.blocks[5]);assert.equal(result.controls[0].label,'Original control');assert.deepEqual(result.sources,input.sources)
})

test('prose documents are distinguished from code, serialized data and explicit original copies',()=>{
  for(const name of ['note.md','note.markdown','note.txt'])assert.equal(proseDocument(name,'This is a draft explanation.'),true)
  for(const name of ['code.py','data.csv','scene.svg','page.html','data.json'])assert.equal(proseDocument(name,'This is a draft explanation.'),false)
  for(const text of ['{"name":"raw"}','[1,2,3]','1,2,3\n4,5,6','<svg><text>raw</text></svg>'])assert.equal(proseDocument('data.txt',text),false)
  for(const request of ['请原样保存这段话','逐字保存，不要修改','Save the exact text unchanged'])assert.equal(proseDocument('note.md','This is original text.',request),false)
})
