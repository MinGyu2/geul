#!/usr/bin/env python3
"""Add targeted tree-construction spans to the already-verified phase source."""
import argparse, hashlib, json
from pathlib import Path
from hash_catalog import load_json


def deepen(root):
    staged = {}; before = {}
    def edit(name, old, new):
        p = root/name; text = staged.get(name, p.read_text())
        if text.count(old) != 1: raise ValueError(f'{name}: boundary count {text.count(old)}')
        before.setdefault(name, hashlib.sha256(p.read_bytes()).hexdigest())
        staged[name] = text.replace(old, new)
    def start(name):
        return '#[cfg(target_arch = "wasm32")] let phase_deep = crate::engine_phase::Span::new("'+name+'");\n'
    end = '#[cfg(target_arch = "wasm32")] drop(phase_deep);\n'
    q = 'src/document_core/queries/rendering.rs'
    edit(q, '        self.layout_engine.reset_numbering_state();', start('layout.numbering.replay')+'        self.layout_engine.reset_numbering_state();')
    edit(q, '        // 머리말/꼬리말이 상속된 경우 원본 구역의 문단을 조회', end+'        // 머리말/꼬리말이 상속된 경우 원본 구역의 문단을 조회')
    edit(q, '        let mut tree = self.layout_engine.build_render_tree(', start('layout.renderTree')+'        let mut tree = self.layout_engine.build_render_tree(')
    edit(q, '        // 확장 바탕쪽 추가 렌더링', end+'        // 확장 바탕쪽 추가 렌더링')
    edit(q, '        tree.clip_overlapping_same_bin_images();', start('layout.clip.overlappingImages')+'        tree.clip_overlapping_same_bin_images();\n'+end)
    layout = 'src/renderer/layout.rs'
    edit(layout, '        self.build_columns(\n            tree.frame_mut(),', start('layout.body.columns')+'        self.build_columns(\n            tree.frame_mut(),')
    edit(layout, '        // 단 구분선은 build_columns 내부의 emit_zone_column_separators', end+'        // 단 구분선은 build_columns 내부의 emit_zone_column_separators')
    edit(layout, '        tree.apply_legacy_hancom_product_display_projection();', start('layout.displayProjection')+'        tree.apply_legacy_hancom_product_display_projection();\n'+end)
    edit(layout, '        Self::lift_cell_anchored_objects_above_text(&mut tree.root);', start('layout.liftAnchored')+'        Self::lift_cell_anchored_objects_above_text(&mut tree.root);\n'+end)
    for name, text in staged.items(): (root/name).write_text(text)
    return {name: {'before': sha, 'after': hashlib.sha256((root/name).read_bytes()).hexdigest()} for name,sha in before.items()}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True, type=Path); p.add_argument('--manifest', required=True, type=Path); p.add_argument('--output', required=True, type=Path)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve previous evidence')
    expected = load_json(a.manifest)['sourceHashes']
    actual = {str(p.relative_to(a.source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (a.source/'src').rglob('*.rs')}
    if actual != expected: p.error('phase source identity mismatch')
    a.output.write_text(json.dumps(deepen(a.source),indent=2)+'\n')


if __name__ == '__main__': main()
