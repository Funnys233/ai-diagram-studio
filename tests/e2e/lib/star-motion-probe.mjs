/** Measure independent particle loops, visibility and animation stability. */
export async function measureStarMotion(browser) {
 const key='__diagramStarMotionProbe';
 await browser.evalRaw(`(() => {
  const field=document.querySelector('.reasoning-slider.is-max.is-boosted .rs-starfield');
  const groups=[...field.querySelectorAll('.rs-star')].map(wrapper=>({wrapper,dots:[...wrapper.children],animation:wrapper.getAnimations().find(a=>a.animationName==='rs-star-drift')}));
  const state=window[${JSON.stringify(key)}]={done:false,result:null};
  if(!groups.length||groups.some(g=>!g.animation)){state.done=true;state.result={ready:false};return;}
  const clip=field.closest('.rs-stars');
  const visiblePoint=g=>{
   const bounds=clip.getBoundingClientRect(),style=getComputedStyle(g.wrapper);
   if(!bounds.width||style.visibility==='hidden'||Number(style.opacity)===0)return null;
   for(const dot of g.dots){const r=dot.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;if(r.width&&x>=bounds.left&&x<bounds.right&&y>=bounds.top&&y<bounds.bottom)return x;}
   return null;
  };
  const durations=groups.map(g=>Number(g.animation.effect.getTiming().duration));
  const result={ready:true,durationMs:Math.max(...durations),uniqueSpeeds:new Set(durations).size,seamMaxDelta:0,seamVisibleBefore:0,seamVisibleAfter:0,seamMatchedPoints:0,visibleMin:Infinity,opacityAlwaysOne:true,currentTimeResets:0,startTimeResets:0,animationReplacements:0,sampleFrames:0};
  // Check each particle at its own seam, accounting for its negative phase delay.
  for(const g of groups){
   const a=g.animation,timing=a.effect.getTiming(),saved={time:a.currentTime,state:a.playState};
   try{a.pause();a.currentTime=2*Number(timing.duration)+Number(timing.delay)-1;const before=visiblePoint(g);a.currentTime=2*Number(timing.duration)+Number(timing.delay)+1;const after=visiblePoint(g);
    result.seamVisibleBefore+=before!==null;result.seamVisibleAfter+=after!==null;
    if(before!==null&&after!==null){result.seamMatchedPoints++;result.seamMaxDelta=Math.max(result.seamMaxDelta,Math.abs(after-before));}
   }finally{a.currentTime=saved.time;if(saved.state==='running')a.play();}
  }
  let started,last=-Infinity;
  const prior=groups.map(()=>({}));
  function sample(now){try{
   started??=now;const elapsed=now-started;
   if(now-last>=50||elapsed>=result.durationMs+200){last=now;
    result.visibleMin=Math.min(result.visibleMin,groups.filter(g=>visiblePoint(g)!==null).length);
    result.opacityAlwaysOne&&=Number(getComputedStyle(field).opacity)===1;
    groups.forEach((g,i)=>{const a=g.wrapper.getAnimations().find(a=>a.animationName==='rs-star-drift'),p=prior[i];
     if(a!==g.animation)result.animationReplacements++;
     if(typeof p.time==='number'&&typeof a?.currentTime==='number'&&a.currentTime<p.time-1)result.currentTimeResets++;
     if(typeof p.start==='number'&&typeof a?.startTime==='number'&&Math.abs(a.startTime-p.start)>2)result.startTimeResets++;
     prior[i]={time:a?.currentTime,start:a?.startTime};
    });result.sampleFrames++;
   }
   if(elapsed<result.durationMs+200){requestAnimationFrame(sample);return;}
   result.elapsedMs=Math.round(elapsed);state.done=true;state.result=result;
  }catch(error){state.done=true;state.result={...result,error:error.message};}}
  requestAnimationFrame(sample);
 })();true`);
 const measured=await browser.waitFor('逐星循环连续性',`JSON.stringify(window[${JSON.stringify(key)}]||null)`,value=>value?.done,{timeout:22000,interval:250});
 await browser.evalRaw(`delete window[${JSON.stringify(key)}];true`);return measured.result;
}
