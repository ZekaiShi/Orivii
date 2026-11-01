import test from 'node:test'
import assert from 'node:assert/strict'
import {createPresentationPlayer} from '../src/expression.js'
import {DotEyeActor} from '../src/eye-state.js'

function clock(){
  let time=1000,id=0;const tasks=new Map(),played=[]
  const add=(fn,delay)=>{tasks.set(++id,{fn,at:time+delay});return id}
  const player=createPresentationPlayer({play:e=>played.push(e.expression),now:()=>time,setTimer:add,clearTimer:id=>tasks.delete(id)})
  const event=(id,expression,jobId='job')=>({id,expression,jobId,time})
  const advance=ms=>{const end=time+ms;while(true){const next=[...tasks.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;tasks.delete(next[0]);next[1].fn()}time=end}
  return {player,event,advance,played,tasks}
}
test('several stages arriving in one poll play in order once, with a gap for tool state',()=>{
  const {player,event,advance,played,tasks}=clock();player.update('chat',[])
  const events=[event(1,'agree'),event(2,'skeptical'),event(3,'relieved')]
  player.update('chat',events);assert.deepEqual(played,['agree'])
  advance(850);assert.deepEqual(played,['agree','skeptical'])
  player.update('chat',events);advance(1700);assert.deepEqual(played,['agree','skeptical','relieved']);assert.equal(tasks.size,0)
})
test('presentation events skip history, hidden backlog, typing and stale stages; reduced motion has no timer',()=>{
  const {player,event,advance,played,tasks}=clock();player.update('chat',[event(1,'angry')]);assert.equal(played.length,0)
  player.update('chat',[event(2,'agree'),event(3,'happy')]);player.suspend();advance(1000)
  player.update('chat',[event(4,'sad')],{visible:false});advance(1000)
  player.update('chat',[{...event(4,'sad'),time:1500}]);assert.deepEqual(played,['agree'])
  player.update('chat',[event(5,'heart')],{input:true});player.update('chat',[event(5,'heart')]);assert.deepEqual(played,['agree'])
  player.update('chat',[event(6,'curious')],{enabled:false});assert.deepEqual(played,['agree','curious']);assert.equal(tasks.size,0)
  player.update('other',[event(7,'astonished')]);assert.equal(played.length,2)
  player.update('other',[{...event(8,'happy'),time:-10000}]);assert.equal(played.length,2)
  player.cancel()
})
test('a new job drops queued old stages and temporary acknowledgement yields to actual search',()=>{
  const {player,event,advance,played}=clock();player.update('chat',[])
  player.update('chat',[event(1,'agree'),event(2,'skeptical')]);player.update('chat',[event(3,'happy','next')]);advance(2000)
  assert.deepEqual(played,['agree','happy'])
  let time=0;const actor=new DotEyeActor({now:()=>time,render(){},raf:()=>1,cancelRaf(){},setTimer:()=>1,clearTimer(){}})
  actor.setContext({phase:'searching'});assert.equal(actor.cue('agree',{stage:true}),true);assert.equal(actor.mode,'agree')
  time=700;actor.tick();assert.equal(actor.mode,'searching')
  actor.setContext({input:true});assert.equal(actor.cue('happy',{stage:true}),false)
  actor.setContext({input:false,phase:'error'});assert.equal(actor.cue('happy',{stage:true}),false);actor.dispose()
})
