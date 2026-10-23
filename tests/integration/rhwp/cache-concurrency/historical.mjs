import { gif, svg, png, classify } from "./fixtures.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function historical(mod) {
  const fixtures = [];
  const stats = () => mod.rendererCacheStats ? JSON.parse(mod.rendererCacheStats()) : null;
  let notified = 0; const notes = [];
  if (mod.setRendererImageLoadListener) mod.setRendererImageLoadListener(() => { notified++; });
  const errors = []; addEventListener("error", (e) => errors.push(String(e.message)));
  const HU = 75; // HWPUNIT per CSS px at 96 dpi
  function makeDoc(bytes, ext, natW, natH, boxPx, crop) {
    fixtures.push({ ext, naturalWidth: natW, naturalHeight: natH, encodedBytes: bytes.length, boxPx, scale: 1 });
    const doc = mod.HwpDocument.createEmpty();
    const r = JSON.parse(doc.insertPicture(0, 0, 0, "", bytes, boxPx * HU, boxPx * HU, natW, natH, ext, "", null, null));
    if (crop) {
      const p = JSON.parse(doc.getPictureProperties(0, r.paraIdx, r.controlIdx));
      notes.push({ cropBefore: { l: p.cropLeft, t: p.cropTop, r: p.cropRight, b: p.cropBottom, w: p.width } });
      doc.setPictureProperties(0, r.paraIdx, r.controlIdx, JSON.stringify(crop(p)));
    }
    return doc;
  }
  const render = (doc, label) => {
    const c = document.createElement("canvas");
    let threw = null; try { doc.renderPageToCanvas(0, c, 1); } catch (e) { threw = String(e); }
    const row = { label, ...classify(c), threw, stats: stats(), notified };
    c.width = c.height = 0; return row;
  };
  const fx = {};
  const scenarios = {
    async smallPng() { const d = makeDoc(await png(64, 64), "png", 64, 64, 200);
      const rows = [render(d, "r1"), render(d, "r2")]; d.free(); return rows; },
    async largePngOversizeDecoded() { const d = makeDoc(fx.bigPng ??= await png(4400, 4000), "png", 4400, 4000, 300);
      const rows = [render(d, "r1"), render(d, "r2"), render(d, "r3")]; d.free(); return rows; },
    async smallSvg() { const d = makeDoc(svg(64, 64), "svg", 64, 64, 200);
      const rows = [render(d, "r1")]; await sleep(400); rows.push(render(d, "r2"), render(d, "r3")); d.free(); return rows; },
    async largeSvgGrowsPastEntryLimit() { const d = makeDoc(svg(2400, 2400), "svg", 2400, 2400, 300);
      const rows = [render(d, "r1")]; await sleep(500); rows.push(render(d, "r2"), render(d, "r3")); await sleep(500);
      rows.push(render(d, "r4"), render(d, "r5")); d.free(); return rows; },
    async croppedGif() { const d = makeDoc(gif(200, 200), "gif", 200, 200, 200, (p) => ({ cropLeft: Math.round(p.width / 2) }));
      const rows = [render(d, "r1")]; await sleep(400); rows.push(render(d, "r2"), render(d, "r3")); d.free(); return rows; },
    async encodedOversizeSvg() { const d = makeDoc(svg(64, 64, 13 << 20), "svg", 64, 64, 200);
      const rows = [render(d, "r1")]; await sleep(800); rows.push(render(d, "r2")); await sleep(800); rows.push(render(d, "r3"), render(d, "r4")); d.free(); return rows; },
    async negativeDecode() { const junk = new Uint8Array(4096).map((_, i) => (i * 7919) & 255); junk[0] = 0x47; // not a valid image
      const d = makeDoc(junk, "png", 64, 64, 200); const rows = [render(d, "r1")]; await sleep(400); rows.push(render(d, "r2"), render(d, "r3")); d.free(); return rows; },
    async trimBetweenDraws() { const d1 = makeDoc(await png(64, 64), "png", 64, 64, 200), d2 = makeDoc(svg(64, 64), "svg", 64, 64, 200);
      const rows = [render(d1, "png1"), render(d2, "svg1")]; await sleep(400); rows.push(render(d2, "svg2"));
      if (mod.trimRendererCaches) mod.trimRendererCaches(0);
      rows.push(render(d1, "png-after-trim"), render(d2, "svg-after-trim")); await sleep(400); rows.push(render(d2, "svg-after-trim-wait"));
      d1.free(); d2.free(); return rows; },
    async trimDuringLoad() { const d = makeDoc(svg(80, 80), "svg", 80, 80, 200); const rows = [render(d, "r1")];
      if (mod.trimRendererCaches) mod.trimRendererCaches(0); await sleep(400); rows.push(render(d, "r2")); await sleep(400); rows.push(render(d, "r3")); d.free(); return rows; },
    async closedBeforeLoad() { const d = makeDoc(svg(96, 96), "svg", 96, 96, 200); const rows = [render(d, "r1")]; d.free();
      await sleep(400); const d2 = makeDoc(svg(96, 96), "svg", 96, 96, 200); rows.push(render(d2, "other-doc-same-image")); d2.free(); return rows; },
    async sharedAcrossDocs() { const bytes = svg(72, 72), pbytes = await png(72, 72);
      const a = makeDoc(bytes, "svg", 72, 72, 200), b = makeDoc(bytes, "svg", 72, 72, 200), c = makeDoc(pbytes, "png", 72, 72, 200), e = makeDoc(pbytes, "png", 72, 72, 200);
      const rows = [render(a, "a1"), render(b, "b1"), render(c, "c1"), render(e, "e1")]; await sleep(400);
      rows.push(render(a, "a2"), render(b, "b2")); b.free(); e.free(); rows.push(render(a, "a-after-b-closed"), render(c, "c-after-e-closed")); a.free(); c.free(); return rows; },
    async budgetPressureAlternating() { // two pages' worth of browser images cannot both fit: alternate renders
      if (mod.setRendererCacheBudget) mod.setRendererCacheBudget(8 << 20, 2 << 20, 16);
      const a = makeDoc(svg(600, 600), "svg", 600, 600, 300), b = makeDoc(svg(610, 610), "svg", 610, 610, 300); // 1.44 MB / 1.49 MB decoded
      const rows = []; for (let i = 0; i < 4; i++) { rows.push(render(a, `a${i}`)); await sleep(300); rows.push(render(b, `b${i}`)); await sleep(300); }
      a.free(); b.free(); if (mod.setRendererCacheBudget) mod.setRendererCacheBudget(256 << 20, 64 << 20, 256);
      return rows; },
  };

  const results = {};
  for (const [name, run] of Object.entries(scenarios)) {
    mod.trimRendererCaches?.(0);
    const before = notified;
    results[name] = { rows: await run() };
    await sleep(100);
    results[name].notifiedTotal = notified - before;
  }
  mod.setRendererImageLoadListener?.(null);
  return { results, fixtures, notes, errors };
}
