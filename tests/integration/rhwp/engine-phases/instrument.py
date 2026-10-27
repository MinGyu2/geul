#!/usr/bin/env python3
"""Diagnostic-only spans for the verified e88d source; never patches production assets."""
import argparse
import hashlib
import json
from pathlib import Path
from hash_catalog import load_json


def instrument(source):
    changes = {}
    staged = {}
    def edit(name, old, new, count=1):
        p = source / name
        text = staged.get(name, p.read_text())
        if text.count(old) != count:
            raise ValueError(f'{name}: expected {count} exact boundaries, found {text.count(old)}')
        changes.setdefault(name, hashlib.sha256(p.read_bytes()).hexdigest())
        staged[name] = text.replace(old, new)
    lib = source / 'src/lib.rs'
    changes['src/lib.rs'] = hashlib.sha256(lib.read_bytes()).hexdigest()
    if 'pub(crate) mod engine_phase {' in lib.read_text():
        raise ValueError('source already instrumented')
    staged['src/lib.rs'] = lib.read_text() + '''
// Diagnostic candidate only: monotonic inclusive spans, no retained document/resource.
#[cfg(target_arch = "wasm32")]
pub(crate) mod engine_phase {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen(inline_js = "export function geulPhaseStart(name){const t=globalThis.__geulEngineTrace;if(!t)return -1;const id=++t.sequence;const parent=t.stack.at(-1)??null;t.stack.push(id);t.pending.set(id,{id,parent,name,at:performance.now(),context:t.context});return id;} export function geulPhaseEnd(id){const t=globalThis.__geulEngineTrace;if(!t)return;const s=t.pending.get(id);if(!s){t.errors++;return;}t.pending.delete(id);if(t.stack.pop()!==id)t.errors++;s.ms=performance.now()-s.at;if(t.rows.length<t.limit)t.rows.push(s);else t.dropped++;}")]
    extern "C" {
        fn geulPhaseStart(name: &str) -> f64;
        fn geulPhaseEnd(id: f64);
    }
    pub struct Span(f64);
    impl Span { pub fn new(name: &'static str) -> Self { Self(geulPhaseStart(name)) } }
    impl Drop for Span { fn drop(&mut self) { if self.0 >= 0.0 { geulPhaseEnd(self.0); } } }
}
'''
    api = 'src/wasm_api.rs'
    edit(api, 'pub fn poll_render_job(&self, id: u32) -> Result<String, JsValue> {', 'pub fn poll_render_job(&self, id: u32) -> Result<String, JsValue> {\nlet _phase_poll = crate::engine_phase::Span::new("poll.total");')
    edit(api, 'let progress = (|| -> Result<bool, JsValue> {', 'let progress = (|| -> Result<bool, JsValue> {\nlet _phase = crate::engine_phase::Span::new("poll.prepare");')
    edit(api, 'let compatibility_tree;', 'let phase_tree = crate::engine_phase::Span::new("poll.tree");\nlet compatibility_tree;')
    edit(api, '// Lower-bound payload observation only;', 'drop(phase_tree);\n// Lower-bound payload observation only;')
    edit(api, 'let scratch: HtmlCanvasElement =', 'let phase_scratch = crate::engine_phase::Span::new("poll.scratch.allocate");\nlet scratch: HtmlCanvasElement =')
    edit(api, 'frame.0.set_height(height);\n            let _guard', 'frame.0.set_height(height);\ndrop(phase_scratch);\nlet phase_replay = crate::engine_phase::Span::new("poll.replay");\n            let _guard')
    edit(api, '            let mut state = job.borrow_mut();\n            if state.state != Outcome::Pending {\n                let outcome', '            drop(phase_replay);\nlet phase_validate = crate::engine_phase::Span::new("poll.validate");\nlet mut state = job.borrow_mut();\n            if state.state != Outcome::Pending {\n                let outcome')
    edit(api, '            render_job::backup_begin(old_bytes);', '            drop(phase_validate);\nlet phase_backup = crate::engine_phase::Span::new("poll.backup.readback");\nrender_job::backup_begin(old_bytes);')
    edit(api, '            // Recheck after backup too:', '            drop(phase_backup);\nlet phase_validate = crate::engine_phase::Span::new("poll.validate.afterBackup");\n// Recheck after backup too:')
    edit(api, '            // No async boundary exists between validation and publication.', '            drop(phase_validate);\nlet _phase_publish = crate::engine_phase::Span::new("poll.publish.atomic");\n// No async boundary exists between validation and publication.')
    web = 'src/renderer/web_canvas.rs'
    edit(web, 'fn decoded_canvas(key: ImageKey, data: &[u8]) -> Option<super::render_job::DecodedLease> {', 'fn decoded_canvas(key: ImageKey, data: &[u8]) -> Option<super::render_job::DecodedLease> {\nlet _phase = crate::engine_phase::Span::new("resource.decoded.lookup");')
    edit(web, '    super::render_job::note_decode();', '    let _phase_total = crate::engine_phase::Span::new("image.prepare.total");\nsuper::render_job::note_decode();')
    edit(web, '    let Ok(dynimg) = image::load_from_memory(data) else {', '    let phase_codec = crate::engine_phase::Span::new("image.codec");\nlet Ok(dynimg) = image::load_from_memory(data) else {')
    edit(web, '    let rgba = super::canvas_rgba::canvas_rgba(&dynimg);', '    drop(phase_codec);\nlet phase_rgba = crate::engine_phase::Span::new("image.rgba");\nlet rgba = super::canvas_rgba::canvas_rgba(&dynimg);\ndrop(phase_rgba);')
    edit(web, '    let buf = rgba.into_raw();', '    let phase_data = crate::engine_phase::Span::new("image.imageData");\nlet buf = rgba.into_raw();')
    edit(web, '    let Some(canvas) = web_sys::window()\n', '    drop(phase_data);\nlet phase_canvas = crate::engine_phase::Span::new("image.canvas.allocate");\nlet Some(canvas) = web_sys::window()\n')
    edit(web, '    let painted = canvas', '    drop(phase_canvas);\nlet phase_upload = crate::engine_phase::Span::new("image.canvas.putImageData");\nlet painted = canvas')
    edit(web, '    if !painted {', '    drop(phase_upload);\nif !painted {')
    rendering = 'src/document_core/queries/rendering.rs'
    # This exact builder is shared by compatibility and staged paths.
    edit(rendering, 'pub fn build_canvas_page_layer_tree_with_profile(\n        &self,\n        page_num: u32,\n        profile: RenderProfile,\n    ) -> Result<PageLayerTree, HwpError> {', 'pub fn build_canvas_page_layer_tree_with_profile(\n        &self,\n        page_num: u32,\n        profile: RenderProfile,\n    ) -> Result<PageLayerTree, HwpError> {\n#[cfg(target_arch = "wasm32")] let _phase = crate::engine_phase::Span::new("tree.build.inclusive");')
    edit(rendering, 'if let Some(variants) = self.page_layer_tree_cache.borrow().get(idx) {\n            if let Some((_, tree)) = variants.iter().find(|(value, _)| *value == fingerprint) {\n                return Ok(tree.clone());', 'if let Some(variants) = self.page_layer_tree_cache.borrow().get(idx) {\n            if let Some((_, tree)) = variants.iter().find(|(value, _)| *value == fingerprint) {\n#[cfg(target_arch = "wasm32")] let _phase = crate::engine_phase::Span::new("tree.cache.clone");\nreturn Ok(tree.clone());')
    edit(rendering, '            Ok(builder.build_with_embedded_fonts(tree, &embedded_fonts))', '            #[cfg(target_arch = "wasm32")] let _phase = crate::engine_phase::Span::new("tree.layer.construct");\nOk(builder.build_with_embedded_fonts(tree, &embedded_fonts))')
    edit(rendering, '            variants.push((fingerprint, layer_tree.clone()));', '            #[cfg(target_arch = "wasm32")] let _phase = crate::engine_phase::Span::new("tree.cache.storeClone");\nvariants.push((fingerprint, layer_tree.clone()));')
    edit(rendering, '        header_footer_override: Option<(usize, bool, u8)>,\n    ) -> Result<PageRenderTree, HwpError> {', '        header_footer_override: Option<(usize, bool, u8)>,\n    ) -> Result<PageRenderTree, HwpError> {\n#[cfg(target_arch = "wasm32")] let _phase = crate::engine_phase::Span::new("layout.pageTree.inclusive");')
    edit(web, '    fn render_image(&mut self, bbox: &BoundingBox, img: &ImageNode, restore_transform: bool) {', '    fn render_image(&mut self, bbox: &BoundingBox, img: &ImageNode, restore_transform: bool) {\nlet _phase = crate::engine_phase::Span::new("resource.image.draw.inclusive");')
    for name, content in staged.items():
        (source/name).write_text(content)
    return {name: {'before': before, 'after': hashlib.sha256((source/name).read_bytes()).hexdigest()} for name,before in changes.items()}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--baseline-manifest', required=True, type=Path)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve earlier result')
    expected = load_json(a.baseline_manifest)['sourceHashes']
    actual = {str(p.relative_to(a.source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (a.source/'src').rglob('*.rs')}
    if actual != expected: p.error('all baseline source hashes must match before instrumentation')
    a.output.write_text(json.dumps(instrument(a.source), indent=2)+'\n')


if __name__ == '__main__': main()
