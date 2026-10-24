#!/usr/bin/env python3
"""Apply test-only timing to an already isolated pinned+caret source export.

Never invoke against external/ or a selected candidate. Produces an unapproved
instrumented diagnostic binary, not a performance optimization or D1 candidate.
"""
import argparse
from pathlib import Path
import difflib
import hashlib
import json


def instrument(work, output, deep=False):
    root = Path(__file__).resolve().parents[4]
    work = work.resolve()
    if work.is_relative_to(root) or not (work/'test-package/ENGINE.json').is_file():
        raise ValueError('requires isolated source prepared by cache-concurrency/prepare.py')
    files = ['src/lib.rs','src/document_core/commands/text_editing.rs', 'src/document_core/queries/rendering.rs']
    if deep: files += ['src/wasm_api.rs','src/renderer/web_canvas.rs']
    before = {f:(work/f).read_text() for f in files}
    helper = r'''
// Test-only D4 phase instrumentation. Bounded numeric timings, no model retention.
#[cfg(target_arch = "wasm32")]
pub(crate) mod d4_phase {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen(inline_js = "export function d4now(){return globalThis.__d4phase ? performance.now() : -1;} export function d4record(name,at){const a=globalThis.__d4phase;if(a && a.length<4096)a.push({name,at,ms:performance.now()-at});}")]
    extern "C" {
        fn d4now() -> f64;
        fn d4record(name: &str, at: f64);
    }
    pub struct Span(&'static str, f64);
    impl Span { pub fn new(name: &'static str) -> Self { Self(name, d4now()) } }
    impl Drop for Span { fn drop(&mut self) { if self.1 >= 0.0 { d4record(self.0,self.1); } } }
}
'''
    (work/files[0]).write_text(before[files[0]]+helper)
    def guard(name):
        return '#[cfg(target_arch = "wasm32")] let _d4span = crate::d4_phase::Span::new("'+name+'");'
    def body_span(text, name, label):
        at=text.index('fn '+name+'('); brace=text.index('{',at)
        return text[:brace+1]+'\n'+guard(label)+text[brace+1:]
    p=work/files[1];text=before[files[1]]
    text=body_span(text,'insert_text_at_caret_native','insert.total')
    text=body_span(text,'reflow_paragraph','reflow.paragraph')
    start=text.index('fn insert_text_at_caret_native(');end=text.index('pub fn ', start+5)
    chunk=text[start:end]
    for token,label in [('self.apply_body_edit_through_picture_band(section_idx, para_idx, &apply_insert)?','pictureBand'),
                        ('apply_insert(para);','mutation'),
                        ('self.reflow_paragraph(section_idx, para_idx);','reflow'),
                        ('self.recompose_paragraph(section_idx, para_idx);','compose'),
                        ('self.paginate_if_needed();','pagination')]:
        # Keep Result/return values and existing semicolons unchanged.
        bare=token.rstrip(';');chunk=chunk.replace(bare, '{ '+guard('insert.'+label)+' '+bare+' }')
    # Multiline recalculate_section_vpos calls end at this exact argument.
    token='crate::renderer::composer::recalculate_section_vpos('
    cursor=0
    while True:
        at=chunk.find(token,cursor)
        if at<0:break
        endcall=chunk.index(');',at)+1
        wrapped='{ '+guard('insert.sectionVpos')+' '+chunk[at:endcall]+' }'
        chunk=chunk[:at]+wrapped+chunk[endcall:];cursor=at+len(wrapped)
    text=text[:start]+chunk+text[end:];p.write_text(text)
    p=work/files[2];text=before[files[2]]
    for name,label in [('recompose_paragraph','compose.paragraph'),('paginate','paginate.total'),('paginate_pass','paginate.pass')]:
        text=body_span(text,name,label)
    for token,label in [('self.compute_render_normalized();','paginate.normalize')]:
        text=text.replace(token, '{ '+guard(label)+' '+token+' }')
    p.write_text(text)
    if deep:
        # Existing native profile boundaries become WASM wall-time spans.
        p=work/files[2];text=p.read_text()
        for begin,finish,var,label in [
            ('let measured = if !self.measured_sections[idx]', 'if let Some(started) = issue2424_measure_started', 'measured','paginate.measure'),
            ('let mut result = if use_paginator', 'if let Some(started) = issue2424_typeset_started', 'result','paginate.typeset')]:
            at=text.index(begin);end=text.index(finish,at)
            statement=text[at:end].rstrip()
            prefix='let '+('mut ' if var=='result' else '')+var+' = '
            text=text[:at]+prefix+'{ '+guard(label)+' '+statement+' '+var+' };\n            '+text[end:]
        p.write_text(text)
        p=work/'src/wasm_api.rs';text=p.read_text();at=text.index('pub fn poll_render_job(')
        begin=text.index('let tree = self',at);end=text.index('.map_err(JsValue::from)?;',begin)+len('.map_err(JsValue::from)?;')
        stmt=text[begin:end]
        text=text[:begin]+'let tree = { '+guard('poll.tree')+' '+stmt+' tree };'+text[end:]
        begin=text.index('match &replay {',text.index('let _guard = render_job::enter',at))
        end=text.index('let mut state = job.borrow_mut();',begin)
        text=text[:begin]+'{ '+guard('poll.replay')+' '+text[begin:end]+' }\n            '+guard('poll.publish')+'\n            '+text[end:]
        p.write_text(text)
        p=work/'src/renderer/web_canvas.rs';text=p.read_text()
        text=body_span(text,'decoded_canvas','image.decodedLookup')
        token='let dynimg = image::load_from_memory(data).ok()?;'
        assert token in text
        text=text.replace(token,'let dynimg = { '+guard('image.decode')+' image::load_from_memory(data).ok()? };')
        p.write_text(text)
    patch=''.join(''.join(difflib.unified_diff(before[f].splitlines(True),(work/f).read_text().splitlines(True),fromfile='a/'+f,tofile='b/'+f)) for f in files)
    # Git accepts empty context lines without a space marker; avoid patch-file trailing whitespace.
    patch = patch.replace('\n \n', '\n\n')
    output.write_text(patch)
    return {f:hashlib.sha256((work/f).read_bytes()).hexdigest() for f in files}


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--work',required=True,type=Path);p.add_argument('--patch-output',required=True,type=Path);p.add_argument('--deep',action='store_true');a=p.parse_args()
    print(json.dumps(instrument(a.work,a.patch_output,a.deep),indent=2))
