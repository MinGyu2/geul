export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const stats=m=>JSON.parse(m.rendererJobStats());
export function png(n,w=64,h=64){const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle=`rgb(${n&255},${(n>>8)&255},${n*71&255})`;x.fillRect(0,0,w,h);x.fillStyle='#f0aa20';if(w>1)x.fillRect(0,0,w/2,h/2);const b=Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0));c.width=c.height=0;return b;}
export function svg(n){return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="rgb(${n&255},80,130)"/><path d="M0 0 L64 64" stroke="black"/></svg>`);}
export function canvas(){const c=document.createElement('canvas');c.width=c.height=40;c.getContext('2d').fillStyle='#123456';c.getContext('2d').fillRect(0,0,40,40);return c;}
export function makeDocument(m,bytes,options={}){
 const d=m.HwpDocument.createEmpty();
 for(const [i,b]of bytes.entries()){
  const p=JSON.parse(d.insertPicture(0,0,0,'',b,2600,2600,64,64,b[0]===60?'svg':b[0]===255?'jpg':'png','',null,null));
  d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzOffset:3000+(i%10)*2800,vertOffset:3000+Math.floor(i/10)*2800,...(Array.isArray(options)?options[i]:options)}));
 }return d;
}
export function frame(c){return {width:c.width,height:c.height,data:c.getContext('2d').getImageData(0,0,c.width,c.height).data};}
export function same(c,f){if(c.width!==f.width||c.height!==f.height)return false;const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return b.length===f.data.length&&b.every((x,i)=>x===f.data[i]);}
export function pixels(a,b){if(a.width!==b.width||a.height!==b.height)return {pixels:-1,maxDelta:255,width:a.width,height:a.height,referenceNonWhite:0};const x=frame(a).data,y=frame(b).data;let different=0,maxDelta=0,nonWhite=0;for(let n=0;n<x.length;n+=4){let delta=0;for(let k=0;k<4;k++)delta=Math.max(delta,Math.abs(x[n+k]-y[n+k]));if(delta)different++;maxDelta=Math.max(maxDelta,delta);if(y[n+3]>0&&(y[n]<250||y[n+1]<250||y[n+2]<250))nonWhite++;}return {pixels:different,maxDelta,width:a.width,height:a.height,referenceNonWhite:nonWhite};}
export function job(m,id){return stats(m).preparation?.jobs.find(x=>x.id===id);}
export function poll(m,d,id,c,rows,label,old=null){
 const before=stats(m),t=performance.now(),outcome=d.pollRenderJob(id),ms=performance.now()-t,after=stats(m);
 rows.push({label,id,outcome,ms,before,after,atomicPending:outcome!=='PENDING'||!old||same(c,old)});
 return outcome;
}
export function finish(m,d,c,rows,label,{id=null,page=0,scale=.5,old=frame(c),timeout=14000}={}){
 id??=d.beginRenderJob(page,c,scale);const started=performance.now();let polls=0,done=false;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{done=true;m.setRendererImageLoadListener(null);reject(Error(label+': progress timeout'));},timeout);
  const step=()=>{if(done)return;try{polls++;if(polls>1000)throw Error('unbounded continuation');const out=poll(m,d,id,c,rows,label,old);if(out!=='PENDING'){done=true;clearTimeout(timer);m.setRendererImageLoadListener(null);resolve({outcome:out,polls,totalMs:performance.now()-started,maxPollMs:Math.max(...rows.filter(r=>r.id===id&&r.label===label).map(r=>r.ms)),id});}}catch(e){done=true;clearTimeout(timer);m.setRendererImageLoadListener(null);reject(e);}};
  m.setRendererImageLoadListener(()=>queueMicrotask(step));step();
 });
}
export function untilReady(m,d,c,rows,label){const id=d.beginRenderJob(0,c,.5),old=frame(c);for(let n=0;n<300;n++){const outcome=poll(m,d,id,c,rows,label,old);if(outcome!=='PENDING')throw Error(label+': unexpected '+outcome);if(job(m,id)?.phase==='ResourcesReady')return {id,old};}throw Error('no ResourcesReady boundary');}
export function holdImages(){
 const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');const held=new Map();
 Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){if(value?.startsWith('data:'))held.set(this,value);else descriptor.set.call(this,value);}});
 return {held,release(){Object.defineProperty(HTMLImageElement.prototype,'src',descriptor);for(const [image,url]of held)descriptor.set.call(image,url);},clear(){for(const image of held.keys())descriptor.set.call(image,'');held.clear();Object.defineProperty(HTMLImageElement.prototype,'src',descriptor);}};
}
