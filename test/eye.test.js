import test from 'node:test'
import assert from 'node:assert/strict'
import {DotEyeActor,poseForEye} from '../src/eye-state.js'
import {eyeGeometry,EYE_HEART_POINTS} from '../src/eye.js'
import {createExpressionTracker,dotExpression,DOT_EXPRESSIONS,expressionParameter} from '../src/expression.js'
import {visibleReply} from '../src/reply.js'

function clockActor(options={}) {
  let time=0,id=0;const tasks=new Map(),frames=[]
  const add=(fn,delay,kind)=>{tasks.set(++id,{fn,at:time+delay,kind});return id}
  const actor=new DotEyeActor({...options,now:()=>time,random:()=>.5,setTimer:(fn,delay)=>add(fn,delay,'timer'),clearTimer:key=>tasks.delete(key),raf:fn=>add(fn,16,'frame'),cancelRaf:key=>tasks.delete(key),render:(pose,mode,animated)=>frames.push({pose:{...pose},mode,animated,time})})
  function advance(duration){const end=time+duration;let count=0;while(true){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;assert.ok(++count<20000,'scheduler runaway');time=next[1].at;tasks.delete(next[0]);next[1].fn(time)}time=end}
  return {actor,advance,tasks,frames}
}
test('background lookup yields to typing and message expressions without putting the eye to sleep',()=>{
  const {actor,advance,tasks}=clockActor()
  actor.setContext({backgroundPhase:'searching'});advance(200000);assert.equal(actor.mode,'searching')
  actor.setContext({input:true});assert.equal(actor.mode,'input')
  actor.setContext({input:false});actor.cue('happy');assert.equal(actor.mode,'happy')
  advance(12000);assert.equal(actor.mode,'searching')
  actor.setContext({active:false});assert.equal(tasks.size,0)
  actor.setContext({active:true,backgroundPhase:null});assert.equal(actor.mode,'idle')
  actor.dispose()
})
test('idle looks around, becomes half-open then sleepy; work cannot doze and activity wakes immediately',()=>{
  const {actor,advance,frames}=clockActor()
  advance(90500);assert.equal(actor.mode,'tired');assert.ok(actor.pose.lid>.5)
  advance(90000);assert.equal(actor.mode,'sleeping');assert.equal(actor.pose.open,0)
  assert.ok(frames.every(f=>['idle','tired','sleeping'].includes(f.mode)),'idle never fabricates agreement or refusal')
  actor.activity('click');assert.equal(actor.mode,'idle');advance(600);assert.equal(actor.pose.open,1)
  actor.setContext({phase:'searching'});advance(200000);assert.equal(actor.mode,'searching')
  actor.setContext({phase:'error'});advance(2500);assert.equal(actor.mode,'idle','failed work can return to idle')
  actor.dispose()
})
test('drowsy pupil detail drops right, follows the straining eyelid up, then droops with it',()=>{
  const {actor,advance,frames,tasks}=clockActor(),rim=eyeGeometry(actor.pose).rim
  advance(90800)
  const resting=eyeGeometry(actor.pose).pupilDetail
  assert.ok(resting.cy>43+actor.pose.gazeY,'cutout rests below the pupil center')
  assert.ok(resting.cx>50+actor.pose.gazeX,'cutout remains on the right')
  const first=frames.length
  advance(3300)
  const effort=frames.slice(first),peak=effort.reduce((a,b)=>a.pose.lid<b.pose.lid?a:b).pose,raised=eyeGeometry(peak).pupilDetail
  assert.ok(peak.lid>.46&&peak.lid<.51,'small effort keeps the eyelid touching the pupil')
  assert.ok(raised.cy<43+peak.gazeY-2.5,'cutout reaches upper-right with the raised lid')
  assert.equal(actor.pose.lid,.65);assert.equal(actor.pose.gazeY,4)
  assert.deepEqual(eyeGeometry(actor.pose).pupilDetail,resting)
  assert.equal(actor.gesture,null);assert.equal(actor.look,null);assert.equal(actor.blinkUntil,0)
  assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0,'no continuous RAF between efforts')
  for(const {pose} of effort){
    const g=eyeGeometry(pose),dx=g.pupilDetail.cx-50-pose.gazeX,dy=g.pupilDetail.cy-43-pose.gazeY
    assert.ok(dx>=3.19&&Math.abs(Math.hypot(dx,dy)-3.2*Math.SQRT2)<.002,'detail follows a continuous right-side arc')
    assert.deepEqual(g.rim,rim)
  }
  advance(12000);assert.ok(frames.slice(first).filter(f=>f.pose.lid<.51).length>effort.filter(f=>f.pose.lid<.51).length,'later effort is scheduled')
  actor.dispose()
})
test('drowsy effort yields from its current pose to input, tasks, activity, hidden pages and reduced motion',()=>{
  for(const change of ['input','searching','scroll','hidden','reduced']){
    const {actor,advance,tasks}=clockActor();advance(91900)
    assert.equal(actor.gesture?.kind,'drowsyLift');const before={...actor.pose}
    if(change==='scroll')actor.activity('scroll')
    else actor.setContext(change==='input'?{input:true}:change==='searching'?{phase:'searching'}:change==='hidden'?{active:false}:{enabled:false})
    assert.equal(actor.gesture,null);assert.equal(actor.nextDrowsy,Infinity)
    if(change!=='reduced')assert.deepEqual(actor.pose,before,'no snap when interrupted')
    if(['hidden','reduced'].includes(change)){assert.equal(tasks.size,0);advance(20000);assert.equal(tasks.size,0)}
    else{advance(800);assert.ok(actor.pose.lid<=.08);assert.equal(actor.gesture,null)}
    if(change==='hidden'){actor.setContext({active:true});advance(500);assert.equal(actor.mode,'idle');assert.equal(actor.gesture,null)}
    actor.dispose()
  }
})
test('ordinary pupil highlight stays upper-right; half-open waking detail returns upward only as lid rises',()=>{
  for(const mode of ['idle','input','responding','concerned','uncertain']){
    const p=poseForEye(mode),g=eyeGeometry(p)
    assert.equal(g.pupilDetail.cx,50+p.gazeX+3.2);assert.equal(g.pupilDetail.cy,43+p.gazeY-3.2)
  }
  const {actor,advance,frames}=clockActor();advance(181000);const first=frames.length
  actor.activity('input');actor.setContext({input:true});advance(700)
  const shake=frames.slice(first).filter(f=>f.pose.lid>=.6)
  assert.ok(shake.length>0)
  assert.ok(shake.every(f=>eyeGeometry(f.pose).pupilDetail.cy>43+f.pose.gazeY+1.9))
  assert.ok(eyeGeometry(actor.pose).pupilDetail.cy<43+actor.pose.gazeY)
  actor.dispose()
})
test('semantic reactions are interrupted continuously by input/work and do not leak a RAF loop',()=>{
  const {actor,advance,tasks,frames}=clockActor()
  assert.equal(actor.cue('agree'),true);advance(160)
  assert.ok(actor.pose.check>0&&actor.pose.check<1)
  const before={...actor.pose};actor.setContext({input:true})
  assert.deepEqual(actor.pose,before,'interruption starts at the current pose')
  advance(500);assert.equal(actor.mode,'input');assert.equal(actor.pose.gazeY,6);assert.equal(actor.pose.check,0)
  assert.equal(actor.cue('blocked'),false)
  actor.setContext({input:false,phase:'recalling'});assert.equal(actor.cue('happy'),false)
  actor.setContext({phase:null});actor.cue('disagree');advance(1500)
  assert.equal(actor.pose.x,0);assert.equal(actor.pose.tilt,0)
  assert.ok(frames.some(f=>f.mode==='disagree'&&Math.abs(f.pose.x)>1))
  advance(1300);assert.equal(actor.mode,'idle');assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0)
  actor.dispose();assert.equal(tasks.size,0)
})
test('hidden/disposed and reduced motion cancel all animation scheduling and resume without old reactions',()=>{
  const {actor,advance,tasks}=clockActor()
  actor.cue('happy');advance(100);actor.setContext({active:false});assert.equal(tasks.size,0)
  advance(200000);assert.equal(actor.cue('agree'),false)
  actor.setContext({active:true});assert.equal(actor.mode,'idle')
  actor.setContext({enabled:false});assert.equal(tasks.size,0)
  actor.cue('blocked');assert.equal(actor.pose.slash,1);assert.equal(tasks.size,0)
  actor.setContext({phase:'searching'});assert.equal(actor.pose.scan,1);assert.equal(tasks.size,0)
  actor.dispose();actor.activity();actor.setContext({enabled:true});assert.equal(tasks.size,0)
})
test('message reactions baseline on entry, skip history/backlog and fire once per new assistant message',()=>{
  const tracker=createExpressionTracker(),m=(id,time,expression='agree')=>({id,time,role:'assistant',presentation:{expression}})
  assert.equal(tracker.observe('a',[m('one',100)]),null)
  assert.equal(tracker.observe('a',[m('one',100),m('two',200)]).id,'two')
  assert.equal(tracker.observe('a',[m('old',50),m('one',100),m('two',200)]),null)
  assert.equal(tracker.observe('b',[m('other',300)]),null)
  assert.equal(tracker.observe('a',[m('one',100),m('two',200)]),null)
  tracker.resume(500)
  assert.equal(tracker.observe('a',[m('two',200),m('hidden',450)]),null)
  assert.equal(tracker.observe('a',[m('hidden',450),m('fresh',550)]).id,'fresh')
  assert.equal(tracker.observe('a',[m('fresh',550)]),null)
  assert.equal(dotExpression({script:'bad'}),'neutral');assert.equal(dotExpression('arbitrary-script'),'neutral')
})
test('eye, check and prohibition share a continuous path topology and every pose stays finite',()=>{
  const poses=['idle','input','responding','searching','recalling','agree','disagree','happy','concerned','uncertain','blocked','tired','sleeping','heart','curious','surprised','confused','astonished','angry','sad','excited','relieved','skeptical','shy']
  const paths=poses.map(mode=>eyeGeometry(poseForEye(mode)))
  for(const path of paths){assert.doesNotMatch(JSON.stringify(path),/NaN|Infinity/);assert.equal(path.inner.match(/[A-Z]/g).join(''),'MCCCCCCCC');assert.deepEqual(path.rim,paths[0].rim)}
  assert.notEqual(paths[0].inner,paths[5].inner)
  const mid=eyeGeometry({...poseForEye('idle'),check:.5})
  assert.notEqual(mid.inner,paths[0].inner);assert.notEqual(mid.inner,paths[5].inner)
})

test('microexpressions survive reply parsing, remain distinct, and interrupt from the current pose',()=>{
  const {actor,advance,tasks}=clockActor(),rim=eyeGeometry(actor.pose).rim,shapes=new Set()
  assert.deepEqual(expressionParameter.enum,[...DOT_EXPRESSIONS])
  for(const expression of ['angry','sad','excited','relieved','skeptical','shy']){
    assert.deepEqual(visibleReply(`[dot-reply:${expression}]\n这是一句普通回复。`),{expression,text:'这是一句普通回复。'})
    const before={...actor.pose};assert.equal(actor.cue(expression),true);assert.deepEqual(actor.pose,before)
    advance(180)
    const moving=eyeGeometry(actor.pose);assert.deepEqual(moving.rim,rim);assert.doesNotMatch(JSON.stringify(moving),/NaN|Infinity/)
    const target=eyeGeometry(poseForEye(expression));shapes.add(JSON.stringify([target.microPaths,target.smilePaths,target.inner,target.microPupils]))
    actor.setContext({phase:'searching'});assert.equal(actor.mode,'searching');advance(500)
    assert.equal(eyeGeometry(actor.pose).micro,0,'work clears old emotional eyes')
    actor.setContext({phase:null})
  }
  assert.equal(shapes.size,6)
  actor.cue('angry');actor.setContext({enabled:false});assert.equal(actor.pose.angry,1);assert.equal(tasks.size,0)
  actor.setContext({active:false});assert.equal(tasks.size,0);actor.setContext({active:true});assert.equal(actor.mode,'idle')
  actor.dispose()
})

test('complex moods use paired eyes inside the same circle while idle retains the original pupil',()=>{
  const baseline=eyeGeometry(poseForEye('idle'))
  for(const mode of ['angry','sad','relieved','skeptical','shy']){
    const pose=poseForEye(mode),g=eyeGeometry(pose)
    assert.equal(g.smile,0);assert.equal(g.faceOpacity,0);assert.equal(g.micro,1)
    assert.equal(g.microPaths.length,2);assert.notEqual(g.microPaths[0],g.microPaths[1])
    assert.equal(g.microPupils.length,2)
    assert.deepEqual(g.rim,baseline.rim)
    for(const pupil of g.microPupils)assert.equal(pupil.opacity,mode==='relieved'?0:1)
  }
  assert.equal(baseline.micro,0);assert.equal(baseline.faceOpacity,1)
  for(const mode of DOT_EXPRESSIONS)assert.equal(eyeGeometry(poseForEye(mode)).smile,['happy','excited'].includes(mode)?1:0)
})

test('live reply expression outlasts its one-shot gesture, settles after completion, and yields to real activity',()=>{
  const {actor,advance,tasks}=clockActor()
  actor.setContext({phase:'responding'});actor.cue('happy',{duringReply:true});advance(4000)
  assert.equal(actor.mode,'happy');assert.equal(actor.gesture,null,'gesture does not repeat during a long reply')
  assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0,'holding an eye pose does not create a permanent RAF loop')
  advance(4000);assert.equal(actor.mode,'happy')
  actor.setContext({phase:null});advance(800);assert.equal(actor.mode,'happy');advance(1000);assert.equal(actor.mode,'idle')
  actor.setContext({phase:'responding'});actor.cue('sad',{duringReply:true});advance(4000)
  actor.setContext({input:true});assert.equal(actor.mode,'input');assert.equal(actor.reaction,null)
  actor.setContext({input:false});actor.cue('curious',{duringReply:true});actor.setContext({phase:'searching'});assert.equal(actor.mode,'searching');assert.equal(actor.reaction,null)
  actor.setContext({phase:'responding'});actor.cue('heart',{duringReply:true});actor.setContext({active:false});assert.equal(tasks.size,0)
  actor.setContext({active:true});assert.equal(actor.mode,'responding');assert.equal(actor.reaction,null,'hidden replies never replay')
  actor.dispose()
})

test('heart has a smooth cleft and rounded bottom with tangent continuity at every curve join',()=>{
  const points=EYE_HEART_POINTS
  for(let i=0;i<8;i++){
    const end=(i+1)*3,p=points[end],before=points[end-1],after=points[(end+1)%24]
    const a=p.map((v,j)=>v-before[j]),b=after.map((v,j)=>v-p[j])
    assert.ok(Math.abs(a[0]*b[1]-a[1]*b[0])<.01,'no sharp turn at segment '+i)
    assert.ok(a[0]*b[0]+a[1]*b[1]>0,'no cusp at segment '+i)
  }
  const happy=eyeGeometry(poseForEye('happy'))
  const idle=eyeGeometry(poseForEye('idle'))
  assert.equal(happy.smile,1);assert.equal(happy.smilePaths.length,2)
  assert.notEqual(happy.smilePaths[0],happy.smilePaths[1],'happy has two inward squints')
  assert.equal(idle.smilePaths[0],idle.smilePaths[1],'both eyes originate at the single pupil')
  for(const lower of [0,.2,.45,.7,.9]){
    const transition=eyeGeometry({...poseForEye('happy'),lower})
    assert.deepEqual(transition.rim,idle.rim,'only internal eyes split; the body remains circular')
    assert.doesNotMatch(transition.smilePaths.join(' '),/NaN|Infinity/)
  }
  assert.equal(idle.smile,0)
})

test('blink moves the upper lid, dips and rebounds without squashing the original circular rim',()=>{
  const {actor,advance,frames,tasks}=clockActor(),initial=eyeGeometry(actor.pose)
  assert.equal(initial.rim.stroke,9.2,'balanced rim weight')
  assert.ok(Math.abs(initial.rim.r*2+initial.rim.stroke-62.4)<1e-9,'outer diameter stays unchanged')
  actor.activity('click');advance(112)
  assert.ok(actor.pose.open<.03);assert.ok(actor.pose.y>2)
  const closed=eyeGeometry(actor.pose)
  assert.notEqual(closed.upper,initial.upper);assert.equal(closed.lower,initial.lower)
  assert.deepEqual(closed.rim,initial.rim)
  advance(1200)
  assert.ok(frames.some(f=>f.pose.y<-.2),'release visibly overshoots the anchor')
  assert.equal(actor.pose.y,0);assert.equal(actor.pose.open,1)
  assert.ok(frames.every(f=>f.pose.sx===1&&f.pose.sy===1))
  assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0)
  actor.dispose()
})

test('thinking follows a clockwise arc; the body follows then returns while the pupil holds its gaze',()=>{
  const {actor,advance}=clockActor()
  actor.setContext({phase:'recalling'});advance(160)
  assert.ok(actor.pose.gazeX<0&&actor.pose.gazeY>0);assert.ok(actor.pose.x<0&&actor.pose.y>0)
  advance(490);assert.ok(actor.pose.gazeX<0&&actor.pose.gazeY<0)
  advance(750);assert.ok(actor.pose.gazeX>0&&actor.pose.gazeY<0)
  advance(900);assert.ok(Math.abs(actor.pose.x)<.01&&Math.abs(actor.pose.y)<.01)
  assert.ok(actor.pose.gazeX>4&&actor.pose.gazeY<-3,'eyes hold after the body returns')
  actor.dispose()
})

test('happy sways in both axes and a fast interruption preserves position and velocity',()=>{
  const {actor,advance,frames,tasks}=clockActor()
  actor.cue('happy');advance(1050)
  assert.ok(frames.some(f=>f.pose.x>1)&&frames.some(f=>f.pose.x<-1))
  assert.ok(frames.some(f=>f.pose.y<-4));assert.ok(actor.pose.lower>.8)
  const position={...actor.pose},velocity={...actor.velocity}
  actor.setContext({input:true});assert.deepEqual(actor.pose,position);assert.deepEqual(actor.velocity,velocity)
  advance(1000);assert.equal(actor.mode,'input');assert.equal(actor.pose.x,0)
  assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0)
  actor.dispose()
})

test('sidebar only glances gently and cancels every timer when inactive or animation is disabled',()=>{
  const {actor,advance,frames,tasks}=clockActor({compact:true})
  advance(12000);assert.ok(frames.some(f=>Math.abs(f.pose.gazeX)>3))
  assert.ok(frames.every(f=>Math.abs(f.pose.x)<2&&f.pose.open===1&&f.pose.lower===0))
  assert.equal(actor.cue('happy'),false)
  actor.setContext({active:false});assert.equal(tasks.size,0)
  actor.setContext({active:true,enabled:false});assert.equal(tasks.size,0)
  advance(200000);assert.equal(actor.mode,'idle');actor.dispose()
})

test('real search morphs into information rows, suppresses blinking and restores idle scheduling after a long lookup',()=>{
  const {actor,advance,tasks}=clockActor(),rim=eyeGeometry(actor.pose).rim
  actor.setContext({phase:'searching'});advance(96)
  assert.ok(actor.pose.scan>0&&actor.pose.scan<1,'entry morph is continuous')
  advance(700);assert.equal(actor.pose.scan,1);assert.equal(actor.pose.open,1)
  assert.equal(tasks.size,0,'settled information scrolling uses CSS, not JS timers or a permanent RAF')
  assert.deepEqual(eyeGeometry(actor.pose).rim,rim)
  advance(190000);assert.equal(actor.mode,'searching');assert.equal(actor.pose.sleep,0)
  actor.setContext({input:true});advance(600)
  assert.equal(actor.mode,'input');assert.equal(actor.pose.scan,0)
  actor.setContext({input:false,phase:null});advance(600)
  assert.equal(actor.mode,'idle');assert.ok(tasks.size>0,'idle blink/gaze timers resume')
  assert.equal(actor.pose.check,0,'query completion does not fabricate an agreement cue')
  actor.cue('agree');advance(500);assert.equal(actor.pose.check,1)
  actor.dispose();assert.equal(tasks.size,0)
})

test('waking stays half-lidded through a fast spherical head shake, across typing/submission without delaying work',()=>{
  const {actor,advance,frames,tasks}=clockActor()
  advance(181000);assert.equal(actor.mode,'sleeping')
  const pose={...actor.pose},velocity={...actor.velocity},first=frames.length
  actor.activity('input');const start=actor.gesture.start
  assert.deepEqual(actor.pose,pose);assert.deepEqual(actor.velocity,velocity)
  actor.setContext({input:true});advance(120)
  assert.equal(actor.gesture.start,start);assert.ok(actor.pose.open>.98);assert.ok(actor.pose.lid>.6)
  actor.activity('input');actor.setContext({input:false,phase:'responding'})
  assert.equal(actor.mode,'responding');assert.equal(actor.gesture.start,start)
  advance(1800)
  const waking=frames.slice(first)
  assert.ok(waking.some(f=>f.pose.x>1)&&waking.some(f=>f.pose.x<-1),'head shakes in both directions')
  const shaking=waking.filter(f=>f.time-start>=80&&f.time-start<=310)
  assert.ok(shaking.every(f=>f.pose.lid>=.6),'half-open lid stays down throughout the shake')
  assert.ok(shaking.some(f=>f.pose.yaw>.3)&&shaking.some(f=>f.pose.yaw<-.3),'sphere turns in both directions')
  assert.ok(waking.every(f=>Math.abs(f.pose.y)<2.1),'no upward startle or vertical bounce')
  assert.ok(waking.filter(f=>f.time-start>=750).every(f=>Math.abs(f.pose.x)<.05&&Math.abs(f.pose.yaw)<.01),'faster gesture has already settled')
  assert.equal(actor.gesture,null);assert.equal(actor.pose.x,0);assert.equal(actor.pose.y,0)
  assert.equal(actor.pose.yaw,0)
  assert.equal(actor.pose.sleep,0);assert.equal(actor.pose.lid,.12)
  assert.equal([...tasks.values()].filter(t=>t.kind==='frame').length,0)
  actor.dispose()
})

test('head turning projects only the internal face and never scales the circular body',()=>{
  const base=eyeGeometry(poseForEye('tired')),left=eyeGeometry({...poseForEye('tired'),yaw:-1,x:-7}),right=eyeGeometry({...poseForEye('tired'),yaw:1,x:7})
  assert.deepEqual(left.rim,base.rim);assert.deepEqual(right.rim,base.rim)
  for(const geometry of [base,left,right])assert.doesNotMatch(geometry.transform,/scale|skew|matrix/,'body only translates and rotates')
  assert.match(left.faceTransform,/translate\(-6 0\)/);assert.match(right.faceTransform,/translate\(6 0\)/)
  assert.match(base.faceTransform,/scale\(1 1\)/)
  assert.equal(left.upper,base.upper);assert.equal(right.upper,base.upper,'turning never lifts the sleepy eyelid')
})

test('fresh replies wake a sleeping character; navigation, reduced motion and hidden pages never replay waking',()=>{
  const {actor,advance,tasks}=clockActor()
  advance(181000);actor.cue('neutral');assert.equal(actor.gesture.kind,'wake')
  advance(100);actor.setContext({active:false});assert.equal(tasks.size,0)
  actor.setContext({active:true});assert.equal(actor.gesture,null)
  advance(181000);actor.activity('navigation');assert.equal(actor.gesture,null)
  advance(181000);actor.setContext({phase:'searching'});assert.equal(actor.gesture.kind,'wake')
  assert.equal(actor.mode,'searching','status is available immediately during wake motion')
  actor.setContext({enabled:false});assert.equal(actor.gesture,null);assert.equal(actor.pose.scan,1);assert.equal(tasks.size,0)
  actor.dispose()
})

test('punctuation morphs from the pupil, remains finite when interrupted, and never changes the circular rim',()=>{
  const {actor,advance,tasks}=clockActor(),rim=eyeGeometry(actor.pose).rim
  for(const mode of ['curious','surprised','confused','astonished']){
    assert.equal(dotExpression(mode),mode);actor.cue(mode);advance(96)
    const halfway=eyeGeometry(actor.pose)
    assert.ok(halfway.dotOpacity>0&&halfway.dotOpacity<1)
    assert.equal(halfway.inner.match(/[A-Z]/g).join(''),'MCCCCCCCC')
    advance(650);const settled=eyeGeometry(actor.pose)
    assert.deepEqual(settled.rim,rim);assert.equal(settled.fillOpacity,0);assert.equal(settled.dotOpacity,1)
    assert.equal(settled.sideOpacity,['confused','astonished'].includes(mode)?1:0)
    assert.doesNotMatch(JSON.stringify(settled),/NaN|Infinity/)
    const before={...actor.pose};actor.setContext({input:true});assert.deepEqual(actor.pose,before)
    advance(650);assert.equal(actor.pose.question,0);assert.equal(actor.pose.exclaim,0);assert.equal(actor.pose.multiple,0)
    actor.setContext({input:false});advance(650)
  }
  actor.dispose();assert.equal(tasks.size,0)
})
