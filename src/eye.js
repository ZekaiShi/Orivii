import {DotEyeActor,eyePose} from './eye-state.js'
import {createExpressionTracker,createPresentationPlayer} from './expression.js'

const eyeLabels={idle:'在这里',input:'认真听你说',responding:'正在回复',searching:'正在查资料',recalling:'正在回想',agree:'认同',disagree:'摇头',happy:'开心',heart:'暖心',angry:'有点生气',sad:'有些难过',excited:'好兴奋',relieved:'松了口气',skeptical:'将信将疑',shy:'有些腼腆',concerned:'关切',uncertain:'有点不确定',blocked:'暂时不能执行',curious:'有些好奇',surprised:'有些惊讶',confused:'摸不着头脑',astonished:'大吃一惊',tired:'有些困了',sleeping:'正在打盹',error:'遇到了一点问题'}
const n=value=>Number(value.toFixed(3))
export const DOT_RING=Object.freeze({radius:8.3125,stroke:2.875})
export const EYE_FLOW_PERIOD=48
export const EYE_SNORES=Object.freeze([0,1,2].map(i=>Object.freeze({x:76+i*6,y:43-i*11,fontSize:14+i*3,fontWeight:800,fontFamily:'Segoe UI,sans-serif'})))
// Eight tangent-continuous curves round both the cleft and the bottom tip.
export const EYE_HEART_POINTS=[[50,36],[47,36],[46,31],[41,31],[36,31],[33,35],[33,40],[33,46],[39,51],[45,55],[47,56.333],[48.5,58],[50,58],[51.5,58],[53,56.333],[55,55],[61,51],[67,46],[67,40],[67,35],[64,31],[59,31],[54,31],[53,36],[50,36]]
const eyeCurve=points=>`M ${points[0]} `+Array.from({length:(points.length-1)/3},(_,i)=>`C ${points[i*3+1]} ${points[i*3+2]} ${points[i*3+3]}`).join(' ')
export const EYE_HEART_PATH=eyeCurve(EYE_HEART_POINTS)
function splitEyeCurves(points){
  const middle=(a,b)=>a.map((v,i)=>(v+b[i])/2),out=[points[0]]
  for(let i=0;i<4;i++){
    const [a,b,c,d]=points.slice(i*3,i*3+4),ab=middle(a,b),bc=middle(b,c),cd=middle(c,d),abc=middle(ab,bc),bcd=middle(bc,cd),center=middle(abc,bcd)
    out.push(ab,abc,center,bcd,cd,d)
  }
  return out
}
export const EYE_HEART_SPARKS=Object.freeze([[-34,-26],[-42,4],[32,-28],[42,6],[-25,29],[29,27]].map(([x,y],i)=>({x,y,delay:i*100,size:.18+(i%3)*.04})))
export function eyeFlowRows(){return [0,EYE_FLOW_PERIOD].map(y=>({path:`M 38 ${31+y} h 6 M 51 ${31+y} h 10 M 38 ${43+y} h 21 M 38 ${55+y} h 5 M 42 ${67+y} h 20`,card:{x:49,y:51+y,width:12,height:8,rx:3}}))}
// Two soft inward squints. Both start at the same pupil and separate as the
// existing smile spring rises; the surrounding circular body stays complete.
const smileEyePoints=[[34,35],[38,35.5],[42,37],[45,40],[46,41],[45.5,42],[44,42.4],[41,43.2],[37.5,44.5],[34,47],[34,47],[34,47],[34,47]]
// Original soft eyelid curves, informed by emoji brow direction. Each uses the
// same topology as the pupil, so rapid changes keep their current spring pose.
const microEyeCurves={
  angry:[[34,37],[37,38],[42,41],[46,42]],
  sad:[[34,43],[39,43],[44,40],[46,37]],
  relieved:[[34,41],[37,47],[43,47],[46,41]],
  skeptical:[[34,39],[37,35],[43,35],[46,39]],
  shy:[[34,39],[38,42],[42,42],[46,39]],
}
const microPoints=(mode,side)=>{
  const curve=mode==='skeptical'&&side===1?[[34,43],[38,44],[42,44],[46,43]]:microEyeCurves[mode]
  const points=[...curve,...Array.from({length:9},()=>curve[3])]
  return points.map(([x,y])=>[side===-1?x:100-x,y])
}
export function eyeGeometry(p) {
  // Shift the centreline as the stroke changes to preserve the outer diameter.
  // Expressions may occlude the circle, never resize or deform it. Head-turn
  // projection belongs to the internal face only (see the package AGENTS.md).
  const rim={cx:50,cy:43,r:n(DOT_RING.radius*3.2),stroke:n(DOT_RING.stroke*3.2)},r=6.5,k=r*.5522847498
  const circle=[[0,-r],[k,-r],[r,-k],[r,0],[r,k],[k,r],[0,r],[-k,r],[-r,k],[-r,0],[-r,-k],[-k,-r],[0,-r]]
  const line=anchors=>anchors.flatMap((point,i)=>i?[1/3,2/3,1].map(t=>point.map((v,j)=>anchors[i-1][j]+(v-anchors[i-1][j])*t)):[point])
  const check=line([[39,43],[44,48],[48,51],[55,43],[62,35]]),slash=line([[39,54],[44.5,48.5],[50,43],[55.5,37.5],[61,32]])
  const question=[[-6,-6],[-6,-14],[7,-14],[7,-6],[7,-2],[1,-1],[0,3],[0,3],[0,4],[0,4],[0,4],[0,4],[0,4]].map(point=>[point[0]+50,point[1]+43])
  const exclaim=line([[50,31],[50,35],[50,39],[50,43],[50,47]])
  const heart=Math.max(0,Math.min(1,p.heart||0)),smile=Math.max(0,Math.min(1,p.lower/.9))
  const q=Math.max(0,Math.min(1,p.question||0)),e=Math.max(0,Math.min(1,p.exclaim||0)),mark=Math.min(1,q+e),multiple=Math.max(0,Math.min(1,p.multiple||0)),droplet=Math.sin(mark*Math.PI)
  const scan=Math.max(0,Math.min(1,p.scan||0))
  const points=circle.map((point,i)=>point.map((v,j)=>{const base=v*(j===0?1-.2*droplet:1+.55*droplet)+(j===0?50+p.gazeX:43+p.gazeY),expression=base+(check[i][j]-base)*p.check+(slash[i][j]-base)*p.slash+(question[i][j]-base)*q+(exclaim[i][j]-base)*e,bar=j===0?40+i*20/12:43;return expression+(bar-expression)*scan}))
  const inner=eyeCurve(splitEyeCurves(points).map((point,i)=>point.map((v,j)=>n(v+(EYE_HEART_POINTS[i][j]-v)*heart))))
  const closure=Math.max(0,Math.min(1,1-p.open*(1-p.lid))),upper=16+41*closure,lower=74-31*p.lower
  // Use the sleeping lid's compact 24-unit arc in every upper-lid pose.
  // Only its height changes; opening the eye never stretches it to the rim.
  const sleep=Math.max(0,Math.min(1,p.sleep||0)),maskEnd=upper-2.5,upperEnd=maskEnd+(43-maskEnd)*sleep,upperControl=upperEnd+7
  // Move along the pupil's right side with the rendered lid, not an independent
  // timer: down-right when drowsy, up-right as the eyelid strains to rise.
  const droop=Math.max(0,Math.min(1,(p.lid-.46)/.19)),detailAngle=-Math.PI/4+Math.PI/2*droop*droop*(3-2*droop),detailRadius=3.2*Math.SQRT2
  const yaw=Math.max(-1,Math.min(1,p.yaw||0)),turn=Math.abs(yaw)
  const smilePaths=[-1,1].map(side=>eyeCurve(circle.map((point,i)=>point.map((v,j)=>{
    const start=v+(j===0?50+p.gazeX:43+p.gazeY),end=j===0?(side===-1?smileEyePoints[i][0]:100-smileEyePoints[i][0]):smileEyePoints[i][1]
    return n(start+(end-start)*smile)
  }))))
  const moods=Object.keys(microEyeCurves),weights=moods.map(mode=>Math.max(0,Math.min(1,p[mode]||0))),total=weights.reduce((a,b)=>a+b,0),micro=Math.min(1,total)
  const microPaths=[-1,1].map(side=>{
    const targets=moods.map(mode=>microPoints(mode,side))
    return eyeCurve(circle.map((point,i)=>point.map((v,j)=>{
      const start=v+(j===0?50+p.gazeX:43+p.gazeY)
      return n(start+targets.reduce((sum,points,k)=>sum+(points[i][j]-start)*weights[k]/Math.max(1,total),0))
    })))
  })
  const microPupils=[-1,1].map(side=>({cx:n(50+side*10+p.gazeX*.3),cy:n(47+(p.sad||0)*2-(p.shy||0)*2),r:2.9,opacity:n(Math.max(0,micro-(p.relieved||0)))}))
  return {rim,smile,smilePaths,micro,microPaths,microPupils,faceOpacity:n(1-Math.min(1,smile+micro)),aperture:n(rim.r-rim.stroke/2+.2),outline:`M ${n(50-rim.r)} 43 A ${rim.r} ${rim.r} 0 1 1 ${n(50+rim.r)} 43 A ${rim.r} ${rim.r} 0 1 1 ${n(50-rim.r)} 43`,inner,width:n(5.6+.6*Math.max(p.check,p.slash)),fillOpacity:n(1-Math.min(1,Math.max(p.check,p.slash,mark,scan))),lidWidth:5.6,flowWidth:4.6,pupilOpacity:n((1-Math.min(1,p.lower/.65))*(1-scan)),flowOpacity:n(scan),
    // The small cutout travels with the pupil. True transparency
    // preserves contrast on both themes and on the transparent sidebar icon.
    pupilDetail:{cx:n(50+p.gazeX+Math.cos(detailAngle)*detailRadius),cy:n(43+p.gazeY+Math.sin(detailAngle)*detailRadius),r:2.3,opacity:n(1-Math.min(1,Math.max(p.check,p.slash,mark,scan,heart)))},
    symbolTransform:`translate(50 43) scale(${n((1-.34*multiple)*(1-.22*heart))}) translate(-50 -43)`,
    sideTransforms:[-1,1].map(side=>`translate(${n(side*14*multiple)} 0) translate(50 43) scale(${n(1-.34*multiple)}) translate(-50 -43)`),sideOpacity:n(multiple*mark*(1-scan)),dotOpacity:n(mark*(1-scan)),dotY:n(43+13*mark),
    // Masks cover the full aperture but have no stroke. Only the open curves
    // are visible: closing a stroked mask exposes vertical sides and extra rims.
    upper:`M 0 0 H 100 V ${n(maskEnd)} H 62 Q 50 ${n(maskEnd+7)} 38 ${n(maskEnd)} H 0 Z`,
    lower:`M 0 100 H 100 V ${n(lower+6)} H 72 Q 50 ${n(lower-16)} 28 ${n(lower+6)} H 0 Z`,
    upperEdge:`M 38 ${n(upperEnd)} Q 50 ${n(upperControl)} 62 ${n(upperEnd)}`,
    lowerEdge:`M 28 ${n(lower+6)} Q 50 ${n(lower-16)} 72 ${n(lower+6)}`,
    transform:`translate(${n(p.x)} ${n(p.y)}) rotate(${n(p.tilt)} 50 43)`,
    faceTransform:`translate(${n(yaw*6)} 0) translate(50 43) scale(${n(1-.16*turn)} 1) translate(-50 -43)`,shadow:n((18+p.y*.3)*(1-.08*turn)),shadowX:n(50+p.x*.4),shadowOpacity:n(.19+p.y*.009)}
}

export function createDotEye(React) {
  const h=React.createElement
  return function DotEye({name='Orivii',phase=null,backgroundPhase=null,input=false,enabled=true,active=true,chatId,messages=[],historyReady=false,livePresentation=null,presentationEvents,controllerRef:externalController,compact=false,size=20}) {
    const localController=React.useRef(null),controllerRef=externalController||localController
    const root=React.useRef(null),tracker=React.useRef(createExpressionTracker()),current=React.useRef(null),previousChat=React.useRef(chatId),previousActive=React.useRef(active)
    const liveSeen=React.useRef(livePresentation?.id)
    const player=React.useRef(null)
    const clipId='dot-eye-'+React.useId().replace(/[^a-zA-Z0-9_-]/g,'')
    current.current={name,phase,backgroundPhase,input,enabled,active,chatId,messages,historyReady}
    React.useLayoutEffect(()=>{
      if(!root.current)return
      const button=root.current,doc=button.ownerDocument,win=doc.defaultView,media=win.matchMedia?.('(prefers-reduced-motion: reduce)')
      const body=button.querySelector('.dot-eye-body'),inner=button.querySelector('.dot-eye-pupil'),flow=button.querySelector('.dot-eye-flow'),upper=button.querySelector('.dot-eye-upper'),lower=button.querySelector('.dot-eye-lower'),shadow=button.querySelector('.dot-eye-shadow'),zzz=button.querySelector('.dot-eye-zzz')
      const affection=button.querySelector('.dot-eye-affection'),face=button.querySelector('.dot-eye-face'),upperEdge=button.querySelector('.dot-eye-upper-edge'),lowerEdge=button.querySelector('.dot-eye-lower-edge'),symbol=button.querySelector('.dot-eye-symbol'),sides=button.querySelectorAll('.dot-eye-symbol-side'),dots=button.querySelectorAll('.dot-eye-symbol-dot')
      const smile=button.querySelector('.dot-eye-smile'),smileEyes=button.querySelectorAll('.dot-eye-smile-eye'),pupilDetail=button.querySelector('.dot-eye-pupil-detail')
      const micro=button.querySelector('.dot-eye-micro'),microEyes=button.querySelectorAll('.dot-eye-micro-lid'),microPupils=button.querySelectorAll('.dot-eye-micro-pupil'),blush=button.querySelector('.dot-eye-blush')
      const actor=new DotEyeActor({
        compact,
        now:()=>win.performance.now(),setTimer:win.setTimeout.bind(win),clearTimer:win.clearTimeout.bind(win),
        raf:win.requestAnimationFrame?win.requestAnimationFrame.bind(win):cb=>win.setTimeout(cb,16),cancelRaf:win.cancelAnimationFrame?win.cancelAnimationFrame.bind(win):win.clearTimeout.bind(win),
        render(p,mode,animated){
          const g=eyeGeometry(p)
          body.setAttribute('transform',g.transform)
          face.setAttribute('opacity',g.faceOpacity)
          smile?.setAttribute('opacity',g.smile)
          smile?.setAttribute('transform',g.faceTransform)
          smile?.setAttribute('fill-opacity',1-g.smile)
          for(const [i,eye] of [...smileEyes].entries())eye.setAttribute('d',g.smilePaths[i])
          micro?.setAttribute('opacity',g.micro);micro?.setAttribute('transform',g.faceTransform)
          micro?.setAttribute('fill-opacity',1-g.micro)
          for(const [i,eye] of [...microEyes].entries())eye.setAttribute('d',g.microPaths[i])
          for(const [i,pupil] of [...microPupils].entries())for(const [key,value] of Object.entries(g.microPupils[i]))pupil.setAttribute(key,value)
          blush?.setAttribute('opacity',p.shy*.6)
          face.setAttribute('transform',g.faceTransform)
          affection?.setAttribute('opacity',p.heart)
          inner.setAttribute('d',g.inner);inner.setAttribute('stroke-width',g.width)
          inner.setAttribute('opacity',g.pupilOpacity)
          inner.setAttribute('fill-opacity',g.fillOpacity)
          for(const [key,value] of Object.entries(g.pupilDetail))pupilDetail.setAttribute(key,value)
          symbol.setAttribute('transform',g.symbolTransform)
          for(const [i,side] of [...sides].entries()){side.setAttribute('transform',g.sideTransforms[i]);side.setAttribute('opacity',g.sideOpacity);side.querySelector('path').setAttribute('d',g.inner)}
          for(const dot of dots){dot.setAttribute('opacity',g.dotOpacity);dot.setAttribute('cy',g.dotY)}
          flow?.setAttribute('opacity',g.flowOpacity)
          upper?.setAttribute('d',g.upper);lower?.setAttribute('d',g.lower)
          upperEdge?.setAttribute('d',g.upperEdge);lowerEdge?.setAttribute('d',g.lowerEdge)
          shadow?.setAttribute('rx',g.shadow);shadow?.setAttribute('cx',g.shadowX);shadow?.setAttribute('opacity',g.shadowOpacity);zzz?.setAttribute('opacity',p.sleep)
          button.dataset.eyeState=mode;button.dataset.eyeAnimated=String(animated&&current.current.active&&!doc.hidden)
          if(!compact)button.setAttribute('aria-label',`${current.current.name}，${eyeLabels[mode]||eyeLabels.idle}；点击互动`)
        },
      })
      controllerRef.current=actor
      player.current=createPresentationPlayer({play:event=>actor.cue(event.expression,{duringReply:current.current.phase==='responding',stage:true}),setTimer:(fn,ms)=>win.setTimeout(fn,ms),clearTimer:id=>win.clearTimeout(id)})
      const sync=()=>{actor.setContext({active:current.current.active&&!doc.hidden,enabled:current.current.enabled&&!media?.matches,phase:current.current.phase,backgroundPhase:current.current.backgroundPhase,input:current.current.input});if(doc.hidden||!current.current.active)player.current?.suspend();else if(media?.matches)player.current?.cancel()}
      const visibility=()=>{
        button.dataset.eyeAnimated='false'
        if(!doc.hidden)tracker.current.resume(Date.now())
        if(current.current.historyReady)tracker.current.observe(current.current.chatId,current.current.messages,{replay:false})
        sync()
      }
      doc.addEventListener('visibilitychange',visibility);media?.addEventListener?.('change',sync);sync()
      return()=>{actor.dispose();player.current?.cancel();player.current=null;controllerRef.current=null;tracker.current.reset();doc.removeEventListener('visibilitychange',visibility);media?.removeEventListener?.('change',sync)}
    },[])
    React.useLayoutEffect(()=>{
      if(!root.current)return
      const doc=root.current.ownerDocument,media=doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)')
      if(previousChat.current!==chatId){controllerRef.current?.activity('navigation');previousChat.current=chatId}
      if(active&&!previousActive.current)tracker.current.resume(Date.now())
      previousActive.current=active
      if(!active||doc.hidden)root.current.dataset.eyeAnimated='false'
      controllerRef.current?.setContext({active:active&&!doc.hidden,enabled:enabled&&!media?.matches,phase,backgroundPhase,input})
      if(presentationEvents!==undefined){player.current?.update(chatId,presentationEvents,{visible:active&&!doc.hidden,input,enabled:enabled&&!media?.matches});return}
      if(livePresentation?.id&&liveSeen.current!==livePresentation.id){
        liveSeen.current=livePresentation.id
        if(active&&!doc.hidden)controllerRef.current?.cue(livePresentation.expression,{duringReply:true})
      }
      if(historyReady){const fresh=tracker.current.observe(chatId,messages,{replay:active&&!doc.hidden});if(fresh&&fresh.id!==liveSeen.current)controllerRef.current?.cue(fresh.presentation?.expression,{duringReply:phase==='responding'})}
    },[phase,backgroundPhase,input,enabled,active,name,chatId,messages,historyReady,livePresentation,presentationEvents])
    const g=eyeGeometry(eyePose())
    return h(compact?'span':'button',{...(compact?{'aria-hidden':true,style:{width:size,height:size}}:{type:'button',title:'点一下，叫醒 '+name,'aria-label':name+'，点击互动',onClick:()=>controllerRef.current?.activity('click')}),ref:root,className:compact?'dot-eye dot-sidebar-eye':'dot-eye','data-eye-animated':'false'},
      h('svg',{viewBox:compact?'11.6 4.6 76.8 76.8':'0 0 100 100',fill:'none','aria-hidden':true},
        h('defs',null,h('clipPath',{id:clipId},h('circle',{cx:50,cy:43,r:g.aperture})),
          h('mask',{id:clipId+'-pupil',maskUnits:'userSpaceOnUse',x:0,y:0,width:100,height:100,style:{maskType:'luminance'}},h('rect',{width:100,height:100,fill:'white'}),h('circle',{className:'dot-eye-pupil-detail',...g.pupilDetail,fill:'black'}))),
        !compact?h('g',{className:'dot-eye-ground'},h('ellipse',{className:'dot-eye-shadow',cx:50,cy:87,rx:18,ry:3,fill:'currentColor',opacity:.19})):null,
        h('g',{className:'dot-eye-float'},h('g',{className:'dot-eye-body'},
          h('circle',{className:'dot-eye-outline',cx:g.rim.cx,cy:g.rim.cy,r:g.rim.r,fill:compact?'none':'var(--dot-bg)',stroke:'currentColor',strokeWidth:g.rim.stroke}),
          !compact?h('g',{clipPath:`url(#${clipId})`},h('g',{className:'dot-eye-smile',opacity:0,fill:'currentColor',fillOpacity:1,stroke:'currentColor',strokeWidth:5.6,strokeLinecap:'round',strokeLinejoin:'round'},...g.smilePaths.map((d,i)=>h('path',{key:i,className:'dot-eye-smile-eye',d})))):null,
          !compact?h('g',{clipPath:`url(#${clipId})`},h('g',{className:'dot-eye-micro',opacity:0,fill:'currentColor',fillOpacity:1},...g.microPaths.map((d,i)=>h('path',{key:i,className:'dot-eye-micro-lid',d,stroke:'currentColor',strokeWidth:5.2,strokeLinecap:'round',strokeLinejoin:'round'})),...g.microPupils.map((attrs,i)=>h('circle',{key:'pupil-'+i,className:'dot-eye-micro-pupil',...attrs,fillOpacity:1})),h('path',{className:'dot-eye-blush',d:'M 34 55 h 4 M 62 55 h 4',opacity:0,fill:'none',stroke:'currentColor',strokeWidth:3,strokeLinecap:'round'}))):null,
          h('g',{clipPath:`url(#${clipId})`},h('g',{className:'dot-eye-face',transform:g.faceTransform},
            h('g',{className:'dot-eye-symbol',transform:g.symbolTransform},h('path',{className:'dot-eye-pupil',d:g.inner,fill:'currentColor',fillOpacity:g.fillOpacity,stroke:'currentColor',strokeWidth:g.width,strokeLinecap:'round',strokeLinejoin:'round',mask:`url(#${clipId}-pupil)`}),!compact?h('circle',{className:'dot-eye-symbol-dot',cx:50,cy:g.dotY,r:2.8,fill:'currentColor',opacity:0}):null),
            !compact?g.sideTransforms.map((transform,i)=>h('g',{key:i,className:'dot-eye-symbol-side',transform,opacity:0},h('path',{d:g.inner,fill:'none',stroke:'currentColor',strokeWidth:5.6,strokeLinecap:'round',strokeLinejoin:'round'}),h('circle',{className:'dot-eye-symbol-dot',cx:50,cy:g.dotY,r:2.8,fill:'currentColor',opacity:0}))):null,
            !compact?h('g',{className:'dot-eye-flow',opacity:0,stroke:'currentColor',strokeWidth:g.flowWidth,strokeLinecap:'round',strokeLinejoin:'round'},h('g',{className:'dot-eye-flow-track'},...eyeFlowRows().map((row,i)=>h('g',{key:i},h('path',{d:row.path}),h('rect',row.card))))):null,
            !compact?h('g',null,
              h('g',{className:'dot-eye-lid-masks',fill:'var(--dot-bg)',stroke:'none'},h('path',{className:'dot-eye-upper',d:g.upper}),h('path',{className:'dot-eye-lower',d:g.lower})),
              h('g',{fill:'none',stroke:'currentColor',strokeWidth:g.lidWidth,strokeLinecap:'round'},h('path',{className:'dot-eye-upper-edge',d:g.upperEdge}),h('path',{className:'dot-eye-lower-edge',d:g.lowerEdge}))):null)))),
        !compact?h('g',{className:'dot-eye-affection',opacity:0,fill:'currentColor'},...EYE_HEART_SPARKS.map((spark,i)=>h('g',{key:i,className:'dot-eye-heart-spark',style:{'--heart-x':spark.x+'px','--heart-y':spark.y+'px','--heart-delay':spark.delay+'ms'}},h('path',{d:EYE_HEART_PATH,transform:`translate(50 43) scale(${spark.size}) translate(-50 -43)`})))):null,
        !compact?h('g',{className:'dot-eye-zzz',opacity:0,fill:'currentColor'},...EYE_SNORES.map((attrs,i)=>h('text',{key:i,...attrs},'z'))):null))
  }
}
