// 명시적 새 실험 전용. 기존 native producer와 production 소스는 그대로 둔다.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mergeConfig} from 'vite';
import original from '../ownership-poc/vite.config.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
export default mergeConfig(original,{plugins:[{
 name:'explicit-preparation-runtime',enforce:'pre',
 transform(code,id){
  if(id.split('?')[0]!==resolve(root,'tests/integration/rhwp/ownership-poc/session.mjs'))return;
  const before='await engine.default({ module_or_path: bytes });';
  if(!code.includes(before))throw Error('준비 opt-in 경계 변경');
  return code.replace(before,before+`
    engine.setRendererPreparationEnabled(true);
    counters.preparation={polls:0,preparing:0,ready:0,complete:0,maxPollMs:0,witnesses:[]};
    const originalPoll=engine.HwpDocument.prototype.pollRenderJob;
    engine.HwpDocument.prototype.pollRenderJob=function(id){
      const t=performance.now(),outcome=originalPoll.call(this,id),ms=performance.now()-t;
      const p=JSON.parse(engine.rendererJobStats()).preparation,j=p.jobs.find(j=>j.id===id),c=counters.preparation;
      c.polls++;c.maxPollMs=Math.max(c.maxPollMs,ms);
      if(j?.phase==='Preparing'&&outcome==='PENDING')c.preparing++;
      if(j?.phase==='ResourcesReady'&&outcome==='PENDING'&&j.readyTransitions===1&&j.replays===0)c.ready++;
      if(j?.phase==='Terminal'&&outcome==='COMPLETE'&&j.replays===1)c.complete++;
      if(j&&c.witnesses.length<12&&((j.phase==='ResourcesReady'&&outcome==='PENDING')||(j.phase==='Terminal'&&outcome==='COMPLETE')))c.witnesses.push({id,outcome,ms,enabled:p.enabled,...j});
      return outcome;
    };
    `);
 }
}]});
