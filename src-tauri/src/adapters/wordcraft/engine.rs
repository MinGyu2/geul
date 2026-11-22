//! WordCraft 엔진 하나(문서 하나)를 감싸는 모델. Tauri·세션 기록과 무관하다(단위 시험 대상).
//!
//! - 프런트엔드가 보낼 수 있는 편집은 `DocxOp`의 고정된 목록뿐이다. 그것을 WordCraft 명령 ID로 바꾸는 일은 여기서만 한다.
//!   `Session::run`을 임의 ID로 열지 않는다: WordCraft 명령에는 임의 경로에 쓰는 것(`file.saveAs`, 편지 병합, 매크로 등)이
//!   있어, 그대로 열면 IPC가 파일 쓰기 권한이 된다(저장은 T009).
//! - 글자 넣기는 `raw`로 한다. 자동 고침·자동 서식은 넣은 글자를 바꾸므로(IME 확정 글자가 그대로 남지 않음) 쓰지 않는다.
//! - 변경 수: WordCraft의 `rev()`는 문서를 바꾸지 않은 "바꾸는 명령"(표 셀 사이 Tab, 문서 처음의 Backspace, 끝의 Delete)
//!   에도 는다(실측). 앱의 revision은 문서가 실제로 바뀐 연산만 세므로, 바꾸는 명령 앞뒤의 문서 모델을 비교한다.
//! - 붙여넣기(T008 안정화): 여러 문단·탭·긴 글자는 `PasteText` 조각으로 받는다(`\n` = 문단 나누기, `\t` = 탭 글자, 조각마다
//!   `MAX_TEXT_CHARS` 이하). 조각 하나는 WordCraft 명령 하나(`text.insert`, 실패하면 엔진이 되돌림)이고, `chain` 조각은 같은
//!   요청의 바로 앞 연산이 거부됐으면 실행하지 않는다(앞 조각 없이 뒤 조각만 들어가 내용 순서가 어긋나지 않음).
//! - 여러 명령으로 된 연산(`InsertAt`·`ReplaceInserted`)은 WordCraft 편집 스냅숏으로 묶는다: 중간 명령이 거부되면 문서·선택·
//!   실행 취소 기록을 그 연산 전으로 돌린다(`Session::edit_snapshot`/`restore`). 그래서 거부한 연산은 문서를 바꾸지 않았고,
//!   성공한 연산만 revision으로 센다. 스냅숏 밖인 어댑터 기억도 거부한 연산 전과 같다(T008 2차 안정화): 자리 표시는 성공한
//!   뒤에만 쓰고, `restore`가 올린 WordCraft 판 때문에 그 전에 고칠 수 있던 바로 앞 넣기가 고칠 수 없게 되지 않는다.
//! - 좌표는 WordCraft 쪽 좌표(pt, 쪽 왼쪽 위 기준)다. 화면 배율·DPR 변환은 프런트엔드가 한다.
//! - 이 모듈은 패닉을 일으키지 않게 쓰지만, 엔진 안의 패닉은 호출하는 쪽(commands)이 잡아 세션을 failed로 돌린다.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wordcraft_engine::doc::{InlineObject, Pos, StoryRef};
use wordcraft_engine::layout::DocLayout;
use wordcraft_engine::render::{render_page, RenderOptions, Rendered};
use wordcraft_engine::{io, Session};

use crate::document::EngineStage;

#[path = "stage1.rs"]
pub mod stage1;
#[path = "table.rs"]
pub mod table;
#[path = "embed_font.rs"]
pub mod embed_font;

/// WordCraft 입출력은 이름의 확장자로 형식을 고른다. 형식은 판별(T006)이 DOCX로 확정했다.
const DOCX_NAME: &str = "document.docx";

/// 한 요청의 연산 수 상한(프런트엔드가 응답을 기다리는 동안 묶은 입력).
pub const MAX_OPS: usize = 256;
/// 한 번에 넣는 글자 수 상한(문자 단위).
pub const MAX_TEXT_CHARS: usize = 4096;
/// 쪽 그림 하나의 픽셀 수 상한(RGBA 64 MiB, T007 canvas 예산과 같음).
pub const MAX_RENDER_PIXELS: f64 = 16.0 * 1024.0 * 1024.0;
/// 그리기 배율(pt당 픽셀) 범위.
pub const MIN_RENDER_SCALE: f32 = 0.1;
pub const MAX_RENDER_SCALE: f32 = 16.0;
/// 기억하는 자리 표시(`Mark`) 수. 오래된 것부터 버린다.
const MAX_MARKS: usize = 8;
/// 보기 응답에 담는 선택 사각형 수 상한.
const MAX_SELECTION_RECTS: usize = 4096;
/// 쪽 크기 상한(pt). 엔진 배치 결과를 검사한다.
const MAX_PAGE_SIDE_PT: f32 = 100_000.0;
/// Group-child geometry is exposed in points, snapped to DrawingML's integer EMU on mutation.
const DOCX_GROUP_COORD_UNITS_PER_PT: f64 = 12_700.0;

/// 프런트엔드가 보낼 수 있는 편집·이동. 인자는 IPC로 받은 값이므로 `validate`를 통과해야 실행한다.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocxOp {
    /// 커서(선택이 있으면 그 범위를 바꿔) 자리에 글자를 넣는다. IME 확정·일반 입력(한 문단 안, 탭·줄바꿈 없음).
    InsertText {
        text: String,
    },
    /// 붙여넣은 글자 조각. `\n`은 문단 나누기, `\t`는 탭 글자다(표 셀 이동이 아님). `chain`이면 같은 요청의 바로 앞 연산이
    /// 거부됐을 때 실행하지 않는다(같은 붙여넣기의 뒤 조각).
    PasteText {
        text: String,
        #[serde(default)]
        chain: bool,
    },
    /// 선택이 있으면 지운다(없으면 아무것도 하지 않음). IME 조합 글자가 처음 보일 때 선택을 바꾸기 시작한다.
    DeleteSelection {
        #[serde(default)]
        selection: Option<SelectionIdentity>,
    },
    Backspace,
    DeleteForward,
    NewParagraph,
    /// 표 안: 다음(앞) 셀로. 마지막 셀의 Tab은 WordCraft(Word와 같음)가 행을 더한다.
    Tab {
        #[serde(default)]
        back: bool,
    },
    Move {
        to: MoveTarget,
        #[serde(default)]
        extend: bool,
    },
    /// 쪽 좌표(pt)를 눌렀다. `before_insert`면 좌표가 바로 앞 `InsertText` 전에 보이던 화면의 것이다(조합 중 클릭: 앱이
    /// 조합 글자를 먼저 넣고 클릭을 처리한다). 그 넣기 전 배치에서 찾은 자리를 넣은 글자만큼 옮긴다.
    Pointer {
        page: u32,
        x: f32,
        y: f32,
        #[serde(default)]
        extend: bool,
        #[serde(default)]
        before_insert: bool,
        #[serde(default)]
        drag: bool,
        #[serde(default)]
        select_object: bool,
    },
    DeselectObject {},
    LeaveTextBox {},
    SelectAll,
    /// 지금 커서 자리를 `id`로 기억한다(IME가 클릭 뒤에 늦게 보내는 확정을 클릭 전 자리에 넣을 때).
    Mark {
        id: u32,
    },
    /// 기억한 자리에 글자를 넣는다. 커서·선택은 같은 문단의 그 자리 뒤에 있을 때만 넣은 만큼 민다.
    InsertAt {
        mark: u32,
        text: String,
    },
    /// 바로 앞에 넣은 글자(그 뒤 문서 변경 없음)가 `expected`이면 `text`로 바꾼다(앱이 먼저 확정한 조합을 입력기의 최종
    /// 글자로 고침).
    ReplaceInserted {
        expected: String,
        text: String,
    },
    /// WordCraft 실행 취소·다시 실행(T010). 기록은 엔진(`Session`)이 가진다. 앱은 따로 기록하지 않는다. 필드 없는 구조체
    /// 변형: 태그 붙은 단위 변형은 `deny_unknown_fields`가 모르는 필드를 거부하지 않는다(실측).
    Undo {},
    Redo {},
    /// 글자 서식 켜고 끄기(T010): 선택이 있으면 그 범위, 없으면 다음 입력 서식(엔진이 정함).
    Format {
        format: CharFormat,
    },
    /// Stage 5-A: font family for the selection (collapsed caret: the engine's `format.font` target —
    /// the word at the caret or the next typed text). WordCraft `format.font {"name"}`; a CJK font also
    /// becomes the East Asian font (`w:eastAsia`), as in Word. The requested name is stored as given even
    /// when this machine lacks the font (layout then falls back).
    Font {
        name: String,
    },
    /// 새 메모(T013, 앱 명령 `review.comment` → WordCraft `review.newComment`): 본문 안의 비어 있지 않은 선택에 한 줄 메모를 단다.
    /// 글자는 `MAX_COMMENT_CHARS` 이하, 제어 문자 없음. 커서만 있거나(엔진은 커서의 단어를 고르지만 앱은 쓰지 않음) 선택이
    /// 본문 밖(각주·머리말 등)이면 거부한다.
    Comment {
        text: String,
    },
    /// 새 각주(T013, 앱 명령 `references.footnote` → WordCraft `references.footnote`): 본문 최상위 문단의 커서(선택 없음) 자리에
    /// 각주 표지를 넣고 각주 글자를 `text`로 채운다. 엔진은 선택을 지우고 커서를 새 각주 안으로 옮기지만, 앱은 선택이 있으면
    /// 거부하고(글자를 지우지 않음) 실행 뒤 커서를 본문의 표지 바로 뒤로 돌린다(검증한 편집 문맥은 본문뿐).
    Footnote {
        text: String,
    },
    /// 새 미주(T013, `references.endnote`). 조건·동작은 `Footnote`와 같다.
    Endnote {
        text: String,
    },
    /// Real body table at a collapsed caret; dimensions are bounded by validate.
    Table {
        rows: u16,
        cols: u16,
    },
    /// Validated encoded PNG/JPEG only. Never accepts filesystem paths.
    Shape {
        kind: BasicShape,
    },
    TextBox {},
    CutShape { position: String, epoch: u64 },
    /// Stage 3 P5: paste a structured object payload (validated before any mutation).
    PasteObject {
        payload: Box<ObjectPayload>,
    },
    PasteHwpxPolygon {
        polygon: HwpxPolygon,
    },
    /// Stage 3: an edit of the selected drawing. `position`/`epoch` must name the current object selection
    /// (stale selections are rejected); the change must pass the DOCX T009 check against the pre-edit export.
    ObjectEdit {
        position: String,
        epoch: u64,
        edit: ObjectEdit,
    },
    Image {
        data: String,
    },
    /// Standard single-level unordered list using WordprocessingML numbering.
    Bullets {},
    /// 목차 넣기(T013, `references.toc` → WordCraft `references.toc {}`): 본문 최상위 문단의 커서(선택 없음) 자리에 엔진의 목차
    /// (`TOCHeading` 문단의 빈 `TOC` 필드 + 제목 문단에서 만든 `TOCn` 항목, 쪽 번호는 엔진 배치)를 넣는다. 문서에 이미 목차가 있으면
    /// 엔진은 두 번째 목차를 만들지 않고 그 목차를 갱신한다(엔진 계약). 선택이 있으면 거부한다(엔진은 선택을 지움).
    Toc {},
    /// 목차 갱신(T013, `references.updateToc`): 본문의 목차 항목을 지금 제목·쪽으로 다시 만든다. 목차가 없으면 거부한다.
    UpdateToc {},
    /// 변경 내용 추적 켜기·끄기(T013 Stage 3, `review.trackChanges` → WordCraft `review.trackChanges {"value"}`). 값을 명시해 늦게 온
    /// 요청이 토글을 뒤집지 않게 한다. 이미 그 값이면 바뀌지 않는다.
    TrackChanges {
        value: bool,
    },
    /// 선택(또는 커서 자리)의 변경 수락·거절(WordCraft `review.accept`·`review.reject`). 그 자리에 변경이 없으면 거부한다.
    AcceptChange {},
    RejectChange {},
    /// 문서 전체 변경 수락·거절(WordCraft `review.acceptAll`·`review.rejectAll`). 변경이 없으면 거부한다.
    AcceptAll {},
    RejectAll {},
    /// Stage 1: explicit paragraph alignment of the selected paragraphs (`para.align`, no toggling).
    Align {
        value: stage1::ParagraphAlign,
    },
    /// Stage 1: font size in points (`format.size`, half-point rounding by the engine).
    FontSize {
        size: f32,
    },
    /// Stage 1: font color `RRGGBB` or `auto` (`format.color`).
    FontColor {
        color: String,
    },
    /// Stage 1: highlight (`format.highlight`, one of `stage1::HIGHLIGHTS`).
    Highlight {
        color: String,
    },
    /// Stage 1 F: embed the font program of a face (`family`, `style`) of the shared font database into the
    /// document (font table embed slot + obfuscated font part). Refused unless the license permits editable
    /// embedding, the outlines are TrueType and the style has a DOCX slot.
    EmbedFont {
        family: String,
        style: String,
    },
    /// Stage 1: superscript/subscript/baseline with explicit values.
    Script {
        value: stage1::ScriptValue,
    },
    /// Stage 1: paragraph spacing and indents (one `para.set`).
    Paragraph {
        format: stage1::ParagraphFormat,
    },
    /// Stage 1: numbered/multilevel/custom bullet list (or off).
    List {
        style: stage1::ListStyle,
        #[serde(default)]
        off: bool,
    },
    /// Stage 1: list level demote (indent) / promote (outdent).
    ListIndent {
        #[serde(default)]
        outdent: bool,
    },
    RestartNumbering {},
    ContinueNumbering {},
    /// Stage 1: page setup of the selection's section(s).
    PageSetup {
        setup: stage1::PageSetupOp,
    },
    /// Stage 1: select the next/previous match (navigation; no revision).
    Find {
        query: stage1::SearchQuery,
        #[serde(default)]
        backward: bool,
    },
    /// Stage 1: replace the selected match if it is still a current match.
    Replace {
        query: stage1::SearchQuery,
        with: String,
    },
    /// Stage 1: replace every current match (one undo step).
    ReplaceAll {
        query: stage1::SearchQuery,
        with: String,
    },
    /// Stage 1: close the search (stop reporting search state).
    ClearSearch {},
    /// Stage 2 Phase 1: DOCX table structure editing with explicit target cell/selection ownership.
    TableStructure {
        action: table::TableStructureAction,
        target: SelectionIdentity,
        #[serde(default)]
        rows: Option<u32>,
        #[serde(default)]
        columns: Option<u32>,
    },
    /// Stage 2 Phase 3 (P3-1): DOCX cell background shading with explicit target ownership.
    TableShading {
        target: SelectionIdentity,
        #[serde(default)]
        color: Option<String>,
    },
    /// Stage 2 Phase 3 (P3-1): DOCX selected-cell border formatting with explicit target ownership.
    TableBorders {
        target: SelectionIdentity,
        kind: table::TableBorderKind,
        #[serde(default)]
        style: Option<String>,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Stage 2 Phase 3 (P3-2): DOCX selected-cell content alignment with explicit target ownership.
    TableAlignment {
        target: SelectionIdentity,
        #[serde(default)]
        horizontal: Option<table::CellHAlign>,
        #[serde(default)]
        vertical: Option<table::CellVAlign>,
    },
    /// Stage 2 Phase 3 (P3-3): DOCX selected-column width or uniform distribution with explicit target ownership.
    TableColumnWidth {
        target: SelectionIdentity,
        #[serde(default)]
        width: Option<f32>,
        #[serde(default)]
        distribute: bool,
    },
    /// Stage 2 Phase 3 (P3-3): DOCX selected-row height (exact/atLeast/auto) or distribution with explicit target ownership.
    TableRowHeight {
        target: SelectionIdentity,
        #[serde(default)]
        height: Option<f32>,
        #[serde(default)]
        rule: Option<table::RowHeightRule>,
        #[serde(default)]
        clear: bool,
        #[serde(default)]
        distribute: bool,
    },
    /// Stage 2 Phase 4 (P4-1): clear contents of a validated multi-cell selection (cut).
    CutTableCells {
        target: SelectionIdentity,
    },
    /// Stage 2 Phase 4 (P4-1): paste validated structured table cells atomically.
    PasteTableCells {
        target: SelectionIdentity,
        payload: table::PasteTableCellsPayload,
    },
    /// Stage 2 Phase 4 (P4-2): set selected-cell or table-default cell margins (pt) or reset override.
    TableCellMargins {
        target: SelectionIdentity,
        scope: table::TableMarginScope,
        #[serde(default)]
        top: Option<f32>,
        #[serde(default)]
        right: Option<f32>,
        #[serde(default)]
        bottom: Option<f32>,
        #[serde(default)]
        left: Option<f32>,
        #[serde(default)]
        reset: bool,
    },
    /// Stage 2 Phase 4 (P4-2): set table alignment and/or left indent (pt).
    TablePositioning {
        target: SelectionIdentity,
        #[serde(default)]
        align: Option<table::TableAlign>,
        #[serde(default)]
        indent_pt: Option<f32>,
    },
    /// Stage 2 Phase 4 (P4-3): toggle contiguous repeating header rows.
    TableRepeatHeader {
        target: SelectionIdentity,
        repeat: bool,
    },
    /// Stage 2 Phase 4 (P4-3): set row pagination break mode (`cell` = allow break, `row` = cantSplit).
    TableRowBreak {
        target: SelectionIdentity,
        mode: table::TableBreakMode,
    },
}

/// 이미 추적 중인 문서를 읽기 전용으로 둘지(T013 정책). WordCraft `b74830b`의 수정 기록 색인 일대일 비교 뒤 앱의 실제 연산 열
/// (넣기·IME 교정·늦은 확정·지우기·선택 바꾸기·붙여넣기·서식·메모·각주·목차·수락·거절·실행 취소)이 모두 저장 검증을 통과해
/// 해제했다(시험 `추적_문서의_실제_연산_열은_모두_저장_동등하다`). 다시 막아야 하면 이 상수 하나로 IPC·IME·명령 경계가 함께 막힌다.
pub const TRACKED_READ_ONLY: bool = false;

/// 메모 글자 수 상한(문자 단위).
pub const MAX_COMMENT_CHARS: usize = 1000;
/// 각주·미주 글자 수 상한(문자 단위). 메모와 같은 한 줄 입력 창을 쓴다.
pub const MAX_NOTE_CHARS: usize = 1000;
/// 이 앱이 쓰는 메모의 작성자. geul에는 사용자 이름 설정이 아직 없어 엔진 기본값("WordCraft User" — 다른 제품 이름)
/// 대신 앱 이름을 쓴다(사람 이름으로 꾸미지 않음, docs/architecture/command-registry.md "T013").
pub const COMMENT_AUTHOR: &str = "geul";

/// 앱이 여는 글자 서식(WordCraft `format.*` 중 고정된 것만).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CharFormat {
    Bold,
    Italic,
    Underline,
    Strikethrough,
}

impl CharFormat {
    fn command(self) -> &'static str {
        match self {
            CharFormat::Bold => "format.bold",
            CharFormat::Italic => "format.italic",
            CharFormat::Underline => "format.underline",
            CharFormat::Strikethrough => "format.strikethrough",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveTarget {
    Left,
    Right,
    Up,
    Down,
    LineStart,
    LineEnd,
    DocStart,
    DocEnd,
}

impl MoveTarget {
    fn command(self) -> &'static str {
        match self {
            MoveTarget::Left => "caret.left",
            MoveTarget::Right => "caret.right",
            MoveTarget::Up => "caret.up",
            MoveTarget::Down => "caret.down",
            MoveTarget::LineStart => "caret.home",
            MoveTarget::LineEnd => "caret.end",
            MoveTarget::DocStart => "caret.docStart",
            MoveTarget::DocEnd => "caret.docEnd",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BasicShape {
    Rectangle,
    Ellipse,
    Line,
}

impl BasicShape {
    fn name(self) -> &'static str {
        match self {
            Self::Rectangle => "rectangle",
            Self::Ellipse => "ellipse",
            Self::Line => "line",
        }
    }
}

/// Stage 3 P5 structured object clipboard payload (untrusted on paste).
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectPayload {
    /// One paragraph holding exactly the copied drawing (WordCraft fragment), plus its text box story.
    pub fragment: wordcraft_engine::doc::edit::Fragment,
    /// Media the drawing uses, by its key in the fragment.
    pub media: Vec<PayloadMedia>,
}

/// HWPUNIT coordinates for a supported inline, filled, borderless HWPX polygon.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HwpxPolygon {
    pub width: u32,
    pub height: u32,
    pub points: Vec<[u32; 2]>,
    pub fill: String,
    pub description: String,
}

impl HwpxPolygon {
    fn valid(&self) -> bool {
        if !(200..=14_400).contains(&self.width)
            || !(200..=14_400).contains(&self.height)
            || !(3..=256).contains(&self.points.len())
            || self.fill.len() != 6 || !self.fill.bytes().all(|b| b.is_ascii_hexdigit())
            || !valid_object_alt_text(&self.description)
            || self.points.iter().any(|[x, y]| *x > self.width || *y > self.height)
            || self.points.iter().collect::<std::collections::BTreeSet<_>>().len() != self.points.len()
        {
            return false;
        }
        self.points.iter().zip(self.points.iter().cycle().skip(1))
            .map(|([a, b], [c, d])| i64::from(*a) * i64::from(*d) - i64::from(*b) * i64::from(*c))
            .sum::<i64>() != 0
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayloadMedia {
    pub name: String,
    pub sha256: String,
    pub data: String,
}

pub const MAX_PAYLOAD_MEDIA: usize = 16;
pub const MAX_PAYLOAD_MEDIA_BYTES: usize = 8 * 1024 * 1024;

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The image keys a drawing uses (pictures, and flat group children of pictures/shapes).
fn drawing_media(object: &InlineObject, out: &mut Vec<String>, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match object {
        InlineObject::Image {
            media, ole: None, ..
        } => {
            out.push(media.clone());
            true
        }
        InlineObject::Image { ole: Some(_), .. } => false,
        InlineObject::Group { children, .. } => {
            if depth > 0 {
                // WordCraft flattens nested groups on open and drops nested Group children on save.
                return false;
            }
            children
                .iter()
                .all(|c| drawing_media(&c.obj, out, depth + 1))
        }
        InlineObject::Shape { .. } => true,
        // Charts/SmartArt would add chart/diagram parts; there is no T009 proof for that yet.
        _ => false,
    }
}

impl ObjectPayload {
    /// Structural validation of an untrusted payload. Returns the drawing on success.
    fn drawing(&self) -> Option<&InlineObject> {
        use std::collections::BTreeSet;
        use wordcraft_engine::doc::para::{MAX_GROUP_CHILDREN, OBJ};
        let [block] = self.fragment.blocks.as_slice() else {
            return None;
        };
        let para = block.as_para()?;
        if para.text != OBJ.to_string() || para.objects.len() != 1 || para.object_offsets() != [0] {
            return None;
        }
        let object = para.object_at(0)?;
        let (w, h, float) = object.frame()?;
        let bounded = |v: f32, lo: f32, hi: f32| v.is_finite() && (lo..=hi).contains(&v);
        if !bounded(w, 0.5, MAX_OBJECT_SIDE_PT)
            || !bounded(h, 0.5, MAX_OBJECT_SIDE_PT)
            || !bounded(float.x, -MAX_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT)
            || !bounded(float.y, -MAX_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT)
            || !float.rot.is_finite()
        {
            return None;
        }
        if let InlineObject::Group {
            ch_w,
            ch_h,
            children,
            canvas,
            ..
        } = object
        {
            if children.len() > MAX_GROUP_CHILDREN
                || (children.is_empty() && canvas.is_none())
                || !bounded(*ch_w, 0.5, MAX_OBJECT_SIDE_PT)
                || !bounded(*ch_h, 0.5, MAX_OBJECT_SIDE_PT)
            {
                return None;
            }
            for child in children {
                if !bounded(child.x, -MAX_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT)
                    || !bounded(child.y, -MAX_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT)
                {
                    return None;
                }
                let (cw, ch, cfloat) = child.obj.frame()?;
                if !bounded(cw, 0.0, MAX_OBJECT_SIDE_PT)
                    || !bounded(ch, 0.0, MAX_OBJECT_SIDE_PT)
                    || !cfloat.rot.is_finite()
                {
                    return None;
                }
            }
        }
        let mut media = Vec::new();
        if !drawing_media(object, &mut media, 0) {
            return None;
        }
        // Every text box (standalone or inside a flat group) brings its own plain-paragraph story.
        let stories = object.text_boxes();
        let unique_stories: BTreeSet<u32> = stories.iter().copied().collect();
        if stories.len() != unique_stories.len() || self.fragment.parts.len() != unique_stories.len()
        {
            return None;
        }
        let mut chars = 0usize;
        for id in unique_stories {
            let part = self.fragment.parts.get(&id)?;
            if part.kind != wordcraft_engine::doc::PartKind::TextBox || part.blocks.len() > 256 {
                return None;
            }
            for b in &part.blocks {
                let p = b.as_para()?;
                chars += p.text.len();
                if !p.objects.is_empty() || chars > 64 * 1024 || p.text.contains(OBJ) {
                    return None;
                }
            }
        }
        // Every media key is carried exactly once, and nothing else is.
        media.sort();
        media.dedup();
        let mut names: Vec<&str> = self.media.iter().map(|m| m.name.as_str()).collect();
        names.sort_unstable();
        if names.len() != self.media.len()
            || names.windows(2).any(|w| w[0] == w[1])
            || media != names
            || self.media.len() > MAX_PAYLOAD_MEDIA
        {
            return None;
        }
        Some(object)
    }
}

/// Stage 3 object edits (WordCraft `arrange.*`, `picture.*`, `text.delete` on the object range).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ObjectEdit {
    /// Move (x, y: top-left on the object's page, pt) and/or resize (width, height, pt).
    Bounds {
        x: Option<f32>,
        y: Option<f32>,
        width: Option<f32>,
        height: Option<f32>,
    },
    /// Move a floating object by an offset (pt).
    Nudge {
        dx: f32,
        dy: f32,
    },
    Delete {},
    /// Picture crop as fractions of each side (0–0.45; all zero resets the crop). The media is unchanged.
    Crop {
        left: f32,
        top: f32,
        right: f32,
        bottom: f32,
    },
    /// Text wrapping (`inline` puts a floating object back in line).
    Wrap {
        wrap: wordcraft_engine::doc::para::Wrap,
    },
    /// Alternative text (description), at most `MAX_ALT_TEXT_CHARS`; empty clears it.
    AltText {
        text: String,
    },
    /// Position preset relative to the margins (the object floats with Square wrapping).
    Position {
        preset: PositionPreset,
    },
    /// Shape fill `RRGGBB`, or `None` for no fill.
    Fill {
        color: Option<String>,
    },
    ConvertShape {
        to: BasicShape,
    },
    /// Shape outline `RRGGBB` (`None`: no line) and width in points.
    Outline {
        color: Option<String>,
        width: Option<f32>,
    },
    /// Exact clockwise rotation in degrees (normalised to 0–360) and flips.
    Rotate {
        degrees: f32,
        flip_h: bool,
        flip_v: bool,
    },
    /// Layer: in front of the text or behind it.
    Layer {
        front: bool,
    },
    /// Chart title (`None` removes it).
    ChartTitle {
        text: Option<String>,
    },
    /// Chart type (WordCraft chart type id).
    ChartType {
        plot: String,
    },
    /// Chart categories and series values.
    ChartData {
        categories: Vec<String>,
        series: Vec<ChartSeriesEdit>,
    },
    /// SmartArt outline (items with levels 0–7).
    SmartArtItems {
        items: Vec<SmartArtItemEdit>,
    },
    /// SmartArt layout id.
    SmartArtLayout {
        layout: String,
    },
    /// One DrawingML move/line/Bézier point, in the path's original integer EMU coordinates.
    DocxPathPoint {
        path: usize,
        segment: usize,
        point: usize,
        x: i64,
        y: i64,
    },
    /// Insert or remove a source DrawingML line vertex without rewriting neighboring commands.
    DocxPathVertex {
        path: usize,
        segment: usize,
        action: DocxPathVertexAction,
        x: Option<i64>,
        y: Option<i64>,
    },
    /// Move a direct child of a selected DOCX group in its local point coordinate space.
    DocxGroupChildMove { index: usize, id: u32, inst_id: u32, x: f32, y: f32 },
    /// Resize a direct child of a selected DOCX group in its local point coordinate space.
    DocxGroupChildResize { index: usize, id: u32, inst_id: u32, width: f32, height: f32 },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartSeriesEdit {
    pub name: String,
    pub values: Vec<Option<f64>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmartArtItemEdit {
    pub text: String,
    pub level: u8,
}

pub const CHART_PLOTS: [&str; 9] = [
    "column",
    "columnStacked",
    "bar",
    "barStacked",
    "line",
    "area",
    "pie",
    "doughnut",
    "scatter",
];
pub const SMART_ART_LAYOUTS: [&str; 8] = [
    "basicList",
    "process",
    "cycle",
    "hierarchy",
    "pyramid",
    "radial",
    "matrix",
    "venn",
];
pub const MAX_GRAPHIC_TEXT_CHARS: usize = 256;

fn valid_graphic_text(text: &str) -> bool {
    text.chars().count() <= MAX_GRAPHIC_TEXT_CHARS
        && !text.chars().any(|c| c.is_control() || c == '\u{FFFC}')
}

fn valid_rgb(color: &Option<String>) -> bool {
    color
        .as_ref()
        .is_none_or(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PositionPreset {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    MiddleCenter,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocxPathVertexAction {
    Insert,
    Remove,
}

impl PositionPreset {
    fn name(self) -> &'static str {
        match self {
            Self::TopLeft => "topLeft",
            Self::TopCenter => "topCenter",
            Self::TopRight => "topRight",
            Self::MiddleLeft => "middleLeft",
            Self::MiddleCenter => "middleCenter",
            Self::MiddleRight => "middleRight",
            Self::BottomLeft => "bottomLeft",
            Self::BottomCenter => "bottomCenter",
            Self::BottomRight => "bottomRight",
        }
    }
}

pub const MAX_ALT_TEXT_CHARS: usize = 1024;
pub const MAX_CROP_FRACTION: f32 = 0.45;

pub const MAX_OBJECT_SIDE_PT: f32 = 4000.0;
pub const MIN_OBJECT_SIDE_PT: f32 = 2.0;

fn valid_object_alt_text(text: &str) -> bool {
    text.chars().count() <= MAX_ALT_TEXT_CHARS
        // XML attribute values normalize line breaks.
        && !text.chars().any(|c| c.is_control() || c == '\u{FFFC}')
}

impl ObjectEdit {
    fn valid(&self) -> bool {
        let coord =
            |v: &Option<f32>| v.is_none_or(|v| v.is_finite() && v.abs() <= MAX_PAGE_SIDE_PT);
        let side = |v: &Option<f32>| {
            v.is_none_or(|v| {
                v.is_finite() && (MIN_OBJECT_SIDE_PT..=MAX_OBJECT_SIDE_PT).contains(&v)
            })
        };
        match self {
            Self::Bounds {
                x,
                y,
                width,
                height,
            } => {
                x.is_some() == y.is_some()
                    && coord(x)
                    && coord(y)
                    && side(width)
                    && side(height)
                    && (x.is_some() || width.is_some() || height.is_some())
            }
            Self::Nudge { dx, dy } => {
                [dx, dy].iter().all(|d| d.is_finite() && d.abs() <= 288.0)
                    && (*dx != 0.0 || *dy != 0.0)
            }
            Self::Delete {} => true,
            Self::Crop {
                left,
                top,
                right,
                bottom,
            } => [left, top, right, bottom]
                .iter()
                .all(|v| v.is_finite() && (0.0..=MAX_CROP_FRACTION).contains(*v)),
            Self::Wrap { .. } | Self::Position { .. } => true,
            Self::Fill { color } => valid_rgb(color),
            Self::ConvertShape { to } => matches!(to, BasicShape::Rectangle | BasicShape::Ellipse),
            Self::Outline { color, width } => {
                valid_rgb(color) && width.is_none_or(|w| w.is_finite() && (0.0..=72.0).contains(&w))
            }
            Self::Rotate { degrees, .. } => degrees.is_finite() && degrees.abs() <= 3600.0,
            Self::Layer { .. } => true,
            Self::ChartTitle { text } => text
                .as_deref()
                .is_none_or(|t| !t.is_empty() && valid_graphic_text(t)),
            Self::ChartType { plot } => CHART_PLOTS.contains(&plot.as_str()),
            Self::ChartData { categories, series } => {
                (1..=128).contains(&categories.len())
                    && categories.iter().all(|c| valid_graphic_text(c))
                    && (1..=16).contains(&series.len())
                    && series.iter().all(|s| {
                        !s.name.is_empty()
                            && valid_graphic_text(&s.name)
                            && s.values.len() == categories.len()
                            && s.values
                                .iter()
                                .flatten()
                                .all(|v| v.is_finite() && v.abs() <= 1e15)
                    })
            }
            Self::SmartArtItems { items } => {
                (1..=64).contains(&items.len())
                    && items.first().is_some_and(|i| i.level == 0)
                    && items
                        .windows(2)
                        .all(|w| w[1].level <= w[0].level.saturating_add(1))
                    && items
                        .iter()
                        .all(|i| i.level <= 7 && !i.text.is_empty() && valid_graphic_text(&i.text))
            }
            Self::SmartArtLayout { layout } => SMART_ART_LAYOUTS.contains(&layout.as_str()),
            Self::DocxPathPoint { path, segment, point, x, y } => {
                *path < wordcraft_engine::doc::freeform::MAX_PATHS
                    && *segment < wordcraft_engine::doc::freeform::MAX_POINTS
                    && *point < 3
                    && (-1_000_000_000_000..=1_000_000_000_000).contains(x)
                    && (-1_000_000_000_000..=1_000_000_000_000).contains(y)
            }
            Self::DocxPathVertex { path, segment, action, x, y } => {
                *path < wordcraft_engine::doc::freeform::MAX_PATHS
                    && *segment < wordcraft_engine::doc::freeform::MAX_POINTS
                    && match action {
                        DocxPathVertexAction::Insert => (*x).zip(*y).is_some_and(|(x, y)|
                            (0..=1_000_000_000_000).contains(&x) && (0..=1_000_000_000_000).contains(&y)),
                        DocxPathVertexAction::Remove => x.is_none() && y.is_none(),
                    }
            }
            Self::DocxGroupChildMove { index, id, inst_id, x, y } => {
                *index < wordcraft_engine::doc::para::MAX_GROUP_CHILDREN
                    && *id == (*index as u32).saturating_add(1)
                    && *inst_id == 0
                    && x.is_finite() && y.is_finite()
                    && (0.0..=14_400.0).contains(x) && (0.0..=14_400.0).contains(y)
            }
            Self::DocxGroupChildResize { index, id, inst_id, width, height } => {
                *index < wordcraft_engine::doc::para::MAX_GROUP_CHILDREN
                    && *id == (*index as u32).saturating_add(1)
                    && *inst_id == 0
                    && width.is_finite() && height.is_finite()
                    && (0.0..=14_400.0).contains(width) && (0.0..=14_400.0).contains(height)
                    && *width > 0.0 && *height > 0.0
            }
            Self::AltText { text } => valid_object_alt_text(text),
        }
    }

    pub fn operation(&self) -> &'static str {
        match self {
            Self::Bounds { x: Some(_), .. } | Self::Nudge { .. } | Self::Position { .. } => "move",
            Self::Bounds { .. } => "resize",
            Self::Delete {} => "delete",
            Self::Crop { .. } => "crop",
            Self::Wrap { .. } => "wrap",
            Self::AltText { .. } => "altText",
            Self::Fill { .. } => "fill",
            Self::ConvertShape { .. } => "convertShape",
            Self::Outline { .. } => "outline",
            Self::Rotate { .. } => "rotate",
            Self::Layer { .. } => "zOrder",
            Self::ChartTitle { .. } | Self::ChartType { .. } | Self::ChartData { .. } => "chart",
            Self::SmartArtItems { .. } | Self::SmartArtLayout { .. } => "smartArt",
            Self::DocxPathPoint { .. } => "pathPoint",
            Self::DocxPathVertex { .. } => "pathVertex",
            Self::DocxGroupChildMove { .. } | Self::DocxGroupChildResize { .. } => "groupChildGeometry",
        }
    }
}

/// 비어 있지 않고 `MAX_TEXT_CHARS` 이하이며, `allowed` 밖의 제어 문자와 U+FFFC가 없다.
fn valid_chars(text: &str, allowed: &[char]) -> bool {
    // U+FFFC는 WordCraft가 개체 자리로 쓰는 글자라 직접 넣지 않는다.
    !text.is_empty()
        && text.chars().count() <= MAX_TEXT_CHARS
        && !text
            .chars()
            .any(|c| (c.is_control() && !allowed.contains(&c)) || c == '\u{FFFC}')
}

fn valid_text(text: &str) -> bool {
    valid_chars(text, &[])
}

/// A font family name the engine accepts (`format.font`: 1–128 bytes after trimming) without control
/// characters, quotes or separators that would make it ambiguous in DOCX or CSS.
pub fn valid_font_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name.len() <= 128
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | ',' | ';' | '\\' | '{' | '}' | '\u{FFFC}'))
}

/// Optional Cut guard, checked under the model lock immediately before deletion.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionIdentity {
    pub anchor_key: String,
    pub caret_key: String,
}

/// 요청 전체를 실행 전에 검사한다. 하나라도 계약에 맞지 않으면 아무것도 실행하지 않는다.
pub fn validate(ops: &[DocxOp]) -> bool {
    !ops.is_empty()
        && ops.len() <= MAX_OPS
        && ops
            .iter()
            .filter(|op| matches!(op, DocxOp::Image { .. }))
            .count()
            <= 1
        && ops.iter().all(|op| match op {
            DocxOp::InsertText { text } | DocxOp::InsertAt { text, .. } => valid_text(text),
            // 줄바꿈은 프런트엔드가 `\n` 하나로 맞춘다(`\r`은 거부).
            DocxOp::PasteText { text, .. } => valid_chars(text, &['\n', '\t']),
            DocxOp::Font { name } => valid_font_name(name),
            DocxOp::CutShape { position, epoch } => {
                !position.is_empty() && position.len() <= 256 && *epoch > 0
            }
            DocxOp::PasteObject { payload } => {
                payload.media.iter().map(|m| m.data.len()).sum::<usize>()
                    <= MAX_PAYLOAD_MEDIA_BYTES.div_ceil(3) * 4
                    && payload.drawing().is_some()
            }
            DocxOp::PasteHwpxPolygon { polygon } => polygon.valid(),
            DocxOp::ObjectEdit {
                position,
                epoch,
                edit,
            } => !position.is_empty() && position.len() <= 256 && *epoch > 0 && edit.valid(),
            DocxOp::DeleteSelection { selection: Some(s) } => {
                s.anchor_key.len() <= 256 && s.caret_key.len() <= 256
            }
            DocxOp::ReplaceInserted { expected, text } => valid_text(expected) && valid_text(text),
            DocxOp::Comment { text } => {
                valid_text(text)
                    && text.chars().count() <= MAX_COMMENT_CHARS
                    && !text.trim().is_empty()
            }
            DocxOp::Footnote { text } | DocxOp::Endnote { text } => {
                valid_text(text)
                    && text.chars().count() <= MAX_NOTE_CHARS
                    && !text.trim().is_empty()
            }
            DocxOp::Image { data } => {
                data.len() <= crate::picture::MAX_BYTES.div_ceil(3) * 4
                    && wordcraft_engine::cmd::insert::base64_decode(data)
                        .is_some_and(|bytes| crate::picture::valid(&bytes))
            }
            DocxOp::Table { rows, cols } => {
                (1..=32).contains(rows)
                    && (1..=16).contains(cols)
                    && u32::from(*rows) * u32::from(*cols) <= 256
            }
            DocxOp::Pointer { x, y, .. } => {
                x.is_finite()
                    && y.is_finite()
                    && x.abs() <= MAX_PAGE_SIDE_PT
                    && y.abs() <= MAX_PAGE_SIDE_PT
            }
            DocxOp::FontSize { size } => size.is_finite() && (1.0..=1638.0).contains(size),
            DocxOp::FontColor { color } => {
                color == "auto"
                    || (color.len() == 6 && color.bytes().all(|b| b.is_ascii_hexdigit()))
            }
            DocxOp::Highlight { color } => stage1::HIGHLIGHTS.contains(&color.as_str()),
            DocxOp::EmbedFont { family, style } => {
                valid_font_name(family) && !style.is_empty() && style.len() <= 128 && !style.chars().any(char::is_control)
            }
            DocxOp::Paragraph { format } => format.valid(),
            DocxOp::PageSetup { setup } => setup.valid(),
            DocxOp::Find { query, .. } => query.valid(),
            DocxOp::Replace { query, with } | DocxOp::ReplaceAll { query, with } => {
                query.valid() && stage1::valid_replacement(with)
            }
            DocxOp::TableStructure { action, target, rows, columns } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let dims_ok = match (action, rows, columns) {
                    (table::TableStructureAction::SplitCell, None, None) => true,
                    (table::TableStructureAction::SplitCell, Some(r), Some(c)) => {
                        (1..=16).contains(r) && (1..=16).contains(c) && r.saturating_mul(*c) >= 2
                    }
                    (_, None, None) => true,
                    _ => false,
                };
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && dims_ok
            }
            DocxOp::TableShading { target, color } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let color_ok = color
                    .as_deref()
                    .map_or(true, |c| table::normalize_hex_color(c).is_some());
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && color_ok
            }
            DocxOp::TableBorders { target, kind: _, style, width, color } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let style_ok = style
                    .as_deref()
                    .map_or(true, table::valid_docx_border_style);
                let width_ok = width.map_or(true, table::valid_docx_border_width);
                let color_ok = color
                    .as_deref()
                    .map_or(true, |c| table::normalize_hex_color(c).is_some());
                ok_key(&target.anchor_key)
                    && ok_key(&target.caret_key)
                    && style_ok
                    && width_ok
                    && color_ok
            }
            DocxOp::TableAlignment { target, horizontal, vertical } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                ok_key(&target.anchor_key)
                    && ok_key(&target.caret_key)
                    && (horizontal.is_some() || vertical.is_some())
            }
            DocxOp::TableColumnWidth { target, width, distribute } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let dim_ok = match (*distribute, *width) {
                    (true, None) => true,
                    (false, Some(w)) => table::valid_docx_col_width(w),
                    _ => false,
                };
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && dim_ok
            }
            DocxOp::TableRowHeight { target, height, rule, clear, distribute } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let dim_ok = if *distribute {
                    height.is_none() && rule.is_none() && !*clear
                } else if *clear {
                    height.is_none() && rule.is_none()
                } else {
                    height.is_some_and(table::valid_docx_row_height)
                };
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && dim_ok
            }
            DocxOp::CutTableCells { target } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                ok_key(&target.anchor_key) && ok_key(&target.caret_key)
            }
            DocxOp::PasteTableCells { target, payload } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && payload.valid()
            }
            DocxOp::TableCellMargins { target, scope, top, right, bottom, left, reset } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                let sides_ok = [top, right, bottom, left].into_iter().all(|s| s.is_none_or(table::valid_docx_margin_pt));
                let mode_ok = if *reset {
                    *scope == table::TableMarginScope::Cell && [top, right, bottom, left].into_iter().all(|s| s.is_none())
                } else {
                    [top, right, bottom, left].into_iter().any(|s| s.is_some())
                };
                ok_key(&target.anchor_key) && ok_key(&target.caret_key) && sides_ok && mode_ok
            }
            DocxOp::TablePositioning { target, align, indent_pt } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                ok_key(&target.anchor_key)
                    && ok_key(&target.caret_key)
                    && (align.is_some() || indent_pt.is_some())
                    && indent_pt.is_none_or(table::valid_docx_indent_pt)
            }
            DocxOp::TableRepeatHeader { target, .. } | DocxOp::TableRowBreak { target, .. } => {
                let ok_key = |k: &str| !k.is_empty() && k.len() <= 256 && !k.chars().any(char::is_control);
                ok_key(&target.anchor_key) && ok_key(&target.caret_key)
            }
            _ => true,
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

/// 커서 막대: 쪽 `page`의 (x, y)에서 높이 `height`(pt).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct CaretView {
    pub page: usize,
    pub x: f32,
    pub y: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct RectView {
    pub page: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ObjectView {
    kind: &'static str,
    position: String,
    frame: RectView,
    epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<PictureView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    graphic: Option<Value>,
    #[serde(rename = "clipboardShape", skip_serializing_if = "Option::is_none")]
    clipboard_shape: Option<ClipboardShapeView>,
    /// Mutations this object admits now (Stage 3): `move`, `resize`, `delete`. Each is still
    /// re-validated and T009-checked when applied.
    operations: Vec<&'static str>,
    #[serde(rename = "convertShape", skip_serializing_if = "Option::is_none")]
    convert_shape: Option<BasicShape>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shape: Option<ShapeView>,
    #[serde(rename = "drawingMlPaths", skip_serializing_if = "Option::is_none")]
    drawing_ml_paths: Option<Vec<DocxPathView>>,
    #[serde(rename = "groupChildren", skip_serializing_if = "Option::is_none")]
    group_children: Option<EditableGroupChildrenView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditableGroupChildrenView {
    parent_id: u32,
    width: f32,
    height: f32,
    children: Vec<GroupChildGeometryView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupChildGeometryView {
    index: usize,
    kind: &'static str,
    id: u32,
    inst_id: u32,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    size_protect: bool,
    locked: bool,
    can_move: bool,
    can_resize: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxPathView {
    viewport_width: i64,
    viewport_height: i64,
    segments: Vec<DocxPathSegmentView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxPathSegmentView {
    command: &'static str,
    points: Vec<DocxPathPointView>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocxPathPointView {
    x: i64,
    y: i64,
    control: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShapeView {
    fill: Option<String>,
    outline: Option<String>,
    outline_width: f32,
    rotation: f32,
    flip_h: bool,
    flip_v: bool,
    width_pt: f32,
    height_pt: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardShapeView {
    shape: BasicShape,
    cut_allowed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PictureView {
    width_pt: f32,
    height_pt: f32,
    wrap: wordcraft_engine::doc::para::Wrap,
    /// Crop fractions `[left, top, right, bottom]`.
    crop: [f32; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

/// 편집 표면이 그리는 데 필요한 것. 문서 모델 자체는 보내지 않는다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxView {
    /// Authoritative tracked-document policy; navigation remains available.
    pub tracked_read_only: bool,
    /// 본문에 갱신할 수 있는 목차가 있음(T013 `references.updateToc` 가용성, `DocxModel::has_toc`).
    pub has_toc: bool,
    pub bullets: Option<bool>,
    pub image_insertion_allowed: bool,
    pub drawing_insertion_allowed: bool,
    pub text_box_editing: bool,
    /// 변경 내용 추적이 켜져 있음(`settings.track_changes`, 리본 단추 눌림 상태).
    pub tracking: bool,
    /// 추적된 변경이 하나라도 있음(수락·거절 가용성, `DocxModel::has_revisions`).
    pub has_revisions: bool,
    pub pages: Vec<PageSize>,
    /// 커서 자리를 배치에서 찾지 못하면(숨은 글자 등) 없다.
    pub caret: Option<CaretView>,
    pub selection: Vec<RectView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<ObjectView>,
    /// 선택이 비어 있음(커서만).
    pub collapsed: bool,
    /// 커서가 표 셀 안에 있음(Tab을 셀 이동으로 쓸지).
    pub in_table: bool,
    /// 커서·기준점 자리의 비교용 키(`story:path:off`). 늦게 온 응답·검사용이며 문서 내용이 아니다.
    pub caret_key: String,
    pub anchor_key: String,
    /// 커서 문단의 글자(개체는 그 글자로). 화면에는 검사 훅 빌드에서만 노출한다.
    pub paragraph_text: String,
    /// Bounded single-paragraph text preview. Object/multi-paragraph selections remain unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_text: Option<String>,
    pub clipboard_text_available: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub clipboard_table_cells_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paragraph_style: Option<String>,
    /// 커서의 문단 안 위치(문자 단위).
    pub caret_offset: usize,
    /// WordCraft 실행 취소 기록(T010): 되돌릴·다시 할 단계가 있고 그 단계가 문서 보호를 풀지 않음.
    pub history: HistoryView,
    /// 선택(없으면 다음 입력)의 글자 서식(T010, WordCraft `format.state`). 선택 전체가 그 서식일 때 true.
    pub format: FormatView,
    /// 문서 보호가 글자 서식 명령을 허용하는지(T010 안정화, WordCraft `review.restrict` 상태에서). 엔진이 실행할 때 다시 판정한다.
    pub format_access: FormatAccess,
    /// Stage 5-A: font database generation the layout reflects; a change means pages must be drawn again
    /// although the document revision is the same.
    pub font_generation: u64,
    /// Stage 1: size/color/highlight/script of the selection (or next typed text).
    pub chars: stage1::CharView,
    /// Stage 1: paragraph formatting and list state of the selection.
    pub paragraph: stage1::ParagraphView,
    /// Stage 1: page setup of the caret's section.
    pub page: stage1::PageSetupView,
    /// Stage 1: current search (count and selected match) while a search is open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<stage1::SearchView>,
    /// Stage 1 F: fonts embedded in the document (font table embed slots).
    pub embedded_fonts: Vec<embed_font::Embedded>,
    /// Stage 2 Phase 1: current table geometry and per-command eligibility when inside a table.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<table::DocxTableView>,
}

/// 문서 보호(Restrict Editing)에서 직접 글자 서식(`format.bold` 등)을 할 수 있는지.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FormatAccess {
    /// 보호 없음 또는 서식을 막지 않는 보호(변경 내용 추적).
    Allowed,
    /// 엔진이 언제나 거부한다(읽기 전용·양식·메모만, 편집 가능 영역 없음, 또는 서식을 스타일로 제한).
    Protected,
    /// 이 사용자가 편집할 수 있는 영역 안의 변경만 허용한다. 선택이 그 안인지는 엔진이 실행 뒤 비교로 판정한다.
    Regions,
}

impl FormatAccess {
    /// WordCraft 공개 보호 상태(`cmd::protect::state`)에서 정한다. 엔진의 `check_before`(비공개)가 직접 서식 명령에 하는 판정과
    /// 같은 순서다: 서식 제한이면 거부, 읽기 전용·메모만은 편집 가능 영역이 있으면 영역 안만, 없으면 거부, 양식은 거부, 그 밖은 허용.
    /// 이 대응은 시험(`보호_상태의_서식_가용성은_엔진_판정과_같다`)이 실제 엔진 결과와 맞춘다.
    pub(super) fn of(session: &Session) -> FormatAccess {
        if TRACKED_READ_ONLY && session.doc.settings.track_changes {
            return FormatAccess::Protected;
        }
        let state = wordcraft_engine::cmd::protect::state(session);
        let Some(mode) = state.get("protection").and_then(Value::as_str) else {
            return FormatAccess::Allowed;
        };
        if state.get("formatting").and_then(Value::as_bool) != Some(false) {
            return FormatAccess::Protected;
        }
        let regions = state.get("exceptions").and_then(Value::as_u64).unwrap_or(0) > 0;
        match mode {
            "readOnly" | "comments" if regions => FormatAccess::Regions,
            "readOnly" | "comments" | "forms" => FormatAccess::Protected,
            _ => FormatAccess::Allowed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct HistoryView {
    pub undo: bool,
    pub redo: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatView {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    /// Stage 5-A: the requested (stored) font family of the whole selection; `None` when mixed.
    pub font: Option<String>,
    /// The East Asian font family (`w:eastAsia`); `None` when mixed.
    pub font_east_asia: Option<String>,
}

/// 한 요청의 실행 결과.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditOutcome {
    /// 앞에서부터 실행에 성공한 연산 수.
    pub applied: usize,
    /// 그중 문서를 실제로 바꾼 연산 수(revision 증가량).
    pub changed: u64,
    /// 엔진이 거부한 연산의 위치. 엔진은 거부한 명령의 문서·선택을 그 전으로 돌리므로 거부는 그 연산만 없던 일이 되고,
    /// 뒤의 연산(이어 친 키 등 따로 일어난 입력)은 그대로 실행한다.
    pub rejected: Vec<usize>,
}

/// 메모리 안 내보내기 → 다시 읽기 비교(디스크에 쓰지 않음).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundTrip {
    pub bytes: usize,
    pub pages: usize,
    pub reopened_pages: usize,
    pub pages_equal: bool,
    pub text_equal: bool,
    /// 다시 읽은 문서 모델(글자·서식·표 구조)이 내보낸 모델과 같음.
    pub model_equal: bool,
    pub passed: bool,
}

/// 엔진이 거부한 연산(엔진 메시지는 버린다).
struct Rejected;

struct LastInsert {
    start: Pos,
    end: Pos,
    text: String,
    /// 넣은 직후 WordCraft `rev()`. 다르면 그 뒤에 문서를 바꾸는 명령이 실행됐다.
    rev: u64,
    /// 넣기 전 배치(`Pointer { before_insert }`).
    layout: Arc<DocLayout>,
}

pub struct DocxModel {
    session: Session,
    selected_object: Option<(Pos, usize)>,
    /// Object to keep selected after a successful `ObjectEdit` (set by it, taken by `apply`).
    reselect: Option<(Pos, usize)>,
    /// Media keys added by structured pastes: removed again when history leaves them unreferenced
    /// (they are added just before the paste command, outside its undo snapshot).
    pasted_media: Vec<String>,
    object_epoch: u64,
    story_picture_resize: bool,
    rounded_rectangle_conversion: bool,
    /// Group-child edits rewrite the owning DrawingML body tree. Expose them only when the
    /// opened body's semantic XML was already preserved exactly by this reader/writer pair.
    group_body_roundtrips: bool,
    created_shapes: Vec<Pos>,
    marks: Vec<(u32, Pos)>,
    last_insert: Option<LastInsert>,
    /// 쪽·배율마다 마지막으로 그린 래스터와 그 판(바뀐 띠만 보낼 때 비교 기준). 최근 것부터 MAX_RASTERS개.
    rasters: Vec<Raster>,
    /// The font database generation the cached layout and rasters were made with (Stage 5-A): a user font
    /// registered or removed, or a system font refresh, lays the document out again.
    font_generation: u64,
    /// Stage 1: the open search's query (search state is reported in the view while set).
    search: Option<stage1::SearchQuery>,
    /// 시험용 실패 주입: 명령 `id`의 `n`번째 실행을 엔진이 거부한 것처럼 실행하지 않고 돌려준다(한 번).
    #[cfg(test)]
    pub fail_at: Option<(&'static str, usize)>,
}

/// 마지막으로 보낸 쪽 래스터.
struct Raster {
    page: usize,
    scale: u32,
    revision: u64,
    image: Rendered,
}

/// 기억하는 쪽 래스터 수(쪽 하나 100% 약 3.5 MiB).
const MAX_RASTERS: usize = 4;

/// 쪽 그림 응답. `base`가 있으면 그 판의 그림 위에 `y`부터 `height`줄을 `png`로 바꾸면 이 판이 된다(바뀐 띠). 없으면 쪽 전체.
/// 바뀐 줄이 없으면 `height` 0, `png`는 비어 있다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageRender {
    pub base: Option<u64>,
    pub y: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

/// 두 래스터(같은 크기)에서 다른 줄의 범위 `(첫 줄, 줄 수)`. 같으면 `None`.
fn changed_rows(before: &Rendered, after: &Rendered) -> Option<(u32, u32)> {
    let row = after.width as usize * 4;
    if row == 0 {
        return None;
    }
    let rows = || before.pixels.chunks(row).zip(after.pixels.chunks(row));
    let first = rows().position(|(a, b)| a != b)?;
    let last = rows().rposition(|(a, b)| a != b)?;
    Some((first as u32, (last - first + 1) as u32))
}

fn same_paragraph(a: &Pos, b: &Pos) -> bool {
    a.story == b.story && a.path == b.path
}

fn position_key(pos: &Pos) -> String {
    let story = match pos.story {
        StoryRef::Body => "body".to_owned(),
        StoryRef::Part(id) => format!("part{id}"),
    };
    let path: Vec<String> = pos.path.0.iter().map(u32::to_string).collect();
    format!("{story}:{}:{}", path.join("."), pos.off)
}

impl DocxModel {
    /// Read-only plain text, one story/container, paragraphs only, no objects.
    /// Bound work before using the engine serializer; never run edit.copy, which
    /// changes the engine's internal clipboard history.
    pub fn clipboard_text(&self) -> Option<String> {
        if self.selected_object.is_some() {
            return None;
        }
        let (a, b) = self.session.sel.ordered();
        if a == b
            || a.story != b.story
            || a.path.parent() != b.path.parent()
            || !matches!(a.path.0.len(), 1 | 4)
            || a.path.0.len() != b.path.0.len()
        {
            return None;
        }
        let blocks = self.session.doc.container(a.story, &a.path)?;
        let mut bytes = 0usize;
        for i in a.path.last()..=b.path.last() {
            let p = blocks.get(i)?.as_para()?;
            let start = if i == a.path.last() { a.off } else { 0 };
            let end = if i == b.path.last() {
                b.off
            } else {
                p.text.len()
            };
            let text = p.text.get(start..end)?;
            if text.contains('\u{fffc}')
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
            {
                return None;
            }
            bytes = bytes.checked_add(text.len() + 1)?;
            if bytes > 4 * 1024 * 1024 {
                return None;
            }
        }
        let text = self.session.doc.copy_range(&a, &b).clipboard_text();
        if text.is_empty() || text.chars().count() > 1024 * 1024 || text.contains('\u{fffc}') {
            return None;
        }
        Some(text)
    }

    pub fn clipboard_selection_matches(&self, anchor: &str, focus: &str) -> bool {
        position_key(&self.session.sel.anchor) == anchor
            && position_key(&self.session.sel.focus) == focus
    }

    /// DOCX 바이트를 읽고 첫 배치를 검사한다. 읽지 못하면 `Parse`, 쪽이 없거나 크기가 이상하면 `Render`.
    pub fn open(bytes: &[u8]) -> Result<DocxModel, EngineStage> {
        let doc = io::open_bytes(DOCX_NAME, bytes).map_err(|_| EngineStage::Parse)?;
        let mut session = Session::new(doc);
        session.author = COMMENT_AUTHOR.to_owned();
        let mut model = DocxModel {
            session,
            selected_object: None,
            reselect: None,
            pasted_media: Vec::new(),
            object_epoch: 0,
            story_picture_resize: false,
            rounded_rectangle_conversion: false,
            group_body_roundtrips: false,
            created_shapes: Vec::new(),
            marks: Vec::new(),
            last_insert: None,
            rasters: Vec::new(),
            font_generation: wordcraft_fonts::FontDb::global().generation(),
            search: None,
            #[cfg(test)]
            fail_at: None,
        };
        let layout = model.session.layout();
        let valid = |side: f32| side.is_finite() && side > 0.0 && side <= MAX_PAGE_SIDE_PT;
        if layout.pages.is_empty() || !layout.pages.iter().all(|p| valid(p.w) && valid(p.h)) {
            return Err(EngineStage::Render);
        }
        let count = model.sizable_story_picture_count();
        let has_rounded_rectangle = model.session.doc.body.iter().filter_map(|block| block.as_para()).any(|para| {
            para.objects.iter().any(|object| matches!(object, InlineObject::Shape {
                kind: wordcraft_engine::doc::para::ShapeKind::RoundedRectangle, ..
            }))
        });
        if count != 0 || has_rounded_rectangle {
            if let Some(export) = model.export() {
                model.story_picture_resize = count != 0
                    && crate::services::save::docx_story_drawings::resize_source_supported(bytes, &export, count);
                model.rounded_rectangle_conversion = has_rounded_rectangle
                    && crate::services::save::package::docx_body_source_roundtrips(bytes, &export);
            }
        }
        if let Some(export) = model.export() {
            model.group_body_roundtrips = crate::services::save::package::docx_body_source_roundtrips(bytes, &export);
        }
        Ok(model)
    }

    /// 명령 하나를 실행한다. 바꾸는 명령이면 문서가 실제로 바뀌었는지 돌려준다.
    fn run(&mut self, id: &str, params: Value) -> Result<bool, Rejected> {
        #[cfg(test)]
        if let Some((target, n)) = self.fail_at {
            if target == id {
                self.fail_at = (n > 1).then_some((target, n - 1));
                if n <= 1 {
                    return Err(Rejected);
                }
            }
        }
        let mutates = self
            .session
            .registry
            .get(id)
            .map(|spec| spec.mutates)
            .ok_or(Rejected)?;
        let before = mutates.then(|| self.session.doc.clone());
        self.session.run(id, &params).map_err(|_| Rejected)?;
        Ok(before.is_some_and(|before| before != self.session.doc))
    }

    fn select(&mut self, anchor: &Pos, focus: &Pos) -> Result<(), Rejected> {
        self.run("select.range", json!({ "anchor": anchor, "focus": focus }))
            .map(|_| ())
    }

    fn insert_raw(&mut self, text: &str) -> Result<bool, Rejected> {
        self.run("text.insert", json!({ "text": text, "raw": true }))
    }

    /// 연산을 차례로 실행한다. 엔진이 거부한 연산은 건너뛰고 그 위치를 기록한다. 바로 앞 연산이 거부된 `chain` 조각은 실행하지
    /// 않고 거부로 기록한다.
    /// Lay the document out again when the font database changed since the cached layout (fonts are
    /// render state: the document and its revision do not change).
    fn sync_fonts(&mut self) {
        let generation = wordcraft_fonts::FontDb::global().generation();
        if generation != self.font_generation {
            self.font_generation = generation;
            self.session.relayout();
            self.rasters.clear();
        }
    }

    /// The font database generation this model's layout reflects.
    pub fn font_generation(&self) -> u64 {
        self.font_generation
    }

    pub fn apply(&mut self, ops: &[DocxOp]) -> EditOutcome {
        self.sync_fonts();
        let mut outcome = EditOutcome {
            applied: 0,
            changed: 0,
            rejected: Vec::new(),
        };
        for (index, op) in ops.iter().enumerate() {
            let broken = matches!(op, DocxOp::PasteText { chain: true, .. })
                && index > 0
                && outcome.rejected.last() == Some(&(index - 1));
            let result = if broken {
                Err(Rejected)
            } else {
                self.apply_one(op)
            };
            match result {
                Ok(changed) => {
                    if changed {
                        let reselect = self.reselect.take();
                        self.selected_object = reselect;
                        match op {
                            DocxOp::Shape { .. } => {
                                let mut pos = self.session.sel.focus.clone();
                                pos.off -= wordcraft_engine::doc::para::OBJ.len_utf8();
                                self.created_shapes.push(pos);
                            }
                            DocxOp::CutShape { position, .. } => {
                                self.created_shapes.retain(|pos| position_key(pos) != *position);
                            }
                            // Existing shape XML may contain attributes the model does
                            // not project. Discard this transient provenance whenever
                            // an edit or history traversal can reuse an address.
                            _ => self.created_shapes.clear(),
                        }
                    }
                    outcome.applied += 1;
                    outcome.changed += u64::from(changed);
                }
                Err(Rejected) => outcome.rejected.push(index),
            }
        }
        outcome
    }

    fn apply_one(&mut self, op: &DocxOp) -> Result<bool, Rejected> {
        if TRACKED_READ_ONLY
            && self.session.doc.settings.track_changes
            && !matches!(
                op,
                DocxOp::Move { .. }
                    | DocxOp::Pointer { .. }
                    | DocxOp::DeselectObject {}
                    | DocxOp::LeaveTextBox {}
                    | DocxOp::SelectAll
                    | DocxOp::Mark { .. }
                    | DocxOp::Find { .. }
                    | DocxOp::ClearSearch {}
            )
        {
            return Err(Rejected);
        }
        if self.selected_object.is_some() {
            match op {
                // A drag that started on an object must not extend the old text selection.
                DocxOp::Pointer { drag: true, .. } => return Ok(false),
                DocxOp::Move { .. } | DocxOp::SelectAll | DocxOp::Find { .. } => {
                    self.selected_object = None;
                }
                DocxOp::Pointer { .. }
                | DocxOp::DeselectObject {}
                | DocxOp::Mark { .. }
                | DocxOp::InsertAt { .. }
                | DocxOp::ReplaceInserted { .. }
                | DocxOp::Undo {}
                | DocxOp::Redo {}
                | DocxOp::ClearSearch {}
                | DocxOp::CutShape { .. }
                | DocxOp::ObjectEdit { .. } => {}
                _ => return Err(Rejected),
            }
        }
        match op {
            DocxOp::InsertText { text } => self.insert_text(text),
            DocxOp::PasteText { text, .. } => {
                self.last_insert = None;
                // WordCraft `text.insert`는 `\r`에서 문단을 나눈다(`\n`은 줄 바꿈 글자). 한 명령이므로 실패하면 엔진이 되돌린다.
                self.run(
                    "text.insert",
                    json!({ "text": text.replace('\n', "\r"), "raw": true }),
                )
            }
            DocxOp::DeleteSelection { selection } => {
                if let Some(s) = selection {
                    if !self.clipboard_selection_matches(&s.anchor_key, &s.caret_key)
                        || self.clipboard_text().is_none()
                    {
                        return Err(Rejected);
                    }
                }
                if self.session.sel.is_collapsed() {
                    Ok(false)
                } else {
                    self.run("text.backspace", json!({}))
                }
            }
            DocxOp::Backspace => self.run("text.backspace", json!({})),
            DocxOp::DeleteForward => self.run("text.delete", json!({})),
            DocxOp::NewParagraph => self.run("text.newParagraph", json!({})),
            DocxOp::Tab { back } => {
                self.run(if *back { "text.backTab" } else { "text.tab" }, json!({}))
            }
            DocxOp::Move { to, extend } => self.run(to.command(), json!({ "extend": extend })),
            DocxOp::DeselectObject {} => {
                self.selected_object = None;
                Ok(false)
            }
            DocxOp::LeaveTextBox {} => {
                let id = self.editing_text_box().ok_or(Rejected)?;
                let anchor = self.session.doc.text_box_anchor(id).ok_or(Rejected)?;
                self.run("caret.set", json!({"pos": anchor}))
            }
            DocxOp::SelectAll => self.run("select.all", json!({})),
            DocxOp::Pointer {
                page,
                x,
                y,
                extend,
                before_insert,
                select_object,
                ..
            } => {
                self.selected_object = None;
                // IME can commit text just before this click. Its pre-insert text hit path
                // maps the caret across the inserted bytes, so keep that path authoritative.
                if *select_object && !extend && !before_insert {
                    let story = self.session.sel.focus.story;
                    let layout = self.session.layout();
                    let hit = layout
                        .object_at_in(*page as usize, *x, *y, 2.0, story)
                        .or_else(|| layout.object_at(*page as usize, *x, *y, 2.0))
                        .or_else(|| {
                            // Only fall back to the displayed margin story. An inactive
                            // header/footer drawing overlapping the body retains its story
                            // and must not intercept a body click.
                            let (owner, _) = layout.header_footer_at(*page as usize, *y)?;
                            let hit = layout.object_at_in(*page as usize, *x, *y, 2.0, owner)?;
                            self.story_inline_picture(&hit.pos()).then_some(hit)
                        });
                    if let Some(hit) = hit {
                        let pos = hit.pos();
                        if self.object_kind(&pos).is_some() {
                            self.object_epoch += 1;
                            self.selected_object = Some((pos, hit.page));
                            return Ok(false);
                        }
                    }
                }
                // A ribbon control takes focus from the editor's input surface. Clicking the
                // already active insertion point to return to it is focus restoration, not
                // navigation: WordCraft's `caret.set` deliberately clears pending next-input
                // formatting, so avoid that command when the actual hit is unchanged. A click
                // at any other position still follows the normal navigation path below.
                let focus_restore = if !extend && self.session.sel.is_collapsed() {
                    let story = self.session.sel.focus.story;
                    self.hit_before_insert(*page, *x, *y, *before_insert)
                        .or_else(|| self.session.layout().hit(*page as usize, *x, *y, story))
                        .is_some_and(|pos| self.session.doc.clamp(&pos) == self.session.sel.focus)
                } else {
                    false
                };
                if focus_restore {
                    return Ok(false);
                }
                let params = match self.hit_before_insert(*page, *x, *y, *before_insert) {
                    Some(pos) => json!({ "pos": pos, "extend": extend }),
                    None => json!({ "page": page, "x": x, "y": y, "extend": extend }),
                };
                self.run("caret.set", params)
            }
            DocxOp::Mark { id } => {
                self.marks.retain(|(mark, _)| mark != id);
                if self.marks.len() >= MAX_MARKS {
                    self.marks.remove(0);
                }
                self.marks.push((*id, self.session.sel.focus.clone()));
                Ok(false)
            }
            DocxOp::InsertAt { mark, text } => self.insert_at(*mark, text),
            DocxOp::ReplaceInserted { expected, text } => self.replace_inserted(expected, text),
            DocxOp::Undo {} => self.undo_redo_step(false),
            DocxOp::Redo {} => self.undo_redo_step(true),
            DocxOp::Format { format } => self.run(format.command(), json!({})),
            DocxOp::Font { name } => self.run("format.font", json!({ "name": name.trim() })),
            DocxOp::Comment { text } => self.new_comment(text),
            DocxOp::Footnote { text } => self.new_note("references.footnote", text),
            DocxOp::Endnote { text } => self.new_note("references.endnote", text),
            DocxOp::Bullets {} => {
                let (a, b) = self.session.sel.ordered();
                if a.story != StoryRef::Body
                    || b.story != StoryRef::Body
                    || a.path.0.len() != 1
                    || b.path.0.len() != 1
                {
                    return Err(Rejected);
                }
                if !(a.path.last()..=b.path.last()).all(|i| {
                    self.session
                        .doc
                        .body
                        .get(i)
                        .is_some_and(|b| b.as_para().is_some())
                }) {
                    return Err(Rejected);
                }
                self.run("para.bullets", json!({}))
            }
            DocxOp::Shape { kind } => self.insert_drawing("insert.shape", json!({"kind": kind.name()}), true),
            DocxOp::TextBox {} => self.insert_drawing("insert.textBox", json!({}), false),
            DocxOp::CutShape { position, epoch } => self.cut_clipboard_shape(position, *epoch),
            DocxOp::ObjectEdit {
                position,
                epoch,
                edit,
            } => self.object_edit(position, *epoch, edit),
            DocxOp::PasteObject { payload } => self.paste_object(payload),
            DocxOp::PasteHwpxPolygon { polygon } => self.paste_hwpx_polygon(polygon),
            DocxOp::Image { data } => {
                let at = &self.session.sel.focus;
                if !self.session.sel.is_collapsed()
                    || at.story != StoryRef::Body
                    || at.path.0.len() != 1
                    || !self.image_insertion_allowed()
                {
                    return Err(Rejected);
                }
                self.run("insert.picture", json!({"data": data}))
            }
            DocxOp::Table { rows, cols } => {
                let at = &self.session.sel.focus;
                if !self.session.sel.is_collapsed()
                    || at.story != StoryRef::Body
                    || at.path.0.len() != 1
                {
                    return Err(Rejected);
                }
                self.run("insert.table", json!({"rows": rows, "cols": cols}))
            }
            DocxOp::Toc {} => self.toc(false),
            DocxOp::UpdateToc {} => self.toc(true),
            DocxOp::TrackChanges { value } => {
                if self.session.doc.settings.track_changes == *value {
                    return Ok(false);
                }
                self.run("review.trackChanges", json!({ "value": value }))
            }
            DocxOp::AcceptChange {} => self.resolve("review.accept"),
            DocxOp::RejectChange {} => self.resolve("review.reject"),
            DocxOp::AcceptAll {} => self.resolve("review.acceptAll"),
            DocxOp::RejectAll {} => self.resolve("review.rejectAll"),
            DocxOp::Align { value } => self.stage1_align(*value),
            DocxOp::FontSize { size } => self.stage1_font_size(*size),
            DocxOp::FontColor { color } => self.stage1_font_color(color),
            DocxOp::Highlight { color } => self.stage1_highlight(color),
            DocxOp::EmbedFont { family, style } => self.embed_font(family, style),
            DocxOp::Script { value } => self.stage1_script(*value),
            DocxOp::Paragraph { format } => self.stage1_paragraph(format),
            DocxOp::List { style, off } => self.stage1_list(*style, *off),
            DocxOp::ListIndent { outdent } => self.stage1_list_indent(*outdent),
            DocxOp::RestartNumbering {} => self.stage1_restart_numbering(),
            DocxOp::ContinueNumbering {} => self.stage1_continue_numbering(),
            DocxOp::PageSetup { setup } => self.stage1_page_setup(setup),
            DocxOp::Find { query, backward } => self.stage1_find(query, *backward),
            DocxOp::Replace { query, with } => self.stage1_replace(query, with),
            DocxOp::ReplaceAll { query, with } => self.stage1_replace_all(query, with),
            DocxOp::ClearSearch {} => {
                self.stage1_clear_search();
                Ok(false)
            }
            DocxOp::TableStructure { action, target, rows, columns } => {
                self.table_structure(*action, target, *rows, *columns)
            }
            DocxOp::TableShading { target, color } => {
                self.table_shading(target, color.as_deref())
            }
            DocxOp::TableBorders { target, kind, style, width, color } => {
                self.table_cell_borders(
                    target,
                    *kind,
                    style.as_deref(),
                    *width,
                    color.as_deref(),
                )
            }
            DocxOp::TableAlignment { target, horizontal, vertical } => {
                self.table_cell_alignment(target, *horizontal, *vertical)
            }
            DocxOp::TableColumnWidth { target, width, distribute } => {
                self.table_column_width(target, *width, *distribute)
            }
            DocxOp::TableRowHeight { target, height, rule, clear, distribute } => {
                self.table_row_height(target, *height, *rule, *clear, *distribute)
            }
            DocxOp::CutTableCells { target } => self.cut_table_cells(target),
            DocxOp::PasteTableCells { target, payload } => self.paste_table_cells(target, payload),
            DocxOp::TableCellMargins { target, scope, top, right, bottom, left, reset } => {
                self.table_cell_margins(target, *scope, *top, *right, *bottom, *left, *reset)
            }
            DocxOp::TablePositioning { target, align, indent_pt } => {
                self.table_positioning(target, *align, *indent_pt)
            }
            DocxOp::TableRepeatHeader { target, repeat } => self.table_repeat_header(target, *repeat),
            DocxOp::TableRowBreak { target, mode } => self.table_row_break(target, *mode),
        }
    }

    /// 수락·거절(T013 Stage 3). 변경 기록이 하나도 없으면 거부한다. WordCraft 명령 하나라 실패하면 엔진이 되돌리고, 문서가 그대로면
    /// (그 자리에 변경 없음) 거부로 알린다(성공으로 세지 않음). 글자가 빠지거나 남으므로 어댑터 기억을 버린다.
    fn resolve(&mut self, command: &str) -> Result<bool, Rejected> {
        if !self.has_revisions() {
            return Err(Rejected);
        }
        // The engine maintains bookmark lifecycles. Keep the independent semantic
        // round-trip guard before accepting the edit/history step.
        let check_toc = self.has_toc();
        let changed = self.atomic(|model| {
            let changed = model.run(command, json!({}))?;
            if check_toc && !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(changed)
        })?;
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        if changed {
            Ok(true)
        } else {
            Err(Rejected)
        }
    }

    /// 본문·부분 이야기에 추적된 변경(넣기·지우기·서식·문단·번호·표·행·셀·구역 변경)이 하나라도 있는지. 쓰이지 않는 기록은 세지 않는다.
    pub fn has_revisions(&self) -> bool {
        use wordcraft_engine::doc::{Block, Blocks};
        fn blocks(list: &Blocks, depth: usize) -> bool {
            depth < 64
                && list.iter().any(|block| match &**block {
                    Block::Para(p) => {
                        p.props.fmt_change.is_some()
                            || p.props.num_change.is_some()
                            || [&p.mark]
                                .into_iter()
                                .chain(p.runs.iter().map(|r| &r.props))
                                .any(|c| {
                                    c.ins.is_some() || c.del.is_some() || c.fmt_change.is_some()
                                })
                            || p.section.as_ref().is_some_and(|s| s.fmt_change.is_some())
                    }
                    Block::Table(t) => {
                        t.props.fmt_change.is_some()
                            || t.rows.iter().any(|r| {
                                r.props.fmt_change.is_some()
                                    || r.cells.iter().any(|c| {
                                        c.props.fmt_change.is_some() || blocks(&c.blocks, depth + 1)
                                    })
                            })
                    }
                })
        }
        let doc = &self.session.doc;
        !doc.revisions.is_empty()
            && (blocks(&doc.body, 0)
                || doc.parts.values().any(|part| blocks(&part.blocks, 0))
                || doc.last_section.fmt_change.is_some())
    }

    /// 본문 최상위에 엔진이 갱신할 수 있는 목차(`TOC` 필드 표지, 또는 잠기지 않은 가져온 범위 필드)가 있는지. 그림 목차(`\c`)는
    /// 아니다.
    pub fn has_toc(&self) -> bool {
        let is_toc = |instr: &str| {
            let mut words = instr.split_whitespace();
            words.next().is_some_and(|k| k.eq_ignore_ascii_case("TOC"))
                && !words.any(|w| w.eq_ignore_ascii_case("\\c"))
        };
        self.session.doc.body.iter().any(|block| {
            block.as_para().is_some_and(|para| {
                para.objects.iter().any(|object| match object {
                    InlineObject::Field { instr, .. } => is_toc(instr),
                    // 잠긴 범위 목차는 엔진이 갱신하지 않는다(`range_toc_to_field`).
                    InlineObject::FieldStart { instr, locked } => !locked && is_toc(instr),
                    _ => false,
                })
            })
        })
    }

    /// 목차 넣기·갱신(T013). WordCraft 명령 하나라 실패하면 엔진이 되돌린다(문서 보호도 엔진이 판정). 넣기는 본문 최상위 문단의 커서
    /// (선택 없음)에서만, 갱신은 목차가 있을 때만 한다. 위치가 바뀌므로 어댑터 기억을 버린다.
    fn toc(&mut self, update: bool) -> Result<bool, Rejected> {
        if update {
            if !self.has_toc() {
                return Err(Rejected);
            }
        } else {
            let at = &self.session.sel.focus;
            if !self.session.sel.is_collapsed() || at.story != StoryRef::Body || at.path.depth() > 0
            {
                return Err(Rejected);
            }
        }
        let tracked = self.has_revisions();
        let changed = self.atomic(|model| {
            let changed = model.run(
                if update {
                    "references.updateToc"
                } else {
                    "references.toc"
                },
                json!({}),
            )?;
            if tracked && !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(changed)
        })?;
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    /// 새 각주·미주(T013). 커서가 본문 최상위 문단에 있고 선택이 없을 때만 WordCraft 명령 하나를 실행한다(실패하면 엔진이 되돌림,
    /// 문서 보호도 엔진이 판정). 엔진은 커서를 새 각주 이야기 안으로 옮기므로, 앱이 검증한 본문 편집 문맥을 지키려고 커서를 본문의
    /// 각주 표지 바로 뒤로 돌린다(표지는 커서 자리에 개체 글자 하나로 들어감, 실측). 위치가 바뀌므로 어댑터 기억은 버린다.
    fn new_note(&mut self, command: &str, text: &str) -> Result<bool, Rejected> {
        let at = self.session.sel.focus.clone();
        if !self.session.sel.is_collapsed() || at.story != StoryRef::Body || at.path.depth() > 0 {
            return Err(Rejected);
        }
        let changed = self.run(command, json!({ "text": text }))?;
        let after = Pos {
            off: at.off + wordcraft_engine::doc::para::OBJ.len_utf8(),
            ..at
        };
        self.session.sel = wordcraft_engine::Selection::caret(after);
        self.session.clamp_selection();
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    /// 새 메모(T013). 본문 안의 비어 있지 않은 선택일 때만 WordCraft `review.newComment`를 한 명령으로 실행한다(실패하면 엔진이
    /// 되돌림, 문서 보호도 엔진이 판정). 메모 표지(개체 글자)가 들어가 위치가 바뀌므로 어댑터 기억(자리 표시·고칠 수 있는 바로 앞
    /// 넣기)은 버린다.
    fn new_comment(&mut self, text: &str) -> Result<bool, Rejected> {
        let sel = &self.session.sel;
        if sel.is_collapsed()
            || sel.anchor.story != StoryRef::Body
            || sel.focus.story != StoryRef::Body
        {
            return Err(Rejected);
        }
        let changed = self.run("review.newComment", json!({ "text": text }))?;
        self.marks.clear();
        self.last_insert = None;
        Ok(changed)
    }

    /// WordCraft 실행 취소·다시 실행 한 단계(T010). 엔진은 `edit.undo`·`edit.redo`를 문서를 바꾸지 않는 명령(`pure`)으로
    /// 등록하지만 실제로는 문서·선택을 바꾸므로(실측), `run`의 판단 대신 앞뒤 문서를 직접 비교해 revision을 정한다. 되돌릴
    /// 단계가 없으면 아무것도 바꾸지 않는다(`Ok(false)`). 엔진이 거부하면(문서 보호를 푸는 단계) 거부다. 바뀐 문서에서는
    /// 어댑터 기억(IME 늦은 확정의 자리 표시, 고칠 수 있는 바로 앞 넣기)의 위치가 맞지 않을 수 있으므로 버린다.
    fn undo_redo_step(&mut self, redo: bool) -> Result<bool, Rejected> {
        let available = if redo {
            self.session.can_redo()
        } else {
            self.session.can_undo()
        };
        if !available {
            return Ok(false);
        }
        let before = self.session.doc.clone();
        self.run(if redo { "edit.redo" } else { "edit.undo" }, json!({}))?;
        self.prune_pasted_media();
        self.marks.clear();
        self.last_insert = None;
        Ok(before != self.session.doc)
    }

    fn insert_text(&mut self, text: &str) -> Result<bool, Rejected> {
        let layout = self.session.layout();
        let start = self.session.sel.ordered().0;
        let changed = self.insert_raw(text)?;
        let end = self.session.sel.focus.clone();
        // 한 문단 안에 그대로 들어갔을 때만 기억한다(그 범위를 나중에 고칠 수 있음).
        self.last_insert = (changed
            && same_paragraph(&start, &end)
            && Some(end.off) == start.off.checked_add(text.len()))
        .then(|| LastInsert {
            start,
            end,
            text: text.to_owned(),
            rev: self.session.rev(),
            layout,
        });
        Ok(changed)
    }

    /// 바로 앞에 넣은 글자가 그대로 있을 때 그것.
    fn recent_insert(&self) -> Option<&LastInsert> {
        self.last_insert
            .as_ref()
            .filter(|last| last.rev == self.session.rev())
    }

    fn hit_before_insert(&self, page: u32, x: f32, y: f32, before_insert: bool) -> Option<Pos> {
        if !before_insert {
            return None;
        }
        let last = self.recent_insert()?;
        let mut pos = last
            .layout
            .hit(page as usize, x, y, self.session.sel.focus.story)?;
        if same_paragraph(&pos, &last.start) && pos.off >= last.start.off {
            pos.off = pos.off.checked_add(last.text.len())?;
        }
        Some(pos)
    }

    /// 여러 명령으로 된 연산을 하나로 실행한다. `work`가 거부되면(중간 명령 거부) WordCraft 편집 스냅숏으로 문서·선택·실행 취소
    /// 기록·dirty를 그 전으로 돌린다(엔진 `Session::restore` 계약). 어댑터의 기억(`marks`·`last_insert`)은 스냅숏 밖이므로
    /// `work`는 그것을 바꾸지 않고(호출하는 쪽이 성공한 뒤에만 바꿈), 되돌린 뒤 여기서 맞춘다: `restore`는 WordCraft 판을 올리므로,
    /// 연산 전에 고칠 수 있던 바로 앞 넣기는 그 판을 새 판으로 옮긴다. 문서가 스냅숏 그대로라 넣은 글자는 같은 자리에 있고,
    /// 그 사이 다른 변경은 없다(판을 옮기는 것은 그 넣기가 연산 전에 유효했을 때뿐).
    fn atomic<T>(
        &mut self,
        work: impl FnOnce(&mut Self) -> Result<T, Rejected>,
    ) -> Result<T, Rejected> {
        let snapshot = self.session.edit_snapshot();
        // 스냅숏 밖이지만 복합 연산 안의 `caret.set`·`text.insert`가 지우고 그다음 허용 연산이 읽는 상태(T008 3차 안정화):
        // 세로 이동이 지키는 x, 다음 입력 서식(WordCraft 실행 취소 기록도 함께 담는 값).
        let aux = (self.session.goal_x, self.session.pending.clone());
        let recent = self.recent_insert().map(|last| last.rev);
        let result = work(self);
        if result.is_err() {
            self.session.restore(snapshot);
            (self.session.goal_x, self.session.pending) = aux;
            let rev = self.session.rev();
            if let Some(last) = self
                .last_insert
                .as_mut()
                .filter(|last| Some(last.rev) == recent)
            {
                last.rev = rev;
            }
        }
        result
    }

    /// 선택(기준점·커서)을 되돌리며, `at` 문단의 `from` 뒤 자리는 `map`으로 옮긴다.
    fn restore_selection(
        &mut self,
        anchor: Pos,
        focus: Pos,
        at: &Pos,
        map: impl Fn(usize) -> usize,
    ) -> Result<(), Rejected> {
        let shift = |mut pos: Pos| {
            if same_paragraph(&pos, at) {
                pos.off = map(pos.off);
            }
            pos
        };
        self.select(&shift(anchor), &shift(focus))
    }

    fn insert_at(&mut self, mark: u32, text: &str) -> Result<bool, Rejected> {
        let pos = self
            .marks
            .iter()
            .find(|(id, _)| *id == mark)
            .map(|(_, pos)| pos.clone())
            .ok_or(Rejected)?;
        let at = self.session.doc.clamp(&pos);
        let (anchor, focus) = (
            self.session.sel.anchor.clone(),
            self.session.sel.focus.clone(),
        );
        let (from, length) = (at.off, text.len());
        let changed = self.atomic(|model| {
            model.run("caret.set", json!({ "pos": at }))?;
            let changed = model.insert_raw(text)?;
            model.restore_selection(anchor, focus, &at, |off| {
                if off >= from {
                    off.saturating_add(length)
                } else {
                    off
                }
            })?;
            Ok(changed)
        })?;
        // 성공한 뒤에만 자리 표시를 쓴다(거부하면 문서가 그대로이므로 남겨 같은 자리에 다시 넣을 수 있다).
        self.marks.retain(|(id, _)| *id != mark);
        self.last_insert = None;
        Ok(changed)
    }

    fn replace_inserted(&mut self, expected: &str, text: &str) -> Result<bool, Rejected> {
        let last = self.recent_insert().ok_or(Rejected)?;
        let (start, end) = (last.start.clone(), last.end.clone());
        let current = self
            .session
            .doc
            .para_at(&start)
            .and_then(|para| para.text.get(start.off..end.off));
        if last.text != expected || current != Some(expected) {
            return Err(Rejected);
        }
        let (anchor, focus) = (
            self.session.sel.anchor.clone(),
            self.session.sel.focus.clone(),
        );
        let (from, to, length) = (start.off, end.off, text.len());
        let changed = self.atomic(|model| {
            model.select(&start, &end)?;
            let changed = model.insert_raw(text)?;
            model.restore_selection(anchor, focus, &start, |off| {
                if off >= to {
                    (off - to).saturating_add(from).saturating_add(length)
                } else if off > from {
                    from.saturating_add(length)
                } else {
                    off
                }
            })?;
            Ok(changed)
        })?;
        self.last_insert = None;
        Ok(changed)
    }

    fn drawing_insertion_allowed(&self) -> bool {
        let caret = &self.session.sel.focus;
        // Appending a body drawing avoids renumbering existing drawings after
        // the insertion point. Other stories must pass the same conservative
        // check as picture insertion.
        self.session.sel.is_collapsed()
            && self.session.doc.settings.protection.is_none()
            && !self.session.doc.settings.track_changes
            && caret.story == StoryRef::Body
            && caret.path.0.len() == 1
            && *caret == self.session.doc.end_of(StoryRef::Body)
            && self.image_insertion_allowed()
    }

    fn editing_text_box(&self) -> Option<u32> {
        let StoryRef::Part(id) = self.session.sel.focus.story else { return None };
        self.session.doc.parts.get(&id)
            .is_some_and(|part| part.kind == wordcraft_engine::doc::PartKind::TextBox)
            .then_some(id)
    }

    fn insert_drawing(&mut self, command: &str, params: Value, collapse: bool) -> Result<bool, Rejected> {
        if !self.drawing_insertion_allowed() {
            return Err(Rejected);
        }
        self.atomic(|model| {
            let changed = model.run(command, params)?;
            if changed && collapse {
                model.run("select.collapse", json!({"end": true}))?;
            }
            if changed && !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(changed)
        })
    }

    /// Whether `story` serializes inside `word/document.xml` (Body or a Body-anchored TextBox chain).
    fn body_hosted_story(&self, story: StoryRef) -> bool {
        use wordcraft_engine::doc::PartKind;
        let mut current = story;
        let mut seen = Vec::new();
        for _ in 0..16 {
            match current {
                StoryRef::Body => return true,
                StoryRef::Part(id) => {
                    if seen.contains(&id)
                        || !self
                            .session
                            .doc
                            .parts
                            .get(&id)
                            .is_some_and(|p| p.kind == PartKind::TextBox)
                    {
                        return false;
                    }
                    seen.push(id);
                    let Some(anchor) = self.session.doc.text_box_anchor(id) else {
                        return false;
                    };
                    current = anchor.story;
                }
            }
        }
        false
    }

    fn image_insertion_allowed(&self) -> bool {
        // The pinned writer renumbers drawings in later OPC parts (headers, footers,
        // notes, comments) when a body-part drawing is added or removed. T009 rejects
        // those unrelated part changes; Body-hosted TextBoxes serialize inside document.xml.
        self.session
            .doc
            .parts
            .iter()
            .filter(|(id, _)| !self.body_hosted_story(StoryRef::Part(**id)))
            .all(|(id, _)| {
                self.session
                    .doc
                    .para_paths(StoryRef::Part(*id))
                    .iter()
                    .all(|path| {
                        self.session
                            .doc
                            .para(StoryRef::Part(*id), path)
                            .is_some_and(|p| p.objects.is_empty())
                    })
            })
    }

    fn object_at(&self, pos: &Pos) -> Option<&InlineObject> {
        self.session.doc.para_at(pos)?.object_at(pos.off)
    }

    fn linked_picture_story(&self, story: StoryRef) -> bool {
        use wordcraft_engine::doc::PartKind;
        let StoryRef::Part(id) = story else { return false };
        let doc = &self.session.doc;
        doc.parts.get(&id).is_some_and(|part| {
            matches!(part.kind, PartKind::Header | PartKind::Footer)
                || (matches!(part.kind, PartKind::Footnote | PartKind::Endnote)
                    && doc.counted_stories().contains(&story))
        })
    }

    fn embedded_inline_picture(&self, object: Option<&InlineObject>) -> bool {
        use wordcraft_engine::doc::para::Wrap;
        matches!(object, Some(InlineObject::Image { ole: None, media, float, w, h, .. })
            if float.wrap == Wrap::Inline && self.session.doc.media.contains_key(media)
                && w.is_finite() && *w > 0.0 && h.is_finite() && *h > 0.0)
    }

    fn story_inline_picture(&self, pos: &Pos) -> bool {
        pos.path.0.len() == 1 && self.linked_picture_story(pos.story)
            && self.embedded_inline_picture(self.object_at(pos))
    }

    fn plain_picture_size(object: Option<&InlineObject>) -> bool {
        matches!(object, Some(InlineObject::Image { float, w, h, .. })
            if float.spin().is_identity() && [w, h].into_iter()
                .all(|size| (MIN_OBJECT_SIDE_PT..=MAX_OBJECT_SIDE_PT).contains(size)))
    }

    fn sizable_story_picture_count(&self) -> usize {
        use wordcraft_engine::doc::Block;
        if self.session.doc.settings.protection.is_some() || self.session.doc.settings.track_changes {
            return 0;
        }
        self.session.doc.parts.iter()
            .filter(|(id, _)| self.linked_picture_story(StoryRef::Part(**id)))
            .flat_map(|(_, part)| &part.blocks)
            .filter_map(|block| match block.as_ref() {
                Block::Para(para) => Some(para),
                _ => None,
            })
            .map(|para| para.object_offsets().into_iter().filter(|&off| {
                let object = para.object_at(off);
                self.embedded_inline_picture(object) && Self::plain_picture_size(object)
            }).count())
            .sum()
    }

    fn object_kind(&self, pos: &Pos) -> Option<&'static str> {
        use wordcraft_engine::doc::graphic::GraphicKind;
        match self.object_at(pos)? {
            InlineObject::Image { ole: Some(_), .. } => Some("embedded"),
            InlineObject::Image { .. } => Some("picture"),
            InlineObject::Shape { story: Some(_), .. } => Some("textBox"),
            InlineObject::Shape { .. } => Some("shape"),
            InlineObject::Group { .. } => Some("group"),
            InlineObject::Graphic { graphic, .. } => Some(match graphic.kind {
                GraphicKind::Chart => "chart",
                GraphicKind::Diagram => "smartArt",
                GraphicKind::Ink => "embedded",
            }),
            _ => None,
        }
    }

    /// The clipboard can faithfully recreate precisely the basic inline
    /// objects the ordinary insert command produces. Reject all extensions.
    fn clipboard_shape(&self, pos: &Pos) -> Option<ClipboardShapeView> {
        use wordcraft_engine::doc::{para::{Float, ShapeKind, OBJ}, props::Rgb};
        if !self.created_shapes.contains(pos) {
            return None;
        }
        let InlineObject::Shape { kind, w, h, fill, stroke, stroke_width, float, story, freeform, effects, extra }
            = self.object_at(pos)? else { return None };
        let shape = match kind {
            ShapeKind::Rectangle => BasicShape::Rectangle,
            ShapeKind::Ellipse => BasicShape::Ellipse,
            ShapeKind::Line => BasicShape::Line,
            _ => return None,
        };
        let expected_fill = if shape == BasicShape::Line { None } else { Some(Rgb(0x15, 0x60, 0x82)) };
        let expected_height = if shape == BasicShape::Line { 1.0 } else { 72.0 };
        if pos.story != StoryRef::Body || pos.path.0.len() != 1 || *w != 108.0 || *h != expected_height
            || *fill != expected_fill || *stroke != Some(Rgb(0x0e, 0x40, 0x5a)) || *stroke_width != 1.0
            || *float != Float::default() || story.is_some() || freeform.is_some() || !effects.is_empty() || !extra.is_empty()
        {
            return None;
        }
        let end = self.session.doc.end_of(StoryRef::Body);
        let cut_allowed = end.path == pos.path && end.off == pos.off + OBJ.len_utf8()
            && self.session.doc.settings.protection.is_none()
            && !self.session.doc.settings.track_changes && self.image_insertion_allowed();
        Some(ClipboardShapeView { shape, cut_allowed })
    }

    fn cut_clipboard_shape(&mut self, position: &str, epoch: u64) -> Result<bool, Rejected> {
        let (pos, _) = self.selected_object.clone().ok_or(Rejected)?;
        if epoch != self.object_epoch || position_key(&pos) != position
            || !self.clipboard_shape(&pos).is_some_and(|shape| shape.cut_allowed) {
            return Err(Rejected);
        }
        let end = Pos { off: pos.off + wordcraft_engine::doc::para::OBJ.len_utf8(), ..pos.clone() };
        self.atomic(|model| {
            model.select(&pos, &end)?;
            let changed = model.run("text.delete", json!({}))?;
            if changed && !model.export().is_some_and(|bytes| model.same_as(&bytes)) {
                return Err(Rejected);
            }
            Ok(changed)
        })
    }

    /// Which mutations the object at `pos` admits. Secondary stories expose
    /// inline picture properties with a separate T009 proof. Charts and SmartArt
    /// are written to their own parts, so their geometry stays frozen.
    fn object_operations(&self, pos: &Pos) -> Vec<&'static str> {
        let doc = &self.session.doc;
        if doc.settings.protection.is_some() || doc.settings.track_changes {
            return Vec::new();
        }
        if !self.body_hosted_story(pos.story) {
            if !self.story_inline_picture(pos) {
                return Vec::new();
            }
            return if self.story_picture_resize && Self::plain_picture_size(self.object_at(pos)) {
                vec!["resize", "altText"]
            } else {
                vec!["altText"]
            };
        }
        let Some(object) = self.object_at(pos) else {
            return Vec::new();
        };
        // Charts and SmartArt with a WordCraft model are regenerated from that model on save: only
        // their model edits (T009 regenerated-part proof), never their geometry.
        if let InlineObject::Graphic { graphic, .. } = object {
            return match (&graphic.chart, &graphic.smart_art) {
                (Some(_), _) => vec!["chart"],
                (None, Some(_)) => vec!["smartArt"],
                _ => Vec::new(),
            };
        }
        let drawing = matches!(
            self.object_kind(pos),
            Some("picture" | "shape" | "textBox" | "group")
        );
        if !drawing {
            return Vec::new();
        }
        // Pinned WordCraft `docx/read/story.rs:948` scans `a:graphicData` descendants for `a:blip`
        // before `wps:wsp`, collapsing any TextBox that contains an image into a plain Image on reopen.
        if pos.story != StoryRef::Body {
            let mut media = Vec::new();
            if !drawing_media(object, &mut media, 0) || !media.is_empty() {
                return Vec::new();
            }
        }
        let picture = matches!(self.object_kind(pos), Some("picture"));
        let top_level = pos.story == StoryRef::Body && pos.path.0.len() == 1;
        let mut ops = vec!["resize"];
        // Relocating or removing a drawing renumbers later drawings: only when no separate part has one.
        let relocatable = self.image_insertion_allowed();
        if relocatable {
            if top_level {
                ops.insert(0, "move");
            }
            ops.push("delete");
        }
        if picture {
            ops.push("crop");
        }
        // Floating an inline object (or back) only changes its own drawing element; the move rules
        // above still apply because the engine anchors floating objects at their paragraph.
        if relocatable && top_level {
            ops.push("wrap");
        }
        ops.push("altText");
        if matches!(self.object_kind(pos), Some("shape" | "textBox")) {
            ops.extend(["fill", "outline"]);
        }
        if top_level && self.editable_group_children(pos).is_some_and(|group| group.children.iter().any(|child| child.can_move || child.can_resize)) {
            ops.push("groupChildGeometry");
        }
        if top_level && self.drawingml_paths(pos).is_some() {
            ops.push("pathPoint");
            if let InlineObject::Shape { freeform: Some(freeform), .. } = object {
                if freeform.can_edit_drawingml_vertices() {
                    ops.push("pathVertex");
                }
            }
        }
        if self.conversion_target(pos).is_some() {
            ops.push("convertShape");
        }
        // Rotation and layer change the frame/wrap: the same placement rules as moving.
        if relocatable && top_level {
            ops.extend(["rotate", "zOrder"]);
        }
        ops
    }

    /// Direct, unturned group members whose local rectangles can be edited without mapping
    /// through a composite transform. Coordinates are integer EMU so a saved/reopened edit is
    /// exact. Unsupported or out-of-frame children remain in the model and are not exposed here.
    fn editable_group_children(&self, pos: &Pos) -> Option<EditableGroupChildrenView> {
        use wordcraft_engine::doc::para::{GroupChild, ShapeKind};
        if !self.group_body_roundtrips || pos.story != StoryRef::Body || pos.path.0.len() != 1
            || self.session.doc.settings.protection.is_some() || self.session.doc.settings.track_changes
        {
            return None;
        }
        let InlineObject::Group { w: owner_w, h: owner_h, float, ch_w, ch_h, children, canvas: None, .. } = self.object_at(pos)? else {
            return None;
        };
        if float.hidden || float.rot != 0.0 || float.flip_h || float.flip_v
            || !ch_w.is_finite() || !ch_h.is_finite() || *ch_w <= 0.0 || *ch_h <= 0.0
        {
            return None;
        }
        let units = |pt: f32| -> Option<f32> {
            if !pt.is_finite() || !(0.0..=14_400.0).contains(&pt) { return None; }
            Some(((f64::from(pt) * DOCX_GROUP_COORD_UNITS_PER_PT).round() / DOCX_GROUP_COORD_UNITS_PER_PT) as f32)
        };
        let (owner_width, owner_height, width, height) = (
            units(*owner_w)?, units(*owner_h)?, units(*ch_w)?, units(*ch_h)?,
        );
        if width == 0.0 || height == 0.0 || owner_width != width || owner_height != height {
            return None;
        }
        let mut visible = Vec::new();
        for (index, GroupChild { x, y, obj }) in children.iter().take(wordcraft_engine::doc::para::MAX_GROUP_CHILDREN).enumerate() {
            let Some((w, h, child_float)) = obj.frame() else { continue };
            let (Some(x), Some(y), Some(w), Some(h)) = (units(*x), units(*y), units(w), units(h)) else { continue };
            if w == 0.0 || h == 0.0 || x + w > width + 0.001 || y + h > height + 0.001 {
                continue;
            }
            let kind = match obj {
                InlineObject::Image { ole: None, .. } => "picture",
                InlineObject::Shape { kind: ShapeKind::Rectangle, .. } => "rectangle",
                InlineObject::Shape { kind: ShapeKind::Ellipse, .. } => "ellipse",
                InlineObject::Shape { .. } => "shape",
                InlineObject::Group { .. } => "group",
                _ => continue,
            };
            let simple_transform = !child_float.hidden && child_float.rot == 0.0 && !child_float.flip_h && !child_float.flip_v;
            let can_edit = simple_transform && matches!(obj,
                InlineObject::Image { ole: None, .. }
                    | InlineObject::Shape { .. }
                    | InlineObject::Group { canvas: None, .. });
            visible.push(GroupChildGeometryView {
                index,
                kind,
                id: (index as u32).saturating_add(1),
                inst_id: 0,
                x,
                y,
                width: w,
                height: h,
                size_protect: false,
                locked: false,
                can_move: can_edit,
                can_resize: can_edit,
            });
        }
        visible.iter().any(|child| child.can_move || child.can_resize).then_some(EditableGroupChildrenView {
            parent_id: 0,
            width,
            height,
            children: visible,
        })
    }

    /// Original integer DrawingML commands whose selected frame and modeled orthogonal object
    /// transform can be mapped reversibly to their stored path coordinates.
    fn drawingml_paths(&self, pos: &Pos) -> Option<Vec<DocxPathView>> {
        use wordcraft_engine::doc::freeform::DrawingMlPathCommand as Command;
        let InlineObject::Shape {
            kind: wordcraft_engine::doc::para::ShapeKind::Freeform,
            freeform: Some(freeform),
            float,
            ..
        } = self.object_at(pos)? else {
            return None;
        };
        if freeform.ink.is_some() || !float.rot.is_finite() || !(-360.0..=360.0).contains(&float.rot) {
            return None;
        }
        let geometry = freeform.drawingml.as_ref()?;
        if !geometry.editable
            || geometry.paths.is_empty()
            || geometry.paths.len() > wordcraft_engine::doc::freeform::MAX_PATHS
        {
            return None;
        }
        let mut views = Vec::with_capacity(geometry.paths.len());
        let mut total_commands = 0usize;
        let mut total_points = 0usize;
        for path in &geometry.paths {
            let [viewport_width, viewport_height] = path.viewport;
            if !(1..=1_000_000_000_000).contains(&viewport_width)
                || !(1..=1_000_000_000_000).contains(&viewport_height)
            {
                return None;
            }
            let commands = path.commands.as_ref()?;
            if commands.is_empty() || commands.len() > wordcraft_engine::doc::freeform::MAX_POINTS {
                return None;
            }
            total_commands = total_commands.saturating_add(commands.len());
            if total_commands > wordcraft_engine::doc::freeform::MAX_POINTS {
                return None;
            }
            let mut segments = Vec::with_capacity(commands.len());
            for command in commands {
                let (name, points, controls): (&'static str, Vec<[i64; 2]>, &[usize]) = match command {
                    Command::MoveTo { point } => ("moveTo", vec![*point], &[]),
                    Command::LineTo { point } => ("lnTo", vec![*point], &[]),
                    Command::QuadraticTo { control, end } => ("quadBezTo", vec![*control, *end], &[0]),
                    Command::CubicTo { control1, control2, end } => ("cubicBezTo", vec![*control1, *control2, *end], &[0, 1]),
                    Command::Close => ("close", Vec::new(), &[]),
                };
                if points.iter().any(|[x, y]| *x < 0 || *x > viewport_width || *y < 0 || *y > viewport_height) {
                    return None;
                }
                total_points = total_points.saturating_add(points.len());
                if total_points > wordcraft_engine::doc::freeform::MAX_POINTS {
                    return None;
                }
                segments.push(DocxPathSegmentView {
                    command: name,
                    points: points.into_iter().enumerate().map(|(index, [x, y])| DocxPathPointView {
                        x,
                        y,
                        control: controls.contains(&index),
                    }).collect(),
                });
            }
            views.push(DocxPathView { viewport_width, viewport_height, segments });
        }
        Some(views)
    }

    fn conversion_target(&self, pos: &Pos) -> Option<BasicShape> {
        use wordcraft_engine::doc::para::{ShapeKind, Wrap};
        let InlineObject::Shape { kind, story: None, freeform: None, effects, extra, float, .. }
            = self.object_at(pos)? else { return None };
        if pos.story != StoryRef::Body || pos.path.0.len() != 1 || !effects.is_empty()
            || !extra.is_empty() || float.wrap != Wrap::Inline {
            return None;
        }
        match kind {
            ShapeKind::Rectangle => Some(BasicShape::Ellipse),
            ShapeKind::Ellipse => Some(BasicShape::Rectangle),
            ShapeKind::RoundedRectangle if self.rounded_rectangle_conversion => Some(BasicShape::Rectangle),
            _ => None,
        }
    }

    fn paste_hwpx_polygon(&mut self, polygon: &HwpxPolygon) -> Result<bool, Rejected> {
        use wordcraft_engine::doc::{
            edit::Fragment, freeform::{FreePath, Freeform}, para::{Float, ShapeKind},
            props::{CharProps, Rgb}, Block, Paragraph,
        };
        if !polygon.valid() {
            return Err(Rejected);
        }
        let rgb = u32::from_str_radix(&polygon.fill, 16).map_err(|_| Rejected)?;
        let (w, h) = (polygon.width as f32 / 100.0, polygon.height as f32 / 100.0);
        let mut drawing = InlineObject::Shape {
            kind: ShapeKind::Freeform, w, h, fill: Some(Rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)),
            stroke: None, stroke_width: 0.0, float: Float::default(), story: None,
            freeform: Some(std::sync::Arc::new(Freeform {
                w, h, paths: vec![FreePath { closed: true, pts: polygon.points.iter().map(|[x, y]|
                    [*x as f32 / 100.0, *y as f32 / 100.0]).collect() }], ..Freeform::default()
            })),
            effects: Default::default(), extra: Default::default(),
        };
        drawing.set_alt_text(&polygon.description);
        let mut para = Paragraph::new();
        para.insert_object(0, drawing, &CharProps::default()).map_err(|_| Rejected)?;
        self.paste_object(&ObjectPayload {
            fragment: Fragment { blocks: vec![Block::Para(para)], ..Fragment::default() },
            media: Vec::new(),
        })
    }

    /// The engine computes drag offsets in f32 points; DOCX stores whole EMUs. Snap the edited
    /// object's frame to that grid so the saved file reopens to exactly this model.
    fn snap_to_emu(&mut self, pos: &Pos) -> Result<(), Rejected> {
        fn snap(pt: f32) -> f32 {
            ((f64::from(pt) * 12_700.0).round() as i64) as f32 / 12_700.0
        }
        let para = self
            .session
            .doc
            .para_mut(pos.story, &pos.path)
            .map_err(|_| Rejected)?;
        let object = para.object_at_mut(pos.off).ok_or(Rejected)?;
        let Some((w, h, _)) = object.frame() else {
            return Err(Rejected);
        };
        let (nw, nh) = (snap(w), snap(h));
        if (nw, nh) != (w, h) {
            object.set_size(nw, nh);
        }
        if let InlineObject::Shape {
            kind: wordcraft_engine::doc::para::ShapeKind::Freeform,
            freeform: Some(freeform),
            ..
        } = object
        {
            if (freeform.w, freeform.h) != (nw, nh) {
                let f = std::sync::Arc::make_mut(freeform);
                let sx = if f.w > 0.0 { f64::from(nw) / f64::from(f.w) } else { 1.0 };
                let sy = if f.h > 0.0 { f64::from(nh) / f64::from(f.h) } else { 1.0 };
                for path in &mut f.paths {
                    for pt in &mut path.pts {
                        pt[0] = snap((f64::from(pt[0]) * sx) as f32);
                        pt[1] = snap((f64::from(pt[1]) * sy) as f32);
                    }
                }
                f.w = nw;
                f.h = nh;
            }
        }
        if let Some(float) = object.float_mut() {
            float.x = snap(float.x);
            float.y = snap(float.y);
            // Match DrawingML's integer-EMU `wp:effectExtent` padding for rotated overhang.
            let (px, py) = float.spin_pad(nw, nh);
            if px != 0.0 || py != 0.0 {
                for (e, p) in float.effect.iter_mut().zip([px, py, px, py]) {
                    *e = (snap(*e + p) - p).clamp(0.0, 1584.0);
                }
            }
            // `wp:inline` carries no position or wrap distance: an object put back in line keeps
            // only what the inline form stores (rotation, flip, alt text, effects).
            if float.wrap == wordcraft_engine::doc::para::Wrap::Inline {
                let inline = wordcraft_engine::doc::para::Float::default();
                float.h_rel = inline.h_rel;
                float.v_rel = inline.v_rel;
                float.x = inline.x;
                float.y = inline.y;
                float.h_align = inline.h_align;
                float.v_align = inline.v_align;
                float.dist = inline.dist;
                float.dist_top = inline.dist_top;
                float.dist_bottom = inline.dist_bottom;
                float.wrap_text = inline.wrap_text;
                float.wrap_polygon = inline.wrap_polygon;
            }
            // DOCX has no vertical "column" anchor: `wp:positionV` reads back as the paragraph.
            if float.wrap != wordcraft_engine::doc::para::Wrap::Inline
                && float.v_rel == wordcraft_engine::doc::para::Anchor::Column
            {
                float.v_rel = wordcraft_engine::doc::para::Anchor::Paragraph;
            }
        }
        if let Some(float) = object.float_mut() {
            // `a:xfrm/@rot` stores 60000ths of a degree.
            let rot = ((f64::from(float.rot.rem_euclid(360.0)) * 60_000.0).round() as i64)
                .rem_euclid(21_600_000);
            float.rot = rot as f32 / 60_000.0;
        }
        if let InlineObject::Shape { stroke_width, .. } = object {
            *stroke_width = snap(stroke_width.clamp(0.0, 100.0));
        }
        // `a:srcRect` stores 1/100000 of each side.
        if let InlineObject::Image { crop, .. } = object {
            for side in crop.iter_mut() {
                *side = ((side.clamp(0.0, 1.0) * 100_000.0).round() as i64) as f32 / 100_000.0;
            }
        }
        para.touch();
        Ok(())
    }

    /// Drop pasted media that no picture references any more (after undo).
    fn prune_pasted_media(&mut self) {
        if self.pasted_media.is_empty() {
            return;
        }
        let mut used = Vec::new();
        let doc = &self.session.doc;
        let mut stories = vec![StoryRef::Body];
        stories.extend(doc.parts.keys().map(|id| StoryRef::Part(*id)));
        for story in stories {
            for path in doc.para_paths(story) {
                if let Some(para) = doc.para(story, &path) {
                    for object in &para.objects {
                        drawing_media(object, &mut used, 0);
                    }
                }
            }
        }
        let pasted = std::mem::take(&mut self.pasted_media);
        for key in pasted {
            if used.contains(&key) {
                self.pasted_media.push(key);
            } else {
                self.session.doc.media.remove(&key);
            }
        }
    }

    /// The structured clipboard payload for the selected drawing (`position`/`epoch` must match).
    pub fn clipboard_object(&self, position: &str, epoch: u64) -> Option<String> {
        let (pos, _) = self.selected_object.clone()?;
        if epoch != self.object_epoch
            || position_key(&pos) != position
            || !self.body_hosted_story(pos.story)
        {
            return None;
        }
        let end = Pos {
            off: pos.off + wordcraft_engine::doc::para::OBJ.len_utf8(),
            ..pos.clone()
        };
        let fragment = self.session.doc.copy_range(&pos, &end);
        let object = fragment.blocks.first()?.as_para()?.object_at(0)?.clone();
        let mut keys = Vec::new();
        if !drawing_media(&object, &mut keys, 0) {
            return None;
        }
        if pos.story != StoryRef::Body && !keys.is_empty() {
            return None;
        }
        keys.sort();
        keys.dedup();
        let mut media = Vec::new();
        let mut total = 0usize;
        for key in keys {
            let bytes = self.session.doc.media.get(&key)?;
            total += bytes.len();
            if total > MAX_PAYLOAD_MEDIA_BYTES || !crate::picture::valid(bytes) {
                return None;
            }
            media.push(PayloadMedia {
                name: key,
                sha256: sha256_hex(bytes),
                data: wordcraft_engine::cmd::insert::base64_encode(bytes),
            });
        }
        let payload = ObjectPayload { fragment, media };
        payload.drawing()?;
        serde_json::to_string(&payload).ok()
    }

    /// Paste a validated payload at the caret as one history step. Media get destination-owned
    /// keys; the text box story a new destination part. Rejected without any change unless the
    /// result passes the T009 gate against the pre-paste export.
    fn paste_object(&mut self, payload: &ObjectPayload) -> Result<bool, Rejected> {
        if !self.drawing_insertion_allowed() || payload.drawing().is_none() {
            return Err(Rejected);
        }
        let mut decoded = Vec::new();
        let mut total = 0usize;
        for m in &payload.media {
            let bytes = wordcraft_engine::cmd::insert::base64_decode(&m.data).ok_or(Rejected)?;
            total = total.saturating_add(bytes.len());
            if total > MAX_PAYLOAD_MEDIA_BYTES
                || sha256_hex(&bytes) != m.sha256
                || !crate::picture::valid(&bytes)
            {
                return Err(Rejected);
            }
            let ext = if bytes.starts_with(b"\x89PNG") {
                "png"
            } else {
                "jpeg"
            };
            decoded.push((m.name.clone(), bytes, ext));
        }
        let before = self.export().ok_or(Rejected)?;
        let saved_clipboard = (
            self.session.clipboard.take(),
            std::mem::take(&mut self.session.clipboard_text),
        );
        let mut added = Vec::new();
        let result = self.atomic(|model| {
            let mut fragment = payload.fragment.clone();
            let mut renamed = std::collections::BTreeMap::new();
            for (name, bytes, ext) in &decoded {
                let existed = model.session.doc.media.len();
                let key = model.session.doc.add_media(bytes.clone(), ext);
                if model.session.doc.media.len() > existed {
                    added.push(key.clone());
                }
                renamed.insert(name.clone(), key);
            }
            fn collect_obj_ids(
                object: &InlineObject,
                used: &mut std::collections::BTreeSet<u32>,
            ) {
                match object {
                    InlineObject::Shape { extra, .. } if extra.id != 0 => {
                        used.insert(extra.id);
                    }
                    InlineObject::Group { children, .. } => {
                        for c in children {
                            collect_obj_ids(&c.obj, used);
                        }
                    }
                    _ => {}
                }
            }
            fn collect_block_ids(
                blocks: &[std::sync::Arc<wordcraft_engine::doc::Block>],
                used: &mut std::collections::BTreeSet<u32>,
                depth: usize,
            ) {
                if depth > 32 {
                    return;
                }
                for block in blocks {
                    match block.as_ref() {
                        wordcraft_engine::doc::Block::Para(p) => {
                            for o in &p.objects {
                                collect_obj_ids(o, used);
                            }
                        }
                        wordcraft_engine::doc::Block::Table(t) => {
                            for r in &t.rows {
                                for c in &r.cells {
                                    collect_block_ids(&c.blocks, used, depth + 1);
                                }
                            }
                        }
                    }
                }
            }
            let mut used_shape_ids = std::collections::BTreeSet::new();
            collect_block_ids(&model.session.doc.body, &mut used_shape_ids, 0);
            for part in model.session.doc.parts.values() {
                collect_block_ids(&part.blocks, &mut used_shape_ids, 0);
            }
            let mut next_shape_id = used_shape_ids
                .iter()
                .next_back()
                .copied()
                .unwrap_or(0)
                .saturating_add(1)
                .max(1);
            fn collect_glued_targets(object: &InlineObject, out: &mut std::collections::BTreeSet<u32>) {
                match object {
                    InlineObject::Shape { extra, .. } => {
                        if let Some(s) = extra.start {
                            out.insert(s.id);
                        }
                        if let Some(e) = extra.end {
                            out.insert(e.id);
                        }
                    }
                    InlineObject::Group { children, .. } => {
                        for c in children {
                            collect_glued_targets(&c.obj, out);
                        }
                    }
                    _ => {}
                }
            }
            let mut src_shape_ids = std::collections::BTreeSet::new();
            let mut glued_targets = std::collections::BTreeSet::new();
            {
                let ro_obj = fragment
                    .blocks
                    .first()
                    .and_then(|b| b.as_para())
                    .and_then(|p| p.object_at(0))
                    .ok_or(Rejected)?;
                collect_obj_ids(ro_obj, &mut src_shape_ids);
                collect_glued_targets(ro_obj, &mut glued_targets);
            }
            let mut id_map = std::collections::BTreeMap::new();
            for old_id in src_shape_ids {
                if glued_targets.contains(&old_id) {
                    let assigned = if used_shape_ids.insert(old_id) {
                        old_id
                    } else {
                        while used_shape_ids.contains(&next_shape_id) {
                            next_shape_id = next_shape_id.saturating_add(1);
                        }
                        used_shape_ids.insert(next_shape_id);
                        next_shape_id
                    };
                    id_map.insert(old_id, assigned);
                }
            }
            fn remap_object(
                object: &mut InlineObject,
                map: &std::collections::BTreeMap<String, String>,
                id_map: &std::collections::BTreeMap<u32, u32>,
            ) -> bool {
                match object {
                    InlineObject::Image { media, .. } => match map.get(media) {
                        Some(key) => {
                            *media = key.clone();
                            true
                        }
                        None => false,
                    },
                    InlineObject::Shape { extra, .. } => {
                        extra.start = extra.start.and_then(|mut cxn| {
                            id_map.get(&cxn.id).map(|&id| {
                                cxn.id = id;
                                cxn
                            })
                        });
                        extra.end = extra.end.and_then(|mut cxn| {
                            id_map.get(&cxn.id).map(|&id| {
                                cxn.id = id;
                                cxn
                            })
                        });
                        extra.id = id_map.get(&extra.id).copied().unwrap_or(0);
                        true
                    }
                    InlineObject::Group { children, .. } => children
                        .iter_mut()
                        .all(|c| remap_object(&mut c.obj, map, id_map)),
                    _ => true,
                }
            }
            let block = fragment.blocks.first_mut().ok_or(Rejected)?;
            let wordcraft_engine::doc::Block::Para(para) = block else {
                return Err(Rejected);
            };
            let object = para.object_at_mut(0).ok_or(Rejected)?;
            if !remap_object(object, &renamed, &id_map) {
                return Err(Rejected);
            }
            model.session.clipboard_text = fragment.clipboard_text();
            model.session.clipboard = Some(fragment);
            let changed = model.run("edit.paste", json!({}))?;
            if !changed {
                return Err(Rejected);
            }
            let after = model.export().ok_or(Rejected)?;
            let same = model.same_as(&after);
            let gate = crate::services::save::service::check_saved(
                crate::document::Format::Docx,
                &before,
                &after,
                None,
                same,
            );
            if !same || !gate.is_safe() {
                return Err(Rejected);
            }
            Ok(true)
        });
        (self.session.clipboard, self.session.clipboard_text) = saved_clipboard;
        if result.is_ok() {
            self.pasted_media.extend(added);
        }
        result
    }

    /// A chart or SmartArt with a WordCraft model is written from that model; the reader also keeps
    /// its parts as `passthrough` bytes, which an edit leaves stale. Take the regenerated bytes of
    /// exactly those parts (same names, nothing added or removed) so the model matches its file.
    fn sync_regenerated_parts(&mut self, bytes: &[u8]) -> Result<(), Rejected> {
        let reopened = io::open_bytes(DOCX_NAME, bytes).map_err(|_| Rejected)?;
        let (mine, theirs) = (&self.session.doc.passthrough, &reopened.passthrough);
        if mine.len() != theirs.len() || !mine.keys().eq(theirs.keys()) {
            return Err(Rejected);
        }
        let stale: Vec<String> = mine
            .iter()
            .filter(|(k, v)| theirs.get(*k) != Some(*v))
            .map(|(k, _)| k.clone())
            .collect();
        if !stale
            .iter()
            .all(|name| crate::services::save::package::regenerated_graphic_part(name))
        {
            return Err(Rejected);
        }
        for name in stale {
            let fresh = theirs.get(&name).cloned().ok_or(Rejected)?;
            self.session.doc.passthrough.insert(name, fresh);
        }
        Ok(())
    }

    fn object_edit(
        &mut self,
        position: &str,
        epoch: u64,
        edit: &ObjectEdit,
    ) -> Result<bool, Rejected> {
        let (pos, page) = self.selected_object.clone().ok_or(Rejected)?;
        if epoch != self.object_epoch
            || position_key(&pos) != position
            || !self.object_operations(&pos).contains(&edit.operation())
        {
            return Err(Rejected);
        }
        if let ObjectEdit::ConvertShape { to } = edit {
            if self.conversion_target(&pos) != Some(*to) {
                return Err(Rejected);
            }
        }
        if let ObjectEdit::DocxPathPoint { path, segment, point, x, y } = edit {
            let paths = self.drawingml_paths(&pos).ok_or(Rejected)?;
            let target = paths
                .get(*path)
                .and_then(|path| path.segments.get(*segment))
                .and_then(|segment| segment.points.get(*point))
                .ok_or(Rejected)?;
            let viewport = paths.get(*path).ok_or(Rejected)?;
            if *x < 0
                || *x > viewport.viewport_width
                || *y < 0
                || *y > viewport.viewport_height
                || (target.x == *x && target.y == *y)
            {
                return Err(Rejected);
            }
        }
        if let ObjectEdit::DocxPathVertex { path, segment, action, x, y } = edit {
            let paths = self.drawingml_paths(&pos).ok_or(Rejected)?;
            let source = paths.get(*path).ok_or(Rejected)?;
            let target = source.segments.get(*segment).ok_or(Rejected)?;
            match action {
                DocxPathVertexAction::Insert => {
                    if !matches!(target.command, "lnTo" | "close") {
                        return Err(Rejected);
                    }
                    let (Some(x), Some(y)) = (x, y) else { return Err(Rejected) };
                    if *x < 0 || *x > source.viewport_width || *y < 0 || *y > source.viewport_height {
                        return Err(Rejected);
                    }
                }
                DocxPathVertexAction::Remove => {
                    if target.command != "lnTo" || x.is_some() || y.is_some() {
                        return Err(Rejected);
                    }
                }
            }
        }
        if let ObjectEdit::DocxGroupChildMove { index, id, inst_id, x, y } = edit {
            let group = self.editable_group_children(&pos).ok_or(Rejected)?;
            let child = group.children.iter().find(|child| child.index == *index && child.id == *id && child.inst_id == *inst_id && child.can_move).ok_or(Rejected)?;
            if *x == child.x && *y == child.y
                || *x + child.width > group.width + 0.001
                || *y + child.height > group.height + 0.001
            {
                return Err(Rejected);
            }
        }
        if let ObjectEdit::DocxGroupChildResize { index, id, inst_id, width, height } = edit {
            let group = self.editable_group_children(&pos).ok_or(Rejected)?;
            let child = group.children.iter().find(|child| child.index == *index && child.id == *id && child.inst_id == *inst_id && child.can_resize).ok_or(Rejected)?;
            if (*width == child.width && *height == child.height)
                || child.x + *width > group.width + 0.001
                || child.y + *height > group.height + 0.001
            {
                return Err(Rejected);
            }
        }
        let before = self.export().ok_or(Rejected)?;
        let end = Pos {
            off: pos.off + wordcraft_engine::doc::para::OBJ.len_utf8(),
            ..pos.clone()
        };
        let selection = (
            self.session.sel.anchor.clone(),
            self.session.sel.focus.clone(),
        );
        let result = self.atomic(|model| {
            model.select(&pos, &end)?;
            let (changed, at) = match edit {
                ObjectEdit::Delete {} => {
                    let changed = model.run("text.delete", json!({}))?;
                    // Media only the deleted picture used leaves the package (T009 drawing-owned media proof).
                    table::retain_used_media(&mut model.session.doc);
                    (changed, None)
                }
                ObjectEdit::Nudge { dx, dy } => {
                    let changed = model.run("arrange.nudge", json!({"dx": dx, "dy": dy}))?;
                    (changed, Some(pos.clone()))
                }
                ObjectEdit::Bounds {
                    x,
                    y,
                    width,
                    height,
                } => {
                    let mut params = serde_json::Map::new();
                    if let (Some(x), Some(y)) = (x, y) {
                        params.insert("x".into(), json!(x));
                        params.insert("y".into(), json!(y));
                        params.insert("page".into(), json!(page));
                    }
                    if let Some(w) = width {
                        params.insert("width".into(), json!(w));
                    }
                    if let Some(h) = height {
                        params.insert("height".into(), json!(h));
                    }
                    let params = Value::Object(params);
                    let changed = model.run("arrange.bounds", params)?;
                    // The engine leaves the object selected at its (possibly new) anchor.
                    let (a, b) = model.session.sel.ordered();
                    if a.story != b.story
                        || a.path != b.path
                        || b.off != a.off + wordcraft_engine::doc::para::OBJ.len_utf8()
                        || model.object_kind(&a).is_none()
                    {
                        return Err(Rejected);
                    }
                    (changed, Some(a))
                }
                ObjectEdit::Crop {
                    left,
                    top,
                    right,
                    bottom,
                } => {
                    let params =
                        json!({"left": left, "top": top, "right": right, "bottom": bottom});
                    (model.run("picture.crop", params)?, Some(pos.clone()))
                }
                ObjectEdit::Wrap { wrap } => (
                    model.run("arrange.wrap", json!({"wrap": wrap}))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::AltText { text } => (
                    model.run("object.altText", json!({"text": text}))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::Position { preset } => (
                    model.run("arrange.position", json!({"preset": preset.name()}))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::Fill { color } => (
                    model.run("shape.fill", json!({ "color": color }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::ConvertShape { to } => (
                    model.run("shape.change", json!({ "kind": to.name() }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::Outline { color, width } => {
                    let mut params = json!({ "color": color });
                    if let Some(width) = width {
                        params["width"] = json!(width);
                    }
                    (model.run("shape.outline", params)?, Some(pos.clone()))
                }
                ObjectEdit::Rotate {
                    degrees,
                    flip_h,
                    flip_v,
                } => (
                    model.run(
                        "arrange.rotation",
                        json!({"degrees": degrees, "flipH": flip_h, "flipV": flip_v}),
                    )?,
                    Some(pos.clone()),
                ),
                ObjectEdit::ChartTitle { text } => (
                    model.run("chart.title", json!({ "text": text }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::ChartType { plot } => (
                    model.run("chart.type", json!({ "type": plot }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::ChartData { categories, series } => (
                    model.run(
                        "chart.editData",
                        json!({"data": {"categories": categories, "series": series}}),
                    )?,
                    Some(pos.clone()),
                ),
                ObjectEdit::SmartArtItems { items } => (
                    model.run("smartArt.items", json!({ "items": items }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::SmartArtLayout { layout } => (
                    model.run("smartArt.layout", json!({ "layout": layout }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::DocxPathPoint { path, segment, point, x, y } => (
                    model.run("shape.pathPoint", json!({ "path": path, "segment": segment, "point": point, "x": x, "y": y }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::DocxPathVertex { path, segment, action, x, y } => {
                    let mut params = json!({ "path": path, "segment": segment, "action": action });
                    if let (Some(x), Some(y)) = (x, y) {
                        params["x"] = json!(x);
                        params["y"] = json!(y);
                    }
                    (model.run("shape.pathVertex", params)?, Some(pos.clone()))
                }
                ObjectEdit::DocxGroupChildMove { index, id, inst_id, x, y } => (
                    model.run("group.childBounds", json!({
                        "index": index,
                        "id": id,
                        "instId": inst_id,
                        "x": x,
                        "y": y,
                    }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::DocxGroupChildResize { index, id, inst_id, width, height } => (
                    model.run("group.childBounds", json!({
                        "index": index,
                        "id": id,
                        "instId": inst_id,
                        "width": width,
                        "height": height,
                    }))?,
                    Some(pos.clone()),
                ),
                ObjectEdit::Layer { front } => (
                    model.run(
                        if *front {
                            "arrange.bringForward"
                        } else {
                            "arrange.sendBackward"
                        },
                        json!({}),
                    )?,
                    Some(pos.clone()),
                ),
            };
            if !changed {
                return Err(Rejected);
            }
            if let Some(at) = at.as_ref().filter(|at| {
                !matches!(edit, ObjectEdit::DocxPathPoint { .. } | ObjectEdit::DocxPathVertex { .. })
                    && (!matches!(edit, ObjectEdit::AltText { .. }) || !model.story_inline_picture(at))
            }) {
                model.snap_to_emu(at)?;
            }
            let mut after = model.export().ok_or(Rejected)?;
            if matches!(edit.operation(), "chart" | "smartArt") {
                model.sync_regenerated_parts(&after)?;
                after = model.export().ok_or(Rejected)?;
            }
            let same = model.same_as(&after);
            let gate = crate::services::save::service::check_saved(
                crate::document::Format::Docx,
                &before,
                &after,
                None,
                same,
            );
            if !same || !gate.is_safe() {
                return Err(Rejected);
            }
            // Text caret goes back where it was (object selection hides it); an anchor that
            // moved paragraphs only shifts offsets inside those paragraphs.
            let caret = model.session.doc.clamp(&selection.1);
            model.session.sel = wordcraft_engine::Selection {
                anchor: caret.clone(),
                focus: caret,
            };
            Ok(at)
        })?;
        if let Some(at) = result {
            let layout = self.session.layout();
            let page = layout.object(&at, page).map_or(page, |hit| hit.page);
            self.object_epoch += 1;
            self.reselect = Some((at, page));
        }
        Ok(true)
    }

    fn graphic_properties(&self, pos: &Pos) -> Option<Value> {
        let InlineObject::Graphic { graphic, .. } = self.object_at(pos)? else { return None };
        if let Some(chart) = &graphic.chart {
            let bounded = |s: &str| s.len() <= 1024;
            if chart.categories.len() > 128
                || !chart.categories.iter().all(|s| bounded(s))
                || chart.title.as_deref().is_some_and(|s| !bounded(s))
                || chart.series.len() > 16
                || chart.series.iter().any(|s| !bounded(&s.name) || s.values.len() > 128)
            {
                return None;
            }
            let series: Vec<Value> = chart.series.iter().map(|s| {
                let values: Vec<Option<String>> = s.values.iter().map(|v| v.map(|n| n.to_string())).collect();
                json!({"name": s.name, "values": values})
            }).collect();
            return Some(json!({"kind": "chart", "plot": chart.kind.id(), "title": chart.title,
                "labels": chart.categories, "series": series}));
        }
        let art = graphic.smart_art.as_ref()?;
        if art.items.len() > 128 || art.items.iter().any(|i| i.text.len() > 1024 || i.level > 7) {
            return None;
        }
        Some(json!({"kind": "smartArt", "layout": art.layout.id(), "items": art.items}))
    }

    pub fn view(&mut self) -> DocxView {
        self.sync_fonts();
        let layout = self.session.layout();
        let hint = self.session.page_hint;
        let sel = self.session.sel.clone();
        let object = self.selected_object.as_ref().and_then(|(pos, page)| {
            let hit = layout.object(pos, *page)?;
            let kind = self.object_kind(pos)?;
            let bounds = hit.bounds();
            let picture = match self.object_at(pos)? {
                InlineObject::Image {
                    ole: None,
                    w,
                    h,
                    alt,
                    float,
                    crop,
                    ..
                } if [*w, *h].iter().all(|side| side.is_finite() && *side > 0.0) => {
                    Some(PictureView {
                        width_pt: *w,
                        height_pt: *h,
                        wrap: float.wrap,
                        crop: *crop,
                        description: (alt.len() <= 4096).then(|| alt.clone()),
                    })
                }
                _ => None,
            };
            Some(ObjectView {
                kind,
                position: position_key(pos),
                frame: RectView { page: hit.page, x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h },
                epoch: self.object_epoch,
                picture,
                graphic: self.graphic_properties(pos),
                clipboard_shape: self.clipboard_shape(pos),
                operations: self.object_operations(pos),
                convert_shape: self.conversion_target(pos),
                shape: match self.object_at(pos)? {
                    InlineObject::Shape {
                        fill,
                        stroke,
                        stroke_width,
                        float,
                        w,
                        h,
                        ..
                    } => Some(ShapeView {
                        fill: fill.map(|c| c.hex()),
                        outline: stroke.map(|c| c.hex()),
                        outline_width: *stroke_width,
                        rotation: float.rot,
                        flip_h: float.flip_h,
                        flip_v: float.flip_v,
                        width_pt: *w,
                        height_pt: *h,
                    }),
                    InlineObject::Group {
                        w,
                        h,
                        float,
                        ..
                    } => Some(ShapeView {
                        fill: None,
                        outline: None,
                        outline_width: 0.0,
                        rotation: float.rot,
                        flip_h: float.flip_h,
                        flip_v: float.flip_v,
                        width_pt: *w,
                        height_pt: *h,
                    }),
                    _ => None,
                },
                drawing_ml_paths: self.drawingml_paths(pos),
                group_children: self.editable_group_children(pos),
            })
        });
        if object.is_none() {
            self.selected_object = None;
        }
        let caret = layout.caret_on(&sel.focus, hint).filter(|_| object.is_none()).map(|c| CaretView {
            page: c.page,
            x: c.x,
            y: c.top,
            height: c.height.max(c.width),
        });
        let collapsed = sel.is_collapsed();
        let selection = if object.is_some() {
            Vec::new()
        } else if let Some(range) = self.session.cell_range() {
            wordcraft_engine::cmd::table_mouse::cell_rects(&layout, &self.session.doc, range)
                .into_iter()
                .take(MAX_SELECTION_RECTS)
                .map(|(page, r)| RectView {
                    page,
                    x: r.x,
                    y: r.y,
                    width: r.w,
                    height: r.h,
                })
                .collect()
        } else if collapsed {
            Vec::new()
        } else {
            layout
                .selection_rects(&self.session.doc, &sel.anchor, &sel.focus, hint)
                .into_iter()
                .take(MAX_SELECTION_RECTS)
                .map(|(page, r)| RectView {
                    page,
                    x: r.x,
                    y: r.y,
                    width: r.w,
                    height: r.h,
                })
                .collect()
        };
        let history = HistoryView {
            undo: self.session.can_undo() && !self.session.step_lifts_protection(false),
            redo: self.session.can_redo() && !self.session.step_lifts_protection(true),
        };
        // Search counting runs WordCraft's (pure) search: before reading the selection-dependent state.
        let search = self.search_view();
        let state = wordcraft_engine::cmd::format::state(&self.session);
        let flag = |key: &str| state.get(key).and_then(Value::as_bool).unwrap_or(false);
        let text = |key: &str| state.get(key).and_then(Value::as_str).map(str::to_owned);
        let format = FormatView {
            bold: flag("bold"),
            italic: flag("italic"),
            underline: flag("underline"),
            strikethrough: flag("strike"),
            font: text("font"),
            font_east_asia: text("fontEastAsia"),
        };
        let paragraph = self.session.doc.para_at(&sel.focus);
        let caret_offset = paragraph
            .and_then(|para| para.text.get(..sel.focus.off))
            .map_or(0, |head| head.chars().count());
        DocxView {
            tracked_read_only: TRACKED_READ_ONLY && self.session.doc.settings.track_changes,
            tracking: self.session.doc.settings.track_changes,
            has_revisions: self.has_revisions(),
            has_toc: self.has_toc(),
            image_insertion_allowed: self.image_insertion_allowed(),
            drawing_insertion_allowed: object.is_none() && self.drawing_insertion_allowed(),
            text_box_editing: object.is_none() && self.editing_text_box().is_some(),
            bullets: sel.is_collapsed().then(|| {
                self.session.doc.para_at(&sel.focus).is_some_and(|p| {
                    let props = self.session.doc.styles.resolve_para(&p.props);
                    wordcraft_engine::cmd::para::list_buttons(&self.session.doc, props.numbering)
                        .bullets
                })
            }),
            pages: layout
                .pages
                .iter()
                .map(|p| PageSize {
                    width: p.w,
                    height: p.h,
                })
                .collect(),
            caret,
            selection,
            clipboard_text_available: object.is_none() && self.clipboard_text().is_some(),
            clipboard_table_cells_available: object.is_none() && self.has_clipboard_table_cells(),
            collapsed,
            in_table: object.is_none() && sel.focus.path.cell().is_some(),
            caret_key: position_key(&sel.focus),
            anchor_key: position_key(&sel.anchor),
            paragraph_text: paragraph.map(|para| para.plain_text()).unwrap_or_default(),
            selection_text: if object.is_none()
                && sel.anchor.story == sel.focus.story
                && sel.anchor.path == sel.focus.path
                && sel.anchor != sel.focus
            {
                paragraph.and_then(|para| {
                    let (a, b) = (
                        sel.anchor.off.min(sel.focus.off),
                        sel.anchor.off.max(sel.focus.off),
                    );
                    para.text
                        .get(a..b)
                        .map(|text| text.chars().take(500).collect::<String>())
                        .filter(|text| !text.contains('\u{fffc}'))
                })
            } else {
                None
            },
            paragraph_style: state
                .get("styleName")
                .and_then(Value::as_str)
                .map(str::to_owned),
            caret_offset,
            history,
            format,
            format_access: FormatAccess::of(&self.session),
            font_generation: self.font_generation,
            chars: DocxModel::char_view(&state),
            paragraph: self.paragraph_view(),
            page: self.page_view(),
            search,
            embedded_fonts: embed_font::embedded(&self.session.doc),
            table: if object.is_none() { self.table_view() } else { None },
            object,
        }
    }

    /// 시험용: WordCraft 명령을 그대로 실행한다(보호 설정 등 시험 준비, IPC로는 열지 않음).
    #[cfg(test)]
    pub fn run_engine(&mut self, id: &str, params: Value) -> bool {
        self.session.run(id, &params).is_ok()
    }

    /// 쪽 하나를 `scale`(pt당 픽셀)로 그린 래스터. 쪽이 없거나 배율·픽셀 예산 밖이면 `None`.
    fn rasterize(&mut self, page: usize, scale: f32) -> Option<Rendered> {
        if !(MIN_RENDER_SCALE..=MAX_RENDER_SCALE).contains(&scale) {
            return None;
        }
        self.sync_fonts();
        let layout = self.session.layout();
        let size = layout.pages.get(page)?;
        let pixels = (f64::from(size.w) * f64::from(scale)).ceil()
            * (f64::from(size.h) * f64::from(scale)).ceil();
        if pixels > MAX_RENDER_PIXELS {
            return None;
        }
        Some(render_page(
            &self.session.doc,
            size,
            scale,
            &RenderOptions::default(),
        ))
    }

    /// 쪽 하나를 `scale`로 그린 PNG(쪽 전체). 쪽이 없거나 배율·픽셀 예산 밖이면 `None`.
    pub fn render_png(&mut self, page: usize, scale: f32) -> Option<Vec<u8>> {
        let png = self.rasterize(page, scale)?.to_png();
        (!png.is_empty()).then_some(png)
    }

    /// 판 `revision`의 쪽 그림. 받는 쪽이 판 `base`의 같은 배율 그림을 이미 가지고 있고 그 래스터를 기억하면, 그것과 다른 줄의
    /// 띠만 PNG로 준다(키 하나에 쪽 전체를 인코딩·디코딩·다시 합성하지 않음). 아니면 쪽 전체.
    pub fn render_page(
        &mut self,
        page: usize,
        scale: f32,
        revision: u64,
        base: Option<u64>,
    ) -> Option<PageRender> {
        self.sync_fonts();
        let image = self.rasterize(page, scale)?;
        let key = scale.to_bits();
        let previous = self
            .rasters
            .iter()
            .position(|r| r.page == page && r.scale == key)
            .map(|index| self.rasters.remove(index));
        let band = previous
            .filter(|p| Some(p.revision) == base)
            .filter(|p| p.image.width == image.width && p.image.height == image.height)
            .map(|p| changed_rows(&p.image, &image));
        let out = match band {
            Some(None) => PageRender {
                base,
                y: 0,
                height: 0,
                png: Vec::new(),
            },
            Some(Some((y, height))) => {
                let row = image.width as usize * 4;
                let start = y as usize * row;
                let pixels = image
                    .pixels
                    .get(start..start + height as usize * row)?
                    .to_vec();
                let png = Rendered {
                    width: image.width,
                    height,
                    pixels,
                }
                .to_png();
                PageRender {
                    base,
                    y,
                    height,
                    png,
                }
            }
            None => PageRender {
                base: None,
                y: 0,
                height: image.height,
                png: image.to_png(),
            },
        };
        if out.height > 0 && out.png.is_empty() {
            return None;
        }
        self.rasters.insert(
            0,
            Raster {
                page,
                scale: key,
                revision,
                image,
            },
        );
        self.rasters.truncate(MAX_RASTERS);
        Some(out)
    }

    /// Test-only semantic model inspection for round-trip diagnosis; never IPC.
    #[cfg(test)]
    pub(crate) fn diagnostic_document(&self) -> &wordcraft_engine::doc::Document {
        &self.session.doc
    }

    /// Test-only: corrupt the authoritative model (fail-closed acceptance). Never IPC.
    #[cfg(test)]
    pub(crate) fn diagnostic_document_mut(&mut self) -> &mut wordcraft_engine::doc::Document {
        &mut self.session.doc
    }

    /// PDF of the current model through WordCraft's own writer (`Session::print_pdf`, krilla): the engine's
    /// print layout of every page, without comment balloons, as vector pages with embedded, subsetted fonts
    /// (selectable text). Returns the bytes and the page count. Never changes the model, selection, history
    /// or revision. `None` on an engine refusal (the message is dropped: it may contain document text).
    pub fn export_pdf(&self) -> Option<(Vec<u8>, usize)> {
        let (bytes, plan) = self.session.print_pdf(&json!({ "markup": false })).ok()?;
        (plan.copies == 1 && plan.pages.len() == plan.chosen && !plan.pages.is_empty())
            .then_some((bytes, plan.chosen))
    }

    /// Stage 1 F: embed a face's font program (one undo step). The face must be an exact family/style of the
    /// shared font database whose license permits editable embedding (installable/editable `fsType`) with
    /// TrueType outlines, and its style must have a DOCX slot. The changed model must write and reopen to an
    /// equal model through WordCraft (the T009 save contract) before it replaces the current one, so success is
    /// never reported for a resource the writer would drop. `Ok(false)`: exactly this font is already embedded.
    fn embed_font(&mut self, family: &str, style: &str) -> Result<bool, Rejected> {
        use crate::fonts::embedding;
        let slot = embedding::docx_slot(style).ok_or(Rejected)?;
        let candidate = embedding::candidate(family.trim(), style).map_err(|_| Rejected)?;
        embedding::embeddable(&candidate.program).map_err(|_| Rejected)?;
        let mut doc = self.session.doc.clone();
        match embed_font::embed(&mut doc, family.trim(), slot, &candidate.bytes) {
            Ok(false) => return Ok(false),
            Ok(true) => {}
            Err(_) => return Err(Rejected),
        }
        let bytes = io::save_bytes(DOCX_NAME, &doc).map_err(|_| Rejected)?;
        let reopened = io::open_bytes(DOCX_NAME, &bytes).map_err(|_| Rejected)?;
        if !matches!(wordcraft_engine::doc::roundtrip::roundtrip_equivalent(&doc, &reopened), Ok(true))
            || !embed_font::embedded(&reopened)
                .iter()
                .any(|e| e.family == family.trim() && e.slot == slot && e.part.is_some())
        {
            return Err(Rejected);
        }
        self.session.checkpoint("Embed Font");
        self.session.doc = doc;
        self.session.touch();
        self.last_insert = None;
        Ok(true)
    }

    /// 지금 모델을 DOCX 바이트로 내보낸다(메모리 안, T009 저장의 출력). 실패하면 `None`(엔진 메시지는 버린다).
    pub fn export(&self) -> Option<Vec<u8>> {
        io::save_bytes(DOCX_NAME, &self.session.doc).ok()
    }

    /// 다른 바이트(저장 출력)를 다시 읽은 문서 모델이 지금 모델과 의미상 같은지(T009 저장 검증). WordCraft
    /// `roundtrip_equivalent`(감사한 `90b1877`)로 비교한다: 내부 Part ID 순열만 허용하고, 내용·종류·별칭·순환 참조가
    /// 다르면(`Ok(false)`) 또는 증명할 수 없으면(`Err`: 끊긴·종류가 맞지 않는·닿지 않는 참조, 한도 초과) false다.
    /// 읽지 못해도 false. `Document::PartialEq`(실행 취소 등)는 바꾸지 않는다.
    pub fn same_as(&self, bytes: &[u8]) -> bool {
        io::open_bytes(DOCX_NAME, bytes).is_ok_and(|reopened| {
            matches!(
                wordcraft_engine::doc::roundtrip::roundtrip_equivalent(
                    &self.session.doc,
                    &reopened
                ),
                Ok(true)
            )
        })
    }

    /// 지금 모델을 DOCX로 내보내 다시 읽고 비교한다(메모리 안, 디스크에 쓰지 않음). 내보내기·다시 읽기가 실패하면 `None`.
    pub fn round_trip(&mut self) -> Option<RoundTrip> {
        let bytes = io::save_bytes(DOCX_NAME, &self.session.doc).ok()?;
        let reopened = io::open_bytes(DOCX_NAME, &bytes).ok()?;
        let mut session = Session::new(reopened);
        let pages = self.session.layout().pages.len();
        let reopened_pages = session.layout().pages.len();
        let text_equal =
            session.doc.plain_text(StoryRef::Body) == self.session.doc.plain_text(StoryRef::Body);
        let model_equal = session.doc == self.session.doc;
        let pages_equal = pages == reopened_pages;
        Some(RoundTrip {
            bytes: bytes.len(),
            pages,
            reopened_pages,
            pages_equal,
            text_equal,
            model_equal,
            passed: pages_equal && text_equal && model_equal,
        })
    }

    /// 시험용: 지금 커서 문단의 글자와 커서 오프셋(바이트).
    #[cfg(test)]
    pub fn caret_paragraph(&self) -> (String, usize) {
        let focus = &self.session.sel.focus;
        let text = self
            .session
            .doc
            .para_at(focus)
            .map(|p| p.text.clone())
            .unwrap_or_default();
        (text, focus.off)
    }

    /// 시험용: 쪽 래스터(너비, 높이, 픽셀).
    #[cfg(test)]
    pub fn raster(&mut self, page: usize, scale: f32) -> (u32, u32, Vec<u8>) {
        let image = self.rasterize(page, scale).unwrap_or_default();
        (image.width, image.height, image.pixels)
    }

    /// 시험용: 메모(작성자, 메모 글, 완료 표시) 목록.
    #[cfg(test)]
    pub fn comments(&self) -> Vec<(String, String, bool)> {
        self.session
            .doc
            .comments
            .values()
            .map(|c| {
                (
                    c.author.clone(),
                    self.session.doc.plain_text(StoryRef::Part(c.part)),
                    c.resolved,
                )
            })
            .collect()
    }

    /// 시험용: 본문 전체 글자.
    #[cfg(test)]
    pub fn body_text(&self) -> String {
        self.session.doc.plain_text(StoryRef::Body)
    }

    /// 시험용: 어댑터의 기억(자리 표시 id, 아직 고칠 수 있는 바로 앞 넣기의 글자)과 WordCraft 판·dirty·실행 취소 가능 여부.
    #[cfg(test)]
    pub fn adapter_state(&self) -> (Vec<u32>, Option<String>, u64, bool, bool) {
        (
            self.marks.iter().map(|(id, _)| *id).collect(),
            self.recent_insert().map(|last| last.text.clone()),
            self.session.rev(),
            self.session.dirty,
            self.session.can_undo(),
        )
    }

    /// 시험용: 스냅숏 밖의 WordCraft 편집 보조 상태(세로 이동이 지키는 x, 다음 입력 서식, 쪽 힌트).
    #[cfg(test)]
    pub fn engine_aux(&self) -> (Option<f32>, Option<String>, usize) {
        (
            self.session.goal_x,
            self.session.pending.as_ref().map(|p| format!("{p:?}")),
            self.session.page_hint,
        )
    }

    /// 시험용: 커서 바로 앞 글자의 서식(없으면 빈 글자).
    #[cfg(test)]
    pub fn char_props_before_caret(&self) -> String {
        let focus = &self.session.sel.focus;
        let Some(para) = self.session.doc.para_at(focus) else {
            return String::new();
        };
        let Some(ch) = para
            .text
            .get(..focus.off)
            .and_then(|head| head.chars().last())
        else {
            return String::new();
        };
        format!("{:?}", para.props_of_char(focus.off - ch.len_utf8()))
    }

    /// 시험용: WordCraft 실행 취소·다시 실행(IPC로는 열지 않음, T010).
    #[cfg(test)]
    pub fn undo_redo(&mut self, redo: bool) -> bool {
        let id = if redo { "edit.redo" } else { "edit.undo" };
        self.session.run(id, &json!({})).is_ok()
    }

    /// 시험용: 지금 배치에서 위치의 커서 자리.
    #[cfg(test)]
    pub fn caret_of(&mut self, pos: &Pos) -> Option<CaretView> {
        let layout = self.session.layout();
        layout.caret(pos).map(|c| CaretView {
            page: c.page,
            x: c.x,
            y: c.top,
            height: c.height,
        })
    }

    /// 시험용: 본문 `path` 문단의 `off` 위치.
    #[cfg(test)]
    pub fn body_pos(path: &[u32], off: usize) -> Pos {
        Pos::new(
            StoryRef::Body,
            wordcraft_engine::doc::Path(path.to_vec()),
            off,
        )
    }
}
