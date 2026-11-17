//! WordCraft DOCX table structure editing (Stage 2 Phase 1): capability reporting, strict
//! target validation, atomic execution with round-trip equivalence checking, and Undo/Redo.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::json;
use wordcraft_engine::doc::table::{MAX_COLS, MAX_ROWS};
use wordcraft_engine::doc::{Block, Cell, Document, InlineObject, StoryRef, Table};

use super::{position_key, DocxModel, Rejected, SelectionIdentity};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableStructureAction {
    InsertRowAbove,
    InsertRowBelow,
    InsertColumnLeft,
    InsertColumnRight,
    DeleteRow,
    DeleteColumn,
    MergeRight,
    MergeBelow,
    MergeCells,
    SplitCell,
}

impl TableStructureAction {
    pub fn command(self) -> &'static str {
        match self {
            TableStructureAction::InsertRowAbove => "table.insertRowAbove",
            TableStructureAction::InsertRowBelow => "table.insertRowBelow",
            TableStructureAction::InsertColumnLeft => "table.insertColumnLeft",
            TableStructureAction::InsertColumnRight => "table.insertColumnRight",
            TableStructureAction::DeleteRow => "table.deleteRow",
            TableStructureAction::DeleteColumn => "table.deleteColumn",
            TableStructureAction::MergeRight => "table.mergeRight",
            TableStructureAction::MergeBelow => "table.mergeBelow",
            TableStructureAction::MergeCells => "table.mergeCells",
            TableStructureAction::SplitCell => "table.splitCell",
        }
    }
}

/// Table structure state & per-command refusal reasons exposed in `DocxView`.
/// `None` for an action field means the operation is allowed in the current context;
/// `Some(reason)` holds the UI `UnavailableReason` key (`tableShape`, `tableContent`, `limit`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxTableView {
    pub rows: usize,
    pub cols: usize,
    pub row: usize,
    pub col: usize,
    pub row_span: usize,
    pub col_span: usize,
    pub selected_cells: usize,
    pub insert_row_above: Option<&'static str>,
    pub insert_row_below: Option<&'static str>,
    pub insert_column_left: Option<&'static str>,
    pub insert_column_right: Option<&'static str>,
    pub delete_row: Option<&'static str>,
    pub delete_column: Option<&'static str>,
    pub merge_right: Option<&'static str>,
    pub merge_below: Option<&'static str>,
    pub merge_cells: Option<&'static str>,
    pub split_cell: Option<&'static str>,
    pub max_split_rows: usize,
    pub max_split_columns: usize,
}

enum MultiCellState {
    /// Caret or text selection confined inside one cell.
    Single,
    /// Selection crosses out of the table or covers unrelated tables.
    CrossTable,
    /// Valid logical cell rectangle `(r0, r1, g0, g1, distinct_logical_cells)`.
    Rect(usize, usize, usize, usize, usize),
    /// Selection overlaps a merged cell partially.
    PartialOverhang,
}

fn grid_cols(t: &Table, r: usize, c: usize) -> (usize, usize) {
    let g = t.grid_col(r, c);
    let span = t.rows.get(r).and_then(|row| row.cells.get(c)).map_or(1, Cell::span);
    (g, g + span - 1)
}

fn inspect_selection(model: &DocxModel, tp: &wordcraft_engine::doc::Path, t: &Table) -> MultiCellState {
    let sel = &model.session.sel;
    if let Some(range) = model
        .session
        .cell_range()
        .filter(|cr| cr.story == StoryRef::Body && cr.table == *tp)
    {
        return match t.logical_rect_valid(range.rows.0, range.rows.1, range.cols.0, range.cols.1) {
            Some(count) => MultiCellState::Rect(
                range.rows.0,
                range.rows.1,
                range.cols.0,
                range.cols.1,
                count,
            ),
            None => MultiCellState::PartialOverhang,
        };
    }
    if sel.is_collapsed() {
        return MultiCellState::Single;
    }
    if sel.anchor.story != StoryRef::Body || sel.focus.story != StoryRef::Body {
        return MultiCellState::CrossTable;
    }
    match (sel.anchor.path.cell(), sel.focus.path.cell()) {
        (Some((ta, ra, ca)), Some((tb, rb, cb))) if ta == *tp && tb == *tp => {
            if (ra, ca) == (rb, cb) {
                MultiCellState::Single
            } else {
                let (ga0, ga1) = grid_cols(t, ra, ca);
                let (gb0, gb1) = grid_cols(t, rb, cb);
                let (r0, r1, g0, g1) = (ra.min(rb), ra.max(rb), ga0.min(gb0), ga1.max(gb1));
                match t.logical_rect_valid(r0, r1, g0, g1) {
                    Some(count) => MultiCellState::Rect(r0, r1, g0, g1, count),
                    None => MultiCellState::PartialOverhang,
                }
            }
        }
        _ => MultiCellState::CrossTable,
    }
}

fn collect_obj_media(obj: &InlineObject, used: &mut BTreeSet<String>) {
    match obj {
        InlineObject::Image { media, .. } => {
            used.insert(media.clone());
        }
        InlineObject::Group { children, .. } => {
            for child in children {
                collect_obj_media(&child.obj, used);
            }
        }
        _ => {}
    }
}

fn collect_block_media(blocks: &[std::sync::Arc<Block>], used: &mut BTreeSet<String>) {
    for block in blocks {
        match block.as_ref() {
            Block::Para(p) => {
                for obj in &p.objects {
                    collect_obj_media(obj, used);
                }
            }
            Block::Table(t) => {
                for row in &t.rows {
                    for cell in &row.cells {
                        collect_block_media(&cell.blocks, used);
                    }
                }
            }
        }
    }
}

/// Prune unreferenced `Document::media` entries after deleting rows/columns so
/// `roundtrip_equivalent` and DOCX serialization do not retain orphaned image parts
/// (Undo snapshots preserve the prior `Document::media` intact).
fn retain_used_media(doc: &mut Document) {
    if doc.media.is_empty() {
        return;
    }
    let mut used = BTreeSet::new();
    collect_block_media(&doc.body, &mut used);
    for part in doc.parts.values() {
        collect_block_media(&part.blocks, &mut used);
    }
    doc.media.retain(|key, _| used.contains(key));
}

fn refusal_for(
    model: &DocxModel,
    t: &Table,
    ext: (usize, usize, usize, usize),
    multi: &MultiCellState,
    action: TableStructureAction,
    split_dims: Option<(u32, u32)>,
) -> Option<&'static str> {
    if matches!(multi, MultiCellState::CrossTable) {
        return Some("tableShape");
    }
    if !matches!(action, TableStructureAction::SplitCell) && split_dims.is_some() {
        return Some("tableShape");
    }
    let (r0, r1, g0, g1) = ext;
    let ncols = t.grid.len();
    let nrows = t.rows.len();
    let multi_active = match multi {
        MultiCellState::Rect(_, _, _, _, count) => *count > 1,
        MultiCellState::PartialOverhang => true,
        MultiCellState::Single | MultiCellState::CrossTable => false,
    };
    let (sel_r0, sel_r1, _sel_g0, _sel_g1) = match multi {
        MultiCellState::Rect(ar0, ar1, ag0, ag1, _) => (*ar0, *ar1, *ag0, *ag1),
        _ => (r0, r1, g0, g1),
    };
    match action {
        TableStructureAction::InsertRowAbove | TableStructureAction::InsertRowBelow => {
            let count = sel_r1.saturating_sub(sel_r0) + 1;
            if nrows.saturating_add(count) > MAX_ROWS {
                return Some("limit");
            }
            let like = if matches!(action, TableStructureAction::InsertRowBelow) {
                sel_r1
            } else {
                sel_r0
            };
            if t.rect_has_controls(like, like, 0, ncols.saturating_sub(1)) {
                return Some("tableContent");
            }
            let _ = model;
            None
        }
        TableStructureAction::InsertColumnLeft | TableStructureAction::InsertColumnRight => {
            if ncols >= MAX_COLS {
                Some("limit")
            } else {
                None
            }
        }
        TableStructureAction::DeleteRow => {
            let rows_to_delete: BTreeSet<usize> = match multi {
                MultiCellState::Rect(ar0, ar1, _, _, _) => (*ar0..=*ar1).collect(),
                _ => {
                    let Some((_, fr, _)) = model.session.sel.focus.path.cell() else {
                        return Some("tableShape");
                    };
                    [fr].into_iter().collect()
                }
            };
            if nrows <= 1 || rows_to_delete.len() >= nrows {
                return Some("tableShape");
            }
            for &rr in &rows_to_delete {
                if t.rect_has_controls(rr, rr, 0, ncols.saturating_sub(1)) {
                    return Some("tableContent");
                }
            }
            let mut probe = (rows_to_delete.len() > 1).then(|| t.clone());
            for &rr in rows_to_delete.iter().rev() {
                let ok = if let Some(ref mut p) = probe {
                    p.delete_row_safe(rr)
                } else {
                    t.can_delete_row_safe(rr)
                };
                if !ok {
                    return Some("tableContent");
                }
            }
            None
        }
        TableStructureAction::DeleteColumn => {
            let cols: BTreeSet<usize> = match multi {
                MultiCellState::Rect(ar0, ar1, ag0, ag1, _) => {
                    let mut set = BTreeSet::new();
                    for rr in *ar0..=*ar1 {
                        if let (Some(ca), Some(cb)) = (t.cell_at_grid(rr, *ag0), t.cell_at_grid(rr, *ag1)) {
                            for cc in ca..=cb {
                                let (a, b) = grid_cols(t, rr, cc);
                                set.extend(a..=b);
                            }
                        }
                    }
                    set
                }
                _ => (g0..=g1).collect(),
            };
            if ncols <= 1 || cols.is_empty() || cols.len() >= ncols {
                return Some("tableShape");
            }
            for &g in &cols {
                if t.rect_has_controls(0, nrows.saturating_sub(1), g, g) {
                    return Some("tableContent");
                }
            }
            None
        }
        TableStructureAction::MergeRight => {
            if multi_active {
                return Some("tableShape");
            }
            let next_g = g1 + 1;
            let Some(nc) = t.cell_at_grid(r0, next_g) else {
                return Some("tableShape");
            };
            let Some((nr0, nr1, ng0, ng1)) = t.cell_extent(r0, nc) else {
                return Some("tableShape");
            };
            if nr0 != r0 || nr1 != r1 || ng0 != next_g {
                return Some("tableShape");
            }
            if t.rect_has_controls(r0, r1, g0, ng1) || !t.can_merge_rect(r0, r1, g0, ng1) {
                return Some("tableContent");
            }
            None
        }
        TableStructureAction::MergeBelow => {
            if multi_active {
                return Some("tableShape");
            }
            let next_r = r1 + 1;
            let Some(bc) = t.cell_at_grid(next_r, g0) else {
                return Some("tableShape");
            };
            let Some((br0, br1, bg0, bg1)) = t.cell_extent(next_r, bc) else {
                return Some("tableShape");
            };
            if br0 != next_r || bg0 != g0 || bg1 != g1 {
                return Some("tableShape");
            }
            if t.rect_has_controls(r0, br1, g0, g1) || !t.can_merge_rect(r0, br1, g0, g1) {
                return Some("tableContent");
            }
            None
        }
        TableStructureAction::MergeCells => match multi {
            MultiCellState::Rect(ar0, ar1, ag0, ag1, count) if *count >= 2 => {
                if t.rect_has_controls(*ar0, *ar1, *ag0, *ag1) || !t.can_merge_rect(*ar0, *ar1, *ag0, *ag1) {
                    Some("tableContent")
                } else {
                    None
                }
            }
            _ => Some("tableShape"),
        },
        TableStructureAction::SplitCell => {
            if multi_active {
                return Some("tableShape");
            }
            let is_merged = r1 > r0 || g1 > g0;
            if is_merged {
                if split_dims.is_some() {
                    return Some("tableShape");
                }
                if t.rect_has_controls(r0, r1, g0, g1) {
                    return Some("tableContent");
                }
                return None;
            }
            let Some(ci) = t.cell_at_grid(r0, g0) else {
                return Some("tableShape");
            };
            let Some(cell) = t.rows.get(r0).and_then(|row| row.cells.get(ci)) else {
                return Some("tableShape");
            };
            if !cell.controls.is_empty() {
                return Some("tableContent");
            }
            let Some((mr, mc)) = t.unmerged_split_limits(r0, ci) else {
                let controls_block = t.rect_has_controls(r0, r0, 0, ncols.saturating_sub(1))
                    || t.rect_has_controls(0, nrows.saturating_sub(1), g0, g0);
                return Some(if controls_block { "tableContent" } else { "limit" });
            };
            if let Some((sr, sc)) = split_dims {
                if sr == 0 || sc == 0 || sr * sc < 2 || sr as usize > mr || sc as usize > mc {
                    return Some("limit");
                }
            }
            None
        }
    }
}

impl DocxModel {
    pub(super) fn table_view(&self) -> Option<DocxTableView> {
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body {
            return None;
        }
        let (tp, r, c) = focus.path.cell()?;
        let t = self.session.doc.table(StoryRef::Body, &tp)?;
        let Some(ext) = (if t.is_grid_consistent() { t.cell_extent(r, c) } else { None }) else {
            return Some(DocxTableView {
                rows: t.rows.len(),
                cols: t.cols(),
                row: r,
                col: c,
                row_span: 1,
                col_span: 1,
                selected_cells: 1,
                insert_row_above: Some("tableShape"),
                insert_row_below: Some("tableShape"),
                insert_column_left: Some("tableShape"),
                insert_column_right: Some("tableShape"),
                delete_row: Some("tableShape"),
                delete_column: Some("tableShape"),
                merge_right: Some("tableShape"),
                merge_below: Some("tableShape"),
                merge_cells: Some("tableShape"),
                split_cell: Some("tableShape"),
                max_split_rows: 0,
                max_split_columns: 0,
            });
        };
        let multi = inspect_selection(self, &tp, t);
        let selected_cells = match multi {
            MultiCellState::Rect(_, _, _, _, count) => count,
            _ => 1,
        };
        let reason = |a| refusal_for(self, t, ext, &multi, a, None);
        let is_merged = ext.1 > ext.0 || ext.3 > ext.2;
        let (max_split_rows, max_split_columns) = if is_merged
            || matches!(multi, MultiCellState::CrossTable | MultiCellState::PartialOverhang)
            || matches!(multi, MultiCellState::Rect(_, _, _, _, count) if count > 1)
        {
            (0, 0)
        } else if let Some(ci) = t.cell_at_grid(ext.0, ext.2) {
            t.unmerged_split_limits(ext.0, ci).unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        Some(DocxTableView {
            rows: t.rows.len(),
            cols: t.grid.len(),
            row: ext.0,
            col: ext.2,
            row_span: ext.1 - ext.0 + 1,
            col_span: ext.3 - ext.2 + 1,
            selected_cells,
            insert_row_above: reason(TableStructureAction::InsertRowAbove),
            insert_row_below: reason(TableStructureAction::InsertRowBelow),
            insert_column_left: reason(TableStructureAction::InsertColumnLeft),
            insert_column_right: reason(TableStructureAction::InsertColumnRight),
            delete_row: reason(TableStructureAction::DeleteRow),
            delete_column: reason(TableStructureAction::DeleteColumn),
            merge_right: reason(TableStructureAction::MergeRight),
            merge_below: reason(TableStructureAction::MergeBelow),
            merge_cells: reason(TableStructureAction::MergeCells),
            split_cell: reason(TableStructureAction::SplitCell),
            max_split_rows,
            max_split_columns,
        })
    }

    pub(super) fn table_structure(
        &mut self,
        action: TableStructureAction,
        target: &SelectionIdentity,
        rows: Option<u32>,
        columns: Option<u32>,
    ) -> Result<bool, Rejected> {
        if position_key(&self.session.sel.anchor) != target.anchor_key
            || position_key(&self.session.sel.focus) != target.caret_key
        {
            return Err(Rejected);
        }
        let split_dims = match (rows, columns) {
            (None, None) => None,
            (Some(r), Some(c)) => Some((r, c)),
            _ => return Err(Rejected),
        };
        let focus = &self.session.sel.focus;
        if focus.story != StoryRef::Body || self.session.sel.anchor.story != StoryRef::Body {
            return Err(Rejected);
        }
        let (tp, r, c) = focus.path.cell().ok_or(Rejected)?;
        let t = self.session.doc.table(StoryRef::Body, &tp).ok_or(Rejected)?;
        if !t.is_grid_consistent() {
            return Err(Rejected);
        }
        let ext = t.cell_extent(r, c).ok_or(Rejected)?;
        let multi = inspect_selection(self, &tp, t);
        if refusal_for(self, t, ext, &multi, action, split_dims).is_some() {
            return Err(Rejected);
        }
        let params = match split_dims {
            Some((sr, sc)) => json!({ "rows": sr, "columns": sc }),
            None => json!({}),
        };
        let changed = self.atomic(|model| {
            let changed = model.run(action.command(), params.clone())?;
            if !changed {
                return Err(Rejected);
            }
            if matches!(action, TableStructureAction::DeleteRow | TableStructureAction::DeleteColumn) {
                retain_used_media(&mut model.session.doc);
            }
            let updated_tp = model
                .session
                .sel
                .focus
                .path
                .cell()
                .map(|(p, _, _)| p)
                .ok_or(Rejected)?;
            if updated_tp != tp {
                return Err(Rejected);
            }
            let updated_table = model
                .session
                .doc
                .table(StoryRef::Body, &updated_tp)
                .ok_or(Rejected)?;
            if !updated_table.is_grid_consistent() {
                return Err(Rejected);
            }
            if !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(true)
        })?;
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }
}
