"""Bind the historical read-only native probe to actual application documents.

Instance wrappers avoid depending on a Vite module-query alias sharing the same
prototype. Every method still calls the original method with unchanged arguments.
"""
def app_observer(script):
    start = script.index("  for (const name of ['getPageInfo'")
    end = script.index('  p.engineSurfaces=', start)
    loop = script[start:end].replace('mod.HwpDocument.prototype', 'target')
    loop = loop.replace("if(name==='hitTest') {", "if(['insertText','insertTextInCell','deleteText','deleteTextInCell','splitParagraph','splitParagraphInCell','restoreSnapshot'].includes(name))active=this;\n        if(name==='hitTest') {")
    replacement = """
  const facade=await import('/src/components/Editor/rhwp/rhwpModule.ts').then(m=>m.loadRhwpModule());
  p.actualConstructorAlias=[];
  p.fields=()=>active?JSON.parse(active.getFieldList()):null;
  p.cellProperties=(s,p,c,cell)=>active?JSON.parse(active.getCellCharPropertiesAt(s,p,c,cell,0,0)):null;
  p.memory=()=>facade.memoryBytes();
  const open=facade.openDocument;
  facade.openDocument=function(...args){
    const target=open.apply(this,args);
    p.actualConstructorAlias.push(Object.getPrototypeOf(target)===mod.HwpDocument.prototype);
""" + loop + """
    return target;
  };
"""
    result = script[:start] + replacement + script[end:]
    return result.replace('  window.__rhwpProbeReady=true;', "  const surfaces=p.engineSurfaces;\n  p.engineSurfaces=()=>p.actualConstructorAlias.length&&p.actualConstructorAlias.every(Boolean)?surfaces():null;\n  window.__rhwpProbeReady=true;")
