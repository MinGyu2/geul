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
use wordcraft_engine::doc::{Pos, StoryRef};
use wordcraft_engine::layout::DocLayout;
use wordcraft_engine::render::{render_page, RenderOptions, Rendered};
use wordcraft_engine::{io, Session};

use crate::document::EngineStage;

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
    DeleteSelection,
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
    },
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
}

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

/// 요청 전체를 실행 전에 검사한다. 하나라도 계약에 맞지 않으면 아무것도 실행하지 않는다.
pub fn validate(ops: &[DocxOp]) -> bool {
    !ops.is_empty()
        && ops.len() <= MAX_OPS
        && ops.iter().all(|op| match op {
            DocxOp::InsertText { text } | DocxOp::InsertAt { text, .. } => valid_text(text),
            // 줄바꿈은 프런트엔드가 `\n` 하나로 맞춘다(`\r`은 거부).
            DocxOp::PasteText { text, .. } => valid_chars(text, &['\n', '\t']),
            DocxOp::ReplaceInserted { expected, text } => valid_text(expected) && valid_text(text),
            DocxOp::Pointer { x, y, .. } => {
                x.is_finite()
                    && y.is_finite()
                    && x.abs() <= MAX_PAGE_SIDE_PT
                    && y.abs() <= MAX_PAGE_SIDE_PT
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

/// 편집 표면이 그리는 데 필요한 것. 문서 모델 자체는 보내지 않는다.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxView {
    pub pages: Vec<PageSize>,
    /// 커서 자리를 배치에서 찾지 못하면(숨은 글자 등) 없다.
    pub caret: Option<CaretView>,
    pub selection: Vec<RectView>,
    /// 선택이 비어 있음(커서만).
    pub collapsed: bool,
    /// 커서가 표 셀 안에 있음(Tab을 셀 이동으로 쓸지).
    pub in_table: bool,
    /// 커서·기준점 자리의 비교용 키(`story:path:off`). 늦게 온 응답·검사용이며 문서 내용이 아니다.
    pub caret_key: String,
    pub anchor_key: String,
    /// 커서 문단의 글자(개체는 그 글자로). 화면에는 검사 훅 빌드에서만 노출한다.
    pub paragraph_text: String,
    /// 커서의 문단 안 위치(문자 단위).
    pub caret_offset: usize,
    /// WordCraft 실행 취소 기록(T010): 되돌릴·다시 할 단계가 있고 그 단계가 문서 보호를 풀지 않음.
    pub history: HistoryView,
    /// 선택(없으면 다음 입력)의 글자 서식(T010, WordCraft `format.state`). 선택 전체가 그 서식일 때 true.
    pub format: FormatView,
    /// 문서 보호가 글자 서식 명령을 허용하는지(T010 안정화, WordCraft `review.restrict` 상태에서). 엔진이 실행할 때 다시 판정한다.
    pub format_access: FormatAccess,
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
    fn of(session: &Session) -> FormatAccess {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FormatView {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
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
    marks: Vec<(u32, Pos)>,
    last_insert: Option<LastInsert>,
    /// 쪽·배율마다 마지막으로 그린 래스터와 그 판(바뀐 띠만 보낼 때 비교 기준). 최근 것부터 MAX_RASTERS개.
    rasters: Vec<Raster>,
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
    /// DOCX 바이트를 읽고 첫 배치를 검사한다. 읽지 못하면 `Parse`, 쪽이 없거나 크기가 이상하면 `Render`.
    pub fn open(bytes: &[u8]) -> Result<DocxModel, EngineStage> {
        let doc = io::open_bytes(DOCX_NAME, bytes).map_err(|_| EngineStage::Parse)?;
        let mut model = DocxModel {
            session: Session::new(doc),
            marks: Vec::new(),
            last_insert: None,
            rasters: Vec::new(),
            #[cfg(test)]
            fail_at: None,
        };
        let layout = model.session.layout();
        let valid = |side: f32| side.is_finite() && side > 0.0 && side <= MAX_PAGE_SIDE_PT;
        if layout.pages.is_empty() || !layout.pages.iter().all(|p| valid(p.w) && valid(p.h)) {
            return Err(EngineStage::Render);
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
    pub fn apply(&mut self, ops: &[DocxOp]) -> EditOutcome {
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
                    outcome.applied += 1;
                    outcome.changed += u64::from(changed);
                }
                Err(Rejected) => outcome.rejected.push(index),
            }
        }
        outcome
    }

    fn apply_one(&mut self, op: &DocxOp) -> Result<bool, Rejected> {
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
            DocxOp::DeleteSelection => {
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
            DocxOp::SelectAll => self.run("select.all", json!({})),
            DocxOp::Pointer {
                page,
                x,
                y,
                extend,
                before_insert,
            } => {
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
        }
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

    pub fn view(&mut self) -> DocxView {
        let layout = self.session.layout();
        let hint = self.session.page_hint;
        let sel = self.session.sel.clone();
        let caret = layout.caret_on(&sel.focus, hint).map(|c| CaretView {
            page: c.page,
            x: c.x,
            y: c.top,
            height: c.height.max(c.width),
        });
        let collapsed = sel.is_collapsed();
        let selection = if collapsed {
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
        let state = wordcraft_engine::cmd::format::state(&self.session);
        let flag = |key: &str| state.get(key).and_then(Value::as_bool).unwrap_or(false);
        let format = FormatView {
            bold: flag("bold"),
            italic: flag("italic"),
            underline: flag("underline"),
            strikethrough: flag("strike"),
        };
        let paragraph = self.session.doc.para_at(&sel.focus);
        let caret_offset = paragraph
            .and_then(|para| para.text.get(..sel.focus.off))
            .map_or(0, |head| head.chars().count());
        DocxView {
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
            collapsed,
            in_table: sel.focus.path.cell().is_some(),
            caret_key: position_key(&sel.focus),
            anchor_key: position_key(&sel.anchor),
            paragraph_text: paragraph.map(|para| para.plain_text()).unwrap_or_default(),
            caret_offset,
            history,
            format,
            format_access: FormatAccess::of(&self.session),
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

    /// 지금 모델을 DOCX 바이트로 내보낸다(메모리 안, T009 저장의 출력). 실패하면 `None`(엔진 메시지는 버린다).
    pub fn export(&self) -> Option<Vec<u8>> {
        io::save_bytes(DOCX_NAME, &self.session.doc).ok()
    }

    /// 다른 바이트(저장 출력)를 다시 읽은 문서 모델이 지금 모델과 같은지(T009 저장 검증). 읽지 못하면 false.
    pub fn same_as(&self, bytes: &[u8]) -> bool {
        io::open_bytes(DOCX_NAME, bytes).is_ok_and(|doc| doc == self.session.doc)
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
