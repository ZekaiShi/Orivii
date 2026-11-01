import {dotExpression} from './expression.js'

export const EYE_TIMING=Object.freeze({tired:90000,sleep:180000,reaction:2100,replySettle:1200,gesture:800,happy:1350,excited:1500,angry:650,relieved:1100,wake:380,drowsyLift:1900,arc:1250,look:2600})
export const eyePose=()=>({open:1,lid:0,lower:0,gazeX:0,gazeY:0,tilt:0,x:0,y:0,yaw:0,sx:1,sy:1,check:0,slash:0,sleep:0,scan:0,question:0,exclaim:0,multiple:0,heart:0,angry:0,sad:0,relieved:0,skeptical:0,shy:0})
const clamp=value=>Math.max(0,Math.min(1,value))
const smooth=value=>{const t=clamp(value);return t*t*(3-2*t)}
export function poseForEye(mode,gaze={x:0,y:0}) {
  const p=eyePose()
  if(mode==='idle'){p.gazeX=gaze.x;p.gazeY=gaze.y}
  if(mode==='input'){p.gazeY=6;p.lid=.08}
  if(mode==='responding'){p.lid=.12;p.gazeY=-2}
  if(mode==='searching')p.scan=1
  if(mode==='recalling'){p.gazeX=5;p.gazeY=-5;p.tilt=3}
  if(mode==='agree')p.check=1
  if(mode==='blocked')p.slash=1
  if(mode==='happy'||mode==='excited'){p.lower=.9;p.y=-2}
  if(mode==='angry'){p.angry=1;p.y=1}
  if(mode==='sad'){p.sad=1;p.y=3;p.tilt=-4}
  if(mode==='relieved'){p.relieved=1;p.y=1}
  if(mode==='skeptical'){p.skeptical=1;p.tilt=6;p.gazeX=-2}
  if(mode==='shy'){p.shy=1;p.gazeX=5;p.gazeY=4;p.tilt=7}
  if(mode==='heart'){p.heart=1;p.y=-2}
  if(mode==='curious'||mode==='confused'){p.question=1;p.tilt=mode==='confused'?-7:-4}
  if(mode==='surprised'||mode==='astonished'){p.exclaim=1;p.y=-2}
  if(mode==='confused'||mode==='astonished')p.multiple=1
  if(mode==='concerned'){p.lid=.25;p.tilt=-5;p.gazeY=3}
  if(mode==='uncertain'||mode==='error'){p.lid=.2;p.tilt=7;p.gazeX=-3}
  if(mode==='tired'){p.lid=.65;p.gazeY=4;p.tilt=-3}
  if(mode==='sleeping'){p.open=0;p.sleep=1;p.tilt=-5;p.y=2}
  return p
}

// Exact damped-spring integration. Retargeting preserves velocity as well as
// position; the character is pulled back to its anchor rather than tween-reset.
export function eyeSpring(value,velocity,target,dt,omega=23,damping=.6) {
  const x=value-target,decay=Math.exp(-damping*omega*dt)
  if(damping>=1){const b=velocity+omega*x;return [target+(x+b*dt)*decay,(velocity-omega*b*dt)*decay]}
  const wd=omega*Math.sqrt(1-damping*damping),a=(velocity+damping*omega*x)/wd,c=Math.cos(wd*dt),s=Math.sin(wd*dt)
  return [target+decay*(x*c+a*s),decay*(velocity*c-(damping*omega*a+wd*x)*s)]
}

export class DotEyeActor {
  constructor({render,compact=false,now=()=>performance.now(),random=Math.random,setTimer=setTimeout,clearTimer=clearTimeout,raf=cb=>requestAnimationFrame(cb),cancelRaf=id=>cancelAnimationFrame(id)}) {
    Object.assign(this,{render,compact,now,random,setTimer,clearTimer,raf,cancelRaf})
    this.context={active:true,enabled:true,phase:null,backgroundPhase:null,input:false};this.pose=eyePose();this.velocity=Object.fromEntries(Object.keys(this.pose).map(key=>[key,0]));this.mode='idle'
    this.lastActivity=now();this.phaseStartedAt=now();this.lastFrame=now()
    this.nextBlink=now()+this.delay(4000,7000);this.nextGaze=now()+this.delay(8000,15000)
    this.frame=null;this.timer=null;this.gesture=null;this.reaction=null;this.look=null;this.blinkUntil=0;this.nextDrowsy=Infinity;this.disposed=false
    this.update()
  }
  delay(min,max){return min+(max-min)*this.random()}
  stop(){if(this.frame!==null)this.cancelRaf(this.frame);if(this.timer!==null)this.clearTimer(this.timer);this.frame=null;this.timer=null;this.gesture=null;this.look=null;this.blinkUntil=0;this.nextDrowsy=Infinity;for(const key in this.velocity)this.velocity[key]=0}
  dispose(){this.stop();this.disposed=true;this.reaction=null}
  gestureLength(){return EYE_TIMING[this.gesture?.kind]||EYE_TIMING.gesture}
  startWake(){
    if(!this.context.enabled||this.compact)return
    this.gesture={kind:'wake',start:this.now()};this.look=null;this.blinkUntil=0
    this.nextBlink=this.now()+this.delay(4000,7000);this.nextGaze=this.now()+this.delay(8000,15000)
  }
  setContext(patch) {
    if(this.disposed)return
    const old=this.context;this.context={...old,...patch}
    if(!this.context.active){this.stop();this.reaction=null;return}
    if(!old.active||(!old.enabled&&this.context.enabled)){this.lastActivity=this.now();this.nextBlink=this.now()+this.delay(4000,7000);this.nextGaze=this.now()+this.delay(8000,15000)}
    if(old.phase!==this.context.phase)this.phaseStartedAt=this.now()
    if(old.phase!==this.context.phase||old.input!==this.context.input){
      const wake=old.active&&this.mode==='sleeping'&&(this.context.input||this.context.phase)
      const completing=old.phase==='responding'&&!this.context.phase&&!this.context.input&&old.input===this.context.input&&this.reaction?.duringReply
      if(completing)this.reaction.until=Math.max(this.reaction.until,this.now()+EYE_TIMING.replySettle)
      this.lastActivity=this.now();if(!completing)this.reaction=null;this.look=null;this.blinkUntil=0
      // Typing and submitting often change several props in the same moment.
      // Keep the one wake gesture while the actual task status updates normally.
      if(!completing&&this.gesture?.kind!=='wake')this.gesture=null
      if(wake)this.startWake()
      if(!this.gesture&&!this.context.input&&this.context.phase==='recalling'&&this.context.enabled&&!this.compact)this.startLook('arc')
    }
    this.update()
  }
  activity(kind='activity') {
    if(this.disposed||!this.context.active)return
    const wake=this.mode==='sleeping'&&['input','click','pointer','message'].includes(kind)
    this.lastActivity=this.now()
    if(kind==='input'||kind==='click'||kind==='navigation'){this.reaction=null;if(kind==='navigation'||this.gesture?.kind!=='wake')this.gesture=null;this.look=null;this.blinkUntil=0}
    if(wake)this.startWake()
    if(kind==='click'&&this.gesture?.kind!=='wake'&&this.context.enabled&&!this.compact&&this.mode!=='searching'){this.blinkUntil=this.now()+125;this.nextBlink=this.now()+this.delay(4000,7000)}
    this.update()
  }
  cue(value,{duringReply=false,stage=false}={}) {
    if(this.disposed||!this.context.active||this.compact)return false
    const wake=this.mode==='sleeping'
    this.lastActivity=this.now()
    if(this.context.input||this.isBusy(this.now())&&!(duringReply&&this.context.phase==='responding')&&!(stage&&this.context.phase!=='error'))return false
    const expression=dotExpression(value)
    this.reaction={expression,duringReply,stage,until:this.now()+(stage?650:EYE_TIMING.reaction)};this.look=null;this.blinkUntil=0
    this.gesture=this.context.enabled&&['agree','disagree','happy','excited','angry','relieved'].includes(expression)?{kind:expression,start:this.now()}:null
    if(wake)this.startWake()
    this.nextBlink=Math.max(this.nextBlink,this.reaction.until+400)
    this.update();return true
  }
  isBusy(time){return Boolean(this.context.phase)&&(this.context.phase!=='error'||time-this.phaseStartedAt<2200)}
  holdingReply(){return Boolean(this.reaction?.duringReply&&this.context.phase==='responding'&&!this.context.input)}
  currentMode(time) {
    if(this.compact)return 'idle'
    if(this.context.input)return 'input'
    if(this.holdingReply()&&this.reaction.expression!=='neutral')return this.reaction.expression
    if(this.reaction?.stage&&this.reaction.until>time)return this.reaction.expression==='neutral'?'responding':this.reaction.expression
    if(this.isBusy(time))return this.context.phase
    if(this.reaction&&this.reaction.until>time)return this.reaction.expression==='neutral'?'idle':this.reaction.expression
    if(this.context.backgroundPhase)return this.context.backgroundPhase
    if(this.context.enabled&&time-this.lastActivity>=EYE_TIMING.sleep)return 'sleeping'
    if(this.context.enabled&&time-this.lastActivity>=EYE_TIMING.tired)return 'tired'
    return 'idle'
  }
  startLook(kind='glance') {
    const direction=[[7,0],[0,6],[-7,0],[0,-6]][Math.floor(this.random()*4)%4]
    this.look={kind,start:this.now(),x:direction[0],y:direction[1]}
    this.nextGaze=this.now()+this.delay(8000,15000)
  }
  target(time) {
    const p=poseForEye(this.mode)
    if(this.look){
      const age=time-this.look.start
      if(this.look.kind==='arc'){
        // Screen coordinates: lower left -> upper left -> upper right, clockwise.
        const angle=Math.PI*(.75+smooth(age/EYE_TIMING.arc))
        p.gazeX=Math.cos(angle)*7;p.gazeY=Math.sin(angle)*6
      }else{p.gazeX=this.look.x;p.gazeY=this.look.y}
      const release=1-smooth((age-(this.look.kind==='arc'?EYE_TIMING.arc:300))/300)
      // Follow the actual pupil slightly later, then return while it holds gaze.
      p.x+=this.pose.gazeX*(this.compact ? .18 : .45)*release
      p.y+=this.pose.gazeY*(this.compact ? .18 : .38)*release
      p.tilt+=this.pose.gazeX*.3*release
    }
    if(this.gesture){
      const age=time-this.gesture.start,t=clamp(age/this.gestureLength()),envelope=Math.sin(Math.PI*t)*(1-.4*t)
      if(this.gesture.kind==='wake'){
        // Stay groggy throughout both quick turns; only lift the eyelid once
        // the head has returned. Task status is independent of this gesture.
        const beat=t*760,blend=smooth((beat-620)/140),groggy=poseForEye('tired')
        for(const key of ['open','lid','lower','gazeX','gazeY','check','slash','question','exclaim','multiple','scan','sleep','heart','angry','sad','relieved','skeptical','shy'])p[key]=groggy[key]+(p[key]-groggy[key])*blend
        const shake=clamp((beat-85)/535),wave=Math.sin(shake*Math.PI*4)*Math.sin(shake*Math.PI)*(1-.2*shake)
        // Yaw gives the face parallax against the turning rim. No upward jump.
        p.yaw=wave;p.x+=wave*7;p.tilt+=wave*3;p.gazeX-=wave*1.6
      }else if(this.gesture.kind==='drowsyLift'){
        // A slow effort followed by a heavier droop, never fully opening.
        // The pupil cutout follows this same spring-driven lid in eyeGeometry.
        const lift=t<.6?smooth(t/.6):1-smooth((t-.6)/.4)
        p.lid-=.18*lift;p.gazeY-=1.5*lift;p.y-=.7*lift;p.tilt+=.8*lift
      }else if(this.gesture.kind==='happy'||this.gesture.kind==='excited'){
        const energy=this.gesture.kind==='excited'?1.35:1,beats=this.gesture.kind==='excited'?6:4
        p.x+=Math.sin(t*Math.PI*beats)*7*envelope*energy
        p.y-=Math.sin(t*Math.PI*3)**2*9*envelope*energy
        p.tilt-=Math.sin(t*Math.PI*beats)*5*envelope
      }else if(this.gesture.kind==='angry'){
        p.x+=Math.sin(t*Math.PI*2)*2*envelope;p.tilt+=Math.sin(t*Math.PI*2)*2*envelope
      }else if(this.gesture.kind==='relieved'){
        p.y+=3*Math.sin(t*Math.PI);p.tilt-=2*Math.sin(t*Math.PI)
      }else if(this.gesture.kind==='agree')p.y+=Math.sin(t*Math.PI*4)*6*envelope
      else{p.x+=Math.sin(t*Math.PI*4)*7*envelope;p.tilt+=Math.sin(t*Math.PI*4)*5*envelope}
    }
    if(this.blinkUntil>time){p.open=0;p.y+=4.5}
    return p
  }
  moving(time){return Boolean(this.gesture&&time-this.gesture.start<this.gestureLength()||this.look&&time-this.look.start<(this.look.kind==='arc'?EYE_TIMING.arc+300:600))}
  update() {
    if(this.disposed||!this.context.active)return
    const time=this.now(),previousMode=this.mode;this.mode=this.currentMode(time)
    if(['searching','tired'].includes(previousMode)&&this.mode!==previousMode){this.nextBlink=time+this.delay(4000,7000);this.nextGaze=time+this.delay(8000,15000)}
    if(this.mode==='tired'&&previousMode!=='tired'){this.look=null;this.blinkUntil=0;this.nextDrowsy=time+900}
    if(this.mode!=='tired'){this.nextDrowsy=Infinity;if(this.gesture?.kind==='drowsyLift')this.gesture=null}
    if(!this.context.enabled){this.stop();this.pose=poseForEye(this.mode);this.render(this.pose,this.mode,false);return}
    const target=this.target(time)
    if(this.moving(time)||Object.keys(target).some(key=>Math.abs(target[key]-this.pose[key])>.001||Math.abs(this.velocity[key])>.025))this.requestFrame()
    else this.render(this.pose,this.mode,true)
    this.schedule()
  }
  requestFrame(){if(this.frame===null){this.lastFrame=this.now();this.frame=this.raf(()=>{this.frame=null;this.drawFrame()})}}
  drawFrame() {
    if(this.disposed||!this.context.active||!this.context.enabled)return
    const time=this.now(),dt=Math.max(.001,Math.min(.05,(time-this.lastFrame)/1000)),target=this.target(time)
    let moving=this.moving(time)
    for(const key of Object.keys(target)){
      const body=['x','y','tilt'].includes(key),gaze=key.startsWith('gaze'),waking=this.gesture?.kind==='wake',omega=key==='yaw'?44:body?(waking?40:24):gaze?28:key==='open'&&this.blinkUntil>time?70:34,damping=key==='yaw'?.78:body?(waking?.65:.52):gaze?.85:1
      // Match spring response to the wake tempo so faster targets retain their
      // travel instead of being smoothed into an almost stationary vibration.
      let [value,velocity]=eyeSpring(this.pose[key],this.velocity[key],target[key],dt,omega*(waking?760/EYE_TIMING.wake:1),damping)
      if(Math.abs(value-target[key])<.001&&Math.abs(velocity)<.025){value=target[key];velocity=0}else moving=true
      this.pose[key]=value;this.velocity[key]=velocity
    }
    this.render(this.pose,this.mode,true)
    if(moving)this.requestFrame()
  }
  schedule() {
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null
    if(this.disposed||!this.context.active||!this.context.enabled)return
    const time=this.now(),times=[]
    if(!this.compact&&!['sleeping','searching','tired'].includes(this.mode))times.push(this.blinkUntil>time?this.blinkUntil:this.nextBlink)
    if(this.mode==='tired')times.push(this.nextDrowsy)
    const canLook=!this.context.input&&!this.reaction&&(!this.isBusy(time)||this.mode==='recalling')&&!['sleeping','tired'].includes(this.mode)
    if(canLook)times.push(this.nextGaze)
    if(!this.compact&&!this.context.input&&!this.isBusy(time)&&!this.reaction)times.push(this.lastActivity+EYE_TIMING.tired,this.lastActivity+EYE_TIMING.sleep)
    if(this.context.phase==='error')times.push(this.phaseStartedAt+2200)
    if(this.look)times.push(this.look.start+EYE_TIMING.look)
    if(this.gesture)times.push(this.gesture.start+this.gestureLength())
    if(this.reaction&&!this.holdingReply())times.push(this.reaction.until)
    const future=times.filter(value=>value>time)
    if(future.length)this.timer=this.setTimer(()=>{this.timer=null;this.tick()},Math.max(1,Math.min(...future)-time))
  }
  tick() {
    const time=this.now(),mode=this.currentMode(time)
    if(this.reaction?.until<=time&&!this.holdingReply())this.reaction=null
    if(this.look&&time>=this.look.start+EYE_TIMING.look)this.look=null
    if(this.gesture&&time>=this.gesture.start+this.gestureLength())this.gesture=null
    if(this.blinkUntil&&time>=this.blinkUntil)this.blinkUntil=0
    if(mode==='tired'&&time>=this.nextDrowsy){this.gesture={kind:'drowsyLift',start:time};this.nextDrowsy=time+this.delay(9000,14000)}
    if(!this.compact&&time>=this.nextBlink&&!['sleeping','searching','tired'].includes(mode)){this.blinkUntil=time+125;this.nextBlink=time+this.delay(4000,7000)}
    if(time>=this.nextGaze){
      if(!this.context.input&&!this.reaction&&(!this.isBusy(time)||mode==='recalling')&&!['sleeping','tired'].includes(mode))this.startLook(mode==='recalling'?'arc':'glance')
      else this.nextGaze=time+this.delay(8000,15000)
    }
    this.update()
  }
}

