"""Read-only measurements around the pinned WASM API in the actual WebView.

Installed by the native test harness, never imported by product code. Stores numeric
coordinates/IDs/durations, never document text or document bytes. Does not retain a
freed document. The active handle exists only to query live cell geometry.
"""
from rhwp_poc import smoke, perform

INSTALL = r"""
window.__rhwpProbeReady = false;
import('/rhwp/rhwp.js').then(async mod => {
  const wasm = await mod.default({module_or_path:'/rhwp/rhwp_bg.wasm'});
  const docs = new Map(), ids = new WeakMap(); let serial=0, active=null;
  const p = window.__rhwpProbe = {calls:[], hits:[], disposals:[], memory:()=>wasm.memory.buffer.byteLength};
  const tracked = self => {
    let id=ids.get(self); if(id===undefined) {id=++serial; ids.set(self,id); docs.set(id,{id,live:new Set(),saves:0,discards:0});}
    return docs.get(id);
  };
  p.paragraphCheck = (expected,section,paragraph) => {
    if(!active)return null;
    const text=active.getTextRange(section,paragraph,0,active.getParagraphLength(section,paragraph));
    return {equals:text===expected,expectedLength:[...expected].length,actualLength:[...text].length,section,paragraph};
  };
  p.owners = () => [...docs.values()].map(d=>({id:d.id,live:d.live.size,saves:d.saves,discards:d.discards,nativeCapacity:d.nativeCapacity??null}));
  p.cursor = key => {
    if(!active)return null;
    const [body,cell]=key.split('@'),[s,parent,offset]=body.split(':').map(Number);
    const r=JSON.parse(cell?active.getCursorRectInCell(s,parent,...cell.split('/').slice(0,2).map(Number),Number(cell.split('/')[2]),offset)
      :active.getCursorRect(s,parent,offset));
    return {...r,page:JSON.parse(active.getPageInfo(r.pageIndex))};
  };
  p.cell = (section,parent,control,cell) => {
    if(!active) return null;
    const caret=JSON.parse(active.getCursorRectInCell(section,parent,control,cell,0,0));
    return {...caret,page:JSON.parse(active.getPageInfo(caret.pageIndex))};
  };
  for (const name of ['getPageInfo','saveSnapshot','restoreSnapshot','discardSnapshot','insertText','insertTextInCell',
    'snapshotCapacity','deleteText','deleteTextInCell','splitParagraph','splitParagraphInCell','getPageLayerTreeWithProfile',
    'renderPageToCanvas','renderPagePatchToCanvasFilteredWithProfile','hitTest','free']) {
    const original=mod.HwpDocument.prototype[name]; if(!original) continue;
    mod.HwpDocument.prototype[name]=function(...args) {
      const doc=tracked(this), start=performance.now(); let value,completed=false;
      try {
        value=original.apply(this,args);completed=true;
        if(name==='snapshotCapacity'){doc.nativeCapacity=value;if(p.historyDisabled)value=2;}
        if(name==='saveSnapshot') {doc.live.add(value);doc.saves++;}
        if(name==='discardSnapshot') {doc.live.delete(args[0]);doc.discards++;if(p.throwAfterDiscard){p.throwAfterDiscard=false;throw new Error('injected exception after actual discard');}}
        if(name==='hitTest') {
          active=this;
          p.hits.push({page:args[0],x:args[1],y:args[2],raw:JSON.parse(value)});
          if(p.hits.length>100) p.hits.shift();
        }
        return value;
      } finally {
        if(name==='free' && completed) {p.disposals.push({id:doc.id,liveAtFree:doc.live.size,saves:doc.saves,discards:doc.discards});if(p.disposals.length>50)p.disposals.shift();docs.delete(doc.id);if(active===this) active=null;}
        p.calls.push({name,ms:performance.now()-start,at:start});
        if(p.calls.length>20000) p.calls.splice(0,10000);
      }
    };
  }
  p.engineSurfaces=()=>{
    const table=wasm.__wbindgen_externrefs;if(!table)return null;
    const canvases=new Set(),images=new Set();
    for(let i=0;i<table.length;i++){
      const value=table.get(i);
      if(value instanceof HTMLCanvasElement)canvases.add(value);
      if(value instanceof CanvasRenderingContext2D)canvases.add(value.canvas);
      if(value instanceof HTMLImageElement)images.add(value);
    }
    return {externrefSlots:table.length,canvasCount:canvases.size,
      canvasPixels:[...canvases].reduce((n,c)=>n+c.width*c.height,0),
      detachedCanvases:[...canvases].filter(c=>!c.isConnected).length,
      imageCount:images.size,imagePixels:[...images].reduce((n,c)=>n+c.naturalWidth*c.naturalHeight,0)};
  };
  window.__rhwpProbeReady=true;
}).catch(e=>{window.__rhwpProbeError=String(e)});
"""


def install(d):
    d.js(INSTALL)
    smoke.wait_until(d, "return window.__rhwpProbeReady === true", timeout=30)


    # WebKitWebDriver 2.54 under Xvfb with fractional DPR maps requested viewport
    # positions to different client coordinates. Measure it with a move, no click.
    d.js("window.__driverMove=null; window.addEventListener('mousemove',e=>{window.__driverMove=[e.clientX,e.clientY]},true)")
    perform(d, [{"type":"pointer","id":"calibration","parameters":{"pointerType":"mouse"},"actions":[
        {"type":"pointerMove","x":100,"y":100,"origin":"viewport"}]}])
    smoke.wait_until(d,"return window.__driverMove && window.__driverMove[0]>0 && window.__driverMove[1]>0")
    received=d.js("return window.__driverMove")
    d.pointer_scale=(100/received[0],100/received[1])
    d.engine_cell_probe=True
    d.js("window.__rhwpProbe.pointerScale=arguments[0]", list(d.pointer_scale))
    d.js("window.__driverMove=null")
    perform(d, [{"type":"pointer","id":"calibration","parameters":{"pointerType":"mouse"},"actions":[
        {"type":"pointerMove","x":200,"y":200,"origin":"viewport"}]}])
    smoke.wait_until(d,"return window.__driverMove !== null")
    second=d.js("return window.__driverMove")
    if any(abs(second[i]*d.pointer_scale[i]-200)>2 for i in (0,1)):
        raise smoke.Failure("WebDriver pointer mapping is not a verified origin-preserving scale")
