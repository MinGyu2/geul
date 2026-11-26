//! T008 WordCraft 어댑터 시험. 픽스처는 실행할 때 엔진 명령으로 만든다(tests/fixtures/wordcraft/basic.rs).

pub(crate) mod basic {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/wordcraft/basic.rs"
    ));
}

use std::future::Future;
use std::pin::Pin;
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

use serde_json::json;

use super::commands::{self, DocxState, FULL_PAGE, RENDER_HEADER_LEN};
use super::engine::{validate, DocxModel, DocxOp, MoveTarget, MAX_OPS, MAX_TEXT_CHARS};
use crate::document::commands::DocumentState;
use crate::document::testutil::{docx_entries, entry, hwpx, zip, TempDir};
use crate::document::{
    identify, DocumentError, Engine, EngineStage, Limits, SessionId, SessionInfo, SessionState,
};

fn fixture() -> Vec<u8> {
    basic::basic_ko().expect("픽스처 생성")
}

fn model() -> DocxModel {
    DocxModel::open(&fixture()).expect("픽스처 열기")
}

fn insert(text: &str) -> DocxOp {
    DocxOp::InsertText { text: text.into() }
}

fn mv(to: MoveTarget, extend: bool) -> DocxOp {
    DocxOp::Move { to, extend }
}

fn pointer(page: u32, x: f32, y: f32) -> DocxOp {
    DocxOp::Pointer {
        page,
        x,
        y,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: false,
    }
}

/// 본문 `path` 문단의 `chars`번째 글자 경계(바이트 오프셋).
fn byte_at(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map_or(text.len(), |(at, _)| at)
}

// ---- 엔진 모델 ----

#[test]
fn 픽스처를_열면_쪽과_커서와_문단을_보인다() {
    let mut m = model();
    let view = m.view();
    assert!(!view.pages.is_empty());
    assert!(view.pages.iter().all(|p| p.width > 0.0 && p.height > 0.0));
    let caret = view.caret.expect("커서");
    assert_eq!(caret.page, 0);
    assert!(caret.height > 0.0);
    assert!(view.collapsed && view.selection.is_empty());
    assert_eq!(view.paragraph_text, basic::PARAGRAPHS[0]);
    assert_eq!(
        (view.caret_offset, view.caret_key.as_str()),
        (0, "body:0:0")
    );
    assert!(!view.in_table);
}

#[test]
fn 확정한_한글은_그대로_한_번씩_들어가고_연산마다_변경_하나다() {
    let mut m = model();
    // 입력기가 음절·공백마다 확정하는 순서 그대로("한글 입력 테스트").
    let syllables = ["한", "글", " ", "입", "력", " ", "테", "스", "트"];
    let ops: Vec<DocxOp> = syllables.iter().map(|s| insert(s)).collect();
    let outcome = m.apply(&ops);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (9, 9, vec![])
    );
    let view = m.view();
    assert_eq!(
        view.paragraph_text,
        format!("한글 입력 테스트{}", basic::PARAGRAPHS[0])
    );
    assert_eq!(view.caret_offset, 9);
    // 자동 고침·자동 서식을 쓰지 않는다(raw): 같은 음절을 이어 넣어도 그대로 남는다.
    let outcome = m.apply(&[insert("하"), insert("하"), insert(".")]);
    assert_eq!(outcome.changed, 3);
    assert!(m.view().paragraph_text.starts_with("한글 입력 테스트하하."));
}

#[test]
fn 문서를_바꾸지_않은_바꾸는_명령은_세지_않는다() {
    let mut m = model();
    // 문서 처음의 Backspace, 끝의 Delete: WordCraft rev()는 늘지만 문서는 그대로다.
    let outcome = m.apply(&[
        DocxOp::Backspace,
        mv(MoveTarget::DocEnd, false),
        DocxOp::DeleteForward,
    ]);
    assert_eq!((outcome.applied, outcome.changed), (3, 0));
    // 표 셀 사이 Tab은 이동만, 마지막 셀의 Tab은 행을 더한다(Word와 같음).
    let cell = DocxModel::body_pos(&[basic::TABLE_BLOCK, 0, 0, 0], 0);
    let c = m.caret_of(&cell).unwrap();
    assert_eq!(
        m.apply(&[pointer(c.page as u32, c.x + 1.0, c.y + c.height / 2.0)])
            .changed,
        0
    );
    let view = m.view();
    assert!(view.in_table);
    let tabs = m.apply(&[
        DocxOp::Tab { back: false },
        DocxOp::Tab { back: false },
        DocxOp::Tab { back: true },
    ]);
    assert_eq!((tabs.applied, tabs.changed), (3, 0));
    assert_eq!(
        m.view().caret_key,
        format!("body:{}.0.1.0:0", basic::TABLE_BLOCK)
    );
    // (0,1) → (1,0) → (1,1)은 이동, 그다음 Tab은 마지막 셀을 넘어 행을 더한다.
    let last = m.apply(&[
        DocxOp::Tab { back: false },
        DocxOp::Tab { back: false },
        DocxOp::Tab { back: false },
    ]);
    assert_eq!(
        (last.applied, last.changed),
        (3, 1),
        "마지막 셀의 Tab만 행 추가(변경)"
    );
    assert_eq!(
        m.view().caret_key,
        format!("body:{}.2.0.0:0", basic::TABLE_BLOCK)
    );
}

#[test]
fn 키보드_이동과_선택과_지우기와_문단_나누기() {
    let mut m = model();
    let p0 = basic::PARAGRAPHS[0];
    m.apply(&[mv(MoveTarget::LineEnd, false)]);
    assert_eq!(m.view().caret_offset, p0.chars().count());
    m.apply(&[
        mv(MoveTarget::LineStart, false),
        mv(MoveTarget::Right, false),
        mv(MoveTarget::Right, false),
    ]);
    assert_eq!(m.view().caret_offset, 2);
    // Shift+→ 세 번: 선택 사각형이 생기고, Backspace는 선택만 지운다.
    m.apply(&[
        mv(MoveTarget::Right, true),
        mv(MoveTarget::Right, true),
        mv(MoveTarget::Right, true),
    ]);
    let view = m.view();
    assert!(!view.collapsed && !view.selection.is_empty());
    assert_eq!(view.anchor_key, format!("body:0:{}", byte_at(p0, 2)));
    let outcome = m.apply(&[DocxOp::Backspace]);
    assert_eq!(outcome.changed, 1);
    let expected: String = p0.chars().take(2).chain(p0.chars().skip(5)).collect();
    assert_eq!(m.view().paragraph_text, expected);
    // Enter는 문단을 나누고 커서를 새 문단 처음으로, 그 자리의 Backspace는 다시 합친다.
    m.apply(&[DocxOp::NewParagraph]);
    let view = m.view();
    assert_eq!(
        (view.caret_key.as_str(), view.caret_offset),
        ("body:1:0", 0)
    );
    m.apply(&[DocxOp::Backspace]);
    assert_eq!(m.view().paragraph_text, expected);
    // ↓·↑는 줄을 오간다. Delete는 커서 뒤 글자를 지운다.
    m.apply(&[mv(MoveTarget::Down, false)]);
    assert_eq!(m.view().paragraph_text, basic::PARAGRAPHS[1]);
    m.apply(&[
        mv(MoveTarget::Up, false),
        mv(MoveTarget::DocStart, false),
        DocxOp::DeleteForward,
    ]);
    assert_eq!(
        m.view().paragraph_text,
        expected.chars().skip(1).collect::<String>()
    );
    // 전체 선택.
    m.apply(&[DocxOp::SelectAll]);
    assert!(!m.view().collapsed);
}

#[test]
fn 클릭한_글자_경계_사이_30과_70퍼센트에서_가까운_경계에_커서() {
    let mut m = model();
    let cases: Vec<(Vec<u32>, &str)> = vec![
        (vec![0], basic::PARAGRAPHS[0]),
        (vec![basic::TABLE_BLOCK, 0, 0, 0], basic::CELLS[0]),
        (vec![basic::TABLE_BLOCK, 1, 0, 0], basic::CELLS[2]),
    ];
    let mut clicks = 0;
    for (path, text) in cases {
        let chars = text.chars().count().min(12);
        for k in 0..chars {
            let left = m
                .caret_of(&DocxModel::body_pos(&path, byte_at(text, k)))
                .unwrap();
            let right = m
                .caret_of(&DocxModel::body_pos(&path, byte_at(text, k + 1)))
                .unwrap();
            if right.y != left.y {
                continue; // 줄이 바뀌는 경계
            }
            for (fraction, expected) in [(0.3, k), (0.7, k + 1)] {
                let x = left.x + (right.x - left.x) * fraction;
                m.apply(&[pointer(left.page as u32, x, left.y + left.height / 2.0)]);
                let view = m.view();
                let want = format!(
                    "body:{}:{}",
                    path.iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join("."),
                    byte_at(text, expected)
                );
                assert_eq!(view.caret_key, want, "{text:?} {k} {fraction}");
                clicks += 1;
            }
        }
    }
    assert!(clicks >= 30, "클릭 {clicks}회");
    // 끌기(extend)는 선택을 만든다.
    let start = m.caret_of(&DocxModel::body_pos(&[0], 0)).unwrap();
    let end = m
        .caret_of(&DocxModel::body_pos(&[0], byte_at(basic::PARAGRAPHS[0], 4)))
        .unwrap();
    m.apply(&[
        pointer(0, start.x + 0.5, start.y + start.height / 2.0),
        DocxOp::Pointer {
            page: 0,
            x: end.x,
            y: end.y + end.height / 2.0,
            extend: true,
            before_insert: false,
            drag: false,
            select_object: false,
        },
    ]);
    let view = m.view();
    assert_eq!(
        (view.anchor_key.as_str(), view.caret_offset),
        ("body:0:0", 4)
    );
    assert!(!view.selection.is_empty());
}

#[test]
fn 조합_중_클릭은_넣기_전_화면의_좌표로_자리를_찾는다() {
    let mut m = model();
    let p0 = basic::PARAGRAPHS[0];
    // 화면에 보이던 배치에서 5번째 글자 앞을 누른다. 그 전에 앱이 커서(처음)에 조합 글자 "한"을 확정한다.
    let target = m
        .caret_of(&DocxModel::body_pos(&[0], byte_at(p0, 5)))
        .unwrap();
    let outcome = m.apply(&[
        insert("한"),
        DocxOp::Pointer {
            page: 0,
            x: target.x,
            y: target.y + target.height / 2.0,
            extend: false,
            before_insert: true,
            drag: false,
            select_object: false,
        },
    ]);
    assert_eq!((outcome.applied, outcome.changed), (2, 1));
    let view = m.view();
    assert_eq!(view.paragraph_text, format!("한{p0}"));
    // 누른 글자(원래 5번째 앞)는 이제 6번째 앞이다.
    assert_eq!(view.caret_offset, 6);
    // 바로 앞이 넣기가 아니면(그 뒤 문서 변경) 지금 배치로 찾는다.
    let mut other = model();
    let target = other
        .caret_of(&DocxModel::body_pos(&[0], byte_at(p0, 5)))
        .unwrap();
    other.apply(&[insert("한"), DocxOp::Backspace]);
    other.apply(&[DocxOp::Pointer {
        page: 0,
        x: target.x,
        y: target.y + target.height / 2.0,
        extend: false,
        before_insert: true,
        drag: false,
        select_object: false,
    }]);
    assert_eq!(other.view().caret_offset, 5);
}

#[test]
fn 기억한_자리에_늦은_확정을_넣고_커서는_밀린다() {
    let mut m = model();
    let p0 = basic::PARAGRAPHS[0];
    // 커서를 2번째 글자 뒤에 두고 기억(클릭 직전) → 같은 문단 8번째로 클릭 → 늦게 온 확정 "글".
    m.apply(&[
        mv(MoveTarget::Right, false),
        mv(MoveTarget::Right, false),
        DocxOp::Mark { id: 7 },
    ]);
    let target = m
        .caret_of(&DocxModel::body_pos(&[0], byte_at(p0, 8)))
        .unwrap();
    m.apply(&[pointer(0, target.x, target.y + target.height / 2.0)]);
    let outcome = m.apply(&[DocxOp::InsertAt {
        mark: 7,
        text: "글".into(),
    }]);
    assert_eq!(outcome.changed, 1);
    let view = m.view();
    let expected: String = p0
        .chars()
        .take(2)
        .chain("글".chars())
        .chain(p0.chars().skip(2))
        .collect();
    assert_eq!(view.paragraph_text, expected);
    assert_eq!(
        view.caret_offset, 9,
        "클릭한 자리(8)가 넣은 한 글자만큼 밀림"
    );
    // 기억은 한 번만 쓴다.
    assert_eq!(
        m.apply(&[DocxOp::InsertAt {
            mark: 7,
            text: "x".into()
        }])
        .rejected,
        vec![0]
    );
    // 다른 문단의 커서는 밀지 않는다.
    m.apply(&[DocxOp::Mark { id: 8 }, mv(MoveTarget::Down, false)]);
    let before = m.view().caret_key;
    m.apply(&[DocxOp::InsertAt {
        mark: 8,
        text: "!".into(),
    }]);
    assert_eq!(m.view().caret_key, before);
}

#[test]
fn 앱이_먼저_확정한_조합은_입력기의_최종_글자로_고친다() {
    let mut m = model();
    let p0 = basic::PARAGRAPHS[0];
    let target = m
        .caret_of(&DocxModel::body_pos(&[0], byte_at(p0, 5)))
        .unwrap();
    m.apply(&[
        insert("하"),
        DocxOp::Pointer {
            page: 0,
            x: target.x,
            y: target.y + target.height / 2.0,
            extend: false,
            before_insert: true,
            drag: false,
            select_object: false,
        },
    ]);
    assert_eq!(m.view().caret_offset, 6);
    let outcome = m.apply(&[DocxOp::ReplaceInserted {
        expected: "하".into(),
        text: "한".into(),
    }]);
    assert_eq!((outcome.changed, outcome.rejected), (1, vec![]));
    let view = m.view();
    assert_eq!(view.paragraph_text, format!("한{p0}"));
    assert_eq!(
        view.caret_offset, 6,
        "같은 길이로 고치면 클릭한 자리 그대로"
    );
    // 한 번 고친 뒤나, 넣은 글자가 다르면 거부한다(문서 그대로).
    assert_eq!(
        m.apply(&[DocxOp::ReplaceInserted {
            expected: "한".into(),
            text: "할".into()
        }])
        .rejected,
        vec![0]
    );
    let mut other = model();
    other.apply(&[insert("가")]);
    assert_eq!(
        other
            .apply(&[DocxOp::ReplaceInserted {
                expected: "나".into(),
                text: "다".into()
            }])
            .rejected,
        vec![0]
    );
    // 그 뒤 문서를 바꾸는 연산이 있었으면 거부한다.
    other.apply(&[insert("나")]);
    other.apply(&[DocxOp::Backspace]);
    assert_eq!(
        other
            .apply(&[DocxOp::ReplaceInserted {
                expected: "나".into(),
                text: "다".into()
            }])
            .rejected,
        vec![0]
    );
    assert!(other.view().paragraph_text.starts_with("가한글"));
}

#[test]
fn 엔진이_거부한_연산만_없던_일이_되고_나머지는_실행한다() {
    let mut m = model();
    let outcome = m.apply(&[
        insert("가"),
        DocxOp::InsertAt {
            mark: 99,
            text: "x".into(),
        },
        insert("나"),
    ]);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (2, 2, vec![1])
    );
    assert!(m.view().paragraph_text.starts_with("가나한글"));
    // 없는 쪽 클릭은 엔진이 거부한다.
    assert_eq!(m.apply(&[pointer(50, 10.0, 10.0)]).rejected, vec![0]);
}

#[test]
fn 계약_밖의_요청은_실행_전에_거부한다() {
    assert!(!validate(&[]));
    assert!(!validate(&vec![DocxOp::Backspace; MAX_OPS + 1]));
    assert!(validate(&vec![DocxOp::Backspace; MAX_OPS]));
    for bad in ["", "a\nb", "\t", "\u{7}", "\u{FFFC}"] {
        assert!(!validate(&[insert(bad)]), "{bad:?}");
        assert!(
            !validate(&[DocxOp::InsertAt {
                mark: 1,
                text: bad.into()
            }]),
            "{bad:?}"
        );
    }
    assert!(!validate(&[insert(&"가".repeat(MAX_TEXT_CHARS + 1))]));
    assert!(validate(&[insert(&"가".repeat(MAX_TEXT_CHARS))]));
    assert!(!validate(&[DocxOp::ReplaceInserted {
        expected: "".into(),
        text: "a".into()
    }]));
    assert!(!validate(&[pointer(0, f32::NAN, 1.0)]));
    assert!(!validate(&[pointer(0, 1.0, f32::INFINITY)]));
    assert!(!validate(&[pointer(0, 1e9, 1.0)]));
    // IPC 모양: 알 수 없는 연산·필드는 역직렬화에서 거부한다(임의 WordCraft 명령을 보낼 수 없음).
    let parse = |value: serde_json::Value| serde_json::from_value::<Vec<DocxOp>>(value);
    assert_eq!(
        parse(json!([{"op": "insertText", "text": "가"}, {"op": "move", "to": "lineEnd", "extend": true},
                     {"op": "pointer", "page": 0, "x": 1.5, "y": 2.0, "beforeInsert": true}, {"op": "tab"}]))
        .unwrap(),
        vec![
            insert("가"),
            mv(MoveTarget::LineEnd, true),
            DocxOp::Pointer { page: 0, x: 1.5, y: 2.0, extend: false, before_insert: true, drag: false, select_object: false },
            DocxOp::Tab { back: false },
        ]
    );
    assert!(
        parse(json!([{"op": "run", "id": "file.saveAs", "params": {"path": "/tmp/x.docx"}}]))
            .is_err()
    );
    assert!(parse(json!([{"op": "insertText", "text": "가", "raw": false}])).is_err());
    assert!(parse(json!([{"op": "move", "to": "pageDown"}])).is_err());
}

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let be = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]);
    (be(16), be(20))
}

#[test]
fn 쪽을_배율대로_png로_그리고_예산_밖은_거부한다() {
    let mut m = model();
    let page = m.view().pages[0];
    for scale in [1.0f32, 96.0 / 72.0, 2.0 * 96.0 / 72.0] {
        let png = m.render_png(0, scale).expect("그림");
        assert_eq!(
            png_size(&png),
            (
                (page.width * scale).ceil() as u32,
                (page.height * scale).ceil() as u32
            )
        );
    }
    assert!(m.render_png(1, 1.0).is_none(), "없는 쪽");
    assert!(m.render_png(0, 0.0).is_none());
    assert!(m.render_png(0, f32::NAN).is_none());
    assert!(m.render_png(0, 9.0).is_none(), "64 MiB 예산 밖");
}

#[test]
fn 편집한_모델을_메모리에서_내보내고_다시_읽으면_같다() {
    let mut m = model();
    m.apply(&[insert("한글 입력"), DocxOp::NewParagraph, insert("둘째")]);
    let result = m.round_trip().expect("왕복");
    assert!(result.passed, "{result:?}");
    assert!(result.bytes > 0 && result.pages >= 1);
    assert!(m.body_text().contains("한글 입력"));
}

#[test]
fn 읽지_못하는_바이트는_parse_실패() {
    assert!(matches!(
        DocxModel::open(b"not a docx"),
        Err(EngineStage::Parse)
    ));
    let mut cut = fixture();
    cut.truncate(cut.len() / 2);
    assert!(matches!(DocxModel::open(&cut), Err(EngineStage::Parse)));
}

#[test]
fn 커서_문단_시험_도우미는_바이트_오프셋을_준다() {
    let mut m = model();
    m.apply(&[insert("가")]);
    assert_eq!(m.caret_paragraph().1, "가".len());
}

// ---- 명령(세션 기록과 함께) ----

fn register(state: &DocumentState, dir: &TempDir, name: &str, bytes: &[u8]) -> SessionInfo {
    let path = dir.write(name, bytes);
    let file = identify(path.to_str().unwrap(), &Limits::default()).unwrap();
    state.registry().register(file).unwrap()
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn loaded(state: &DocumentState, dir: &TempDir) -> DocxState {
    let info = register(state, dir, "a.docx", &fixture());
    block_on(commands::load(state, info.session_id, None)).expect("불러오기")
}

#[test]
fn 불러오기는_백엔드_모델을_만들고_ready로_전이한다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let s = &docx.session;
    assert_eq!(
        (s.state, s.revision, s.load_generation, s.dirty),
        (SessionState::Ready, 0, 1, false)
    );
    assert_eq!(s.engine, Engine::Wordcraft);
    assert_eq!(docx.view.paragraph_text, basic::PARAGRAPHS[0]);
    assert_eq!(state.wordcraft().len(), 1);
    // 이미 ready면 다시 불러오지 않는다.
    assert_eq!(
        block_on(commands::load(&state, s.session_id, None)),
        Err(DocumentError::InvalidState {
            session_id: s.session_id,
            state: SessionState::Ready
        })
    );
}

#[test]
fn 프런트엔드_모델_명령은_wordcraft_세션을_거부한다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    assert_eq!(
        state.frontend_model(docx.session.session_id),
        Err(DocumentError::InvalidRequest)
    );
    let rhwp = register(&state, &dir, "b.hwpx", &hwpx());
    assert_eq!(state.frontend_model(rhwp.session_id), Ok(()));
    // 반대로 WordCraft 명령은 rhwp 세션을 받지 않는다.
    assert_eq!(
        block_on(commands::load(&state, rhwp.session_id, None)),
        Err(DocumentError::InvalidRequest)
    );
    assert_eq!(
        block_on(commands::edit(
            &state,
            rhwp.session_id,
            0,
            0,
            vec![insert("가")]
        )),
        Err(DocumentError::InvalidRequest)
    );
}

#[test]
fn 편집은_기준_revision을_확인하고_실제로_바뀐_연산만큼_확정한다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    let ops = vec![
        insert("한"),
        DocxOp::Backspace,
        DocxOp::Backspace,
        insert("글"),
        mv(MoveTarget::Left, false),
    ];
    // 처음의 Backspace 두 번 중 둘째는 문서 처음이라 바뀌지 않는다: 바뀐 연산 3개.
    let edited = block_on(commands::edit(&state, id, 1, 0, ops)).unwrap();
    assert_eq!((edited.applied, edited.rejected), (5, vec![]));
    assert_eq!((edited.session.revision, edited.session.dirty), (3, true));
    assert_eq!(
        edited.view.paragraph_text,
        format!("글{}", basic::PARAGRAPHS[0])
    );
    assert_eq!(
        edited.session.sequence,
        state.registry().get(id).unwrap().sequence
    );
    // 옛 기준은 거부하고 아무것도 실행하지 않는다.
    assert_eq!(
        block_on(commands::edit(&state, id, 1, 0, vec![insert("x")])),
        Err(DocumentError::RevisionMismatch {
            session_id: id,
            revision: 3
        })
    );
    let view = block_on(commands::view(&state, id, 1)).unwrap();
    assert_eq!(view.view.paragraph_text, edited.view.paragraph_text);
    // 이동만 하면 revision은 그대로다.
    let moved = block_on(commands::edit(
        &state,
        id,
        1,
        3,
        vec![mv(MoveTarget::LineEnd, false)],
    ))
    .unwrap();
    assert_eq!(moved.session.revision, 3);
    // 계약 밖 요청·옛 시도 번호.
    assert_eq!(
        block_on(commands::edit(&state, id, 1, 3, vec![])),
        Err(DocumentError::InvalidRequest)
    );
    assert_eq!(
        block_on(commands::edit(&state, id, 2, 3, vec![insert("x")])),
        Err(DocumentError::StaleLoad {
            session_id: id,
            load_generation: 1
        })
    );
    // 엔진 거부: 앞의 성공만 확정하고 거부 위치를 알린다.
    let partial = block_on(commands::edit(
        &state,
        id,
        1,
        3,
        vec![
            insert("a"),
            DocxOp::InsertAt {
                mark: 5,
                text: "b".into(),
            },
        ],
    ))
    .unwrap();
    assert_eq!(
        (partial.applied, partial.rejected, partial.session.revision),
        (1, vec![1], 4)
    );
}

#[test]
fn 그림은_보는_판의_것만_주고_앞에_revision을_붙인다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    let scale = 96.0 / 72.0;
    let framed = block_on(commands::render(&state, id, 1, 0, 0, scale, None)).unwrap();
    let header = |framed: &[u8]| {
        let u64_at = |at: usize| u64::from_le_bytes(framed[at..at + 8].try_into().unwrap());
        let u32_at = |at: usize| u32::from_le_bytes(framed[at..at + 4].try_into().unwrap());
        (u64_at(0), u64_at(8), u32_at(16), u32_at(20))
    };
    let height = (docx.view.pages[0].height * scale).ceil() as u32;
    assert_eq!(header(&framed), (0, FULL_PAGE, 0, height));
    assert_eq!(
        png_size(&framed[RENDER_HEADER_LEN..]),
        ((docx.view.pages[0].width * scale).ceil() as u32, height)
    );
    block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])).unwrap();
    // 받는 쪽이 판 0 그림을 가지고 있으면 바뀐 띠만(첫 문단 줄 근처).
    let band = block_on(commands::render(&state, id, 1, 1, 0, scale, Some(0))).unwrap();
    let (revision, base, y, rows) = header(&band);
    assert_eq!((revision, base), (1, 0));
    assert!(
        rows > 0 && rows < height / 4 && y > 0,
        "띠 {y}+{rows} / {height}"
    );
    assert_eq!(png_size(&band[RENDER_HEADER_LEN..]).1, rows);
    // 같은 판이면 바뀐 줄 없음(PNG 없음), 기억하지 않는 기준이면 쪽 전체.
    let same = block_on(commands::render(&state, id, 1, 1, 0, scale, Some(1))).unwrap();
    assert_eq!((header(&same).3, same.len()), (0, RENDER_HEADER_LEN));
    let unknown = block_on(commands::render(&state, id, 1, 1, 0, scale, Some(0))).unwrap();
    assert_eq!(header(&unknown).1, FULL_PAGE);
    assert_eq!(
        block_on(commands::render(&state, id, 1, 0, 0, 1.0, None)),
        Err(DocumentError::RevisionMismatch {
            session_id: id,
            revision: 1
        })
    );
    assert_eq!(
        block_on(commands::render(&state, id, 1, 1, 9, 1.0, None)),
        Err(DocumentError::InvalidRequest)
    );
    assert_eq!(
        block_on(commands::render(&state, id, 1, 1, 0, 100.0, None)),
        Err(DocumentError::InvalidRequest)
    );
    let trip = block_on(commands::round_trip(&state, id, 1, 1)).unwrap();
    assert!(trip.result.passed && trip.revision == 1);
    assert!(matches!(
        block_on(commands::round_trip(&state, id, 1, 0)),
        Err(DocumentError::RevisionMismatch { .. })
    ));
}

#[test]
fn 닫으면_모델을_놓고_늦은_요청은_stale_session() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    state.registry().close(id).unwrap();
    state.wordcraft().release(id);
    assert_eq!(state.wordcraft().len(), 0);
    assert_eq!(
        block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])),
        Err(DocumentError::StaleSession { session_id: id })
    );
    assert_eq!(
        block_on(commands::view(&state, id, 1)),
        Err(DocumentError::StaleSession { session_id: id })
    );
}

type LoadFuture<'a> = Pin<Box<dyn Future<Output = Result<DocxState, DocumentError>> + 'a>>;

/// 엔진 읽기를 gate 뒤에서 실행하는 불러오기. 읽기가 시작될 때까지 future를 돌린다.
fn gated_load(state: &DocumentState, id: SessionId) -> (LoadFuture<'_>, mpsc::Sender<()>) {
    let (release, released) = mpsc::channel::<()>();
    let (started, started_rx) = mpsc::channel::<()>();
    let mut load: LoadFuture<'_> = Box::pin(commands::load_with(state, id, move |bytes| {
        started.send(()).unwrap();
        released
            .recv_timeout(Duration::from_secs(20))
            .expect("gate");
        DocxModel::open(bytes)
    }));
    // 파일 읽기(차단 작업)가 끝나 엔진 읽기가 시작될 때까지 돌린다.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        assert!(load
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending());
        if started_rx.try_recv().is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "엔진 읽기가 시작되지 않음"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    (load, release)
}

#[test]
fn 엔진이_읽는_동안_닫은_세션의_모델은_남지_않는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let info = register(&state, &dir, "a.docx", &fixture());
    let (load, release) = gated_load(&state, info.session_id);
    state.registry().close(info.session_id).unwrap();
    state.wordcraft().release(info.session_id);
    release.send(()).unwrap();
    assert_eq!(
        block_on(load),
        Err(DocumentError::StaleSession {
            session_id: info.session_id
        })
    );
    assert_eq!(state.wordcraft().len(), 0);
}

#[test]
fn 엔진이_읽는_동안_버려진_불러오기는_세션을_failed로_돌린다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let info = register(&state, &dir, "a.docx", &fixture());
    let (load, release) = gated_load(&state, info.session_id);
    drop(load);
    release.send(()).unwrap();
    assert_eq!(
        state.registry().get(info.session_id).unwrap().state,
        SessionState::Failed
    );
    // 차단 작업이 끝나도 모델을 넣지 않는다. 다시 불러올 수 있다.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(state.wordcraft().len(), 0);
    let again = block_on(commands::load(&state, info.session_id, None)).unwrap();
    assert_eq!(
        (again.session.state, again.session.load_generation),
        (SessionState::Ready, 2)
    );
}

#[test]
fn 엔진이_못_읽으면_failed와_engine_failure_parse() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let info = register(&state, &dir, "a.docx", &fixture());
    let result = block_on(commands::load_with(&state, info.session_id, |_| {
        Err(EngineStage::Parse)
    }));
    assert_eq!(
        result,
        Err(DocumentError::EngineFailure {
            engine: Engine::Wordcraft,
            stage: EngineStage::Parse
        })
    );
    assert_eq!(
        state.registry().get(info.session_id).unwrap().state,
        SessionState::Failed
    );
    assert_eq!(state.wordcraft().len(), 0);
    // 오류 JSON은 code·engine·stage만 담는다(엔진 메시지·경로 없음).
    assert_eq!(
        serde_json::to_value(result.unwrap_err()).unwrap(),
        json!({"code": "EngineFailure", "engine": "wordcraft", "stage": "parse"})
    );
    // 엔진 읽기 중 패닉도 같은 실패다.
    let again = block_on(commands::load_with(&state, info.session_id, |_| {
        panic!("읽기 패닉 재현")
    }));
    assert_eq!(
        again,
        Err(DocumentError::EngineFailure {
            engine: Engine::Wordcraft,
            stage: EngineStage::Parse
        })
    );
    assert_eq!(
        state.registry().get(info.session_id).unwrap().state,
        SessionState::Failed
    );
}

/// 기록(T008 발견): T006 판별을 통과한 DOCX의 본문 XML이 중간에서 끊겨도 고정 WordCraft는 오류 없이 끊긴 곳까지만 읽어 연다
/// (rhwp의 깨진 HWPX와 같은 종류, 뒤 내용은 조용히 빠짐). 편집·저장하면 원본 내용이 사라질 수 있으므로 저장 판단(T009)이
/// 엔진의 열기 성공을 무손실 근거로 쓰면 안 된다. 동작이 바뀌면 이 시험이 알려 준다.
#[test]
fn 본문_xml이_끊긴_docx도_wordcraft는_끊긴_곳까지_읽어_연다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let mut entries = docx_entries();
    entries.retain(|e| e.name != "word/document.xml");
    entries.push(entry(
        "word/document.xml",
        b"<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>\xEB\x82\xB4\xEC\x9A\xA9",
    ));
    let info = register(&state, &dir, "broken.docx", &zip(&entries, false));
    let docx =
        block_on(commands::load(&state, info.session_id, None)).expect("WordCraft는 거부하지 않음");
    assert_eq!(docx.session.state, SessionState::Ready);
    assert_eq!(docx.view.paragraph_text, "내용");
}

#[test]
fn 엔진_패닉은_세션을_failed로_돌리고_모델을_놓는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    let result: Result<(), DocumentError> = block_on(commands::with_model(
        &state,
        id,
        1,
        EngineStage::Edit,
        |_, _, _| panic!("엔진 패닉 재현"),
    ));
    assert_eq!(
        result,
        Err(DocumentError::EngineFailure {
            engine: Engine::Wordcraft,
            stage: EngineStage::Edit
        })
    );
    assert_eq!(
        state.registry().get(id).unwrap().state,
        SessionState::Failed
    );
    assert_eq!(state.wordcraft().len(), 0);
    // 다시 불러오면 새 시도 번호의 모델로 이어 간다(옛 번호의 요청은 StaleLoad).
    let again = block_on(commands::load(&state, id, None)).unwrap();
    assert_eq!(again.session.load_generation, 2);
    assert_eq!(
        block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])),
        Err(DocumentError::StaleLoad {
            session_id: id,
            load_generation: 2
        })
    );
}

#[test]
fn 응답_json은_계약의_모양이다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let value = serde_json::to_value(&docx).unwrap();
    let view = value["view"].as_object().unwrap();
    let mut keys: Vec<&str> = view.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "anchorKey",
            "bullets",
            "caret",
            "caretKey",
            "caretOffset",
            "chars",
            "clipboardTextAvailable",
            "collapsed",
            "drawingInsertionAllowed",
            "embeddedFonts",
            "fontGeneration",
            "format",
            "formatAccess",
            "hasRevisions",
            "hasToc",
            "history",
            "imageInsertionAllowed",
            "inTable",
            "page",
            "pages",
            "paragraph",
            "paragraphStyle",
            "paragraphText",
            "selection",
            "textBoxEditing",
            "trackedReadOnly",
            "tracking"
        ]
    );
    // T010: 엔진 기록·서식(프런트엔드 parseDocxView가 정확히 이 키만 받는다).
    assert_eq!(
        value["view"]["history"],
        json!({"undo": false, "redo": false})
    );
    // Stage 5-A: the selection's stored font families (null when mixed) join the flags.
    let format = value["view"]["format"].as_object().unwrap();
    let mut format_keys: Vec<&str> = format.keys().map(String::as_str).collect();
    format_keys.sort();
    assert_eq!(
        format_keys,
        [
            "bold",
            "font",
            "fontEastAsia",
            "italic",
            "strikethrough",
            "underline"
        ]
    );
    for flag in ["bold", "italic", "underline", "strikethrough"] {
        assert_eq!(format[flag], json!(false), "{flag}");
    }
    assert!(format["font"].is_string() || format["font"].is_null());
    assert!(value["view"]["fontGeneration"].is_u64());
    assert_eq!(value["view"]["formatAccess"], "allowed");
    // 추적 정책은 언제나 불리언으로 직렬화한다(프런트엔드 parseDocxView의 필수 키).
    assert_eq!(value["view"]["trackedReadOnly"], json!(false));
    assert_eq!(value["view"]["hasToc"], json!(false));
    assert_eq!(value["view"]["tracking"], json!(false));
    assert_eq!(value["view"]["hasRevisions"], json!(false));
    assert!(value["view"]["caret"]
        .as_object()
        .unwrap()
        .contains_key("height"));
    assert_eq!(value["session"]["engine"], "wordcraft");
    let edited = block_on(commands::edit(
        &state,
        docx.session.session_id,
        1,
        0,
        vec![insert("가")],
    ))
    .unwrap();
    let value = serde_json::to_value(&edited).unwrap();
    assert_eq!(value["rejected"], json!([]));
    assert_eq!(value["applied"], 1);
}

#[test]
fn 다시_불러오기는_그_시도의_ready_모델을_버리고_파일에서_새로_읽는다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    let edited = block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])).unwrap();
    assert!(edited.session.dirty);
    // ready에서 시도 번호 없이 불러오면 거부(버리기 의사 없음), 옛 시도 번호도 거부.
    assert_eq!(
        block_on(commands::load(&state, id, None)),
        Err(DocumentError::InvalidState {
            session_id: id,
            state: SessionState::Ready
        })
    );
    assert_eq!(
        block_on(commands::load(&state, id, Some(7))),
        Err(DocumentError::StaleLoad {
            session_id: id,
            load_generation: 1
        })
    );
    let again = block_on(commands::load(&state, id, Some(1))).unwrap();
    let s = &again.session;
    assert_eq!(
        (s.state, s.load_generation, s.revision, s.dirty),
        (SessionState::Ready, 2, 1, false)
    );
    assert_eq!(
        again.view.paragraph_text,
        basic::PARAGRAPHS[0],
        "편집은 버려지고 파일 내용"
    );
    assert_eq!(state.wordcraft().len(), 1);
    // 옛 시도의 편집·그림 요청은 거부.
    assert_eq!(
        block_on(commands::edit(&state, id, 1, 1, vec![insert("x")])),
        Err(DocumentError::StaleLoad {
            session_id: id,
            load_generation: 2
        })
    );
    // 이미 failed인 세션은 그대로 다시 불러온다.
    block_on(commands::with_model(
        &state,
        id,
        2,
        EngineStage::Edit,
        |_, _, _| -> Result<(), DocumentError> { panic!("엔진 패닉 재현") },
    ))
    .unwrap_err();
    let third = block_on(commands::load(&state, id, Some(2))).unwrap();
    assert_eq!(third.session.load_generation, 3);
}

#[test]
fn 띠는_기준_판과_다른_줄만_정확히_덮는다() {
    let mut m = model();
    let scale = 1.0;
    let before = m.raster(0, scale);
    let full = m.render_page(0, scale, 0, None).unwrap();
    assert_eq!((full.base, full.y, full.height), (None, 0, before.1));
    m.apply(&[insert("가나")]);
    let after = m.raster(0, scale);
    let band = m.render_page(0, scale, 1, Some(0)).unwrap();
    let row = before.0 as usize * 4;
    let differing: Vec<usize> = (0..before.1 as usize)
        .filter(|&r| before.2[r * row..(r + 1) * row] != after.2[r * row..(r + 1) * row])
        .collect();
    assert_eq!(band.base, Some(0));
    assert_eq!(band.y as usize, differing[0]);
    assert_eq!(
        band.y as usize + band.height as usize - 1,
        *differing.last().unwrap()
    );
    assert_eq!(png_size(&band.png), (before.0, band.height));
    // 띠 밖의 줄은 그대로다(띠만 덮으면 새 그림과 같음).
    assert!((0..band.y as usize)
        .all(|r| before.2[r * row..(r + 1) * row] == after.2[r * row..(r + 1) * row]));
    // 다른 배율·쪽 크기의 기준은 쪽 전체.
    assert_eq!(m.render_page(0, 2.0, 1, Some(1)).unwrap().base, None);
}

// ---- T008 안정화: 여러 명령으로 된 연산의 원자성(P2-B) ----

#[test]
fn 기억한_자리_넣기에서_선택_되돌리기가_거부되면_문서도_그대로다() {
    let mut m = model();
    m.apply(&[
        mv(MoveTarget::Right, false),
        DocxOp::Mark { id: 1 },
        mv(MoveTarget::Down, false),
    ]);
    let (body, caret) = (m.body_text(), m.view().caret_key);
    // 넣기는 성공하고 그 뒤 선택 되돌리기(select.range)를 엔진이 거부한다(주입).
    m.fail_at = Some(("select.range", 1));
    let outcome = m.apply(&[DocxOp::InsertAt {
        mark: 1,
        text: "글".into(),
    }]);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (0, 0, vec![0])
    );
    assert_eq!(m.body_text(), body, "거부한 연산은 문서를 바꾸지 않는다");
    assert_eq!(m.view().caret_key, caret);
    // 넣기 자체가 거부돼도 문서·선택 그대로.
    m.apply(&[DocxOp::Mark { id: 2 }]);
    m.fail_at = Some(("text.insert", 1));
    let outcome = m.apply(&[DocxOp::InsertAt {
        mark: 2,
        text: "글".into(),
    }]);
    assert_eq!((outcome.changed, outcome.rejected), (0, vec![0]));
    assert_eq!((m.body_text(), m.view().caret_key), (body, caret));
}

#[test]
fn 앞_넣기_고치기에서_선택_되돌리기가_거부되면_문서도_그대로다() {
    let mut m = model();
    m.apply(&[insert("하")]);
    let (body, caret) = (m.body_text(), m.view().caret_key);
    // 첫 select.range는 고칠 범위 선택, 둘째가 고친 뒤 선택 되돌리기.
    m.fail_at = Some(("select.range", 2));
    let outcome = m.apply(&[DocxOp::ReplaceInserted {
        expected: "하".into(),
        text: "한".into(),
    }]);
    assert_eq!((outcome.changed, outcome.rejected), (0, vec![0]));
    assert_eq!(m.body_text(), body);
    assert_eq!(m.view().caret_key, caret);
}

#[test]
fn 복합_연산이_거부되면_편집_요청은_revision과_문서가_어긋나지_않는다() {
    let dir = TempDir::new();
    let state = DocumentState::default();
    let docx = loaded(&state, &dir);
    let (id, generation) = (docx.session.session_id, docx.session.load_generation);
    let model = state.wordcraft().get(id, generation).expect("모델");
    let edit =
        |base: u64, ops: Vec<DocxOp>| block_on(commands::edit(&state, id, generation, base, ops));
    edit(0, vec![DocxOp::Mark { id: 1 }, mv(MoveTarget::Down, false)]).expect("표시");
    let before = model.lock().unwrap().body_text();
    model.lock().unwrap().fail_at = Some(("select.range", 1));
    let edited = edit(
        0,
        vec![DocxOp::InsertAt {
            mark: 1,
            text: "글".into(),
        }],
    )
    .expect("거부는 실패가 아님");
    assert_eq!((edited.applied, edited.rejected), (0, vec![0]));
    assert_eq!((edited.session.revision, edited.session.dirty), (0, false));
    assert_eq!(
        model.lock().unwrap().body_text(),
        before,
        "revision 0·dirty false인데 문서가 바뀌면 안 된다"
    );
}

// ---- T008 2차 안정화: 거부한 복합 연산과 어댑터 기억(C1 자리 표시, C2 바로 앞 넣기) ----
//
// 불변식: 거부한 복합 연산은 문서·선택·실행 취소 기록·dirty뿐 아니라 그 뒤 편집의 뜻을 바꾸는 어댑터 기억(`marks`·`last_insert`)도
// 바꾸지 않는다. 실패를 주입한 모델과, 같은 성공 연산만 실행한 대조 모델이 그 뒤 같은 연산에 같게 답하는지로 본다(WordCraft 판은
// `restore`가 올리므로 비교하지 않는다).

fn insert_at(mark: u32, text: &str) -> DocxOp {
    DocxOp::InsertAt {
        mark,
        text: text.into(),
    }
}

fn replace(expected: &str, text: &str) -> DocxOp {
    DocxOp::ReplaceInserted {
        expected: expected.into(),
        text: text.into(),
    }
}

/// 비교할 상태: 본문, 커서·기준점, 자리 표시, 고칠 수 있는 넣기, dirty, 실행 취소 가능.
fn observable(m: &mut DocxModel) -> (String, String, String, Vec<u32>, Option<String>, bool, bool) {
    let view = m.view();
    let (marks, recent, _, dirty, undo) = m.adapter_state();
    (
        m.body_text(),
        view.caret_key,
        view.anchor_key,
        marks,
        recent,
        dirty,
        undo,
    )
}

/// 실행 취소를 끝까지, 다시 실행을 끝까지 한 본문들(실행 취소 기록이 같은지).
fn history(m: &mut DocxModel) -> Vec<String> {
    let mut seen = vec![m.body_text()];
    for _ in 0..8 {
        if !m.undo_redo(false) {
            break;
        }
        seen.push(m.body_text());
    }
    for _ in 0..8 {
        if !m.undo_redo(true) {
            break;
        }
        seen.push(m.body_text());
    }
    seen
}

#[test]
fn 기억한_자리_넣기가_거부되면_자리_표시는_남고_같은_자리에_다시_넣을_수_있다() {
    for target in [("caret.set", 1), ("text.insert", 1), ("select.range", 1)] {
        let setup = [
            mv(MoveTarget::Right, false),
            mv(MoveTarget::Right, false),
            DocxOp::Mark { id: 1 },
            mv(MoveTarget::Down, false),
        ];
        let (mut m, mut control) = (model(), model());
        m.apply(&setup);
        control.apply(&setup);
        let before = observable(&mut m);
        m.fail_at = Some(target);
        let outcome = m.apply(&[insert_at(1, "글")]);
        assert_eq!(
            (outcome.applied, outcome.changed, outcome.rejected),
            (0, 0, vec![0]),
            "{target:?}"
        );
        assert_eq!(
            observable(&mut m),
            before,
            "{target:?}: 거부한 연산은 자리 표시도 쓰지 않음"
        );
        // 같은 자리 표시로 다시 넣으면(대조 모델의 첫 넣기와 같게) 클릭 전 자리에 한 번 들어간다.
        assert_eq!(m.apply(&[insert_at(1, "글")]).changed, 1, "{target:?}");
        assert_eq!(control.apply(&[insert_at(1, "글")]).changed, 1);
        let p0 = basic::PARAGRAPHS[0];
        let expected: String = p0
            .chars()
            .take(2)
            .chain("글".chars())
            .chain(p0.chars().skip(2))
            .collect();
        assert!(m.body_text().starts_with(&expected), "{target:?}");
        assert_eq!(observable(&mut m), observable(&mut control), "{target:?}");
        // 자리 표시는 한 번만 쓴다.
        assert_eq!(m.apply(&[insert_at(1, "x")]).rejected, vec![0]);
        assert_eq!(history(&mut m), history(&mut control), "{target:?}");
    }
}

#[test]
fn 앞_넣기_고치기가_거부되면_다시_고칠_수_있고_다른_최종_글자로도_고친다() {
    let (mut m, mut control) = (model(), model());
    m.apply(&[insert("하")]);
    control.apply(&[insert("하")]);
    let before = observable(&mut m);
    let rev = m.adapter_state().2;
    assert_eq!(before.4.as_deref(), Some("하"));
    m.fail_at = Some(("select.range", 2)); // 고친 뒤 선택 되돌리기
    assert_eq!(m.apply(&[replace("하", "한")]).rejected, vec![0]);
    assert_eq!(
        observable(&mut m),
        before,
        "문서가 넣은 직후 그대로이므로 그 넣기는 아직 고칠 수 있다"
    );
    assert!(
        m.adapter_state().2 > rev,
        "WordCraft restore는 판을 올린다(엔진 계약)"
    );
    // 같은 고치기를 다시 하거나, 입력기가 다른 최종 음절을 보내도 고친다.
    let outcome = m.apply(&[replace("하", "할")]);
    assert_eq!((outcome.changed, outcome.rejected), (1, vec![]));
    control.apply(&[replace("하", "할")]);
    assert_eq!(
        m.view().paragraph_text,
        format!("할{}", basic::PARAGRAPHS[0])
    );
    assert_eq!(observable(&mut m), observable(&mut control));
    // 고친 뒤에는 다시 고치지 않는다(중복 고침 없음).
    assert_eq!(m.apply(&[replace("할", "한")]).rejected, vec![0]);
    assert_eq!(history(&mut m), history(&mut control));
}

#[test]
fn 거부한_고치기_뒤라도_문서를_바꾼_연산이_있으면_앞_넣기는_고치지_않는다() {
    let mut m = model();
    m.apply(&[insert("가"), insert("하")]);
    m.fail_at = Some(("select.range", 2));
    assert_eq!(m.apply(&[replace("하", "한")]).rejected, vec![0]);
    // 넣은 글자를 지웠다 같은 글자를 다른 연산으로 넣으면 그 넣기는 바로 앞 넣기가 아니다(Backspace가 끼어듦).
    m.apply(&[DocxOp::Backspace]);
    assert_eq!(m.adapter_state().1, None);
    assert_eq!(m.apply(&[replace("하", "한")]).rejected, vec![0]);
    assert!(m.body_text().starts_with("가한글"));
    // 되돌린 실패 뒤 성공한 복합 연산(기억한 자리 넣기)도 앞 넣기를 끝낸다.
    let mut other = model();
    other.apply(&[DocxOp::Mark { id: 3 }, insert("하")]);
    other.fail_at = Some(("select.range", 2));
    assert_eq!(other.apply(&[replace("하", "한")]).rejected, vec![0]);
    assert_eq!(other.apply(&[insert_at(3, "x")]).changed, 1);
    assert_eq!(other.apply(&[replace("하", "한")]).rejected, vec![0]);
}

#[test]
fn 거부한_기억한_자리_넣기는_앞_넣기의_고치기와_넣기_전_좌표를_막지_않는다() {
    let (mut m, mut control) = (model(), model());
    let setup = [DocxOp::Mark { id: 1 }, insert("하")];
    m.apply(&setup);
    control.apply(&setup);
    m.fail_at = Some(("select.range", 1));
    assert_eq!(m.apply(&[insert_at(1, "글")]).rejected, vec![0]);
    assert_eq!(observable(&mut m), observable(&mut control));
    // 넣기 전 화면의 클릭 좌표도 그대로 쓴다(Pointer.before_insert는 바로 앞 넣기의 배치를 씀).
    let p0 = basic::PARAGRAPHS[0];
    let target = model() // 넣기 전 화면
        .caret_of(&DocxModel::body_pos(&[0], byte_at(p0, 5)))
        .unwrap();
    let click = DocxOp::Pointer {
        page: 0,
        x: target.x,
        y: target.y + target.height / 2.0,
        extend: false,
        before_insert: true,
        drag: false,
        select_object: false,
    };
    m.apply(std::slice::from_ref(&click));
    control.apply(std::slice::from_ref(&click));
    assert_eq!(
        m.view().caret_offset,
        6,
        "넣기 전 화면의 5번째 경계 + 넣은 한 글자"
    );
    assert_eq!(m.apply(&[replace("하", "한")]).changed, 1);
    control.apply(&[replace("하", "한")]);
    assert_eq!(observable(&mut m), observable(&mut control));
}

#[test]
fn 자리_표시_수_한도와_거부한_넣기() {
    let mut m = model();
    let marks: Vec<DocxOp> = (1..=9).map(|id| DocxOp::Mark { id }).collect();
    m.apply(&marks);
    let ids: Vec<u32> = (2..=9).collect();
    assert_eq!(m.adapter_state().0, ids, "오래된 것(1)부터 버림");
    assert_eq!(m.apply(&[insert_at(1, "x")]).rejected, vec![0]);
    m.fail_at = Some(("select.range", 1));
    assert_eq!(m.apply(&[insert_at(9, "x")]).rejected, vec![0]);
    assert_eq!(
        m.adapter_state().0,
        ids,
        "거부한 넣기는 자리 표시를 쓰지 않음"
    );
    assert_eq!(m.apply(&[insert_at(9, "x")]).changed, 1);
    assert_eq!(m.adapter_state().0, (2..=8).collect::<Vec<u32>>());
}

#[test]
fn 거부한_복합_연산과_뒤의_연산이_한_요청에_섞여도_revision과_기억이_맞다() {
    let dir = TempDir::new();
    let state = DocumentState::default();
    let docx = loaded(&state, &dir);
    let (id, generation) = (docx.session.session_id, docx.session.load_generation);
    let model = state.wordcraft().get(id, generation).expect("모델");
    let edit =
        |base: u64, ops: Vec<DocxOp>| block_on(commands::edit(&state, id, generation, base, ops));
    edit(0, vec![DocxOp::Mark { id: 5 }, mv(MoveTarget::Down, false)]).expect("표시");
    model.lock().unwrap().fail_at = Some(("select.range", 1));
    let edited = edit(0, vec![insert_at(5, "글"), insert("x"), replace("x", "y")])
        .expect("거부는 실패가 아님");
    assert_eq!(
        (
            edited.applied,
            edited.rejected.clone(),
            edited.session.revision
        ),
        (2, vec![0], 2)
    );
    assert!(edited.session.dirty);
    assert!(edited.view.paragraph_text.starts_with('y'));
    // 거부한 넣기의 자리 표시는 남아 다음 요청에서 쓸 수 있다.
    let again = edit(2, vec![insert_at(5, "글")]).expect("다시 넣기");
    assert_eq!((again.rejected, again.session.revision), (vec![], 3));
    assert!(model.lock().unwrap().body_text().starts_with("글한글"));
    assert_eq!(model.lock().unwrap().adapter_state().0, Vec::<u32>::new());
}

// ---- T008 3차 안정화: 거부한 복합 연산과 스냅숏 밖의 WordCraft 편집 보조 상태 ----
//
// `Session::edit_snapshot`은 문서·선택·실행 취소 기록·dirty만 담는다. 복합 연산 안의 `caret.set`은 `goal_x`(세로 이동이 지키는 x)와
// `pending`(다음 입력 서식)을, `text.insert`는 `goal_x`를 지운다(고정 WordCraft `cmd/caret.rs`·`cmd/mod.rs`). 거부한 연산 뒤 그다음
// 허용 연산(↑↓·글자 넣기)이 대조 모델과 같게 움직이는지 본다.

const LONG: &str = "가나다라마바사아자차카타파하";

/// 긴 문단 · 짧은 문단("가") · 긴 문단을 문서 앞에 두고, 커서를 첫 문단 10번째 글자 뒤에 둔 모델.
fn vertical_model() -> DocxModel {
    let mut m = model();
    m.apply(&[
        DocxOp::NewParagraph,
        DocxOp::NewParagraph,
        DocxOp::NewParagraph,
        mv(MoveTarget::DocStart, false),
        insert(LONG),
        mv(MoveTarget::Down, false),
        insert("가"),
        mv(MoveTarget::Down, false),
        insert(LONG),
        mv(MoveTarget::DocStart, false),
    ]);
    for _ in 0..10 {
        m.apply(&[mv(MoveTarget::Right, false)]);
    }
    m
}

#[test]
fn 거부한_복합_연산_뒤에도_세로_이동은_지키던_가로_자리로_간다() {
    let cases: [(DocxOp, (&'static str, usize)); 4] = [
        (insert_at(1, "글"), ("caret.set", 1)),
        (insert_at(1, "글"), ("text.insert", 1)),
        (insert_at(1, "글"), ("select.range", 1)),
        (replace("하", "한"), ("select.range", 2)),
    ];
    for (op, target) in cases {
        let (mut m, mut control) = (vertical_model(), vertical_model());
        let setup = [
            DocxOp::Mark { id: 1 },
            insert("하"),
            mv(MoveTarget::Down, false),
        ];
        m.apply(&setup);
        control.apply(&setup);
        // 짧은 문단 끝으로 내려와 있고, 지키는 x는 첫 문단 11번째 글자 자리다.
        assert_eq!(m.view().caret_offset, 1, "{target:?}");
        assert!(m.engine_aux().0.is_some(), "{target:?}");
        m.fail_at = Some(target);
        assert_eq!(
            m.apply(std::slice::from_ref(&op)).rejected,
            vec![0],
            "{target:?}"
        );
        assert_eq!(observable(&mut m), observable(&mut control), "{target:?}");
        assert_eq!(
            m.engine_aux(),
            control.engine_aux(),
            "{target:?}: goal_x·pending·page_hint"
        );
        m.apply(&[mv(MoveTarget::Down, false)]);
        control.apply(&[mv(MoveTarget::Down, false)]);
        assert_eq!(
            m.view().caret_key,
            control.view().caret_key,
            "{target:?}: 다음 ↓는 지키던 x로(짧은 문단 끝의 x가 아님)"
        );
        assert!(m.view().caret_offset > 5, "{target:?}");
        assert_eq!(history(&mut m), history(&mut control), "{target:?}");
    }
}

#[test]
fn 거부한_복합_연산은_다음_입력_서식을_바꾸지_않는다() {
    // 허용 연산만으로 다음 입력 서식(pending)을 만든다: 웹 주소 뒤 Enter는 자동 고침으로 링크가 되고 그 뒤 입력은 링크가 아니다.
    let setup = [
        DocxOp::Mark { id: 1 },
        insert("www.example.com"),
        DocxOp::NewParagraph,
    ];
    let (mut m, mut control) = (model(), model());
    m.apply(&setup);
    control.apply(&setup);
    let pending = m.engine_aux().1;
    assert!(
        pending.is_some(),
        "Enter의 자동 고침이 다음 입력 서식을 정함"
    );
    m.fail_at = Some(("select.range", 1));
    assert_eq!(m.apply(&[insert_at(1, "글")]).rejected, vec![0]);
    assert_eq!(m.engine_aux(), control.engine_aux());
    m.apply(&[insert("x")]);
    control.apply(&[insert("x")]);
    assert_eq!(
        m.char_props_before_caret(),
        control.char_props_before_caret()
    );
    assert_eq!(observable(&mut m), observable(&mut control));
    assert_eq!(history(&mut m), history(&mut control));
}

#[test]
fn 성공한_복합_연산의_보조_상태는_그대로다() {
    // 되돌림은 거부했을 때만: 성공한 기억한 자리 넣기·앞 넣기 고치기는 엔진이 정한 대로(caret.set·text.insert가 지운 goal_x) 둔다.
    let mut m = vertical_model();
    m.apply(&[
        DocxOp::Mark { id: 1 },
        insert("하"),
        mv(MoveTarget::Down, false),
    ]);
    assert!(m.engine_aux().0.is_some());
    assert_eq!(m.apply(&[replace("하", "한")]).changed, 1);
    assert_eq!(m.engine_aux().0, None);
    m.apply(&[mv(MoveTarget::Down, false)]);
    assert_eq!(m.apply(&[insert_at(1, "글")]).changed, 1);
    assert_eq!(m.engine_aux().0, None);
}

// ---- T008 안정화: 붙여넣기(P1-A)·조합의 선택 지우기(P1-C) ----

fn paste(text: &str, chain: bool) -> DocxOp {
    DocxOp::PasteText {
        text: text.into(),
        chain,
    }
}

#[test]
fn 붙여넣은_줄바꿈은_문단을_나누고_탭은_글자로_들어간다() {
    let mut m = model();
    let outcome = m.apply(&[paste("첫 줄\t1\n\n셋째 줄 😀𝄞 ASCII\n", false)]);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (1, 1, vec![]),
        "조각 하나 = 명령 하나 = 변경 하나"
    );
    let lines: Vec<String> = m.body_text().lines().map(str::to_owned).collect();
    assert_eq!(
        &lines[..4],
        [
            "첫 줄\t1".to_owned(),
            String::new(),
            "셋째 줄 😀𝄞 ASCII".to_owned(),
            basic::PARAGRAPHS[0].to_owned()
        ]
    );
    // 커서는 붙여넣은 끝(넷째 문단 처음).
    assert_eq!(
        (m.view().caret_key, m.view().caret_offset),
        ("body:3:0".into(), 0)
    );
    // 자동 고침이 없다(raw): 따옴표·대문자 그대로.
    let mut m = model();
    m.apply(&[paste("\"quote\" teh i\n", false)]);
    assert!(m.body_text().starts_with("\"quote\" teh i\n"));
}

#[test]
fn 표_셀에_붙여넣은_탭은_셀_이동이_아니라_글자다() {
    let mut m = model();
    let cell = DocxModel::body_pos(&[basic::TABLE_BLOCK, 0, 0, 0], 0);
    let c = m.caret_of(&cell).unwrap();
    m.apply(&[pointer(c.page as u32, c.x + 1.0, c.y + c.height / 2.0)]);
    let outcome = m.apply(&[paste("a\tb", false)]);
    assert_eq!(outcome.changed, 1);
    let view = m.view();
    assert!(view.in_table);
    assert_eq!(
        view.caret_key,
        format!("body:{}.0.0.0:{}", basic::TABLE_BLOCK, "a\tb".len())
    );
    assert_eq!(view.paragraph_text, format!("a\tb{}", basic::CELLS[0]));
}

#[test]
fn 앞_조각이_거부되면_chain_조각은_실행하지_않고_따로_친_입력은_실행한다() {
    let mut m = model();
    let before = m.body_text();
    // 첫 조각의 text.insert를 엔진이 거부한다(주입).
    m.fail_at = Some(("text.insert", 1));
    let outcome = m.apply(&[
        paste("가\n나", false),
        paste("다", true),
        paste("라", true),
        insert("마"),
        paste("바", true),
    ]);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (2, 2, vec![0, 1, 2])
    );
    assert_eq!(m.body_text(), format!("마바{before}"));
    // chain이어도 요청의 첫 연산이면(앞 조각은 앞 요청에서 성공) 실행한다.
    assert_eq!(m.apply(&[paste("사", true)]).changed, 1);
}

#[test]
fn 붙여넣기_조각의_검사() {
    assert!(validate(&[paste("a\nb\tc", false)]));
    assert!(validate(&[paste("\n", true)]));
    assert!(validate(&[paste(&"😀".repeat(MAX_TEXT_CHARS), false)]));
    for bad in ["", "a\r\nb", "a\rb", "\u{7}", "\u{0}", "\u{FFFC}", "\u{85}"] {
        assert!(!validate(&[paste(bad, false)]), "{bad:?}");
    }
    assert!(!validate(&[paste(&"\n".repeat(MAX_TEXT_CHARS + 1), false)]));
    // 일반 넣기의 계약은 그대로(한 문단, 탭·줄바꿈 없음).
    assert!(!validate(&[insert("a\nb")]));
    assert!(!validate(&[insert("\t")]));
    let parse = |value: serde_json::Value| serde_json::from_value::<Vec<DocxOp>>(value);
    assert_eq!(
        parse(json!([{"op": "pasteText", "text": "a\n", "chain": true}, {"op": "pasteText", "text": "b"},
                     {"op": "deleteSelection"}]))
        .unwrap(),
        vec![paste("a\n", true), paste("b", false), DocxOp::DeleteSelection { selection: None }]
    );
    assert!(parse(json!([{"op": "pasteText", "text": "a", "raw": false}])).is_err());
}

#[test]
fn 선택_지우기는_선택이_있을_때만_문서를_바꾼다() {
    let mut m = model();
    assert_eq!(
        m.apply(&[DocxOp::DeleteSelection { selection: None }])
            .changed,
        0,
        "선택 없음: 문서·revision 그대로(앞 글자를 지우지 않음)"
    );
    assert_eq!(m.view().paragraph_text, basic::PARAGRAPHS[0]);
    let outcome = m.apply(&[
        mv(MoveTarget::Right, true),
        mv(MoveTarget::Right, true),
        DocxOp::DeleteSelection { selection: None },
        insert("마"),
    ]);
    assert_eq!(outcome.changed, 2);
    let expected: String = "마"
        .chars()
        .chain(basic::PARAGRAPHS[0].chars().skip(2))
        .collect();
    assert_eq!(m.view().paragraph_text, expected);
    // 문단을 건너는 선택.
    let outcome = m.apply(&[
        mv(MoveTarget::DocStart, false),
        mv(MoveTarget::Down, true),
        DocxOp::DeleteSelection { selection: None },
    ]);
    assert_eq!(outcome.changed, 1);
    assert!(m.view().collapsed);
}

/// 측정(기본 실행에서 빠짐): 한도만큼의 붙여넣기 한 요청(256조각 × 4096자, 줄 64자마다 문단)의 엔진 시간.
/// `cargo test --locked -- --ignored --nocapture 붙여넣기_한도`
#[test]
#[ignore]
fn 붙여넣기_한도_측정() {
    let line = format!(
        "{}\n",
        "가나다라마바사 abcdefg "
            .repeat(4)
            .chars()
            .take(63)
            .collect::<String>()
    );
    let text: String = line.repeat(MAX_TEXT_CHARS * MAX_OPS / 64);
    let chars: Vec<char> = text.chars().collect();
    let ops: Vec<DocxOp> = chars
        .chunks(MAX_TEXT_CHARS)
        .enumerate()
        .map(|(index, chunk)| paste(&chunk.iter().collect::<String>(), index > 0))
        .collect();
    assert_eq!(ops.len(), MAX_OPS);
    assert!(validate(&ops));
    let mut m = model();
    let started = std::time::Instant::now();
    let outcome = m.apply(&ops);
    let applied = started.elapsed();
    let view = m.view();
    let laid_out = started.elapsed();
    let png = m
        .render_png(view.caret.map_or(0, |c| c.page), 1.0)
        .map(|p| p.len());
    eprintln!(
        "붙여넣기 {}자 {}조각: apply {:?}, apply+view(배치) {:?}, 쪽 {}개, 그림 {:?}",
        chars.len(),
        ops.len(),
        applied,
        laid_out,
        view.pages.len(),
        png
    );
    assert_eq!(outcome.changed, MAX_OPS as u64);
    // 그 큰 문서에서 이어 친 글자 하나(편집 + 배치).
    let started = std::time::Instant::now();
    m.apply(&[insert("가")]);
    m.view();
    eprintln!("그 뒤 글자 하나: apply+view {:?}", started.elapsed());
}

// ---- T010: 엔진이 가진 실행 취소·다시 실행과 글자 서식 ----

fn format(format: super::engine::CharFormat) -> DocxOp {
    DocxOp::Format { format }
}

#[test]
fn t010_wordcraft는_edit_undo를_문서를_바꾸지_않는_명령으로_등록한다() {
    // 어댑터가 `run`의 `mutates` 판단 대신 앞뒤 문서를 비교하는 이유(이 값이 바뀌면 이 시험이 알린다).
    let session = wordcraft_engine::Session::new(
        wordcraft_engine::io::open_bytes("document.docx", &fixture()).unwrap(),
    );
    for id in ["edit.undo", "edit.redo"] {
        assert!(!session.registry.get(id).unwrap().mutates, "{id}");
    }
    assert!(session.registry.get("format.bold").unwrap().mutates);
}

#[test]
fn t010_실행_취소와_다시_실행은_엔진_기록을_쓰고_바뀐_만큼_revision으로_센다() {
    let mut m = model();
    let original = m.body_text();
    assert_eq!(
        (m.view().history.undo, m.view().history.redo),
        (false, false)
    );
    // 되돌릴 것이 없으면 아무것도 바뀌지 않는다(거부도 아님, revision 그대로).
    let none = m.apply(&[DocxOp::Undo {}, DocxOp::Redo {}]);
    assert_eq!((none.applied, none.changed, none.rejected), (2, 0, vec![]));
    assert_eq!(m.body_text(), original);

    let typed = m.apply(&[insert("가나"), DocxOp::NewParagraph, insert("다")]);
    assert_eq!(typed.changed, 3);
    let edited = m.body_text();
    assert!(m.view().history.undo && !m.view().history.redo);

    // 한 단계씩: "다", 문단 나누기, "가나"(엔진이 이어 친 글자를 한 단계로 묶음).
    let mut seen = vec![m.body_text()];
    loop {
        let step = m.apply(&[DocxOp::Undo {}]);
        assert_eq!((step.applied, step.rejected.len()), (1, 0));
        if step.changed == 0 {
            break;
        }
        assert_eq!(step.changed, 1);
        seen.push(m.body_text());
    }
    assert_eq!(seen.last(), Some(&original));
    assert!(!m.view().history.undo && m.view().history.redo);
    // 다시 실행으로 편집한 본문까지 돌아온다.
    let mut redone = 0;
    while m.apply(&[DocxOp::Redo {}]).changed == 1 {
        redone += 1;
    }
    assert_eq!(redone, seen.len() - 1);
    assert_eq!(m.body_text(), edited);
    // 새 편집은 다시 실행 기록을 버린다(엔진 규칙).
    m.apply(&[DocxOp::Undo {}]);
    m.apply(&[insert("라")]);
    assert!(!m.view().history.redo);
}

#[test]
fn t010_실행_취소는_어댑터의_자리_표시와_바로_앞_넣기를_버린다() {
    let mut m = model();
    m.apply(&[
        mv(MoveTarget::Right, false),
        DocxOp::Mark { id: 7 },
        insert("가"),
    ]);
    let before = m.body_text();
    let undone = m.apply(&[DocxOp::Undo {}]);
    assert_eq!(undone.changed, 1);
    // 옛 자리 표시·바로 앞 넣기로 고치는 연산은 거부되고 문서를 바꾸지 않는다.
    let after_undo = m.body_text();
    assert_ne!(after_undo, before);
    let stale = m.apply(&[
        DocxOp::InsertAt {
            mark: 7,
            text: "나".into(),
        },
        DocxOp::ReplaceInserted {
            expected: "가".into(),
            text: "다".into(),
        },
    ]);
    assert_eq!((stale.changed, stale.rejected), (0, vec![0, 1]));
    assert_eq!(m.body_text(), after_undo);
}

#[test]
fn t010_글자_서식은_선택_범위에_켜고_끄며_서식_상태와_실행_취소를_보인다() {
    use super::engine::CharFormat::{Bold, Italic, Strikethrough, Underline};
    let mut m = model();
    assert!(!m.view().format.bold);
    // 선택(첫 두 글자)을 굵게: 문서가 바뀌고 선택의 서식이 굵게로 보인다.
    let selected = m.apply(&[mv(MoveTarget::Right, true), mv(MoveTarget::Right, true)]);
    assert_eq!(selected.changed, 0);
    let bold = m.apply(&[format(Bold)]);
    assert_eq!((bold.applied, bold.changed), (1, 1));
    let view = m.view();
    assert!(view.format.bold && !view.format.italic && view.history.undo);
    // 다시 누르면 끈다.
    assert_eq!(m.apply(&[format(Bold)]).changed, 1);
    assert!(!m.view().format.bold);
    type Flag = fn(&super::engine::FormatView) -> bool;
    let cases: [(super::engine::CharFormat, Flag); 3] = [
        (Italic, |v| v.italic),
        (Underline, |v| v.underline),
        (Strikethrough, |v| v.strikethrough),
    ];
    for (op, flag) in cases {
        assert_eq!(m.apply(&[format(op)]).changed, 1, "{op:?}");
        assert!(flag(&m.view().format), "{op:?}");
    }
    // 실행 취소는 서식 변경을 되돌린다.
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!(!m.view().format.strikethrough && m.view().format.underline);
}

#[test]
fn t010_선택이_없으면_서식은_다음_입력에만_적용되고_문서는_바뀌지_않는다() {
    let mut m = model();
    let original = m.body_text();
    let collapsed = m.apply(&[format(super::engine::CharFormat::Bold)]);
    assert_eq!((collapsed.applied, collapsed.changed), (1, 0));
    assert_eq!(m.body_text(), original);
    assert!(m.view().format.bold, "다음 입력 서식");
    m.apply(&[insert("굵")]);
    assert!(m.char_props_before_caret().contains("bold: Some(true)"));
}

#[test]
fn t010_새_연산은_ipc_모양만_받는다() {
    let parse = |value: serde_json::Value| serde_json::from_value::<DocxOp>(value).ok();
    assert_eq!(parse(json!({"op": "undo"})), Some(DocxOp::Undo {}));
    assert_eq!(parse(json!({"op": "redo"})), Some(DocxOp::Redo {}));
    assert_eq!(
        parse(json!({"op": "format", "format": "bold"})),
        Some(format(super::engine::CharFormat::Bold))
    );
    for bad in [
        json!({"op": "undo", "count": 2}),
        json!({"op": "format"}),
        json!({"op": "format", "format": "fontSize"}),
        json!({"op": "format", "format": "bold", "value": true}),
        json!({"op": "edit.undo"}),
    ] {
        assert_eq!(parse(bad.clone()), None, "{bad}");
    }
    assert!(validate(&[DocxOp::Undo {}, DocxOp::Redo {}]));
}

// ---- T010 안정화 ----

/// 보호를 건 모델. `exception`이면 첫 두 글자를 모두가 편집할 수 있는 영역으로 둔다. DOCX로 내보내 다시 열어 파일에 담긴
/// 보호로 시험한다(엔진 `review.restrict`, 고정 WordCraft).
fn protected(mode: &str, formatting: bool, exception: bool) -> DocxModel {
    let mut m = model();
    if exception {
        m.apply(&[mv(MoveTarget::Right, true), mv(MoveTarget::Right, true)]);
        assert!(m.run_engine("review.restrict", json!({"exception": "add"})));
    }
    assert!(
        m.run_engine(
            "review.restrict",
            json!({"mode": mode, "formatting": formatting})
        ),
        "{mode}"
    );
    DocxModel::open(&m.export().expect("내보내기")).expect("다시 열기")
}

/// 선택(처음 두 글자 또는 끝 두 글자)이나 커서만 두고 굵게를 보낸 결과와, 그 앞뒤 본문·서식·dirty·실행 취소 기록.
fn bold_at(m: &mut DocxModel, place: &str) -> (bool, bool) {
    let ops: Vec<DocxOp> = match place {
        "start" => vec![
            mv(MoveTarget::DocStart, false),
            mv(MoveTarget::Right, true),
            mv(MoveTarget::Right, true),
        ],
        "end" => vec![
            mv(MoveTarget::DocEnd, false),
            mv(MoveTarget::Left, true),
            mv(MoveTarget::Left, true),
        ],
        _ => vec![mv(MoveTarget::DocEnd, false)],
    };
    m.apply(&ops);
    let before = (
        m.body_text(),
        m.view().format,
        m.adapter_state().3,
        m.adapter_state().4,
    );
    let outcome = m.apply(&[format(super::engine::CharFormat::Bold)]);
    let accepted = outcome.rejected.is_empty();
    if !accepted {
        // 거부: 문서·서식·dirty·실행 취소 기록 모두 그대로, revision으로 셀 변경 없음.
        assert_eq!(outcome.changed, 0, "{place}");
        let after = (
            m.body_text(),
            m.view().format,
            m.adapter_state().3,
            m.adapter_state().4,
        );
        assert_eq!(after, before, "{place}");
    }
    (accepted, outcome.changed == 1)
}

#[test]
fn t010_보호_상태의_서식_가용성은_엔진_판정과_같다() {
    use super::engine::FormatAccess::{Allowed, Protected, Regions};
    // (모드, 서식 제한, 편집 가능 영역) → 보기의 가용성, (처음 두 글자, 끝 두 글자, 커서만) 굵게를 엔진이 받는지.
    let cases = [
        ("readOnly", false, false, Protected, [false, false, false]),
        // 영역 안 선택만 문서를 바꿀 수 있고, 커서만 둔 서식은 문서를 바꾸지 않으므로(다음 입력 서식) 엔진이 받는다.
        ("readOnly", false, true, Regions, [true, false, true]),
        ("comments", false, false, Protected, [false, false, false]),
        ("comments", false, true, Regions, [true, false, true]),
        ("forms", false, false, Protected, [false, false, false]),
        // 추적 문서 편집 허용(T013 Stage 3) 뒤: 변경 내용 추적만 허용하는 보호는 서식도 추적으로 받는다.
        ("trackedChanges", false, false, Allowed, [true, true, true]),
        (
            "trackedChanges",
            true,
            false,
            Protected,
            [false, false, false],
        ),
        ("readOnly", true, true, Protected, [false, false, false]),
    ];
    let mut plain = model();
    assert_eq!(plain.view().format_access, Allowed);
    assert_eq!(
        ["start", "end", "caret"].map(|place| bold_at(&mut plain, place).0),
        [true; 3]
    );
    for (mode, formatting, exception, access, accepted) in cases {
        let label = format!("{mode} formatting={formatting} exception={exception}");
        let mut m = protected(mode, formatting, exception);
        assert_eq!(m.view().format_access, access, "{label}");
        let got = ["start", "end", "caret"].map(|place| bold_at(&mut m, place).0);
        assert_eq!(got, accepted, "{label}");
        // 가용성과 엔진 판정이 어긋나지 않는다: Protected는 어디서나 거부, Allowed는 어디서나 허용.
        match access {
            Protected => assert!(got.iter().all(|ok| !ok), "{label}"),
            Allowed => assert!(got.iter().all(|ok| *ok), "{label}"),
            Regions => assert!(got.iter().any(|ok| *ok), "{label}"),
        }
    }
}

#[test]
fn t010_빈_기록에서_이동_선택_표지만_있으면_실행_취소는_아무것도_바꾸지_않는다() {
    let mut m = model();
    let original = m.body_text();
    let outcome = m.apply(&[
        mv(MoveTarget::Right, false),
        mv(MoveTarget::Right, true),
        DocxOp::SelectAll,
        DocxOp::Mark { id: 3 },
        DocxOp::Undo {},
    ]);
    assert_eq!(
        (outcome.applied, outcome.changed, outcome.rejected),
        (5, 0, vec![])
    );
    assert_eq!(m.body_text(), original);
    assert!(!m.view().history.undo);
}

#[test]
fn t010_엔진이_거부한_넣기_뒤의_실행_취소는_앞선_기록만_되돌린다() {
    let mut m = model();
    m.apply(&[insert("가")]);
    let typed = m.body_text();
    // 넣기가 엔진에서 거부되면(실패 주입) 기록이 늘지 않고, 같은 요청의 실행 취소는 앞선 "가"를 되돌린다.
    m.fail_at = Some(("text.insert", 1));
    let outcome = m.apply(&[mv(MoveTarget::Right, false), insert("뷁"), DocxOp::Undo {}]);
    assert_eq!((outcome.changed, outcome.rejected), (1, vec![1]));
    assert_ne!(m.body_text(), typed);
    assert!(!m.body_text().contains('뷁'));
    assert!(!m.view().history.undo);
}

#[test]
fn t010_커서만_둔_서식은_문서를_바꾸지_않는_엔진_기록_단계를_만들고_되돌리면_다음_입력_서식만_돌아온다(
) {
    // 고정 WordCraft: 바꾸는 명령은 문서가 그대로여도 실행 취소 지점을 남긴다(다음 입력 서식을 함께 담음). 그래서 이 뒤의
    // 실행 취소는 쓸 수 있고, 문서·revision은 그대로이며 다음 입력 서식만 되돌린다(화면 가용성 = 엔진 기록).
    let mut m = model();
    let original = m.body_text();
    let bold = m.apply(&[format(super::engine::CharFormat::Bold)]);
    assert_eq!(bold.changed, 0);
    assert!(m.view().history.undo && m.view().format.bold);
    let undone = m.apply(&[DocxOp::Undo {}]);
    assert_eq!((undone.applied, undone.changed), (1, 0));
    assert_eq!(m.body_text(), original);
    assert!(!m.view().format.bold && !m.view().history.undo && m.view().history.redo);
}

#[test]
fn t010_문서를_바꾸지_않은_바꾸는_명령_뒤의_실행_취소는_revision을_세지_않는다() {
    // 문서 처음의 Backspace: 바꾸는 명령이지만 문서가 그대로다(revision으로 세지 않음, T008). 그 뒤 실행 취소도 문서를 바꾸지
    // 않으면 revision으로 세지 않는다(엔진 기록 지점의 유무와 관계없이 화면 판정은 엔진 결과를 따른다).
    let mut m = model();
    let original = m.body_text();
    let outcome = m.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Backspace]);
    assert_eq!(outcome.changed, 0);
    let had_step = m.view().history.undo;
    let undone = m.apply(&[DocxOp::Undo {}]);
    assert_eq!(
        (undone.applied, undone.changed),
        (1, 0),
        "기록 지점 {had_step}"
    );
    assert_eq!(m.body_text(), original);
    // 고정 WordCraft가 이 경우 기록 지점을 남기는지(마무리 안정화: 화면 예상·흉내의 근거로 고정).
    assert!(
        had_step,
        "문서를 바꾸지 않은 바꾸는 명령도 기록 지점을 남김"
    );
    assert!(!m.view().history.undo && m.view().history.redo);
}

#[test]
fn t010_실제_앱_시험의_보호_픽스처는_파일에_보호를_담는다() {
    use super::engine::FormatAccess::{Protected, Regions};
    let mut read_only = DocxModel::open(&basic::protected_ko("readOnly", false).unwrap()).unwrap();
    let mut regions = DocxModel::open(&basic::protected_ko("readOnly", true).unwrap()).unwrap();
    assert_eq!(read_only.view().format_access, Protected);
    assert_eq!(regions.view().format_access, Regions);
    assert_eq!(bold_at(&mut regions, "start"), (true, true));
    assert!(!bold_at(&mut regions, "end").0);
}

#[test]
fn selection_panel_preview_is_actual_bounded_and_does_not_change_revision_or_document() {
    let bytes = crate::services::files::blank_docx().unwrap();
    let mut model = DocxModel::open(&bytes).unwrap();
    model.apply(&[DocxOp::InsertText {
        text: "한😀글".repeat(300),
    }]);
    model.apply(&[DocxOp::SelectAll]);
    let before = model.export().unwrap();
    let view = model.view();
    assert_eq!(view.paragraph_style.as_deref(), Some("Normal"));
    assert_eq!(view.selection_text.as_ref().unwrap().chars().count(), 500);
    assert!(view.selection_text.unwrap().starts_with("한😀글"));
    assert_eq!(model.export().unwrap(), before);
}

// ---- T013 메모(review.comment → WordCraft review.newComment) ----

fn comment(text: &str) -> DocxOp {
    DocxOp::Comment { text: text.into() }
}

fn select_first_two() -> Vec<DocxOp> {
    vec![
        mv(MoveTarget::DocStart, false),
        mv(MoveTarget::Right, true),
        mv(MoveTarget::Right, true),
    ]
}

#[test]
fn 메모_연산의_글자는_계약_안이어야_한다() {
    assert!(validate(&[comment("검토 필요")]));
    assert!(validate(&[comment(
        &"가".repeat(super::engine::MAX_COMMENT_CHARS)
    )]));
    for bad in [
        String::new(),
        "   ".to_owned(),
        "줄\n바꿈".to_owned(),
        "탭\t".to_owned(),
        "\u{FFFC}".to_owned(),
        "가".repeat(super::engine::MAX_COMMENT_CHARS + 1),
    ] {
        assert!(!validate(&[comment(&bad)]), "{bad:?}");
    }
    // IPC 모양: 모르는 필드·다른 이름은 받지 않는다(임의 WordCraft 명령 ID를 열지 않음).
    let parsed: Result<DocxOp, _> = serde_json::from_value(json!({"op": "comment", "text": "a"}));
    assert_eq!(parsed.unwrap(), comment("a"));
    for raw in [
        json!({"op": "comment", "text": "a", "author": "x"}),
        json!({"op": "comment"}),
        json!({"op": "newComment", "text": "a"}),
        json!({"op": "run", "id": "review.newComment", "params": {}}),
    ] {
        assert!(
            serde_json::from_value::<DocxOp>(raw.clone()).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn 메모는_본문_선택에만_달리고_한_단계로_되돌린다() {
    let mut m = model();
    let before = m.body_text();
    // 커서만 있으면 거부(엔진은 단어를 고르지만 앱은 쓰지 않음): 바뀐 것 없음.
    let outcome = m.apply(&[mv(MoveTarget::DocStart, false), comment("x")]);
    assert_eq!(outcome.rejected, vec![1]);
    assert_eq!(outcome.changed, 0);
    assert!(m.comments().is_empty());

    let mut ops = select_first_two();
    ops.push(comment("검토 필요"));
    let outcome = m.apply(&ops);
    assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![], 1));
    assert_eq!(
        m.comments(),
        vec![("geul".to_owned(), "검토 필요".to_owned(), false)]
    );
    // 본문 글자(개체 표지 빼고)는 그대로다.
    assert_eq!(
        m.body_text().replace('\u{FFFC}', ""),
        before.replace('\u{FFFC}', "")
    );
    assert!(m.view().history.undo);
    let undone = m.apply(&[DocxOp::Undo {}]);
    assert_eq!(undone.changed, 1);
    assert!(m.comments().is_empty());
    assert_eq!(m.body_text(), before);
    let redone = m.apply(&[DocxOp::Redo {}]);
    assert_eq!(redone.changed, 1);
    assert_eq!(m.comments().len(), 1);
}

#[test]
fn 메모_뒤에는_어댑터_기억을_버린다() {
    let mut m = model();
    m.apply(&[
        mv(MoveTarget::DocEnd, false),
        DocxOp::Mark { id: 7 },
        insert("가"),
    ]);
    let mut ops = select_first_two();
    ops.push(comment("c"));
    m.apply(&ops);
    let (marks, recent, ..) = m.adapter_state();
    assert!(marks.is_empty());
    assert_eq!(recent, None);
    // 지운 자리 표시에 넣기는 거부(엉뚱한 자리에 넣지 않음).
    assert_eq!(
        m.apply(&[DocxOp::InsertAt {
            mark: 7,
            text: "x".into()
        }])
        .rejected,
        vec![0]
    );
}

#[test]
fn 읽기_전용_보호에서는_메모를_엔진이_거부하고_메모만_보호에서는_받는다() {
    let mut read_only = protected("readOnly", false, false);
    let mut ops = select_first_two();
    ops.push(comment("x"));
    let outcome = read_only.apply(&ops);
    assert_eq!(outcome.rejected, vec![3]);
    assert!(read_only.comments().is_empty());
    let mut comments_only = protected("comments", false, false);
    let outcome = comments_only.apply(&ops);
    assert_eq!(outcome.rejected, Vec::<usize>::new());
    assert_eq!(comments_only.comments().len(), 1);
}

#[test]
fn 메모를_더한_저장은_안전하고_다시_열면_같다_두_번째_회차의_새_메모도_덧붙임이면_저장된다() {
    use crate::document::Format;
    use crate::services::save::preserve::{FindingCode, Outcome};
    use crate::services::save::service::{check_saved, preflight};
    let original = fixture();
    let unedited = DocxModel::open(&original).unwrap().export().unwrap();
    assert!(preflight(Format::Docx, &original, &unedited, None).is_safe());
    let mut m = DocxModel::open(&original).unwrap();
    let mut ops = select_first_two();
    ops.push(comment("첫 메모"));
    m.apply(&ops);
    let first = m.export().unwrap();
    assert!(m.same_as(&first), "다시 연 모델이 같다");
    let checked = check_saved(Format::Docx, &original, &first, None, true);
    assert_eq!(checked.outcome, Outcome::Safe, "{:?}", checked.findings);
    let reopened = DocxModel::open(&first).unwrap();
    assert_eq!(
        reopened.comments(),
        vec![("geul".to_owned(), "첫 메모".to_owned(), false)]
    );

    // 두 번째 회차: 저장한 파일을 다시 열면 사전 검사는 safe, 메모 없는 편집(글자)은 저장된다.
    let again = DocxModel::open(&first).unwrap().export().unwrap();
    assert!(preflight(Format::Docx, &first, &again, None).is_safe());
    let mut typed = DocxModel::open(&first).unwrap();
    typed.apply(&[mv(MoveTarget::DocEnd, false), insert("끝")]);
    let typed_out = typed.export().unwrap();
    assert!(typed.same_as(&typed_out));
    assert!(check_saved(Format::Docx, &first, &typed_out, None, true).is_safe());
    assert_eq!(DocxModel::open(&typed_out).unwrap().comments().len(), 1);

    // 이미 메모가 있는 문서에 새 메모: 원본 메모는 그대로이고 새 메모가 끝에 덧붙으면 저장된다(다시 열어 둘 다 있음).
    let mut more = DocxModel::open(&first).unwrap();
    let second = vec![
        mv(MoveTarget::DocEnd, false),
        mv(MoveTarget::Left, true),
        mv(MoveTarget::Left, true),
        comment("둘째 메모"),
    ];
    assert_eq!(more.apply(&second).rejected, Vec::<usize>::new());
    let more_out = more.export().unwrap();
    assert!(more.same_as(&more_out));
    let checked = check_saved(Format::Docx, &first, &more_out, None, true);
    assert_eq!(checked.outcome, Outcome::Safe, "{:?}", checked.findings);
    let texts: Vec<String> = DocxModel::open(&more_out)
        .unwrap()
        .comments()
        .into_iter()
        .map(|c| c.1)
        .collect();
    assert_eq!(texts, vec!["첫 메모".to_owned(), "둘째 메모".to_owned()]);

    // 원본 메모를 지운 출력은 덧붙임이 아니다: 막는다(원본 메모 부분이 바뀜/사라짐).
    let mut removed = DocxModel::open(&first).unwrap();
    assert!(removed.run_engine("review.deleteComment", json!({"all": true})));
    let removed_out = removed.export().unwrap();
    let blocked = check_saved(Format::Docx, &first, &removed_out, None, true);
    assert_ne!(blocked.outcome, Outcome::Safe, "{:?}", blocked.findings);
    assert!(blocked
        .findings
        .iter()
        .any(|f| matches!(f.code, FindingCode::PartChanged | FindingCode::PartMissing)));
}

// ---- T013 각주·미주(references.footnote/endnote → WordCraft 같은 이름) ----

fn footnote(text: &str) -> DocxOp {
    DocxOp::Footnote { text: text.into() }
}

fn endnote(text: &str) -> DocxOp {
    DocxOp::Endnote { text: text.into() }
}

fn note_parts(m: &DocxModel, kind: wordcraft_engine::doc::PartKind) -> Vec<String> {
    let doc = m.diagnostic_document();
    doc.parts
        .iter()
        .filter(|(_, p)| p.kind == kind)
        .map(|(id, _)| {
            doc.plain_text(wordcraft_engine::doc::StoryRef::Part(*id))
                .trim()
                .to_owned()
        })
        .collect()
}

#[test]
fn 각주_연산의_글자와_ipc_모양은_계약_안이어야_한다() {
    for op in [footnote, endnote] {
        assert!(validate(&[op("근거")]));
        assert!(validate(&[op(&"가".repeat(super::engine::MAX_NOTE_CHARS))]));
        for bad in [
            String::new(),
            "  ".to_owned(),
            "줄\n바꿈".to_owned(),
            "\u{FFFC}".to_owned(),
            "가".repeat(super::engine::MAX_NOTE_CHARS + 1),
        ] {
            assert!(!validate(&[op(&bad)]), "{bad:?}");
        }
    }
    let parsed: DocxOp = serde_json::from_value(json!({"op": "footnote", "text": "a"})).unwrap();
    assert_eq!(parsed, footnote("a"));
    let parsed: DocxOp = serde_json::from_value(json!({"op": "endnote", "text": "a"})).unwrap();
    assert_eq!(parsed, endnote("a"));
    for raw in [
        json!({"op": "footnote", "text": "a", "mark": "*"}),
        json!({"op": "footnote"}),
        json!({"op": "references.footnote", "text": "a"}),
        json!({"op": "note", "kind": "footnote", "text": "a"}),
    ] {
        assert!(
            serde_json::from_value::<DocxOp>(raw.clone()).is_err(),
            "{raw}"
        );
    }
}

#[test]
fn 각주는_본문_커서에만_넣고_커서를_본문으로_돌리며_한_단계로_되돌린다() {
    use wordcraft_engine::doc::{InlineObject, PartKind};
    for (op, kind) in [
        (footnote as fn(&str) -> DocxOp, PartKind::Footnote),
        (endnote, PartKind::Endnote),
    ] {
        let mut m = model();
        let before = m.body_text();
        // 선택이 있으면 거부: 엔진은 선택을 지우고 넣지만 앱은 글자를 지우지 않는다.
        let mut ops = select_first_two();
        ops.push(op("x"));
        let outcome = m.apply(&ops);
        assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![3], 0));
        assert!(note_parts(&m, kind).is_empty());
        assert_eq!(m.body_text(), before);

        let outcome = m.apply(&[mv(MoveTarget::DocStart, false), op("각주 글")]);
        assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![], 1));
        assert_eq!(note_parts(&m, kind), vec!["각주 글".to_owned()]);
        let doc = m.diagnostic_document();
        let first = doc.body[0].as_para().unwrap();
        assert!(matches!(
            first.objects.first(),
            Some(InlineObject::NoteRef { .. })
        ));
        assert!(first.text.starts_with('\u{FFFC}'));
        // 커서는 본문의 표지 바로 뒤: 이어 친 글자는 본문에 들어간다(각주 안이 아님).
        assert!(
            m.view().caret_key.starts_with("body:"),
            "{}",
            m.view().caret_key
        );
        m.apply(&[insert("가")]);
        let first_text = |m: &DocxModel| {
            m.diagnostic_document().body[0]
                .as_para()
                .unwrap()
                .text
                .clone()
        };
        assert!(
            first_text(&m).starts_with("\u{FFFC}가"),
            "{:?}",
            first_text(&m)
        );
        assert_eq!(m.view().caret_key, "body:0:6");
        assert_eq!(note_parts(&m, kind), vec!["각주 글".to_owned()]);
        // 되돌리기: 글자 한 단계, 각주 한 단계.
        assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(m.body_text(), before);
        assert!(!first_text(&m).starts_with('\u{FFFC}'));
        // 되돌리면 각주 부분도 사라진다(고아 부분이 남으면 저장 동등성이 Err로 거부함).
        assert!(note_parts(&m, kind).is_empty());
        let undone = m.export().unwrap();
        assert!(m.same_as(&undone), "undone document still saves");
        assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
        assert!(first_text(&m).starts_with('\u{FFFC}'));
    }
}

#[test]
fn 각주_뒤에는_어댑터_기억을_버린다() {
    let mut m = model();
    m.apply(&[
        mv(MoveTarget::DocEnd, false),
        DocxOp::Mark { id: 3 },
        insert("가"),
    ]);
    m.apply(&[footnote("n")]);
    let (marks, recent, ..) = m.adapter_state();
    assert!(marks.is_empty());
    assert_eq!(recent, None);
}

#[test]
fn 읽기_전용_보호에서는_각주를_엔진이_거부한다() {
    let mut read_only = protected("readOnly", false, false);
    let outcome = read_only.apply(&[mv(MoveTarget::DocStart, false), footnote("x")]);
    assert_eq!(outcome.rejected, vec![1]);
    assert!(note_parts(&read_only, wordcraft_engine::doc::PartKind::Footnote).is_empty());
}

#[test]
fn 각주_저장_출력은_두_회차_모두_다시_열어_같고_보존_검사를_통과한다() {
    use crate::document::Format;
    use crate::services::save::service::check_saved;
    for op in [footnote as fn(&str) -> DocxOp, endnote] {
        let original = fixture();
        let mut m = DocxModel::open(&original).unwrap();
        m.apply(&[mv(MoveTarget::DocStart, false), op("첫 각주")]);
        let first = m.export().unwrap();
        assert!(m.same_as(&first));
        let verdict = check_saved(Format::Docx, &original, &first, None, true);
        assert!(verdict.is_safe(), "{verdict:?}");
        // 둘째 회차: 저장한 파일을 다시 열어 (기존 각주 앞에) 새 각주 — 번호가 다시 매겨진다.
        let mut m = DocxModel::open(&first).unwrap();
        m.apply(&[mv(MoveTarget::DocEnd, false), op("끝 각주")]);
        m.apply(&[mv(MoveTarget::DocStart, false), op("앞 각주")]);
        let second = m.export().unwrap();
        assert!(m.same_as(&second));
        let verdict = check_saved(Format::Docx, &first, &second, None, true);
        assert!(verdict.is_safe(), "{verdict:?}");
    }
}

// ---- T013 이미 변경 내용 추적이 켜진 DOCX(review.trackChanges는 연결하지 않음) ----

/// 이미 추적 중인 문서: 2026-11-05 Stage 1까지는 모든 변경 연산을 거부했다. Stage 3(WordCraft `b74830b`)에서 앱의 실제 연산 열이 저장
/// 검증을 통과해 정책을 풀었다(`TRACKED_READ_ONLY`). 보기는 읽기 전용이 아니고 편집은 추적된다.
#[test]
fn tracked_documents_are_editable_and_edits_are_tracked() {
    const { assert!(!super::engine::TRACKED_READ_ONLY) };
    let mut m = DocxModel::open(&tracked_fixture()).unwrap();
    let view = m.view();
    assert!(!view.tracked_read_only && view.tracking && !view.has_revisions);
    assert_eq!(view.format_access, super::engine::FormatAccess::Allowed);
    let outcome = m.apply(&[mv(MoveTarget::DocStart, false), insert("가")]);
    assert!(outcome.rejected.is_empty());
    assert_eq!(outcome.changed, 1);
    assert!(m.view().has_revisions);
    let doc = m.diagnostic_document();
    let first = doc.body[0].as_para().unwrap();
    assert!(first.props_of_char(0).ins.is_some(), "insertion is tracked");
}

/// Preserve the underlying WordCraft failure reproduction independently of the geul policy.
#[test]
fn raw_wordcraft_tracked_insertion_roundtrips() {
    use wordcraft_engine::doc::{
        roundtrip::{compare_roundtrip, Equivalence},
        Path, Pos, StoryRef,
    };
    use wordcraft_engine::{io, Session};

    let mut seed = io::open_bytes("x.docx", &fixture()).unwrap();
    seed.settings.track_changes = true;
    let mut session = Session::new(seed);
    session
        .run(
            "caret.set",
            &json!({"pos": Pos::new(StoryRef::Body, Path(vec![0]), 0)}),
        )
        .unwrap();
    session
        .run("text.insert", &json!({"text": "가", "raw": true}))
        .unwrap();
    let clean_insert = io::save_bytes("x.docx", &session.doc).unwrap();
    let reopened = io::open_bytes("x.docx", &clean_insert).unwrap();
    assert!(matches!(
        compare_roundtrip(&session.doc, &reopened, &Default::default()),
        Ok(Equivalence::Equivalent(_))
    ));
}

#[test]
fn raw_tracked_ime_replacement_round_trips() {
    use wordcraft_engine::doc::{
        roundtrip::{compare_roundtrip, Equivalence},
        Pos,
    };
    use wordcraft_engine::{io, Session};
    let mut seed = io::open_bytes("x.docx", &fixture()).unwrap();
    seed.settings.track_changes = true;
    let bytes = io::save_bytes("x.docx", &seed).unwrap();
    let mut session = Session::new(io::open_bytes("x.docx", &bytes).unwrap());
    session
        .run("caret.set", &json!({"pos": Pos::body(0, 0)}))
        .unwrap();
    session
        .run("text.insert", &json!({"text": "가", "raw": true}))
        .unwrap();
    session
        .run(
            "select.range",
            &json!({"anchor": Pos::body(0, 0), "focus": Pos::body(0, 3)}),
        )
        .unwrap();
    session
        .run("text.insert", &json!({"text": "각", "raw": true}))
        .unwrap();
    let bytes = io::save_bytes("x.docx", &session.doc).unwrap();
    let reopened = io::open_bytes("x.docx", &bytes).unwrap();
    // 2026-11-05 이전(WordCraft `b39a8fb`)에는 `Different(Field("revisions"))`였다. 수정 기록 색인 일대일 대응(`b74830b`) 뒤 같다.
    assert!(matches!(
        compare_roundtrip(&session.doc, &reopened, &Default::default()),
        Ok(Equivalence::Equivalent(_))
    ));
}

// ---- T013 목차(references.toc / references.updateToc → WordCraft 같은 이름) ----

/// 첫 두 문단을 제목 1·제목 2로 한 픽스처(제목 스타일은 geul 연산에 없으므로 엔진 명령으로 만든다).
fn headed_fixture() -> Vec<u8> {
    use wordcraft_engine::doc::{Path, Pos, StoryRef};
    let mut s = wordcraft_engine::Session::new(
        wordcraft_engine::io::open_bytes("x.docx", &fixture()).unwrap(),
    );
    for (i, style) in [(0u32, "Heading 1"), (1, "Heading 2")] {
        s.run(
            "caret.set",
            &json!({"pos": Pos::new(StoryRef::Body, Path(vec![i]), 0)}),
        )
        .unwrap();
        s.run("styles.apply", &json!({"style": style})).unwrap();
    }
    wordcraft_engine::io::save_bytes("x.docx", &s.doc).unwrap()
}

/// 그 문단 처음을 누른다(실제 클릭 연산).
fn click(m: &mut DocxModel, path: &[u32]) {
    let c = m.caret_of(&DocxModel::body_pos(path, 0)).unwrap();
    m.apply(&[pointer(c.page as u32, c.x + 0.5, c.y + c.height / 2.0)]);
}

/// 목차 제목과 항목 문단의 (스타일, 첫 탭 앞 글자).
fn toc_entries(m: &DocxModel) -> Vec<(String, String)> {
    m.diagnostic_document()
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .filter_map(|p| {
            let style = p.props.style.clone()?;
            style.starts_with("TOC").then(|| {
                let text = p.plain_text();
                (style, text.split('\t').next().unwrap_or("").to_owned())
            })
        })
        .collect()
}

#[test]
fn 목차_연산의_ipc_모양은_계약_안이어야_한다() {
    assert!(validate(&[DocxOp::Toc {}]));
    assert!(validate(&[DocxOp::UpdateToc {}]));
    let parsed: DocxOp = serde_json::from_value(json!({"op": "toc"})).unwrap();
    assert_eq!(parsed, DocxOp::Toc {});
    let parsed: DocxOp = serde_json::from_value(json!({"op": "updateToc"})).unwrap();
    assert_eq!(parsed, DocxOp::UpdateToc {});
    for bad in [
        json!({"op": "toc", "title": "x"}),
        json!({"op": "toc", "levels": 2}),
        json!({"op": "updateToc", "pages": false}),
        json!({"op": "references.toc"}),
        json!({"op": "insertToc"}),
    ] {
        assert!(
            serde_json::from_value::<DocxOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn 목차는_본문_커서에만_넣고_갱신은_목차가_있을_때만_하며_한_단계로_되돌린다() {
    let mut m = DocxModel::open(&headed_fixture()).unwrap();
    let before = m.diagnostic_document().clone();
    assert!(!m.view().has_toc);
    // 목차가 없으면 갱신은 거부(문서 그대로).
    let outcome = m.apply(&[DocxOp::UpdateToc {}]);
    assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![0], 0));
    // 선택이 있으면 넣기 거부(엔진은 선택을 지움).
    let mut ops = select_first_two();
    ops.push(DocxOp::Toc {});
    let outcome = m.apply(&ops);
    assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![3], 0));
    assert_eq!(*m.diagnostic_document(), before);
    // 표 셀 안의 커서도 거부.
    let mut cell = DocxModel::open(&headed_fixture()).unwrap();
    click(&mut cell, &[basic::TABLE_BLOCK, 0, 0, 0]);
    assert!(cell.view().in_table);
    assert_eq!(cell.apply(&[DocxOp::Toc {}]).rejected, vec![0]);

    let outcome = m.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}]);
    assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![], 1));
    assert!(m.view().has_toc);
    assert!(m.view().caret_key.starts_with("body:"));
    let entries = toc_entries(&m);
    assert_eq!(entries[0].0, "TOCHeading");
    assert_eq!(
        entries[1..],
        [
            ("TOC1".to_owned(), basic::PARAGRAPHS[0].to_owned()),
            ("TOC2".to_owned(), basic::PARAGRAPHS[1].to_owned())
        ]
    );
    // 갱신: 제목 글자를 바꾸면 항목이 따라온다.
    let last_heading = m
        .diagnostic_document()
        .body
        .iter()
        .position(|b| {
            b.as_para()
                .is_some_and(|p| p.props.style.as_deref() == Some("Heading2"))
        })
        .unwrap();
    click(&mut m, &[last_heading as u32]);
    m.apply(&[
        DocxOp::Move {
            to: MoveTarget::LineStart,
            extend: false,
        },
        insert("새 "),
    ]);
    let outcome = m.apply(&[DocxOp::UpdateToc {}]);
    assert_eq!((outcome.rejected.clone(), outcome.changed), (vec![], 1));
    assert_eq!(toc_entries(&m)[2].1, format!("새 {}", basic::PARAGRAPHS[1]));
    let output = m.export().unwrap();
    assert!(m.same_as(&output));
    // 되돌리기: 갱신 한 단계, 글자 한 단계, 목차 한 단계.
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(toc_entries(&m)[2].1, basic::PARAGRAPHS[1]);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!(!m.view().has_toc);
    assert_eq!(
        m.body_text(),
        before.plain_text(wordcraft_engine::doc::StoryRef::Body)
    );
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert!(m.view().has_toc);
    let redone = m.export().unwrap();
    assert!(m.same_as(&redone));
    // 어댑터 기억은 버린다.
    let (marks, recent, ..) = m.adapter_state();
    assert!(marks.is_empty());
    assert_eq!(recent, None);
}

#[test]
fn 읽기_전용_보호에서는_목차를_엔진이_거부한다() {
    let mut read_only = protected("readOnly", false, false);
    let outcome = read_only.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}]);
    assert_eq!(outcome.rejected, vec![1]);
    assert!(!read_only.view().has_toc);
}

#[test]
fn 목차_저장_출력은_새_문서와_기존_문서_두_회차_모두_다시_열어_같고_보존_검사를_통과한다() {
    use crate::document::Format;
    use crate::services::save::service::check_saved;
    // 새 문서(제목 없음: 빈 목차)와 제목이 있는 기존 문서.
    for (name, original) in [("plain", fixture()), ("headed", headed_fixture())] {
        let mut m = DocxModel::open(&original).unwrap();
        m.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}]);
        assert!(m.view().has_toc, "{name}");
        let first = m.export().unwrap();
        assert!(m.same_as(&first), "{name}");
        let verdict = check_saved(Format::Docx, &original, &first, None, true);
        assert!(verdict.is_safe(), "{name}: {verdict:?}");
        // 둘째 회차: 저장한 파일을 다시 열어 본문 끝 편집 + 갱신.
        let mut m = DocxModel::open(&first).unwrap();
        assert!(m.view().has_toc, "{name}");
        let entries = toc_entries(&m);
        m.apply(&[mv(MoveTarget::DocEnd, false), insert(" 끝")]);
        assert_eq!(
            m.apply(&[DocxOp::UpdateToc {}]).rejected,
            Vec::<usize>::new()
        );
        assert_eq!(toc_entries(&m), entries, "{name}");
        let second = m.export().unwrap();
        assert!(m.same_as(&second), "{name}");
        let verdict = check_saved(Format::Docx, &first, &second, None, true);
        assert!(verdict.is_safe(), "{name}: {verdict:?}");
    }
}

// ---- T013 Stage 3: 변경 내용 추적(review.trackChanges, 수락·거절) ----

fn tracked_fixture() -> Vec<u8> {
    let mut seed = wordcraft_engine::io::open_bytes("x.docx", &fixture()).unwrap();
    seed.settings.track_changes = true;
    wordcraft_engine::io::save_bytes("x.docx", &seed).unwrap()
}

/// 첫 문단의 (전체 글, 지운 표시가 없는 글).
fn first_texts(m: &DocxModel) -> (String, String) {
    let doc = m.diagnostic_document();
    let p = doc.body[0].as_para().unwrap();
    let mut live = String::new();
    for (range, props) in p.run_ranges() {
        if props.del.is_none() {
            live.push_str(&p.text[range]);
        }
    }
    (p.plain_text(), live.replace('\u{FFFC}', ""))
}

/// 추적 문서에서 실행한 출력: 모델 왕복 같음 + 원본 대비 T009 안전.
#[track_caller]
fn tracked_save_ok(name: &str, original: &[u8], m: &DocxModel) -> Vec<u8> {
    use crate::document::Format;
    use crate::services::save::service::check_saved;
    let out = m.export().unwrap();
    assert!(m.same_as(&out), "{name}: same_as");
    let verdict = check_saved(Format::Docx, original, &out, None, true);
    assert!(verdict.is_safe(), "{name}: {verdict:?}");
    out
}

#[test]
fn 추적_문서의_실제_연산_열은_모두_저장_동등하다() {
    let original = tracked_fixture();
    let p0 = basic::PARAGRAPHS[0];
    let cases: Vec<(&str, Vec<DocxOp>)> = vec![
        (
            "insert",
            vec![mv(MoveTarget::DocStart, false), insert("가")],
        ),
        (
            "ime correction",
            vec![
                mv(MoveTarget::DocStart, false),
                insert("가"),
                DocxOp::ReplaceInserted {
                    expected: "가".into(),
                    text: "각".into(),
                },
                insert("나"),
            ],
        ),
        (
            "late commit",
            vec![
                mv(MoveTarget::DocStart, false),
                DocxOp::Mark { id: 7 },
                insert("나"),
                DocxOp::InsertAt {
                    mark: 7,
                    text: "한".into(),
                },
            ],
        ),
        (
            "backspace original",
            vec![
                mv(MoveTarget::DocStart, false),
                mv(MoveTarget::Right, false),
                DocxOp::Backspace,
                insert("x"),
            ],
        ),
        (
            "delete forward original",
            vec![
                mv(MoveTarget::DocStart, false),
                DocxOp::DeleteForward,
                DocxOp::DeleteForward,
            ],
        ),
        (
            "backspace own insertion",
            vec![
                mv(MoveTarget::DocStart, false),
                insert("가나"),
                DocxOp::Backspace,
            ],
        ),
        ("selection replace + ime correction", {
            let mut ops = select_first_two();
            ops.push(insert("가"));
            ops.push(DocxOp::ReplaceInserted {
                expected: "가".into(),
                text: "각".into(),
            });
            ops
        }),
        (
            "paste",
            vec![
                mv(MoveTarget::DocEnd, false),
                DocxOp::PasteText {
                    text: "줄1\n줄2\t끝".into(),
                    chain: false,
                },
            ],
        ),
        (
            "new paragraph",
            vec![
                mv(MoveTarget::DocStart, false),
                mv(MoveTarget::Right, false),
                DocxOp::NewParagraph,
            ],
        ),
        ("bold", {
            let mut ops = select_first_two();
            ops.push(DocxOp::Format {
                format: super::engine::CharFormat::Bold,
            });
            ops
        }),
        ("comment", {
            let mut ops = select_first_two();
            ops.push(DocxOp::Comment {
                text: "메모".into(),
            });
            ops
        }),
        (
            "footnote",
            vec![mv(MoveTarget::DocEnd, false), footnote("각주")],
        ),
        ("toc", vec![mv(MoveTarget::DocStart, false), DocxOp::Toc {}]),
        (
            "undo redo",
            vec![
                mv(MoveTarget::DocStart, false),
                insert("가"),
                DocxOp::Backspace,
                DocxOp::Undo {},
                DocxOp::Undo {},
                DocxOp::Redo {},
            ],
        ),
    ];
    for (name, ops) in cases {
        let mut m = DocxModel::open(&original).unwrap();
        assert!(!m.view().tracked_read_only && m.view().tracking, "{name}");
        let outcome = m.apply(&ops);
        assert!(
            outcome.rejected.is_empty(),
            "{name}: {:?}",
            outcome.rejected
        );
        let first = tracked_save_ok(name, &original, &m);
        // 둘째 회차: 저장한 출력을 다시 열어 한 번 더 추적 편집.
        let mut again = DocxModel::open(&first).unwrap();
        assert!(again.view().tracking, "{name}");
        again.apply(&[mv(MoveTarget::DocEnd, false), insert("끝")]);
        tracked_save_ok(name, &first, &again);
    }
    // 위치 계약: 지운 원 글자는 문단에 남고(취소선), IME 교정·늦은 확정은 앱이 기억한 원 글자 좌표에 맞는다.
    let mut m = DocxModel::open(&original).unwrap();
    m.apply(&[
        mv(MoveTarget::DocStart, false),
        insert("가"),
        DocxOp::ReplaceInserted {
            expected: "가".into(),
            text: "각".into(),
        },
    ]);
    assert_eq!(first_texts(&m), (format!("각{p0}"), format!("각{p0}")));
    assert_eq!(m.view().caret_key, "body:0:3");
    let mut m = DocxModel::open(&original).unwrap();
    m.apply(&[
        mv(MoveTarget::DocStart, false),
        DocxOp::Mark { id: 1 },
        insert("나"),
        DocxOp::InsertAt {
            mark: 1,
            text: "한".into(),
        },
    ]);
    assert_eq!(first_texts(&m).1, format!("한나{p0}"));
    assert_eq!(
        m.view().caret_key,
        "body:0:6",
        "caret stays after the late-committed and typed text"
    );
    let mut m = DocxModel::open(&original).unwrap();
    let mut ops = select_first_two();
    ops.push(insert("가"));
    ops.push(DocxOp::ReplaceInserted {
        expected: "가".into(),
        text: "각".into(),
    });
    m.apply(&ops);
    let (all, live) = first_texts(&m);
    assert!(
        all.contains("한글") && !live.starts_with("한글"),
        "deleted text stays as tracked text: {all:?} / {live:?}"
    );
    assert!(live.starts_with('각'), "{live:?}");
    assert!(
        !all.contains('가'),
        "the provisional syllable is gone, not tracked: {all:?}"
    );
}

#[test]
fn 추적_켜기_끄기와_수락_거절은_한_단계이고_저장_동등하다() {
    use crate::document::Format;
    use crate::services::save::service::check_saved;
    let original = fixture();
    let mut m = DocxModel::open(&original).unwrap();
    assert!(!m.view().tracking && !m.view().has_revisions);
    // 변경이 없으면 수락·거절은 거부(문서 그대로).
    for op in [
        DocxOp::AcceptChange {},
        DocxOp::RejectChange {},
        DocxOp::AcceptAll {},
        DocxOp::RejectAll {},
    ] {
        assert_eq!(m.apply(&[op]).rejected, vec![0]);
    }
    assert_eq!(m.apply(&[DocxOp::TrackChanges { value: true }]).changed, 1);
    assert!(m.view().tracking);
    assert_eq!(
        m.apply(&[DocxOp::TrackChanges { value: true }]).changed,
        0,
        "same value: no change"
    );
    let on = m.export().unwrap();
    assert!(m.same_as(&on));
    let verdict = check_saved(Format::Docx, &original, &on, None, true);
    assert!(verdict.is_safe(), "{verdict:?}");
    m.apply(&[
        mv(MoveTarget::DocStart, false),
        insert("새 "),
        mv(MoveTarget::DocEnd, false),
        DocxOp::Backspace,
    ]);
    assert!(m.view().has_revisions);
    let tracked = m.export().unwrap();
    assert!(m.same_as(&tracked));
    // 커서 자리 수락 → 다른 변경 거절 → 전체.
    m.apply(&[
        mv(MoveTarget::DocStart, false),
        mv(MoveTarget::Right, false),
    ]);
    assert_eq!(m.apply(&[DocxOp::AcceptChange {}]).changed, 1);
    assert!(m.body_text().starts_with("새 "));
    assert!(m.view().has_revisions);
    assert_eq!(m.apply(&[DocxOp::RejectAll {}]).changed, 1);
    assert!(!m.view().has_revisions);
    let resolved = m.export().unwrap();
    assert!(m.same_as(&resolved));
    // 실행 취소: 전체 거절 한 단계, 수락 한 단계.
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!(m.view().has_revisions);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!(m.same_as(&m.export().unwrap()));
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    // 끄기: 그 뒤 편집은 추적하지 않는다.
    let mut m = DocxModel::open(&tracked).unwrap();
    assert_eq!(m.apply(&[DocxOp::TrackChanges { value: false }]).changed, 1);
    m.apply(&[DocxOp::AcceptAll {}]);
    m.apply(&[mv(MoveTarget::DocEnd, false), insert("평문")]);
    assert!(!m.view().has_revisions);
    let off = m.export().unwrap();
    assert!(m.same_as(&off));
    let verdict = check_saved(Format::Docx, &tracked, &off, None, true);
    assert!(verdict.is_safe(), "{verdict:?}");
}

#[test]
fn tracked_toc_bookmark_deletion_preserves_revision_on_two_roundtrips() {
    use crate::document::Format;
    use crate::services::save::service::check_saved;
    use wordcraft_engine::doc::{InlineObject, Pos};
    let original = headed_fixture();
    let mut model = DocxModel::open(&original).unwrap();
    model.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}]);
    let (index, off) = model
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .find_map(|(i, block)| {
            let p = block.as_para()?;
            p.object_offsets()
                .into_iter()
                .find(|off| matches!(p.object_at(*off), Some(InlineObject::BookmarkEnd { .. })))
                .map(|off| (i, off + wordcraft_engine::doc::para::OBJ.len_utf8()))
        })
        .unwrap();
    model.apply(&[DocxOp::TrackChanges { value: true }]);
    assert!(model.run_engine("caret.set", json!({"pos": Pos::body(index, off)})));
    assert_eq!(model.apply(&[DocxOp::Backspace]).changed, 1);
    assert!(model.diagnostic_document().body[index]
        .as_para()
        .unwrap()
        .props_of_char(off - wordcraft_engine::doc::para::OBJ.len_utf8())
        .del
        .is_some());
    let first = model.export().unwrap();
    assert!(model.same_as(&first));
    assert!(check_saved(Format::Docx, &original, &first, None, true).is_safe());
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
    assert!(model.same_as(&model.export().unwrap()));
    let reopened = DocxModel::open(&first).unwrap();
    let second = reopened.export().unwrap();
    assert!(reopened.same_as(&second));
    assert!(check_saved(Format::Docx, &first, &second, None, true).is_safe());
}

#[test]
fn resolving_tracked_toc_bookmark_boundaries_preserves_the_surviving_range() {
    use wordcraft_engine::doc::{InlineObject, Pos};
    for operation in [
        DocxOp::AcceptChange {},
        DocxOp::RejectChange {},
        DocxOp::AcceptAll {},
        DocxOp::RejectAll {},
    ] {
        for kind in ["start", "end", "prefix"] {
            let end = kind == "end";
            let mut m = DocxModel::open(&headed_fixture()).unwrap();
            assert_eq!(
                m.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}])
                    .changed,
                1
            );
            let index = m
                .diagnostic_document()
                .body
                .iter()
                .position(|b| {
                    b.as_para()
                        .is_some_and(|p| p.props.style.as_deref() == Some("Heading2"))
                })
                .unwrap();
            let paragraph = m.diagnostic_document().body[index].as_para().unwrap();
            let visible = paragraph.plain_text();
            let first_char_bytes = paragraph
                .text
                .get(wordcraft_engine::doc::para::OBJ.len_utf8()..)
                .unwrap()
                .chars()
                .next()
                .unwrap()
                .len_utf8();
            let off = if end {
                paragraph
                    .object_offsets()
                    .into_iter()
                    .find(|off| {
                        matches!(
                            paragraph.object_at(*off),
                            Some(InlineObject::BookmarkEnd { .. })
                        )
                    })
                    .unwrap()
            } else {
                0
            };
            assert!(m
                .apply(&[
                    DocxOp::TrackChanges { value: true },
                    mv(MoveTarget::DocEnd, false),
                    insert("unrelated revision")
                ])
                .rejected
                .is_empty());
            assert!(m.run_engine("caret.set", json!({"pos": Pos::body(index, off)})));
            if kind == "prefix" {
                assert!(m.run_engine("select.range", json!({"anchor": Pos::body(index, 0), "focus": Pos::body(index, wordcraft_engine::doc::para::OBJ.len_utf8() + first_char_bytes)})));
            }
            assert_eq!(m.apply(&[DocxOp::DeleteForward]).changed, 1);
            let tracked = m.diagnostic_document().clone();
            assert!(m.same_as(&m.export().unwrap()));
            let outcome = m.apply(std::slice::from_ref(&operation));
            assert_eq!(
                (outcome.changed, outcome.rejected),
                (1, vec![]),
                "{operation:?} end={end}"
            );
            let expected: String = if kind == "prefix"
                && matches!(operation, DocxOp::AcceptChange {} | DocxOp::AcceptAll {})
            {
                visible.chars().skip(1).collect()
            } else {
                visible.clone()
            };
            assert_eq!(
                m.diagnostic_document().body[index]
                    .as_para()
                    .unwrap()
                    .plain_text(),
                expected
            );
            if matches!(operation, DocxOp::AcceptChange {} | DocxOp::RejectChange {}) {
                assert!(m.view().has_revisions);
            }
            let resolved = m.diagnostic_document().clone();
            assert!(m.same_as(&m.export().unwrap()));
            assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
            assert_eq!(*m.diagnostic_document(), tracked);
            assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
            assert_eq!(*m.diagnostic_document(), resolved);
            assert!(m
                .apply(&[DocxOp::UpdateToc {}, DocxOp::UpdateToc {}])
                .rejected
                .is_empty());
            assert!(m.same_as(&m.export().unwrap()));
        }
    }
}

#[test]
fn invalid_tracked_toc_marker_structure_still_refuses_atomically() {
    use wordcraft_engine::doc::{InlineObject, Path, StoryRef};
    let mut m = DocxModel::open(&headed_fixture()).unwrap();
    m.apply(&[
        mv(MoveTarget::DocStart, false),
        DocxOp::Toc {},
        DocxOp::TrackChanges { value: true },
        mv(MoveTarget::DocEnd, false),
        insert("tracked tail"),
    ]);
    let (index, off) = m
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .find_map(|(i, b)| {
            let p = b.as_para()?;
            p.object_offsets()
                .into_iter()
                .find(|off| matches!(p.object_at(*off), Some(InlineObject::BookmarkStart { .. })))
                .map(|off| (i, off))
        })
        .unwrap();
    m.diagnostic_document_mut()
        .para_mut(StoryRef::Body, &Path::top(index))
        .unwrap()
        .delete(off, off + wordcraft_engine::doc::para::OBJ.len_utf8())
        .unwrap();
    let before = m.diagnostic_document().clone();
    let history = m.view().history;
    for operation in [
        DocxOp::AcceptAll {},
        DocxOp::RejectAll {},
        DocxOp::UpdateToc {},
    ] {
        let outcome = m.apply(&[operation]);
        assert_eq!((outcome.changed, outcome.rejected), (0, vec![0]));
        assert_eq!(*m.diagnostic_document(), before);
        assert_eq!(m.view().history, history);
    }
}

#[test]
fn accepting_a_whole_bookmarked_heading_refreshes_the_toc_in_one_undo_step() {
    // WordCraft 2026-11-08: removing a live TOC target regenerates the TOC from the surviving
    // headings inside the same accept command (previously refused atomically).
    use wordcraft_engine::doc::Pos;
    for selected in [false, true] {
        let mut m = DocxModel::open(&headed_fixture()).unwrap();
        m.apply(&[mv(MoveTarget::DocStart, false), DocxOp::Toc {}]);
        let entries = toc_entries(&m);
        let index = m
            .diagnostic_document()
            .body
            .iter()
            .position(|b| {
                b.as_para()
                    .is_some_and(|p| p.props.style.as_deref() == Some("Heading2"))
            })
            .unwrap();
        let removed = m.diagnostic_document().body[index]
            .as_para()
            .unwrap()
            .plain_text();
        let len = m.diagnostic_document().body[index].as_para().unwrap().len();
        assert_eq!(m.apply(&[DocxOp::TrackChanges { value: true }]).changed, 1);
        let range = json!({"anchor": Pos::body(index, 0), "focus": Pos::body(index, len)});
        assert!(m.run_engine("select.range", range.clone()));
        assert_eq!(m.apply(&[DocxOp::DeleteForward]).changed, 1);
        assert!(m.same_as(&m.export().unwrap()));
        let tracked = m.diagnostic_document().clone();
        let operation = if selected {
            assert!(m.run_engine("select.range", range));
            DocxOp::AcceptChange {}
        } else {
            DocxOp::AcceptAll {}
        };
        let outcome = m.apply(std::slice::from_ref(&operation));
        assert_eq!(
            (outcome.changed, outcome.rejected),
            (1, vec![]),
            "{operation:?}"
        );
        let after = toc_entries(&m);
        assert!(after.len() < entries.len(), "{entries:?} -> {after:?}");
        assert!(!after.iter().any(|(_, text)| text == &removed), "{after:?}");
        let names: Vec<String> = m
            .diagnostic_document()
            .bookmarks()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        for p in m
            .diagnostic_document()
            .body
            .iter()
            .filter_map(|b| b.as_para())
        {
            for link in p.runs.iter().filter_map(|r| r.props.link.as_deref()) {
                if let Some(target) = link.strip_prefix('#') {
                    assert!(names.iter().any(|n| n == target), "dangling {link}");
                }
            }
        }
        let resolved = m.diagnostic_document().clone();
        assert!(m.same_as(&m.export().unwrap()));
        assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(*m.diagnostic_document(), tracked);
        assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
        assert_eq!(*m.diagnostic_document(), resolved);
        assert!(m.apply(&[DocxOp::UpdateToc {}]).rejected.is_empty());
        assert!(m.same_as(&m.export().unwrap()));
    }
}

#[test]
fn clipboard_full_unicode_paragraphs_are_read_only_and_not_preview() {
    let bytes = crate::services::files::blank_docx().unwrap();
    let mut m = DocxModel::open(&bytes).unwrap();
    assert_eq!(m.clipboard_text(), None);
    let expected = format!("{}\n끝\t글", "한😀글".repeat(300));
    m.apply(&[
        DocxOp::PasteText {
            text: expected.clone(),
            chain: false,
        },
        DocxOp::SelectAll,
    ]);
    let before = m.export().unwrap();
    let view = m.view();
    assert!(view.clipboard_text_available);
    assert_eq!(view.selection_text, None);
    assert_eq!(m.clipboard_text(), Some(expected));
    assert!(m.clipboard_selection_matches(&view.anchor_key, &view.caret_key));
    assert!(!m.clipboard_selection_matches("stale", &view.caret_key));
    assert_eq!(m.export().unwrap(), before);
    m.apply(&[DocxOp::DeleteSelection { selection: None }]);
    let after = m.export().unwrap();
    assert!(m.same_as(&after));
    assert_eq!(m.view().paragraph_text, "");
}

#[test]
fn clipboard_ipc_revalidates_session_revision_generation_and_selection() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let loaded = loaded(&state, &dir);
    let id = loaded.session.session_id;
    let selected = block_on(commands::edit(&state, id, 1, 0, select_first_two())).unwrap();
    let v = selected.view;
    let get = |generation, revision, anchor: String| {
        block_on(commands::selection_text(
            &state,
            id,
            generation,
            revision,
            anchor,
            v.caret_key.clone(),
        ))
    };
    assert!(get(1, 0, v.anchor_key.clone()).is_ok());
    assert!(get(2, 0, v.anchor_key.clone()).is_err());
    assert!(get(1, 1, v.anchor_key.clone()).is_err());
    assert!(get(1, 0, "stale".into()).is_err());
    assert_eq!(state.registry().get(id).unwrap().revision, 0);
    assert!(!state.registry().get(id).unwrap().dirty);
}

#[test]
fn clipboard_cut_guard_rejects_selection_changed_under_backend_lock() {
    let mut m = model();
    m.apply(&select_first_two());
    let v = m.view();
    let cut = DocxOp::DeleteSelection {
        selection: Some(super::engine::SelectionIdentity {
            anchor_key: v.anchor_key,
            caret_key: v.caret_key,
        }),
    };
    m.apply(&[mv(MoveTarget::Right, true)]);
    let before = m.export().unwrap();
    let result = m.apply(std::slice::from_ref(&cut));
    assert_eq!(result.changed, 0);
    assert_eq!(result.rejected, vec![0]);
    assert_eq!(m.export().unwrap(), before);
    // An intact guard uses the original DeleteSelection path and engine history.
    m.apply(&select_first_two());
    assert_eq!(m.apply(&[cut]).changed, 1);
}

#[test]
fn clipboard_table_object_cross_context_and_empty_ranges_fail_closed() {
    let mut m = model();
    m.apply(&[DocxOp::SelectAll]);
    assert_eq!(m.clipboard_text(), None); // fixture includes a whole table
    assert!(!m.view().clipboard_text_available);
    m.apply(&[mv(MoveTarget::DocStart, false)]);
    assert_eq!(m.clipboard_text(), None);
}

/// P2-B measurement (run explicitly with --ignored --nocapture): share of the
/// per-view availability proof in one full DOCX view generation.
#[test]
#[ignore]
fn clipboard_availability_cost_relative_to_view() {
    let bytes = crate::services::files::blank_docx().unwrap();
    for (paragraphs, size) in [(1usize, 600usize), (200, 500), (1, 200_000)] {
        let mut m = DocxModel::open(&bytes).unwrap();
        let line: String = "한😀글a".chars().cycle().take(size).collect();
        let text = vec![line; paragraphs].join("\n");
        m.apply(&[DocxOp::PasteText { text, chain: false }, DocxOp::SelectAll]);
        let start = std::time::Instant::now();
        let available = m.clipboard_text().is_some();
        let probe = start.elapsed();
        let start = std::time::Instant::now();
        let view = m.view();
        let whole = start.elapsed();
        assert!(available && view.clipboard_text_available);
        println!("[P2-B docx] {paragraphs}x{size}: clipboard_text {probe:?}, full view {whole:?}");
    }
}

#[test]
fn core_table_context_validation_and_empty_reopen() {
    assert!(!validate(&[DocxOp::Table { rows: 0, cols: 2 }]));
    assert!(!validate(&[DocxOp::Table { rows: 32, cols: 16 }]));
    assert!(validate(&[DocxOp::Table { rows: 16, cols: 16 }]));
    let bytes = wordcraft_engine::io::save_bytes(
        "x.docx",
        &wordcraft_engine::blank_document(&Default::default()),
    )
    .unwrap();
    let mut m = DocxModel::open(&bytes).unwrap();
    assert_eq!(m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).changed, 1);
    assert_eq!(m.apply(&[insert("한글 셀")]).changed, 1);
    assert!(m.round_trip().unwrap().passed);
    let mut m = model();
    m.apply(&[mv(MoveTarget::Right, true)]);
    let before = m.export().unwrap();
    assert_eq!(
        m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).rejected,
        vec![0]
    );
    assert_eq!(m.export().unwrap(), before);
    let mut m = DocxModel::open(&basic::protected_ko("readOnly", false).unwrap()).unwrap();
    assert_eq!(
        m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).rejected,
        vec![0]
    );
}

#[test]
fn core_insertions_use_wordcraft_history_without_losing_resources() {
    for op in [DocxOp::Table { rows: 2, cols: 2 }, DocxOp::Bullets {}] {
        let mut m = model();
        let before = m.export().unwrap();
        assert_eq!(m.apply(&[op]).changed, 1);
        let after = m.export().unwrap();
        assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
        assert!(m.same_as(&before));
        assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
        assert!(m.same_as(&after));
    }
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 3)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let mut m = model();
    let before = m.export().unwrap();
    assert_eq!(
        m.apply(&[DocxOp::Image {
            data: wordcraft_engine::cmd::insert::base64_encode(encoded.get_ref())
        }])
        .changed,
        1
    );
    let after = m.export().unwrap();
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!(m.same_as(&before));
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert!(m.same_as(&after));
}

// ---- PDF export (Stage 5-A S5-4) ----

#[test]
fn pdf_내보내기는_엔진_pdf를_만들고_모델을_바꾸지_않는다() {
    let mut m = model();
    m.apply(&[insert("가나다")]);
    let before = (m.export().unwrap(), m.adapter_state(), m.view().pages.len());
    let (pdf, pages) = m.export_pdf().expect("PDF");
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(pages, before.2, "every layout page is exported once");
    assert_eq!(
        (m.export().unwrap(), m.adapter_state(), m.view().pages.len()),
        before
    );
}

/// Private directory for publication (the protected sandbox /tmp is a shared tmpfs and is refused).
fn private_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("geul-docx-pdf-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    dir
}

#[test]
fn pdf_내보내기_명령은_그_판만_쓰고_세션과_원본은_그대로다() {
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    let original = std::fs::read(dir.path().join("a.docx")).unwrap();
    block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])).unwrap();
    let out = private_dir("command");
    let target = out.join("out.pdf");
    let path = target.to_str().unwrap().to_owned();
    // Stale revision, wrong generation and non-PDF destinations are refused before writing.
    assert!(matches!(
        block_on(commands::export_pdf(&state, id, 1, 0, &path, None)),
        Err(DocumentError::RevisionMismatch { revision: 1, .. })
    ));
    assert!(block_on(commands::export_pdf(&state, id, 2, 1, &path, None)).is_err());
    let docx_target = out.join("out.docx");
    assert_eq!(
        block_on(commands::export_pdf(
            &state,
            id,
            1,
            1,
            docx_target.to_str().unwrap(),
            None
        )),
        Err(DocumentError::InvalidRequest)
    );
    assert!(!target.exists() && !docx_target.exists());
    let before = state.registry().get(id).unwrap();
    let exported = block_on(commands::export_pdf(&state, id, 1, 1, &path, None)).expect("export");
    assert_eq!(
        (exported.session_id, exported.revision, exported.raster),
        (id, 1, false)
    );
    let bytes = std::fs::read(&target).unwrap();
    assert!(bytes.starts_with(b"%PDF-") && bytes.len() == exported.bytes);
    // Session record (revision, dirty, sequence) and the source file are unchanged.
    assert_eq!(state.registry().get(id).unwrap(), before);
    assert_eq!(std::fs::read(dir.path().join("a.docx")).unwrap(), original);
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn obsolete_docx_pdf_results_are_never_published() {
    use crate::services::pdf::{destination, issue_overwrite_grant, BEFORE_PUBLICATION};
    let state = DocumentState::default();
    let dir = TempDir::new();
    let docx = loaded(&state, &dir);
    let id = docx.session.session_id;
    block_on(commands::edit(&state, id, 1, 0, vec![insert("가")])).unwrap();
    let out = private_dir("obsolete");
    // A real PDF of revision 1 (the "asynchronous result").
    let first = out.join("first.pdf");
    block_on(commands::export_pdf(
        &state,
        id,
        1,
        1,
        first.to_str().unwrap(),
        None,
    ))
    .unwrap();
    let bytes = std::fs::read(&first).unwrap();
    let publish = |gen: u64, rev: u64, name: &str, grant: Option<&str>| {
        let target = destination(out.join(name).to_str().unwrap()).unwrap();
        let result =
            commands::publish_current_pdf(state.registry(), id, gen, rev, &target, &bytes, grant);
        (result, target)
    };
    // Still current: publishable; PDF export does not change the session record.
    let before = state.registry().get(id).unwrap();
    let (ok, target) = publish(1, 1, "current.pdf", None);
    ok.unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert_eq!(state.registry().get(id).unwrap(), before);

    // An edit committed after staging but before the publication point (deterministic hook): refused,
    // nothing written; an existing confirmed destination keeps its bytes and its grant is consumed.
    let kept = out.join("kept.pdf");
    std::fs::write(&kept, b"%PDF-1.7\nkept\n%%EOF").unwrap();
    let grant = issue_overwrite_grant(kept.to_str().unwrap(), id, 1);
    let registry = state.registry().clone();
    BEFORE_PUBLICATION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            registry.commit(id, 1, 1, 1).unwrap();
        }))
    });
    let (stale, kept_target) = publish(1, 1, "kept.pdf", grant.as_deref());
    BEFORE_PUBLICATION.with(|hook| *hook.borrow_mut() = None);
    assert!(
        matches!(
            stale,
            Err(DocumentError::RevisionMismatch { revision: 2, .. })
        ),
        "{stale:?}"
    );
    assert_eq!(std::fs::read(&kept).unwrap(), b"%PDF-1.7\nkept\n%%EOF");
    let (reused, _) = publish(2, 2, "kept.pdf", grant.as_deref());
    assert_eq!(
        reused.err(),
        Some(DocumentError::FileConflict),
        "the grant was consumed by the refused export"
    );
    assert_eq!(
        std::fs::read(&kept_target).unwrap(),
        b"%PDF-1.7\nkept\n%%EOF"
    );

    // A grant issued for this session cannot be used by another session's export.
    let other = issue_overwrite_grant(kept.to_str().unwrap(), id + 100, 1);
    let (foreign, _) = publish(1, 2, "kept.pdf", other.as_deref());
    assert_eq!(foreign.err(), Some(DocumentError::FileConflict));

    // Reload (new load generation, new model): the old generation's result is obsolete.
    block_on(commands::load(&state, id, Some(1))).unwrap();
    let (reloaded, target) = publish(1, 2, "reloaded.pdf", None);
    assert!(
        matches!(
            reloaded,
            Err(DocumentError::StaleLoad {
                load_generation: 2,
                ..
            })
        ),
        "{reloaded:?}"
    );
    assert!(!target.exists());

    // Session closed (and its model released) right before the publication point.
    let registry = state.registry().clone();
    let models = state.wordcraft().clone();
    BEFORE_PUBLICATION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            registry.close(id).unwrap();
            models.release(id);
        }))
    });
    let (closed, target) = publish(2, 0, "closed.pdf", None);
    BEFORE_PUBLICATION.with(|hook| *hook.borrow_mut() = None);
    assert!(
        matches!(
            closed,
            Err(DocumentError::StaleSession { .. }) | Err(DocumentError::UnknownSession { .. })
        ),
        "{closed:?}"
    );
    assert!(!target.exists());
    let _ = std::fs::remove_dir_all(&out);
}

// ---- Stage 2 Phase 1: DOCX Table Structure Editing ----

fn table_target(m: &mut DocxModel) -> super::engine::SelectionIdentity {
    let v = m.view();
    super::engine::SelectionIdentity {
        anchor_key: v.anchor_key,
        caret_key: v.caret_key,
    }
}

fn table_op(
    m: &mut DocxModel,
    action: super::engine::table::TableStructureAction,
) -> super::engine::EditOutcome {
    let target = table_target(m);
    m.apply(&[DocxOp::TableStructure {
        action,
        target,
        rows: None,
        columns: None,
    }])
}

fn body_table_texts(m: &DocxModel) -> Vec<Vec<Vec<String>>> {
    let t = m
        .diagnostic_document()
        .body
        .iter()
        .rev()
        .find_map(|b| b.as_table())
        .expect("table");
    t.rows
        .iter()
        .map(|r| {
            r.cells
                .iter()
                .map(|c| {
                    c.blocks
                        .iter()
                        .filter_map(|b| b.as_para().map(|p| p.plain_text()))
                        .collect()
                })
                .collect()
        })
        .collect()
}

#[test]
fn stage2_p1_all_ten_docx_table_commands_preserve_content_undo_layout_and_reopen() {
    use super::engine::table::TableStructureAction as A;

    let mut m = model();
    assert!(m.view().table.is_none(), "body paragraph has no table state");
    assert_eq!(m.apply(&[mv(MoveTarget::DocEnd, false)]).changed, 0);
    assert_eq!(m.apply(&[DocxOp::NewParagraph]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).changed, 1);

    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let img_b64 = wordcraft_engine::cmd::insert::base64_encode(encoded.get_ref());
    // Fill cells: A1 (bold), B1 (with inline image), A2, B2
    assert_eq!(m.apply(&[insert("A1")]).changed, 1);
    assert_eq!(
        m.apply(&[DocxOp::Tab { back: false }, insert("B1")]).changed,
        1
    );
    assert!(m.run_engine("insert.picture", json!({ "data": img_b64 })));
    assert_eq!(
        m.apply(&[DocxOp::Tab { back: false }, insert("A2")]).changed,
        1
    );
    assert_eq!(
        m.apply(&[DocxOp::Tab { back: false }, insert("B2")]).changed,
        1
    );

    let tv = m.view().table.expect("in table");
    assert_eq!((tv.rows, tv.cols, tv.row, tv.col), (2, 2, 1, 1));
    assert_eq!(tv.insert_row_above, None);
    assert_eq!(tv.insert_row_below, None);
    assert_eq!(tv.insert_column_left, None);
    assert_eq!(tv.insert_column_right, None);
    assert_eq!(tv.delete_row, None);
    assert_eq!(tv.delete_column, None);
    assert_eq!(tv.merge_right, Some("tableShape"));
    assert_eq!(tv.merge_below, Some("tableShape"));
    assert_eq!(tv.merge_cells, Some("tableShape"));
    assert_eq!(tv.split_cell, None);
    assert!(tv.max_split_rows >= 2 && tv.max_split_columns >= 2);

    // 1-4: Insert Row Above/Below, Insert Column Left/Right + Undo/Redo
    assert_eq!(table_op(&mut m, A::InsertRowAbove).changed, 1);
    assert_eq!(body_table_texts(&m).len(), 3);
    assert_eq!(table_op(&mut m, A::InsertRowBelow).changed, 1);
    assert_eq!(body_table_texts(&m).len(), 4);
    assert_eq!(table_op(&mut m, A::InsertColumnLeft).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 3);
    assert_eq!(table_op(&mut m, A::InsertColumnRight).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 4);

    // 5-6: Delete Row and Delete Column (first deleting col 2 at caret, then blank col 1 & blank rows 1-2)
    let tp = m
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i as u32))
        .unwrap();
    assert_eq!(table_op(&mut m, A::DeleteColumn).changed, 1);
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 2, 1, 0], "off": 0 } })
    ));
    assert_eq!(table_op(&mut m, A::DeleteColumn).changed, 1);
    assert_eq!(table_op(&mut m, A::DeleteRow).changed, 1);
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 1, 1, 0], "off": 0 } })
    ));
    assert_eq!(table_op(&mut m, A::DeleteRow).changed, 1);
    assert_eq!(
        body_table_texts(&m),
        vec![vec![vec!["A1"], vec!["B1"]], vec![vec!["A2"], vec!["B2"]]]
    );
    assert_eq!(
        m.diagnostic_document()
            .body[tp as usize]
            .as_table()
            .unwrap()
            .rows[0]
            .cells[1]
            .blocks[0]
            .as_para()
            .unwrap()
            .objects
            .len(),
        1
    );

    // 7: Merge Right from (0,0) preserves A1 + B1 (and its inline image!), Undo/Redo works
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 } })
    ));
    assert_eq!(m.view().table.as_ref().unwrap().merge_right, None);
    assert_eq!(table_op(&mut m, A::MergeRight).changed, 1);
    assert_eq!(body_table_texts(&m)[0], vec![vec!["A1", "B1"]]);
    assert_eq!(
        m.diagnostic_document()
            .body[tp as usize]
            .as_table()
            .unwrap()
            .rows[0]
            .cells[0]
            .blocks[1]
            .as_para()
            .unwrap()
            .objects
            .len(),
        1
    );
    assert_eq!(m.view().table.as_ref().unwrap().split_cell, None);

    // 10: Split merged cell preserves content in top-left and initializes empty right cell
    assert_eq!(table_op(&mut m, A::SplitCell).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 2);
    assert_eq!(body_table_texts(&m)[0][0], vec!["A1", "B1"]);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 1);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 2);

    // 8: Merge Below (0,0) + (1,0), then splitCell vertically
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 } })
    ));
    assert_eq!(m.view().table.as_ref().unwrap().merge_below, None);
    assert_eq!(table_op(&mut m, A::MergeBelow).changed, 1);
    assert_eq!(body_table_texts(&m)[0][0], vec!["A1", "B1", "A2"]);
    // Right cell is shorter vertically -> merge_right refused, split_cell allowed
    let tv = m.view().table.unwrap();
    assert_eq!(tv.merge_right, Some("tableShape"));
    assert_eq!(tv.split_cell, None);
    assert_eq!(table_op(&mut m, A::SplitCell).changed, 1);

    // 9: Rectangular Merge Cells (2x2) + Split Cell + render + save/reopen + continue editing
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 }, "extend": false })
    ));
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 1, 1, 0], "off": 2 }, "extend": true })
    ));
    let tv = m.view().table.unwrap();
    assert_eq!(tv.selected_cells, 4);
    assert_eq!(tv.merge_cells, None);
    assert!(
        !m.view().selection.is_empty(),
        "cell range selection rectangles must be exposed"
    );
    assert_eq!(table_op(&mut m, A::MergeCells).changed, 1);
    assert_eq!(
        body_table_texts(&m)[0][0],
        vec!["A1", "B1", "A2", "B2"]
    );
    assert_eq!(table_op(&mut m, A::SplitCell).changed, 1);
    assert!(m.render_png(0, 1.0).is_some());
    let exported = m.export().unwrap();
    assert!(m.same_as(&exported));
    let mut reopened = DocxModel::open(&exported).unwrap();
    assert!(reopened.same_as(&exported));
    assert!(reopened.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 1, 0], "off": 0 } })
    ));
    assert_eq!(reopened.apply(&[insert("Continued")]).changed, 1);
    assert!(reopened.round_trip().unwrap().passed);
    // Deleting a column containing an inline image prunes unused media for safe roundtrip, and Undo restores it
    assert!(reopened.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 1, 0], "off": 0 } })
    ));
    let mut encoded2 = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2)
        .write_to(&mut encoded2, image::ImageFormat::Png)
        .unwrap();
    let img_b64_2 = wordcraft_engine::cmd::insert::base64_encode(encoded2.get_ref());
    assert!(reopened.run_engine("insert.picture", json!({ "data": img_b64_2 })));
    assert_eq!(table_op(&mut reopened, A::DeleteColumn).changed, 1);
    assert_eq!(reopened.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(reopened.apply(&[DocxOp::Redo {}]).changed, 1);
    assert!(reopened.round_trip().unwrap().passed);
}

#[test]
fn stage2_p1_docx_table_nested_negatives_and_t009_publication() {
    use super::engine::table::TableStructureAction as A;
    use crate::services::save::package;

    // Negative 1: stale target, malformed JSON, outside table, 1x1 split, single-cell selection mergeCells, overhang, delete last row/col, protected doc
    let mut m = model();
    let outside = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableStructure {
            action: A::InsertRowAbove,
            target: outside.clone(),
            rows: None,
            columns: None,
        }])
        .rejected,
        vec![0]
    );
    assert!(serde_json::from_str::<DocxOp>(r#"{"op":"tableStructure","action":"mergeRight","target":{"anchorKey":"a","caretKey":"b"},"extra":1}"#).is_err());
    assert!(!validate(&[DocxOp::TableStructure {
        action: A::MergeRight,
        target: super::engine::SelectionIdentity {
            anchor_key: String::new(),
            caret_key: "body:0:0".into(),
        },
        rows: None,
        columns: None,
    }]));

    // Build a document with a body table, an existing 2x1 vertical merge in col 0, and a nested table in (1,1)
    assert_eq!(m.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).changed, 1);
    assert_eq!(m.apply(&[insert("Outer00")]).changed, 1);
    let stale_target = table_target(&mut m);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Outer01")]).changed, 1);
    // Stale target rejected without changing model
    let rev_before = m.adapter_state().2;
    assert_eq!(
        m.apply(&[DocxOp::TableStructure {
            action: A::InsertRowBelow,
            target: stale_target,
            rows: None,
            columns: None,
        }])
        .rejected,
        vec![0]
    );
    assert_eq!(m.adapter_state().2, rev_before);

    // Ordinary text selection inside a single cell does NOT enable mergeCells
    assert_eq!(m.apply(&[mv(MoveTarget::Left, true)]).changed, 0);
    assert_eq!(m.view().table.as_ref().unwrap().merge_cells, Some("tableShape"));
    assert_eq!(table_op(&mut m, A::MergeCells).rejected, vec![0]);

    // Insert nested 2x2 table inside (1, 1), test nested table edit + reopen
    let tp = m
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i as u32))
        .unwrap();
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 1, 1, 0], "off": 0 } })
    ));
    assert!(m.run_engine("insert.table", json!({ "rows": 2, "cols": 2 })));
    assert_eq!(m.apply(&[insert("N00")]).changed, 1);
    assert_eq!(table_op(&mut m, A::InsertRowBelow).changed, 1);
    assert!(m.round_trip().unwrap().passed);

    let nested_b = m
        .diagnostic_document()
        .body[tp as usize]
        .as_table()
        .unwrap()
        .rows[1]
        .cells[1]
        .blocks
        .iter()
        .position(|b| b.as_table().is_some())
        .unwrap() as u32;
    // Cross-table selection (outer cell (1,1) trailing paragraph -> nested cell) rejects table structure commands
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 1, 1, 1], "off": 0 }, "extend": false })
    ));
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 1, 1, nested_b, 0, 0, 0], "off": 0 }, "extend": true })
    ));
    assert_eq!(table_op(&mut m, A::MergeCells).rejected, vec![0]);

    // Merging outer col 0 vertically creates overhang against (0,1) -> mergeCells across (0,0)-(0,1) rejected
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 }, "extend": false })
    ));
    assert_eq!(table_op(&mut m, A::MergeBelow).changed, 1);
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 }, "extend": false })
    ));
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 1, 0], "off": 0 }, "extend": true })
    ));
    assert_eq!(m.view().table.as_ref().unwrap().merge_cells, Some("tableShape"));
    assert_eq!(table_op(&mut m, A::MergeCells).rejected, vec![0]);

    // Content controls (SDT around row) -> refused with tableContent and 0 mutation
    {
        let doc = m.diagnostic_document_mut();
        if let Some(wordcraft_engine::doc::Block::Table(t)) =
            doc.body.get_mut(tp as usize).map(std::sync::Arc::make_mut)
        {
            t.rows[0].controls.open.push(Default::default());
        }
    }
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 }, "extend": false })
    ));
    assert_eq!(m.view().table.as_ref().unwrap().delete_row, Some("tableContent"));
    assert_eq!(table_op(&mut m, A::DeleteRow).rejected, vec![0]);

    // Read-only protected document with table rejects structure ops cleanly
    let mut ro = DocxModel::open(&basic::protected_ko("readOnly", false).unwrap()).unwrap();
    ro.diagnostic_document_mut()
        .body
        .push(std::sync::Arc::new(wordcraft_engine::doc::Block::Table(
            wordcraft_engine::doc::table::Table::new(2, 2, 200.0),
        )));
    let ro_tp = (ro.diagnostic_document().body.len() - 1) as u32;
    assert!(ro.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [ro_tp, 0, 0, 0], "off": 0 } })
    ));
    assert_eq!(table_op(&mut ro, A::InsertRowBelow).rejected, vec![0]);

    // Real T009 save publication & independent reopen for an edited DOCX table
    let mut seed_model = model();
    assert_eq!(
        seed_model
            .apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph, DocxOp::Table { rows: 2, cols: 2 }])
            .changed,
        2
    );
    assert_eq!(seed_model.apply(&[insert("Cell1")]).changed, 1);
    let cell_caret = seed_model.view().caret.expect("cell caret");
    let seed_bytes = seed_model.export().unwrap();
    let dir = TempDir::new();
    let doc_path = dir.write("table-save.docx", &seed_bytes);
    let state = DocumentState::default();
    let info = state
        .registry()
        .register(identify(doc_path.to_str().unwrap(), &Limits::default()).unwrap())
        .unwrap();
    block_on(commands::load(&state, info.session_id, None)).unwrap();
    let clicked = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        0,
        vec![pointer(cell_caret.page as u32, cell_caret.x, cell_caret.y)],
    ))
    .unwrap();
    assert!(clicked.rejected.is_empty());
    let view_before = clicked.view;
    assert!(view_before.table.is_some());
    let edited = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        clicked.session.revision,
        vec![
            DocxOp::TableStructure {
                action: A::InsertRowBelow,
                target: super::engine::SelectionIdentity {
                    anchor_key: view_before.anchor_key,
                    caret_key: view_before.caret_key,
                },
                rows: None,
                columns: None,
            },
            DocxOp::InsertText {
                text: "Row2".into(),
            },
        ],
    ))
    .unwrap();
    assert_eq!(edited.rejected, Vec::<usize>::new());
    let view_after = edited.view;
    assert_eq!(view_after.table.as_ref().unwrap().rows, 3);
    // Delete-all-rows / delete-all-cols refusal on 1x1-after-deletes check
    let mut one_by_two = DocxModel::open(&seed_bytes).unwrap();
    let otp = one_by_two
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i as u32))
        .unwrap();
    assert!(one_by_two.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [otp, 0, 0, 0], "off": 0 } })
    ));
    assert_eq!(table_op(&mut one_by_two, A::DeleteRow).changed, 1);
    assert_eq!(one_by_two.view().table.as_ref().unwrap().delete_row, Some("tableShape"));
    assert_eq!(table_op(&mut one_by_two, A::DeleteRow).rejected, vec![0]);

    // Real T009 save publication
    let check = block_on(commands::preflight(&state, info.session_id, 1)).unwrap();
    assert!(check.preservation.is_safe());
    let published = block_on(commands::save(
        &state,
        info.session_id,
        1,
        edited.session.revision,
    ))
    .unwrap();
    assert!(published.durable);
    let disk_bytes = std::fs::read(&doc_path).unwrap();
    let orig_pkg = package::open(&seed_bytes, package::Side::Original).unwrap();
    let saved_pkg = package::open(&disk_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &saved_pkg).is_empty());
    let reopened = DocxModel::open(&disk_bytes).unwrap();
    assert!(reopened.same_as(&disk_bytes));
    let rt = reopened
        .diagnostic_document()
        .body
        .iter()
        .rev()
        .find_map(|b| b.as_table())
        .unwrap();
    assert_eq!(rt.rows.len(), 3);
    assert_eq!(rt.rows[0].cells[0].blocks[0].as_para().unwrap().plain_text(), "Cell1");
    assert_eq!(rt.rows[1].cells[0].blocks[0].as_para().unwrap().plain_text(), "Row2");
}

fn table_split_op(
    m: &mut DocxModel,
    rows: Option<u32>,
    columns: Option<u32>,
) -> super::engine::EditOutcome {
    let target = table_target(m);
    m.apply(&[DocxOp::TableStructure {
        action: super::engine::table::TableStructureAction::SplitCell,
        target,
        rows,
        columns,
    }])
}

fn tiny_png_b64(w: u32, h: u32, rgb: [u8; 3]) -> String {
    let img = image::ImageBuffer::from_pixel(w, h, image::Rgb(rgb));
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    wordcraft_engine::cmd::insert::base64_encode(encoded.get_ref())
}

#[test]
fn stage2_p1_unmerged_cell_split_geometry_undo_layout_and_reopen() {
    use super::engine::table::TableStructureAction as A;
    use crate::services::save::package;

    let mut m = model();
    assert_eq!(m.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).changed, 1);
    assert_eq!(m.apply(&[insert("Orig00")]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Orig01")]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Orig10")]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Orig11")]).changed, 1);

    // Move back to (0, 0) unmerged 1x1 cell
    let tp = m
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i as u32))
        .expect("table");
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 } })));
    let tv = m.view().table.expect("in table");
    assert_eq!(tv.split_cell, None);
    assert!(tv.max_split_columns >= 3);
    assert!(tv.max_split_rows >= 3);

    // Partial/invalid dimension validation fails both validate() and apply()
    let tgt = table_target(&mut m);
    for (rows, columns) in [
        (Some(2), None),
        (None, Some(2)),
        (Some(1), Some(1)),
        (Some(0), Some(2)),
        (Some(17), Some(1)),
    ] {
        let op = DocxOp::TableStructure {
            action: A::SplitCell,
            target: tgt.clone(),
            rows,
            columns,
        };
        assert!(!validate(std::slice::from_ref(&op)));
        assert_eq!(m.apply(&[op]).rejected, vec![0]);
    }
    // No-parameter SplitCell on an unmerged 1x1 cell is refused
    assert_eq!(table_split_op(&mut m, None, None).rejected, vec![0]);

    // Split unmerged (0,0) into 1x3
    assert_eq!(table_split_op(&mut m, Some(1), Some(3)).changed, 1);
    {
        let doc = m.diagnostic_document();
        let t = doc.body[tp as usize].as_table().unwrap();
        assert!(t.is_grid_consistent());
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0].cells.len(), 4);
        assert_eq!(t.rows[1].cells.len(), 2);
        assert_eq!(t.rows[1].cells[0].props.span, 3);
        assert_eq!(t.rows[0].cells[0].blocks[0].as_para().unwrap().plain_text(), "Orig00");
        assert_eq!(t.rows[0].cells[1].blocks[0].as_para().unwrap().plain_text(), "");
    }

    // Undo / Redo restores 1x1 then 1x3 cleanly
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 2);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(body_table_texts(&m)[0].len(), 4);

    // Continue typing into newly created cell (0,1), then split (0,2) vertically 2x1
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Split1")]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Split2")]).changed, 1);
    assert_eq!(table_split_op(&mut m, Some(2), Some(1)).changed, 1);
    assert_eq!(body_table_texts(&m).len(), 3);
    assert_eq!(body_table_texts(&m)[0][2], vec!["Split2".to_string()]);

    // Merge cells (0,2)+(1,2) back, verify explicit dims are rejected on merged cell, while no-args restores it
    assert!(m.run_engine(
        "caret.set",
        json!({ "pos": { "story": "body", "path": [tp, 0, 2, 0], "off": 0 } })
    ));
    assert_eq!(table_op(&mut m, A::MergeBelow).changed, 1);
    let merged_tv = m.view().table.unwrap();
    assert!(merged_tv.row_span > 1 || merged_tv.col_span > 1);
    assert_eq!(table_split_op(&mut m, Some(2), Some(2)).rejected, vec![0]);
    assert_eq!(table_split_op(&mut m, None, None).changed, 1);

    // Real T009 save publication via session commands::preflight + commands::save + independent reopen
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp, 2, 1, 0], "off": 0 } })));
    let target_caret = m.view().caret.expect("caret");
    let seed_bytes = m.export().unwrap();
    let dir = TempDir::new();
    let doc_path = dir.write("split.docx", &seed_bytes);
    let state = DocumentState::default();
    let info = state
        .registry()
        .register(identify(doc_path.to_str().unwrap(), &Limits::default()).unwrap())
        .unwrap();
    block_on(commands::load(&state, info.session_id, None)).unwrap();
    let clicked = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        0,
        vec![pointer(target_caret.page as u32, target_caret.x, target_caret.y)],
    ))
    .unwrap();
    let view_before = clicked.view;
    let edited = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        clicked.session.revision,
        vec![
            DocxOp::TableStructure {
                action: A::SplitCell,
                target: super::engine::SelectionIdentity {
                    anchor_key: view_before.anchor_key,
                    caret_key: view_before.caret_key,
                },
                rows: Some(2),
                columns: Some(2),
            },
            DocxOp::InsertText {
                text: "Sub2x2".into(),
            },
        ],
    ))
    .unwrap();
    assert!(edited.rejected.is_empty());
    let check = block_on(commands::preflight(&state, info.session_id, 1)).unwrap();
    assert!(check.preservation.is_safe());
    let published = block_on(commands::save(&state, info.session_id, 1, edited.session.revision)).unwrap();
    assert!(published.durable);

    let disk_bytes = std::fs::read(&doc_path).unwrap();
    let reopened = DocxModel::open(&disk_bytes).unwrap();
    let reopened_table = reopened
        .diagnostic_document()
        .body
        .iter()
        .rev()
        .find_map(|b| b.as_table())
        .unwrap();
    assert!(reopened_table.is_grid_consistent());
    assert_eq!(reopened_table.rows.len(), 4);
    assert_eq!(reopened_table.rows[0].cells[0].blocks[0].as_para().unwrap().plain_text(), "Orig00");
    assert_eq!(reopened_table.rows[0].cells[1].blocks[0].as_para().unwrap().plain_text(), "Split1");
    assert_eq!(reopened_table.rows[0].cells[2].blocks[0].as_para().unwrap().plain_text(), "Split2");
    assert!(package::validate_docx(&package::open(&disk_bytes, package::Side::Output).unwrap()).is_empty());
    assert!(package::compare_saved_docx(
        &package::open(&seed_bytes, package::Side::Original).unwrap(),
        &package::open(&disk_bytes, package::Side::Output).unwrap(),
    ).is_empty());
}

#[test]
fn stage2_p1_vmerge_nonempty_continuation_preservation_and_fail_closed() {
    use super::engine::table::TableStructureAction as A;
    use crate::services::save::package;
    use wordcraft_engine::doc::props::VMerge;

    let mut base = model();
    assert_eq!(base.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]).changed, 1);
    assert_eq!(base.apply(&[DocxOp::Table { rows: 3, cols: 2 }]).changed, 1);
    for (i, txt) in ["RowA", "R0", "RowB", "R1", "RowC", "R2"].iter().enumerate() {
        if i > 0 {
            assert!(base.apply(&[DocxOp::Tab { back: false }]).rejected.is_empty());
        }
        assert_eq!(base.apply(&[insert(txt)]).changed, 1);
    }
    let mut doc = base.diagnostic_document().clone();
    let t_idx = doc
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i))
        .expect("table");
    if let Some(wordcraft_engine::doc::Block::Table(t)) = doc.body.get_mut(t_idx).map(std::sync::Arc::make_mut) {
        t.rows[0].cells[0].props.vmerge = VMerge::Restart;
        t.rows[1].cells[0].props.vmerge = VMerge::Continue;
        t.rows[2].cells[0].props.vmerge = VMerge::Continue;
    }
    let seed_bytes = wordcraft_engine::io::save_bytes("vmerge.docx", &doc).unwrap();

    // Case 1: Delete middle row (row 1) -> RowB preserved into RowA, RowC intact, Undo/Redo
    let mut m_mid = DocxModel::open(&seed_bytes).unwrap();
    assert!(m_mid.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [t_idx, 1, 0, 0], "off": 0 } })));
    assert_eq!(table_op(&mut m_mid, A::DeleteRow).changed, 1);
    let mid_texts = body_table_texts(&m_mid);
    assert_eq!(mid_texts.len(), 2);
    assert_eq!(mid_texts[0][0], vec!["RowA".to_string(), "RowB".to_string()]);
    assert_eq!(mid_texts[1][0], vec!["RowC".to_string()]);
    assert_eq!(m_mid.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(body_table_texts(&m_mid)[1][0], vec!["RowB".to_string()]);
    assert_eq!(m_mid.apply(&[DocxOp::Redo {}]).changed, 1);

    // Case 2: Delete row 0 via real session commands::edit + commands::preflight + commands::save + reopen
    let mut m_top_probe = DocxModel::open(&seed_bytes).unwrap();
    assert!(m_top_probe.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [t_idx, 0, 1, 0], "off": 0 } })));
    let row0_caret = m_top_probe.view().caret.expect("row0 caret");

    let dir = TempDir::new();
    let doc_path = dir.write("vmerge.docx", &seed_bytes);
    let state = DocumentState::default();
    let info = state
        .registry()
        .register(identify(doc_path.to_str().unwrap(), &Limits::default()).unwrap())
        .unwrap();
    block_on(commands::load(&state, info.session_id, None)).unwrap();
    let clicked = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        0,
        vec![pointer(row0_caret.page as u32, row0_caret.x, row0_caret.y)],
    ))
    .unwrap();
    let v0 = clicked.view;
    let deleted = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        clicked.session.revision,
        vec![DocxOp::TableStructure {
            action: A::DeleteRow,
            target: super::engine::SelectionIdentity {
                anchor_key: v0.anchor_key,
                caret_key: v0.caret_key,
            },
            rows: None,
            columns: None,
        }],
    ))
    .unwrap();
    assert!(deleted.rejected.is_empty());
    assert_eq!(deleted.view.table.as_ref().unwrap().rows, 2);
    let check = block_on(commands::preflight(&state, info.session_id, 1)).unwrap();
    assert!(check.preservation.is_safe());
    let published = block_on(commands::save(&state, info.session_id, 1, deleted.session.revision)).unwrap();
    assert!(published.durable);

    let disk_bytes = std::fs::read(&doc_path).unwrap();
    let orig_pkg = package::open(&seed_bytes, package::Side::Original).unwrap();
    let out_pkg = package::open(&disk_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&out_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &out_pkg).is_empty());
    let reopened = DocxModel::open(&disk_bytes).unwrap();
    assert_eq!(body_table_texts(&reopened)[0][0], vec!["RowA".to_string(), "RowB".to_string()]);
    assert_eq!(body_table_texts(&reopened)[1][0], vec!["RowC".to_string()]);

    // Case 3: Fail-closed when continuation row contains broken vMerge chain without Restart
    let mut broken_doc = base.diagnostic_document().clone();
    if let Some(wordcraft_engine::doc::Block::Table(t)) = broken_doc.body.get_mut(t_idx).map(std::sync::Arc::make_mut) {
        t.rows[0].cells[0].props.vmerge = VMerge::None;
        t.rows[1].cells[0].props.vmerge = VMerge::Continue;
    }
    let broken_bytes = wordcraft_engine::io::save_bytes("broken.docx", &broken_doc).unwrap();
    let mut m_broken = DocxModel::open(&broken_bytes).unwrap();
    assert!(m_broken.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [t_idx, 1, 0, 0], "off": 0 } })));
    let tv_broken = m_broken.view().table.unwrap();
    assert_eq!(tv_broken.delete_row, Some("tableShape"));
    assert_eq!(table_op(&mut m_broken, A::DeleteRow).rejected, vec![0]);
    assert_eq!(body_table_texts(&m_broken)[1][0], vec!["RowB".to_string()]);
}

#[test]
fn stage2_p1_table_image_deletion_safe_save_and_reopen() {
    use super::engine::table::TableStructureAction as A;
    use crate::services::save::package;

    let mut m = model();
    let body_png = tiny_png_b64(2, 2, [200, 10, 10]);
    let row0_png = tiny_png_b64(3, 3, [10, 200, 10]);
    let shared_png = tiny_png_b64(4, 4, [10, 10, 200]);
    let row1_png = tiny_png_b64(5, 5, [200, 200, 10]);

    assert_eq!(m.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Image { data: body_png }, mv(MoveTarget::Right, false), DocxOp::NewParagraph]).changed, 2);
    assert_eq!(m.apply(&[DocxOp::Table { rows: 3, cols: 2 }]).changed, 1);

    assert_eq!(m.apply(&[insert("R0C0")]).changed, 1);
    assert!(m.run_engine("insert.picture", json!({ "data": row0_png })));
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("R0C1")]).changed, 1);
    assert!(m.run_engine("insert.picture", json!({ "data": shared_png })));
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("R1C0")]).changed, 1);
    assert!(m.run_engine("insert.picture", json!({ "data": row1_png })));
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("R1C1")]).changed, 1);
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("Keep")]).changed, 1);
    assert!(m.run_engine("insert.picture", json!({ "data": shared_png })));
    assert_eq!(m.apply(&[DocxOp::Tab { back: false }, insert("R2C1")]).changed, 1);

    let seed_bytes = m.export().unwrap();
    let orig_pkg = package::open(&seed_bytes, package::Side::Original).unwrap();
    let orig_media: Vec<String> = orig_pkg
        .parts
        .keys()
        .filter(|k| k.starts_with("word/media/"))
        .cloned()
        .collect();
    assert!(orig_media.len() >= 4, "expected 4+ media parts in seed: {orig_media:?}");

    // Locate Row 0 Col 1 caret coordinate for real IPC DeleteRow
    let mut m_probe = DocxModel::open(&seed_bytes).unwrap();
    let tp = m_probe
        .diagnostic_document()
        .body
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, b)| b.as_table().map(|_| i as u32))
        .unwrap();
    assert!(m_probe.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp, 0, 1, 0], "off": 0 } })));
    let r0_caret = m_probe.view().caret.expect("r0 caret");

    // Scenario A & B via real IPC session: delete Row 0, verify T009 save & reopen, then Undo and delete Column 0!
    let dir = TempDir::new();
    let doc_path = dir.write("table-img.docx", &seed_bytes);
    let state = DocumentState::default();
    let info = state
        .registry()
        .register(identify(doc_path.to_str().unwrap(), &Limits::default()).unwrap())
        .unwrap();
    block_on(commands::load(&state, info.session_id, None)).unwrap();
    let clicked = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        0,
        vec![pointer(r0_caret.page as u32, r0_caret.x, r0_caret.y)],
    ))
    .unwrap();
    let v0 = clicked.view;
    let deleted_row = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        clicked.session.revision,
        vec![DocxOp::TableStructure {
            action: A::DeleteRow,
            target: super::engine::SelectionIdentity {
                anchor_key: v0.anchor_key,
                caret_key: v0.caret_key,
            },
            rows: None,
            columns: None,
        }],
    ))
    .unwrap();
    assert!(deleted_row.rejected.is_empty());
    let check = block_on(commands::preflight(&state, info.session_id, 1)).unwrap();
    assert!(check.preservation.is_safe(), "{:?}", check.preservation);
    let saved = block_on(commands::save(&state, info.session_id, 1, deleted_row.session.revision)).unwrap();
    assert!(saved.durable);

    let after0_bytes = std::fs::read(&doc_path).unwrap();
    let after0_pkg = package::open(&after0_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&after0_pkg).is_empty());
    let f0 = package::compare_saved_docx(&orig_pkg, &after0_pkg);
    assert!(f0.is_empty(), "delete row 0 should pass T009: {f0:?}");
    let after0_media: Vec<String> = after0_pkg.parts.keys().filter(|k| k.starts_with("word/media/")).cloned().collect();
    assert_eq!(after0_media.len(), orig_media.len() - 1, "only row0 unique image removed");

    // Scenario C: Undo restores row 0 & T009 save still passes, Redo deletes row 0 again
    let undone = block_on(commands::edit(
        &state,
        info.session_id,
        1,
        saved.session.revision,
        vec![DocxOp::Undo {}],
    ))
    .unwrap();
    assert!(undone.rejected.is_empty());
    assert_eq!(undone.view.table.as_ref().unwrap().rows, 3);
    assert!(block_on(commands::preflight(&state, info.session_id, 1)).unwrap().preservation.is_safe());

    // Scenario D: Delete Column 0 (removes row0_png & row1_png while keeping R0C1 shared_png + body image!)
    let mut m_col = DocxModel::open(&seed_bytes).unwrap();
    assert!(m_col.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp, 0, 0, 0], "off": 0 } })));
    assert_eq!(table_op(&mut m_col, A::DeleteColumn).changed, 1);
    let col_bytes = wordcraft_engine::io::save_bytes("col-del.docx", m_col.diagnostic_document()).unwrap();
    let col_pkg = package::open(&col_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&col_pkg).is_empty());
    let fc = package::compare_saved_docx(&orig_pkg, &col_pkg);
    assert!(fc.is_empty(), "delete col with images should pass T009: {fc:?}");
    let kept_media: Vec<String> = col_pkg.parts.keys().filter(|k| k.starts_with("word/media/")).cloned().collect();
    assert_eq!(kept_media.len(), orig_media.len() - 2, "row0+row1 unique images removed, shared+body images preserved: {kept_media:?}");
    let reopened = DocxModel::open(&col_bytes).unwrap();
    assert_eq!(body_table_texts(&reopened).len(), 3);
    assert!(body_table_texts(&reopened)[2][0][0].starts_with("R2C1"));
}

#[test]
fn stage2_p3_1_docx_cell_shading_and_borders_preserve_content_undo_reopen_and_negatives() {
    use super::engine::table::TableBorderKind as K;
    use super::engine::table::TableStructureAction as A;
    use crate::services::save::package;

    let mut m = DocxModel::open(&crate::services::files::blank_docx().unwrap()).unwrap();
    assert!(m.apply(&[DocxOp::Table { rows: 3, cols: 3 }]).rejected.is_empty());
    let v_init = m.view();
    let tp = v_init.table.as_ref().unwrap();
    assert_eq!((tp.rows, tp.cols), (3, 3));
    assert!(!tp.has_inside_borders);
    assert!(tp.cell_shading_refusal.is_none());
    assert!(tp.cell_borders_refusal.is_none());

    // Populate unique cell text to verify zero silent content mutation.
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    for r in 0..3 {
        for c in 0..3 {
            assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, r, c, 0], "off": 0 } })));
            let label = format!("R{r}C{c}");
            assert!(m.apply(&[DocxOp::InsertText { text: label }]).rejected.is_empty());
        }
    }

    // Export baseline DOCX for T009 compare_saved_docx later.
    let orig_bytes = wordcraft_engine::io::save_bytes("p3-orig.docx", m.diagnostic_document()).unwrap();
    let orig_pkg = package::open(&orig_bytes, package::Side::Original).unwrap();

    // Negative: `inside` border on single cell must be rejected before mutating.
    let t_single = table_target(&mut m);
    let rej_inside = m.apply(&[DocxOp::TableBorders {
        target: t_single.clone(),
        kind: K::Inside,
        style: Some("single".into()),
        width: Some(1.0),
        color: Some("#000000".into()),
    }]);
    assert_eq!(rej_inside.rejected, vec![0]);

    // Negative validation: bad hex color, unknown style, invalid width.
    assert!(!validate(&[DocxOp::TableShading {
        target: t_single.clone(),
        color: Some("XYZ123".into()),
    }]));
    assert!(!validate(&[DocxOp::TableBorders {
        target: t_single.clone(),
        kind: K::All,
        style: Some("circle".into()),
        width: Some(1.0),
        color: Some("#000000".into()),
    }]));
    assert!(!validate(&[DocxOp::TableBorders {
        target: t_single.clone(),
        kind: K::All,
        style: Some("single".into()),
        width: Some(99.0),
        color: Some("#000000".into()),
    }]));
    // Stale target rejected.
    assert_eq!(
        m.apply(&[DocxOp::TableShading {
            target: super::engine::SelectionIdentity {
                anchor_key: "stale".into(),
                caret_key: "stale".into(),
            },
            color: Some("#FEF08A".into()),
        }])
        .rejected,
        vec![0]
    );

    // Format cell (0,0): shading #FEF08A, Undo restores None, Redo restores #FEF08A.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 } })));
    let t00 = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableShading { target: t00.clone(), color: Some("#FEF08A".into()) }]).changed,
        1
    );
    assert_eq!(m.view().table.as_ref().unwrap().cell_shading.as_deref(), Some("#FEF08A"));
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.view().table.as_ref().unwrap().cell_shading, None);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.view().table.as_ref().unwrap().cell_shading.as_deref(), Some("#FEF08A"));

    // Clear shading on (0,0) then set it on rectangular range (0,0)..=(1,1) along with inside+outside borders.
    let t00_clear = table_target(&mut m);
    assert_eq!(m.apply(&[DocxOp::TableShading { target: t00_clear, color: None }]).changed, 1);
    assert_eq!(m.view().table.as_ref().unwrap().cell_shading, None);

    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    assert!(m.view().table.as_ref().unwrap().has_inside_borders);
    let t_rect = table_target(&mut m);
    assert_eq!(
        m.apply(&[
            DocxOp::TableShading { target: t_rect.clone(), color: Some("#DBEAFE".into()) },
            DocxOp::TableBorders {
                target: t_rect.clone(),
                kind: K::Outside,
                style: Some("double".into()),
                width: Some(1.5),
                color: Some("#DC2626".into()),
            },
            DocxOp::TableBorders {
                target: t_rect,
                kind: K::Inside,
                style: Some("dashed".into()),
                width: Some(0.75),
                color: Some("#1E40AF".into()),
            },
        ])
        .changed,
        3
    );

    // Vertically merge (0,2)..=(1,2), then format merged cell bottom border & shading.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 2, 0], "off": 0 },
    })));
    assert_eq!(table_op(&mut m, A::MergeCells).changed, 1);
    let t_merged = table_target(&mut m);
    assert!(!m.view().table.as_ref().unwrap().has_inside_borders);
    assert_eq!(
        m.apply(&[
            DocxOp::TableShading { target: t_merged.clone(), color: Some("#DCFCE7".into()) },
            DocxOp::TableBorders {
                target: t_merged,
                kind: K::Bottom,
                style: Some("thick".into()),
                width: Some(2.25),
                color: Some("#15803D".into()),
            },
        ])
        .changed,
        2
    );

    // Partial overhang over merged cell (0,2)..=(1,2) by selecting (0,1)..=(0,2) must reject cell formatting.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
    })));
    assert!(m.view().table.as_ref().unwrap().cell_shading_refusal.is_some());
    let t_over = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableShading { target: t_over, color: Some("#FF0000".into()) }]).rejected,
        vec![0]
    );

    // Nested table inside cell (2,0) formats safely.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 2, 0, 0], "off": 0 } })));
    assert!(m.run_engine("insert.table", json!({ "rows": 1, "cols": 2 })));
    let nested_t = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableShading { target: nested_t, color: Some("#F3E8FF".into()) }]).changed,
        1
    );

    // T009 save check + independent reopen verification.
    let saved_bytes = wordcraft_engine::io::save_bytes("p3-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    let findings = package::compare_saved_docx(&orig_pkg, &saved_pkg);
    assert!(findings.is_empty(), "DOCX table cell formatting must pass T009: {findings:?}");

    let reopened = DocxModel::open(&saved_bytes).unwrap();
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert_eq!(tbl.rows[0].cells[0].props.shading, Some(wordcraft_engine::doc::props::Rgb(0xDB, 0xEA, 0xFE)));
    assert!(tbl.rows[0].cells[0].props.borders.as_ref().unwrap().top.is_some());
    assert!(tbl.rows[2].cells[1].props.shading.is_none()); // untouched cell preserved!
    // Vertical merge continuation row holds the bottom border, and header holds green shading.
    assert_eq!(tbl.rows[0].cells[2].props.shading, Some(wordcraft_engine::doc::props::Rgb(0xDC, 0xFC, 0xE7)));
    assert_eq!(
        tbl.rows[1].cells[2].props.borders.as_ref().and_then(|b| b.bottom).unwrap().color,
        Some(wordcraft_engine::doc::props::Rgb(0x15, 0x80, 0x3D))
    );
}

#[test]
fn stage2_p3_2_docx_cell_alignment_preserves_content_undo_reopen_and_negatives() {
    use super::engine::table::{CellHAlign as H, CellVAlign as V, TableStructureAction as A};
    use crate::services::save::package;
    use wordcraft_engine::doc::props::{Align, VAlign};

    let mut m = DocxModel::open(&crate::services::files::blank_docx().unwrap()).unwrap();
    assert!(m.apply(&[DocxOp::Table { rows: 3, cols: 3 }]).rejected.is_empty());
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    for r in 0..3 {
        for c in 0..3 {
            assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, r, c, 0], "off": 0 } })));
            assert!(m.apply(&[DocxOp::InsertText { text: format!("A{r}{c}") }]).rejected.is_empty());
        }
    }
    let orig_bytes = wordcraft_engine::io::save_bytes("p3-2-orig.docx", m.diagnostic_document()).unwrap();
    let orig_pkg = package::open(&orig_bytes, package::Side::Original).unwrap();

    // Empty alignment payload rejected in validation; stale target rejected at apply.
    let t_single = table_target(&mut m);
    assert!(!validate(&[DocxOp::TableAlignment {
        target: t_single,
        horizontal: None,
        vertical: None,
    }]));
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment {
            target: super::engine::SelectionIdentity { anchor_key: "stale".into(), caret_key: "stale".into() },
            horizontal: Some(H::Center),
            vertical: None,
        }])
        .rejected,
        vec![0]
    );

    // Single cell horizontal justify then vertical middle; Undo restores step-by-step.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 } })));
    let t00 = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment { target: t00, horizontal: Some(H::Justify), vertical: None }]).changed,
        1
    );
    let tv = m.view().table.unwrap();
    assert_eq!(tv.cell_align_horizontal, Some("justify"));
    assert_eq!(tv.cell_align_vertical, Some("top"));
    let t00_v = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment { target: t00_v, horizontal: None, vertical: Some(V::Middle) }]).changed,
        1
    );
    let tv2 = m.view().table.unwrap();
    assert_eq!(tv2.cell_align_horizontal, Some("justify"));
    assert_eq!(tv2.cell_align_vertical, Some("middle"));
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.view().table.unwrap().cell_align_vertical, Some("top"));
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.view().table.unwrap().cell_align_vertical, Some("middle"));

    // Mixed state when selecting (0,0)..=(0,1): (0,0) is justify+middle, (0,1) is left+top.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
    })));
    let tv_mix = m.view().table.unwrap();
    assert!(tv_mix.cell_align_horizontal_mixed);
    assert!(tv_mix.cell_align_vertical_mixed);
    // Applying only vertical=bottom updates both cells' vertical while preserving (0,0) justify and (0,1) left!
    let t_row = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment { target: t_row, horizontal: None, vertical: Some(V::Bottom) }]).changed,
        1
    );
    let tv_after = m.view().table.unwrap();
    assert_eq!(tv_after.cell_align_vertical, Some("bottom"));
    assert!(tv_after.cell_align_horizontal_mixed);

    // Merged cell (0,2)..=(1,2) formats safely; partial overhang rejects.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 2, 0], "off": 0 },
    })));
    assert_eq!(table_op(&mut m, A::MergeCells).changed, 1);
    let t_merged = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment {
            target: t_merged,
            horizontal: Some(H::Right),
            vertical: Some(V::Middle),
        }])
        .changed,
        1
    );
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
    })));
    assert!(m.view().table.unwrap().cell_alignment_refusal.is_some());
    let t_over = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment { target: t_over, horizontal: Some(H::Center), vertical: None }]).rejected,
        vec![0]
    );

    // Nested table cell formats independently from outer cell.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 2, 0, 0], "off": 0 } })));
    assert!(m.run_engine("insert.table", json!({ "rows": 1, "cols": 2 })));
    let nested_t = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableAlignment { target: nested_t, horizontal: Some(H::Center), vertical: Some(V::Bottom) }]).changed,
        1
    );

    // T009 save check & independent reopen.
    let saved_bytes = wordcraft_engine::io::save_bytes("p3-2-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    let findings = package::compare_saved_docx(&orig_pkg, &saved_pkg);
    assert!(findings.is_empty(), "DOCX cell alignment must pass T009: {findings:?}");

    let reopened = DocxModel::open(&saved_bytes).unwrap();
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert_eq!(tbl.rows[0].cells[0].props.valign, VAlign::Bottom);
    assert_eq!(tbl.rows[0].cells[0].blocks[0].as_para().unwrap().props.align, Some(Align::Justify));
    assert_eq!(tbl.rows[0].cells[1].props.valign, VAlign::Bottom);
    assert_eq!(tbl.rows[0].cells[1].blocks[0].as_para().unwrap().props.align, None);
    assert_eq!(tbl.rows[0].cells[2].props.valign, VAlign::Center);
    assert_eq!(tbl.rows[0].cells[2].blocks[0].as_para().unwrap().props.align, Some(Align::Right));
    assert_eq!(tbl.rows[2].cells[2].props.valign, VAlign::Top);
}

#[test]
fn stage2_p3_3_docx_column_widths_and_row_heights_preserve_content_undo_reopen_and_negatives() {
    use super::engine::table::{RowHeightRule, TableStructureAction as A};
    use crate::services::save::package;
    use wordcraft_engine::doc::props::HeightRule;

    let mut m = DocxModel::open(&crate::services::files::blank_docx().unwrap()).unwrap();
    assert!(m.apply(&[DocxOp::Table { rows: 3, cols: 3 }]).rejected.is_empty());
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    for r in 0..3 {
        for c in 0..3 {
            assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, r, c, 0], "off": 0 } })));
            assert!(m.apply(&[DocxOp::InsertText { text: format!("D{r}{c}") }]).rejected.is_empty());
        }
    }
    let orig_bytes = wordcraft_engine::io::save_bytes("p3-3-orig.docx", m.diagnostic_document()).unwrap();
    let orig_pkg = package::open(&orig_bytes, package::Side::Original).unwrap();

    // Negative validations: out-of-range widths/heights and conflicting flags must fail validation or reject.
    let t0 = table_target(&mut m);
    assert!(!validate(&[DocxOp::TableColumnWidth {
        target: t0.clone(),
        width: Some(1.0),
        distribute: false,
    }]));
    assert!(!validate(&[DocxOp::TableColumnWidth {
        target: t0.clone(),
        width: Some(100.0),
        distribute: true,
    }]));
    assert!(!validate(&[DocxOp::TableRowHeight {
        target: t0.clone(),
        height: Some(0.1),
        rule: Some(RowHeightRule::Exact),
        clear: false,
        distribute: false,
    }]));
    assert_eq!(
        m.apply(&[DocxOp::TableColumnWidth {
            target: super::engine::SelectionIdentity { anchor_key: "stale".into(), caret_key: "stale".into() },
            width: Some(90.0),
            distribute: false,
        }])
        .rejected,
        vec![0]
    );

    // Single column width 140pt -> Undo restores -> Redo reapplies.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 } })));
    let orig_col0 = m.view().table.as_ref().unwrap().col_width.unwrap();
    let orig_col2 = m.diagnostic_document().body[tp_idx].as_table().unwrap().grid[2];
    let t00 = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableColumnWidth { target: t00, width: Some(140.0), distribute: false }]).changed,
        1
    );
    assert_eq!(m.view().table.as_ref().unwrap().col_width, Some(140.0));
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert!((m.view().table.as_ref().unwrap().col_width.unwrap() - orig_col0).abs() < 0.05);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.view().table.as_ref().unwrap().col_width, Some(140.0));
    assert!((m.diagnostic_document().body[tp_idx].as_table().unwrap().grid[2] - orig_col2).abs() < 0.05);

    // Multi-row exact height 42pt on rows 0..=1; row 2 untouched.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    assert!(m.view().table.as_ref().unwrap().col_width_mixed);
    let t_rect = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableRowHeight {
            target: t_rect,
            height: Some(42.0),
            rule: Some(RowHeightRule::Exact),
            clear: false,
            distribute: false,
        }])
        .changed,
        1
    );
    let tv_rows = m.view().table.unwrap();
    assert_eq!(tv_rows.row_height, Some(42.0));
    assert_eq!(tv_rows.row_height_rule, Some("exact"));

    // Merged cell (0,2)..=(1,2): partial overhang rejects dimension changes.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 2, 0], "off": 0 },
    })));
    assert_eq!(table_op(&mut m, A::MergeCells).changed, 1);
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
    })));
    assert!(m.view().table.as_ref().unwrap().column_width_refusal.is_some());
    let t_over = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableColumnWidth { target: t_over, width: Some(110.0), distribute: false }]).rejected,
        vec![0]
    );

    // Distribute columns evenly from cell (2,2), then nested table resize.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 2, 2, 0], "off": 0 } })));
    let t_dist = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableColumnWidth { target: t_dist, width: None, distribute: true }]).changed,
        1
    );
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 2, 0, 0], "off": 0 } })));
    assert!(m.run_engine("insert.table", json!({ "rows": 1, "cols": 2 })));
    let nested_t = table_target(&mut m);
    assert_eq!(
        m.apply(&[
            DocxOp::TableColumnWidth { target: nested_t.clone(), width: Some(80.0), distribute: false },
            DocxOp::TableRowHeight {
                target: nested_t,
                height: Some(28.0),
                rule: Some(RowHeightRule::AtLeast),
                clear: false,
                distribute: false,
            },
        ])
        .changed,
        2
    );

    // T009 save check + independent reopen.
    let saved_bytes = wordcraft_engine::io::save_bytes("p3-3-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    let findings = package::compare_saved_docx(&orig_pkg, &saved_pkg);
    assert!(findings.is_empty(), "DOCX table dimensions must pass T009: {findings:?}");

    let reopened = DocxModel::open(&saved_bytes).unwrap();
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert!((tbl.grid[0] - tbl.grid[1]).abs() < 0.05);
    assert_eq!(tbl.rows[0].props.height, Some(42.0));
    assert_eq!(tbl.rows[0].props.height_rule, HeightRule::Exact);
    assert_eq!(tbl.rows[2].props.height, None);
}

#[test]
fn stage2_p4_1_docx_multi_cell_clipboard_and_t009() {
    use super::engine::table::{CellHAlign, CellVAlign, PasteTableCellsPayload, TableStructureAction};
    use super::engine::SelectionIdentity;
    use crate::services::save::package;
    let base = crate::services::files::blank_docx().unwrap();
    let orig_pkg = package::open(&base, package::Side::Original).unwrap();
    let mut m = DocxModel::open(&base).unwrap();
    assert!(m.run_engine("insert.table", json!({ "rows": 4, "cols": 3 })));
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();

    // Populate (0,0)..=(1,1) with text, formatting, and a 1x2 merge in row 0.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 } })));
    assert!(m.run_engine("text.insert", json!({ "text": "MergedHead" })));
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 1, 0, 0], "off": 0 } })));
    assert!(m.run_engine("text.insert", json!({ "text": "Left" })));
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 } })));
    assert!(m.run_engine("text.insert", json!({ "text": "Right" })));

    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
    })));
    assert_eq!(table_op(&mut m, TableStructureAction::MergeCells).changed, 1);

    // Format the 2x2 region (0,0)..=(1,1) with shading and alignment.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    let t_fmt = table_target(&mut m);
    assert_eq!(
        m.apply(&[
            DocxOp::TableShading { target: t_fmt.clone(), color: Some("#FEF08A".into()) },
            DocxOp::TableAlignment {
                target: t_fmt,
                horizontal: Some(CellHAlign::Center),
                vertical: Some(CellVAlign::Middle),
            },
        ]).changed,
        2
    );

    // Select 2x2 region (0,0)..=(1,1) -> clipboard_table_cells_available + extract.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    assert!(m.view().clipboard_table_cells_available);
    let extracted_raw = m.clipboard_table_cells().expect("multi-cell payload");
    let extracted: PasteTableCellsPayload = serde_json::from_str(&extracted_raw).unwrap();
    assert_eq!((extracted.rows, extracted.cols, extracted.cells.len()), (2, 2, 3));
    assert_eq!(extracted.cells[0].col_span, 2);

    // Partial merge overhang (0,1)..=(0,2) must reject clipboard extraction.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 1, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 0, 2, 0], "off": 0 },
    })));
    assert!(!m.view().clipboard_table_cells_available);
    assert!(m.clipboard_table_cells().is_none());

    // Paste into unmerged 2x2 target anchored at (2, 1): creates merge + copies text & formatting.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 2, 1, 0], "off": 0 } })));
    let paste_target = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::PasteTableCells { target: paste_target, payload: extracted.clone() }]).changed,
        1
    );
    {
        let tbl = m.diagnostic_document().body[tp_idx].as_table().unwrap();
        assert_eq!(tbl.rows[2].cells.len(), 2); // col 0 + merged (1..=2)
        assert_eq!(tbl.rows[2].cells[1].span(), 2);
        assert_eq!(tbl.rows[2].cells[1].blocks[0].as_para().unwrap().plain_text(), "MergedHead");
        assert_eq!(tbl.rows[3].cells[1].blocks[0].as_para().unwrap().plain_text(), "Left");
        assert_eq!(tbl.rows[3].cells[2].blocks[0].as_para().unwrap().plain_text(), "Right");
    }

    // Undo / Redo structural paste in one step.
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.diagnostic_document().body[tp_idx].as_table().unwrap().rows[2].cells.len(), 3);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.diagnostic_document().body[tp_idx].as_table().unwrap().rows[2].cells[1].span(), 2);

    // Out-of-bounds paste target at (3, 2) must reject without partial mutation.
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 3, 2, 0], "off": 0 } })));
    let bad_target = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::PasteTableCells { target: bad_target, payload: extracted.clone() }]).rejected,
        vec![0]
    );

    // Cut (0,0)..=(1,1) with stale selection rejected, valid selection clears in one Undo step.
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    assert_eq!(
        m.apply(&[DocxOp::CutTableCells { target: SelectionIdentity { anchor_key: "stale".into(), caret_key: "stale".into() } }]).rejected,
        vec![0]
    );
    let cut_target = table_target(&mut m);
    assert_eq!(m.apply(&[DocxOp::CutTableCells { target: cut_target }]).changed, 1);
    assert_eq!(m.diagnostic_document().body[tp_idx].as_table().unwrap().rows[0].cells[0].blocks[0].as_para().unwrap().plain_text(), "");
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.diagnostic_document().body[tp_idx].as_table().unwrap().rows[0].cells[0].blocks[0].as_para().unwrap().plain_text(), "MergedHead");

    // T009 save + independent reopen.
    let saved_bytes = wordcraft_engine::io::save_bytes("p4-1-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &saved_pkg).is_empty());
    let reopened = DocxModel::open(&saved_bytes).unwrap();
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert_eq!(tbl.rows[2].cells[1].span(), 2);
    assert_eq!(tbl.rows[2].cells[1].blocks[0].as_para().unwrap().plain_text(), "MergedHead");
    assert_eq!(tbl.rows[3].cells[2].blocks[0].as_para().unwrap().plain_text(), "Right");
}

#[test]
fn stage2_p4_2_docx_cell_margins_and_positioning_and_t009() {
    use super::engine::SelectionIdentity;
    use super::engine::table::{TableAlign, TableMarginScope};
    use crate::services::save::package;
    let doc = crate::services::files::blank_docx().unwrap();
    let orig_pkg = package::open(&doc, package::Side::Original).unwrap();
    let mut m = DocxModel::open(&doc).unwrap();
    assert!(m.run_engine("text.insert", json!({ "text": "Unrelated body paragraph." })));
    assert_eq!(m.apply(&[DocxOp::Table { rows: 2, cols: 2 }]).changed, 1);
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    let target = table_target(&mut m);

    // Table-wide default cell margins + center align + indent (18pt).
    assert_eq!(
        m.apply(&[DocxOp::TableCellMargins {
            target: target.clone(),
            scope: TableMarginScope::Table,
            top: Some(4.0),
            right: Some(8.0),
            bottom: Some(4.0),
            left: Some(8.0),
            reset: false,
        }]).changed,
        1
    );
    assert_eq!(
        m.apply(&[DocxOp::TablePositioning {
            target: target.clone(),
            align: Some(TableAlign::Center),
            indent_pt: Some(18.0),
        }]).changed,
        1
    );

    // Per-cell margin override on cell (0,0) leaving (0,1) inheriting table default.
    let c0_target = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableCellMargins {
            target: c0_target,
            scope: TableMarginScope::Cell,
            top: Some(12.0),
            right: Some(14.0),
            bottom: Some(12.0),
            left: Some(14.0),
            reset: false,
        }]).changed,
        1
    );
    let v = m.view().table.unwrap();
    assert_eq!(v.table_align, "center");
    assert_eq!(v.table_indent_pt, 18.0);
    assert_eq!(v.table_cell_margins.left, 8.0);
    assert_eq!(v.cell_margins.unwrap().left, 14.0);
    assert!(!v.cell_margins_uses_default);

    // Undo restores cell (0,0) back to table default; Redo re-applies override.
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    let v_undone = m.view().table.unwrap();
    assert!(v_undone.cell_margins_uses_default);
    assert_eq!(v_undone.cell_margins.unwrap().left, 8.0);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);

    // Stale target and invalid margin rejected before mutation.
    let stale = SelectionIdentity { anchor_key: "stale".into(), caret_key: "stale".into() };
    assert_eq!(
        m.apply(&[DocxOp::TablePositioning { target: stale, align: Some(TableAlign::Right), indent_pt: None }]).rejected,
        vec![0]
    );
    let cur = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableCellMargins {
            target: cur,
            scope: TableMarginScope::Cell,
            top: Some(-2.0),
            right: None,
            bottom: None,
            left: None,
            reset: false,
        }]).rejected,
        vec![0]
    );

    // T009 save & independent reopen
    let saved_bytes = wordcraft_engine::io::save_bytes("p4-2-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &saved_pkg).is_empty());
    let reopened = DocxModel::open(&saved_bytes).unwrap();
    assert_eq!(reopened.diagnostic_document().body[0].as_para().unwrap().plain_text(), "Unrelated body paragraph.");
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert_eq!(tbl.props.cell_margins, Some([4.0, 8.0, 4.0, 8.0]));
    assert_eq!(tbl.props.indent, Some(18.0));
    assert_eq!(tbl.rows[0].cells[0].props.margins, Some([12.0, 14.0, 12.0, 14.0]));
    assert_eq!(tbl.rows[0].cells[1].props.margins, None);
}

#[test]
fn stage2_p4_3_docx_repeating_headers_pagination_and_t009() {
    use super::engine::SelectionIdentity;
    use super::engine::table::{RowHeightRule, TableBreakMode};
    use crate::services::save::package;
    let doc = crate::services::files::blank_docx().unwrap();
    let orig_pkg = package::open(&doc, package::Side::Original).unwrap();
    let mut m = DocxModel::open(&doc).unwrap();
    assert!(m.apply(&[DocxOp::Table { rows: 14, cols: 2 }]).rejected.is_empty());
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();

    // Populate 2 header rows + 12 tall body rows spanning 2+ pages
    for (r, label) in [(0usize, "HDR_A"), (1usize, "HDR_B")] {
        assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, r, 0, 0], "off": 0 } })));
        assert!(m.run_engine("text.insert", json!({ "text": label })));
        let t = table_target(&mut m);
        assert_eq!(
            m.apply(&[DocxOp::TableRowHeight { target: t, height: Some(40.0), rule: Some(RowHeightRule::Exact), clear: false, distribute: false }]).changed,
            1
        );
    }
    for r in 2..14 {
        assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, r, 0, 0], "off": 0 } })));
        let t = table_target(&mut m);
        assert_eq!(
            m.apply(&[DocxOp::TableRowHeight { target: t, height: Some(80.0), rule: Some(RowHeightRule::AtLeast), clear: false, distribute: false }]).changed,
            1
        );
    }

    // Non-leading row 3 rejected when row 0..2 are not headers
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 3, 0, 0], "off": 0 } })));
    assert!(!m.view().table.as_ref().unwrap().can_enable_header);
    let non_leading = table_target(&mut m);
    assert_eq!(
        m.apply(&[DocxOp::TableRepeatHeader { target: non_leading, repeat: true }]).rejected,
        vec![0]
    );

    // Select rows 0..=1 and enable repeating header + row-level break prevention
    assert!(m.run_engine("select.range", json!({
        "anchor": { "story": "body", "path": [tp_idx, 0, 0, 0], "off": 0 },
        "focus": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 },
    })));
    let tv = m.view().table.unwrap();
    assert!(tv.can_enable_header);
    assert_eq!(tv.leading_header_rows, 0);
    let hdr_target = table_target(&mut m);
    assert_eq!(
        m.apply(&[
            DocxOp::TableRepeatHeader { target: hdr_target.clone(), repeat: true },
            DocxOp::TableRowBreak { target: hdr_target, mode: TableBreakMode::Row },
        ]).changed,
        2
    );
    let tv_after = m.view().table.unwrap();
    assert_eq!(tv_after.leading_header_rows, 2);
    assert_eq!(tv_after.row_header, Some(true));
    assert_eq!(tv_after.row_break_mode, Some("row"));

    // Rendered layout repeats BOTH header rows on page 2!
    let mut check_sess = wordcraft_engine::Session::new(m.diagnostic_document().clone());
    let layout = check_sess.layout();
    assert!(layout.pages.len() >= 2, "expected >=2 pages, got {}", layout.pages.len());
    let p2_paths: Vec<Vec<u32>> = layout.pages[1]
        .items
        .iter()
        .filter_map(|it| match it {
            wordcraft_engine::layout::Placed::Lines { path, .. } => Some(path.0.clone()),
            _ => None,
        })
        .collect();
    assert!(p2_paths.contains(&vec![tp_idx as u32, 0, 0, 0]), "page 2 missing header row 0: {p2_paths:?}");
    assert!(p2_paths.contains(&vec![tp_idx as u32, 1, 0, 0]), "page 2 missing header row 1: {p2_paths:?}");

    // Undo / Redo check
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.view().table.unwrap().row_break_mode, Some("cell"));
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.view().table.unwrap().row_break_mode, Some("row"));

    // Stale target rejected
    let stale = SelectionIdentity { anchor_key: "stale".into(), caret_key: "stale".into() };
    assert_eq!(
        m.apply(&[DocxOp::TableRepeatHeader { target: stale, repeat: false }]).rejected,
        vec![0]
    );

    // T009 save & independent reopen
    let saved_bytes = wordcraft_engine::io::save_bytes("p4-3-saved.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved_bytes, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &saved_pkg).is_empty());
    let reopened = DocxModel::open(&saved_bytes).unwrap();
    let tbl = reopened.diagnostic_document().body[tp_idx].as_table().unwrap();
    assert!(tbl.rows[0].props.header && tbl.rows[1].props.header);
    assert!(tbl.rows[0].props.cant_split && tbl.rows[1].props.cant_split);
}

#[test]
fn stage2_p4_stab_docx_header_clear_is_limited_to_selected_trailing_rows() {
    use crate::services::save::package;
    let doc = crate::services::files::blank_docx().unwrap();
    let orig_pkg = package::open(&doc, package::Side::Original).unwrap();
    let mut m = DocxModel::open(&doc).unwrap();
    assert!(m.apply(&[DocxOp::Table { rows: 4, cols: 2 }]).rejected.is_empty());
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    let select_rows = |m: &mut DocxModel, r0: usize, r1: usize| {
        assert!(m.run_engine("select.range", json!({
            "anchor": { "story": "body", "path": [tp_idx, r0, 0, 0], "off": 0 },
            "focus": { "story": "body", "path": [tp_idx, r1, 1, 0], "off": 0 },
        })));
        table_target(m)
    };
    let headers = |m: &DocxModel| -> Vec<bool> {
        m.diagnostic_document().body[tp_idx].as_table().unwrap().rows.iter().map(|r| r.props.header).collect()
    };
    let t = select_rows(&mut m, 0, 1);
    assert_eq!(m.apply(&[DocxOp::TableRepeatHeader { target: t, repeat: true }]).changed, 1);
    assert_eq!(headers(&m), vec![true, true, false, false]);
    // Clearing only the first header row would silently clear (or orphan) row 1: refused, unchanged.
    let t = select_rows(&mut m, 0, 0);
    assert_eq!(m.apply(&[DocxOp::TableRepeatHeader { target: t, repeat: false }]).rejected, vec![0]);
    assert_eq!(headers(&m), vec![true, true, false, false]);
    // Clearing the trailing header row keeps the leading block contiguous.
    let t = select_rows(&mut m, 1, 1);
    assert_eq!(m.apply(&[DocxOp::TableRepeatHeader { target: t, repeat: false }]).changed, 1);
    assert_eq!(headers(&m), vec![true, false, false, false]);
    assert_eq!(m.view().table.unwrap().leading_header_rows, 1);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(headers(&m), vec![true, true, false, false]);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(headers(&m), vec![true, false, false, false]);
    let saved = wordcraft_engine::io::save_bytes("p4-stab-headers.docx", m.diagnostic_document()).unwrap();
    let saved_pkg = package::open(&saved, package::Side::Output).unwrap();
    assert!(package::validate_docx(&saved_pkg).is_empty());
    assert!(package::compare_saved_docx(&orig_pkg, &saved_pkg).is_empty());
    let reopened = DocxModel::open(&saved).unwrap();
    assert_eq!(headers(&reopened), vec![true, false, false, false]);
    // Clearing the last remaining header row turns repetition off.
    let t = select_rows(&mut m, 0, 0);
    assert_eq!(m.apply(&[DocxOp::TableRepeatHeader { target: t, repeat: false }]).changed, 1);
    assert_eq!(headers(&m), vec![false; 4]);
    assert_eq!(m.view().table.unwrap().leading_header_rows, 0);
}

#[test]
fn stage2_p4_stab_docx_paste_rejects_overflowing_geometry_without_mutation() {
    use super::engine::table::PasteTableCellsPayload;
    let mut m = DocxModel::open(&crate::services::files::blank_docx().unwrap()).unwrap();
    assert!(m.run_engine("insert.table", json!({ "rows": 3, "cols": 3 })));
    let tp_idx = m.diagnostic_document().body.iter().position(|b| b.as_table().is_some()).unwrap();
    assert!(m.run_engine("caret.set", json!({ "pos": { "story": "body", "path": [tp_idx, 1, 1, 0], "off": 0 } })));
    let big = usize::MAX as u64;
    let cell = |row: u64, col: u64, rs: u64, cs: u64| json!({ "row": row, "col": col, "rowSpan": rs, "colSpan": cs, "paragraphs": [{ "runs": [{ "text": "x" }] }] });
    let payload = |rows: u64, cols: u64, cells: serde_json::Value| json!({ "rows": rows, "cols": cols, "cells": cells });
    let malformed = [
        payload(2, 1, json!([cell(0, 0, 1, 1), cell(1, 0, big, 1)])), // rowSpan wraps near the end row
        payload(1, 2, json!([cell(0, 0, 1, 1), cell(0, 1, 1, big)])), // colSpan wraps near the end column
        payload(1, 2, json!([cell(0, 0, 1, 1), cell(0, 1, 1, 0)])),   // zero span
        payload(1, 2, json!([cell(0, 0, 1, 1), cell(0, 1, 1, 2)])),   // span past the remaining extent
        payload(1, 2, json!([cell(0, 0, 1, 1), cell(1, 0, 1, 1)])),   // row outside the payload
        payload(big, 2, json!([cell(0, 0, 1, 1), cell(0, 1, 1, 1)])), // oversized grid
    ];
    let before = m.diagnostic_document().clone();
    let history = m.view().history;
    for (i, raw) in malformed.iter().enumerate() {
        let parsed: PasteTableCellsPayload = serde_json::from_value(raw.clone()).unwrap();
        assert!(!parsed.valid(), "case {i} validated");
        let target = table_target(&mut m);
        let r = m.apply(&[DocxOp::PasteTableCells { target, payload: parsed }]);
        assert_eq!(r.rejected, vec![0], "case {i} applied");
        assert!(*m.diagnostic_document() == before, "case {i} mutated the document");
        assert_eq!(m.view().history, history, "case {i} recorded history");
    }
    // Boundary-valid: a vertical merge reaching the last target row, and single cells at the last column.
    let ok: PasteTableCellsPayload = serde_json::from_value(payload(2, 2, json!([cell(0, 0, 2, 1), cell(0, 1, 1, 1), cell(1, 1, 1, 1)]))).unwrap();
    assert!(ok.valid());
    let target = table_target(&mut m);
    assert_eq!(m.apply(&[DocxOp::PasteTableCells { target, payload: ok }]).changed, 1);
}

#[test]
fn stage3_object_selection_uses_owned_picture_positions_and_preserves_document() {
    use wordcraft_engine::{io, Session};

    let png = tiny_png_b64(2, 2, [200, 10, 10]);
    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let _ = source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    for n in [1, 2] {
        source.run("insert.picture", &json!({"data": png})).unwrap();
        source.run("picture.size", &json!({"width": 30*n, "height": 20*n})).unwrap();
        source.run("select.collapse", &json!({"end": true})).unwrap();
    }
    let bytes = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &bytes).unwrap());
    let layout = reader.layout();
    let first = layout.find_object(0, |object| object.rect.w == 30.0).unwrap();
    let second = layout.find_object(first.page, |object| object.rect.w == 60.0).unwrap();
    let click = |hit: &wordcraft_engine::layout::hit::ObjectHit| DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + hit.rect.w / 2.0,
        y: hit.rect.y + hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let mut model = DocxModel::open(&bytes).unwrap();
    let baseline = model.export().unwrap();
    let text_caret = model.view().caret.unwrap();
    let out = model.apply(&[click(&first), insert("blocked"), DocxOp::DeleteForward]);
    assert_eq!(out.changed, 0);
    assert_eq!(out.rejected, vec![1, 2]);
    let selected = model.view();
    assert!(selected.caret.is_none() && selected.selection.is_empty());
    let view = serde_json::to_value(selected).unwrap();
    assert_eq!(view["object"]["kind"], "picture");
    assert_eq!(view["object"]["picture"]["widthPt"], 30.0);
    assert_eq!(view["object"]["picture"]["heightPt"], 20.0);
    assert_eq!(view["object"]["picture"]["wrap"], "inline");
    let id = view["object"]["position"].clone();
    let epoch = view["object"]["epoch"].as_u64().unwrap();

    assert_eq!(model.apply(&[click(&second)]).changed, 0);
    let view = serde_json::to_value(model.view()).unwrap();
    assert_ne!(view["object"]["position"], id);
    assert_eq!(view["object"]["picture"]["widthPt"], 60.0);
    assert!(view["object"]["epoch"].as_u64().unwrap() > epoch);
    assert_eq!(model.apply(&[DocxOp::DeselectObject {}]).changed, 0);
    assert!(model.view().object.is_none());

    assert_eq!(model.apply(&[click(&first), pointer(text_caret.page as u32, text_caret.x, text_caret.y + 2.0)]).changed, 0);
    assert!(model.view().object.is_none());
    assert!(model.view().caret.is_some());
    assert_eq!(model.export().unwrap(), baseline);
    assert!(model.same_as(&baseline));
}

#[test]
fn stage3_docx_graphic_inspection_preserves_models_and_package() {
    use wordcraft_engine::doc::{InlineObject, PartKind};
    use wordcraft_engine::{io, Session};
    use crate::services::save::service;

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source.run("insert.chart", &json!({"type":"line", "title":"Revenue"})).unwrap();
    source.run("select.collapse", &json!({"end":true})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source.run("insert.smartArt", &json!({"layout":"process"})).unwrap();
    let bytes = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut reopen = Session::new(io::open_bytes("fixture.docx", &bytes).unwrap());
    let mut model = DocxModel::open(&bytes).unwrap();
    let original = model.export().unwrap();
    let layout = reopen.layout();
    let mut frames = Vec::new();
    for kind in ["chart", "smartArt"] {
        let object = layout.find_object(0, |hit| {
            let pos = hit.pos();
            reopen.doc.para_at(&pos).and_then(|p| p.object_at(pos.off)).is_some_and(|o|
                matches!(o, InlineObject::Graphic { graphic, .. } if (kind == "chart" && graphic.chart.is_some()) || (kind == "smartArt" && graphic.smart_art.is_some())))
        }).unwrap();
        let x = object.rect.x + object.rect.w / 2.0;
        let y = object.rect.y + object.rect.h / 2.0;
        let result = model.apply(&[DocxOp::Pointer {
            page: object.page as u32, x, y, extend: false, before_insert: false, drag: false, select_object: true,
        }]);
        assert_eq!(result.changed, 0);
        let view = serde_json::to_value(model.view()).unwrap();
        assert_eq!(view["object"]["kind"], kind);
        let details = &view["object"]["graphic"];
        if kind == "chart" {
            assert_eq!(details["plot"], "line");
            assert_eq!(details["title"], "Revenue");
            assert_eq!(details["series"][0]["values"][0], "3.2");
        } else {
            assert_eq!(details["layout"], "process");
            assert_eq!(details["items"][0]["text"], "Plan");
        }
        frames.push(json!({"kind": kind, "page": object.page, "x": x, "y": y}));
    }
    assert_eq!(model.export().unwrap(), original);
    assert!(model.same_as(&original));
    assert!(reopen.doc.parts.values().all(|p| p.kind != PartKind::TextBox));

    reopen.run("select.objects", &json!({"index":0})).unwrap();
    reopen.run("chart.title", &json!({"text":"Changed"})).unwrap();
    let changed = io::save_bytes("fixture.docx", &reopen.doc).unwrap();
    // Stage 3 P4: the bound chart part may be regenerated (package proof), but a raw engine edit
    // leaves the model's kept part bytes stale, so the real reopen comparison still refuses it.
    // Product edits go through `DocxOp::ObjectEdit`, which resynchronises those bytes.
    use crate::services::save::preserve::FindingCode;
    let reopened = io::open_bytes("fixture.docx", &changed).unwrap();
    let same = matches!(
        wordcraft_engine::doc::roundtrip::roundtrip_equivalent(&reopen.doc, &reopened),
        Ok(true)
    );
    assert!(!same);
    let gate = service::check_saved(crate::document::Format::Docx, &bytes, &changed, None, same);
    assert_eq!(
        gate.findings,
        vec![crate::services::save::preserve::Finding {
            code: FindingCode::ReopenMismatch,
            part: None
        }],
        "{gate:?}"
    );

    let mut diagram = Session::new(io::open_bytes("fixture.docx", &bytes).unwrap());
    diagram.run("select.objects", &json!({"index":1})).unwrap();
    diagram.run("smartArt.items", &json!({"items":["Changed", "Original"]})).unwrap();
    let changed = io::save_bytes("fixture.docx", &diagram.doc).unwrap();
    let reopened = io::open_bytes("fixture.docx", &changed).unwrap();
    let same = matches!(
        wordcraft_engine::doc::roundtrip::roundtrip_equivalent(&diagram.doc, &reopened),
        Ok(true)
    );
    let gate = service::check_saved(crate::document::Format::Docx, &bytes, &changed, None, same);
    assert!(
        !same
            && gate
                .findings
                .iter()
                .any(|f| f.code == FindingCode::ReopenMismatch),
        "{gate:?}"
    );

    if let Some(out) = std::env::var_os("GEUL_STAGE3_GRAPHIC_FIXTURE") {
        let dir = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("graphics.docx"), bytes).unwrap();
        std::fs::write(dir.join("graphics-frames.json"), serde_json::to_vec(&frames).unwrap()).unwrap();
    }
}

#[test]
fn stage3_shape_clipboard_cut_refuses_stale_or_unowned_objects_and_roundtrips() {
    use wordcraft_engine::doc::{InlineObject, StoryRef};
    use wordcraft_engine::{io, Session};
    use crate::services::save::service;
    use super::engine::BasicShape;

    let source = fixture();
    let mut model = DocxModel::open(&source).unwrap();
    let append = DocxOp::Shape { kind: BasicShape::Rectangle };
    assert_eq!(model.apply(&[mv(MoveTarget::DocEnd, false), append.clone(), append]).changed, 2);
    let after_paste = model.export().unwrap();
    let mut independent = Session::new(io::open_bytes("fixture.docx", &after_paste).unwrap());
    let layout = independent.layout();
    let mut offsets = Vec::new();
    for path in independent.doc.para_paths(StoryRef::Body) {
        let para = independent.doc.para(StoryRef::Body, &path).unwrap();
        for off in para.object_offsets().into_iter().filter(|&off| matches!(para.object_at(off), Some(InlineObject::Shape { .. }))) {
            offsets.push(wordcraft_engine::doc::Pos { story: StoryRef::Body, path: path.clone(), off });
        }
    }
    assert_eq!(offsets.len(), 2);
    let select = |i: usize| {
        let frame = layout.object(&offsets[i], 0).unwrap();
        DocxOp::Pointer {
            page: frame.page as u32, x: frame.rect.x + frame.rect.w / 2.0, y: frame.rect.y + frame.rect.h / 2.0,
            extend: false, before_insert: false, drag: false, select_object: true,
        }
    };
    model.apply(&[select(0)]);
    let first = serde_json::to_value(model.view()).unwrap()["object"].clone();
    assert_eq!(first["clipboardShape"]["shape"], "rectangle");
    assert_eq!(first["clipboardShape"]["cutAllowed"], false);
    model.apply(&[select(1)]);
    let last = serde_json::to_value(model.view()).unwrap()["object"].clone();
    assert_eq!(last["clipboardShape"]["cutAllowed"], true);
    let cut = |key: &serde_json::Value| DocxOp::CutShape {
        position: key["position"].as_str().unwrap().into(), epoch: key["epoch"].as_u64().unwrap(),
    };
    assert_eq!(model.apply(&[cut(&first)]).rejected, vec![0]);
    assert_eq!(model.export().unwrap(), after_paste);
    assert_eq!(model.apply(&[cut(&last)]).changed, 1);
    let after_cut = model.export().unwrap();
    let gate = service::check_saved(crate::document::Format::Docx, &source, &after_cut, None, model.same_as(&after_cut));
    assert!(gate.is_safe(), "{gate:?}");
    let read = io::open_bytes("fixture.docx", &after_cut).unwrap();
    assert_eq!(read.body.iter().filter_map(|b| b.as_para()).flat_map(|p| &p.objects)
        .filter(|o| matches!(o, InlineObject::Shape { .. })).count(), 1);
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), after_paste);
    assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), after_cut);
}

#[test]
fn stage3_object_edit_moves_resizes_deletes_with_t009_and_history() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::{InlineObject, StoryRef};
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    for n in [1, 2] {
        let png = tiny_png_b64(2, 2, [10, 60 * n as u8, 10]);
        source.run("insert.picture", &json!({"data": png})).unwrap();
        source
            .run("picture.size", &json!({"width": 40*n, "height": 30*n}))
            .unwrap();
        source
            .run("select.collapse", &json!({"end": true}))
            .unwrap();
        source.run("text.newParagraph", &json!({})).unwrap();
    }
    let original = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    let baseline = model.export().unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original).unwrap());
    let layout = reader.layout();
    let first = layout.find_object(0, |o| o.rect.w == 40.0).unwrap();
    let click = |hit: &wordcraft_engine::layout::hit::ObjectHit| DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + hit.rect.w / 2.0,
        y: hit.rect.y + hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let key = |model: &mut DocxModel| {
        let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (
            v["position"].as_str().unwrap().to_owned(),
            v["epoch"].as_u64().unwrap(),
            v,
        )
    };
    let edit = |(position, epoch): (String, u64), edit: ObjectEdit| DocxOp::ObjectEdit {
        position,
        epoch,
        edit,
    };
    model.apply(&[click(&first)]);
    let (pos, epoch, view) = key(&mut model);
    assert_eq!(
        view["operations"],
        json!(["move", "resize", "delete", "crop", "wrap", "altText", "rotate", "zOrder"])
    );

    // Invalid sizes never reach the engine.
    assert!(!validate(&[edit(
        (pos.clone(), epoch),
        ObjectEdit::Bounds {
            x: None,
            y: None,
            width: Some(0.5),
            height: None
        }
    )]));
    assert!(!validate(&[edit(
        (pos.clone(), epoch),
        ObjectEdit::Bounds {
            x: Some(1.0),
            y: None,
            width: None,
            height: None
        }
    )]));
    assert!(!validate(&[edit(
        (pos.clone(), epoch),
        ObjectEdit::Nudge {
            dx: f32::NAN,
            dy: 0.0
        }
    )]));

    // Stale epoch / wrong position are refused without mutation.
    let resize = ObjectEdit::Bounds {
        x: None,
        y: None,
        width: Some(80.0),
        height: Some(50.0),
    };
    assert_eq!(
        model
            .apply(&[edit((pos.clone(), epoch + 1), resize.clone())])
            .rejected,
        vec![0]
    );
    assert_eq!(
        model
            .apply(&[edit(("body:0:0".into(), epoch), resize.clone())])
            .rejected,
        vec![0]
    );
    assert_eq!(model.export().unwrap(), baseline);

    // Resize keeps the object selected under a new epoch.
    assert_eq!(
        model
            .apply(&[edit((pos.clone(), epoch), resize.clone())])
            .changed,
        1
    );
    let (pos2, epoch2, view) = key(&mut model);
    assert_eq!(pos2, pos);
    assert!(epoch2 > epoch);
    assert_eq!(view["picture"]["widthPt"], 80.0);
    assert_eq!(view["picture"]["heightPt"], 50.0);
    // The old epoch is now stale.
    assert_eq!(
        model
            .apply(&[edit((pos.clone(), epoch), ObjectEdit::Delete {})])
            .rejected,
        vec![0]
    );
    let resized = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &resized,
        None,
        model.same_as(&resized)
    )
    .is_safe());

    // Move: the picture floats at the requested page position.
    let page = view["frame"]["page"].as_u64().unwrap();
    assert_eq!(
        model
            .apply(&[edit(
                (pos2.clone(), epoch2),
                ObjectEdit::Bounds {
                    x: Some(200.0),
                    y: Some(300.0),
                    width: None,
                    height: None
                }
            )])
            .changed,
        1
    );
    let (pos3, epoch3, view) = key(&mut model);
    assert_eq!(view["frame"]["page"].as_u64().unwrap(), page);
    assert!(
        (view["frame"]["x"].as_f64().unwrap() - 200.0).abs() < 1.0,
        "{view}"
    );
    assert!(
        (view["frame"]["y"].as_f64().unwrap() - 300.0).abs() < 1.0,
        "{view}"
    );
    assert_eq!(view["picture"]["wrap"], "square");
    assert_eq!(
        model
            .apply(&[edit(
                (pos3.clone(), epoch3),
                ObjectEdit::Nudge { dx: 6.0, dy: -4.0 }
            )])
            .changed,
        1
    );
    let (pos4, epoch4, view) = key(&mut model);
    assert!(
        (view["frame"]["x"].as_f64().unwrap() - 206.0).abs() < 1.0,
        "{view}"
    );
    let moved = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &moved,
        None,
        model.same_as(&moved)
    )
    .is_safe());
    let reopened = io::open_bytes("fixture.docx", &moved).unwrap();
    let floats: Vec<_> = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .filter_map(|o| match o {
            InlineObject::Image { w, h, float, .. } => Some((*w, *h, float.wrap)),
            _ => None,
        })
        .collect();
    assert_eq!(floats.len(), 2);
    assert!(floats.contains(&(80.0, 50.0, wordcraft_engine::doc::para::Wrap::Square)));
    assert!(floats.contains(&(80.0, 60.0, wordcraft_engine::doc::para::Wrap::Inline)));

    // Delete: the picture and only its media leave the package.
    assert_eq!(
        model
            .apply(&[edit((pos4, epoch4), ObjectEdit::Delete {})])
            .changed,
        1
    );
    assert!(model.view().object.is_none());
    let deleted = model.export().unwrap();
    let gate = service::check_saved(
        crate::document::Format::Docx,
        &original,
        &deleted,
        None,
        model.same_as(&deleted),
    );
    assert!(gate.is_safe(), "{gate:?}");
    let reopened = io::open_bytes("fixture.docx", &deleted).unwrap();
    let count = reopened
        .para_paths(StoryRef::Body)
        .iter()
        .filter_map(|p| reopened.para(StoryRef::Body, p))
        .flat_map(|p| p.objects.clone())
        .filter(|o| matches!(o, InlineObject::Image { .. }))
        .count();
    assert_eq!(count, 1);

    // One history step per edit.
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), moved);
    assert_eq!(model.apply(&[DocxOp::Undo {}, DocxOp::Undo {}]).changed, 2);
    assert_eq!(model.export().unwrap(), resized);
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), baseline);
    assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), resized);
}

#[test]
fn stage3_docx_picture_crop_wrap_alt_text_position_roundtrip() {
    use super::engine::{ObjectEdit, PositionPreset};
    use crate::services::save::service;
    use wordcraft_engine::doc::para::Wrap;
    use wordcraft_engine::doc::InlineObject;
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run(
            "insert.picture",
            &json!({"data": tiny_png_b64(4, 2, [1, 2, 3])}),
        )
        .unwrap();
    source
        .run("picture.size", &json!({"width": 120, "height": 60}))
        .unwrap();
    let original = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original).unwrap());
    let hit = reader
        .layout()
        .find_object(0, |o| o.rect.w == 120.0)
        .unwrap();
    model.apply(&[DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + 60.0,
        y: hit.rect.y + 30.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let state = |model: &mut DocxModel| {
        let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (
            v["position"].as_str().unwrap().to_owned(),
            v["epoch"].as_u64().unwrap(),
            v,
        )
    };
    let (_, _, view) = state(&mut model);
    assert_eq!(
        view["operations"],
        json!(["move", "resize", "delete", "crop", "wrap", "altText", "rotate", "zOrder"])
    );
    let apply = |model: &mut DocxModel, edit: ObjectEdit| {
        let (position, epoch, _) = state(model);
        model.apply(&[DocxOp::ObjectEdit {
            position,
            epoch,
            edit,
        }])
    };
    let gate = |model: &DocxModel| {
        let bytes = model.export().unwrap();
        assert!(service::check_saved(
            crate::document::Format::Docx,
            &original,
            &bytes,
            None,
            model.same_as(&bytes)
        )
        .is_safe());
        bytes
    };
    // Bounds checked before the engine.
    let (position, epoch, _) = state(&mut model);
    for bad in [
        ObjectEdit::Crop {
            left: 0.5,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        },
        ObjectEdit::Crop {
            left: f32::NAN,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        },
        ObjectEdit::AltText {
            text: "\u{0}".into(),
        },
        ObjectEdit::AltText {
            text: "line\nbreak".into(),
        },
        ObjectEdit::AltText {
            text: "가".repeat(1025),
        },
    ] {
        assert!(!validate(&[DocxOp::ObjectEdit {
            position: position.clone(),
            epoch,
            edit: bad
        }]));
    }

    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Crop {
                left: 0.1,
                top: 0.123456,
                right: 0.05,
                bottom: 0.0
            }
        )
        .changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert!(
        (view["picture"]["crop"][1].as_f64().unwrap() - 0.12346).abs() < 1e-6,
        "{view}"
    );
    assert_eq!(view["picture"]["widthPt"], 120.0);
    gate(&model);
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::AltText {
                text: "빨간 사각형 그림 · \"따옴표\" & <꺾쇠>".into()
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Wrap {
                wrap: Wrap::TopAndBottom
            }
        )
        .changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert_eq!(view["picture"]["wrap"], "topAndBottom");
    assert_eq!(
        view["picture"]["description"],
        "빨간 사각형 그림 · \"따옴표\" & <꺾쇠>"
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Position {
                preset: PositionPreset::TopRight
            }
        )
        .changed,
        1
    );
    let edited = gate(&model);
    let reopened = io::open_bytes("fixture.docx", &edited).unwrap();
    let image = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .find_map(|o| match o {
            InlineObject::Image {
                crop,
                alt,
                float,
                w,
                h,
                media,
                ..
            } => Some((*crop, alt.clone(), float.wrap, *w, *h, media.clone())),
            _ => None,
        })
        .unwrap();
    assert!(
        (image.0[0] - 0.1).abs() < 1e-6 && (image.0[2] - 0.05).abs() < 1e-6 && image.0[3] == 0.0
    );
    assert_eq!(image.1, "빨간 사각형 그림 · \"따옴표\" & <꺾쇠>");
    assert_eq!(image.2, Wrap::TopAndBottom);
    assert_eq!((image.3, image.4), (120.0, 60.0));
    // The media bytes are the original picture (crop does not re-encode).
    assert_eq!(
        reopened.media.get(&image.5),
        source.doc.media.values().next()
    );

    // Crop reset, back inline; each edit is one history step.
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Crop {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(&mut model, ObjectEdit::Wrap { wrap: Wrap::Inline }).changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert_eq!(view["picture"]["crop"], json!([0.0, 0.0, 0.0, 0.0]));
    assert_eq!(view["picture"]["wrap"], "inline");
    gate(&model);
    // A no-op edit is refused (no empty history step).
    assert_eq!(
        apply(&mut model, ObjectEdit::Wrap { wrap: Wrap::Inline }).rejected,
        vec![0]
    );
    assert_eq!(model.apply(&[DocxOp::Undo {}, DocxOp::Undo {}]).changed, 2);
    assert_eq!(model.export().unwrap(), edited);
}

#[test]
fn stage3_docx_shape_fill_outline_rotation_layer_roundtrip() {
    use super::engine::{BasicShape, ObjectEdit};
    use crate::services::save::service;
    use wordcraft_engine::doc::para::Wrap;
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{InlineObject, StoryRef};
    use wordcraft_engine::{io, Session};

    let original = fixture();
    let mut model = DocxModel::open(&original).unwrap();
    assert_eq!(
        model
            .apply(&[
                mv(MoveTarget::DocEnd, false),
                DocxOp::Shape {
                    kind: BasicShape::Ellipse
                }
            ])
            .changed,
        1
    );
    let inserted = model.export().unwrap();
    let mut session = Session::new(io::open_bytes("fixture.docx", &inserted).unwrap());
    let layout = session.layout();
    let pos = session
        .doc
        .para_paths(StoryRef::Body)
        .into_iter()
        .find_map(|path| {
            let para = session.doc.para(StoryRef::Body, &path)?;
            para.object_offsets()
                .first()
                .map(|&off| wordcraft_engine::doc::Pos {
                    story: StoryRef::Body,
                    path: path.clone(),
                    off,
                })
        })
        .unwrap();
    let hit = layout.object(&pos, 0).unwrap();
    model.apply(&[DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + hit.rect.w / 2.0,
        y: hit.rect.y + hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let state = |model: &mut DocxModel| {
        let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (
            v["position"].as_str().unwrap().to_owned(),
            v["epoch"].as_u64().unwrap(),
            v,
        )
    };
    let (_, _, view) = state(&mut model);
    assert_eq!(
        view["operations"],
        json!([
            "move", "resize", "delete", "wrap", "altText", "fill", "outline", "rotate", "zOrder"
        ])
    );
    assert_eq!(view["shape"]["fill"], "156082");
    let apply = |model: &mut DocxModel, edit: ObjectEdit| {
        let (position, epoch, _) = state(model);
        model.apply(&[DocxOp::ObjectEdit {
            position,
            epoch,
            edit,
        }])
    };
    let (position, epoch, _) = state(&mut model);
    for bad in [
        ObjectEdit::Fill {
            color: Some("12345".into()),
        },
        ObjectEdit::Fill {
            color: Some("GG0000".into()),
        },
        ObjectEdit::Outline {
            color: None,
            width: Some(73.0),
        },
        ObjectEdit::Rotate {
            degrees: f32::INFINITY,
            flip_h: false,
            flip_v: false,
        },
    ] {
        assert!(!validate(&[DocxOp::ObjectEdit {
            position: position.clone(),
            epoch,
            edit: bad
        }]));
    }
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Fill {
                color: Some("FF8800".into())
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Outline {
                color: Some("003366".into()),
                width: Some(2.33)
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Rotate {
                degrees: 33.3333,
                flip_h: true,
                flip_v: false
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(&mut model, ObjectEdit::Layer { front: false }).changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert_eq!(view["shape"]["fill"], "FF8800");
    assert_eq!(view["shape"]["outline"], "003366");
    assert_eq!(view["shape"]["flipH"], true);
    let edited = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &edited,
        None,
        model.same_as(&edited)
    )
    .is_safe());
    let reopened = io::open_bytes("fixture.docx", &edited).unwrap();
    let shape = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .find_map(|o| match o {
            InlineObject::Shape {
                fill,
                stroke,
                stroke_width,
                float,
                ..
            } => Some((*fill, *stroke, *stroke_width, float.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(shape.0, Some(Rgb(0xFF, 0x88, 0x00)));
    assert_eq!(shape.1, Some(Rgb(0x00, 0x33, 0x66)));
    assert!((shape.2 - 2.33).abs() < 0.001);
    assert!((shape.3.rot - 33.3333).abs() < 0.001 && shape.3.flip_h && !shape.3.flip_v);
    assert_eq!(shape.3.wrap, Wrap::BehindText);
    // Fill removal and front layer, then four undos back to the inserted shape.
    assert_eq!(
        apply(&mut model, ObjectEdit::Fill { color: None }).changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert!(view["shape"]["fill"].is_null());
    assert_eq!(
        apply(&mut model, ObjectEdit::Layer { front: true }).changed,
        1
    );
    let bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &bytes,
        None,
        model.same_as(&bytes)
    )
    .is_safe());
    assert_eq!(model.apply(&[DocxOp::Undo {}, DocxOp::Undo {}]).changed, 2);
    assert_eq!(model.export().unwrap(), edited);
    assert_eq!(
        model
            .apply(&[
                DocxOp::Undo {},
                DocxOp::Undo {},
                DocxOp::Undo {},
                DocxOp::Undo {}
            ])
            .changed,
        4
    );
    assert_eq!(model.export().unwrap(), inserted);
}

#[test]
fn stage3_docx_bezier_path_point_edit_preserves_source_structure_t009_and_history() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::freeform::{
        DrawingMlGeometry, DrawingMlPath, DrawingMlPathCommand as Command, FreePath, Freeform,
    };
    use wordcraft_engine::doc::para::{Float, ShapeKind};
    use wordcraft_engine::doc::props::{CharProps, Rgb};
    use wordcraft_engine::doc::{InlineObject, StoryRef};
    use wordcraft_engine::{io, Session};

    let mut seed = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let body_end = seed.doc.end_of(StoryRef::Body);
    seed.run("caret.set", &json!({"pos": body_end})).unwrap();
    seed.run("text.newParagraph", &json!({})).unwrap();
    let geometry_xml = r#"<a:custGeom><a:avLst/><a:gdLst><a:gd name="g1" fmla="val 4"/></a:gdLst><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="1270000" h="635000" fill="norm" stroke="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:quadBezTo><a:pt x="127000" y="63500"/><a:pt x="254000" y="127000"/></a:quadBezTo><a:close/></a:path><a:path w="2540000" h="1270000" fill="none" extrusionOk="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="254000" y="0"/><a:pt x="508000" y="127000"/><a:pt x="762000" y="381000"/></a:cubicBezTo></a:path></a:pathLst></a:custGeom>"#;
    let geometry = DrawingMlGeometry {
        before_paths_xml: vec![
            "<a:avLst/>".into(),
            r#"<a:gdLst><a:gd name="g1" fmla="val 4"/></a:gdLst>"#.into(),
            "<a:ahLst/>".into(),
            "<a:cxnLst/>".into(),
            r#"<a:rect l="0" t="0" r="r" b="b"/>"#.into(),
        ],
        paths: vec![
            DrawingMlPath {
                viewport: [1_270_000, 635_000],
                attrs: vec![
                    ("w".into(), "1270000".into()),
                    ("h".into(), "635000".into()),
                    ("fill".into(), "norm".into()),
                    ("stroke".into(), "1".into()),
                ],
                commands: Some(vec![
                    Command::MoveTo { point: [0, 0] },
                    Command::QuadraticTo { control: [127_000, 63_500], end: [254_000, 127_000] },
                    Command::Close,
                ]),
                source_xml: r#"<a:path w="1270000" h="635000" fill="norm" stroke="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:quadBezTo><a:pt x="127000" y="63500"/><a:pt x="254000" y="127000"/></a:quadBezTo><a:close/></a:path>"#.into(),
                render_path_indexes: vec![0],
                ..Default::default()
            },
            DrawingMlPath {
                viewport: [2_540_000, 1_270_000],
                attrs: vec![
                    ("w".into(), "2540000".into()),
                    ("h".into(), "1270000".into()),
                    ("fill".into(), "none".into()),
                    ("extrusionOk".into(), "1".into()),
                ],
                commands: Some(vec![
                    Command::MoveTo { point: [0, 0] },
                    Command::CubicTo { control1: [254_000, 0], control2: [508_000, 127_000], end: [762_000, 381_000] },
                ]),
                source_xml: r#"<a:path w="2540000" h="1270000" fill="none" extrusionOk="1"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="254000" y="0"/><a:pt x="508000" y="127000"/><a:pt x="762000" y="381000"/></a:cubicBezTo></a:path>"#.into(),
                render_path_indexes: vec![1],
                ..Default::default()
            },
        ],
        source_xml: geometry_xml.into(),
        editable: true,
        ..Default::default()
    };
    let mut freeform = Freeform {
        w: 100.0,
        h: 50.0,
        paths: vec![FreePath { pts: Vec::new(), closed: false }, FreePath { pts: Vec::new(), closed: false }],
        drawingml: Some(geometry),
        ..Default::default()
    };
    freeform.refresh_drawingml_render_points();
    let object = InlineObject::Shape {
        kind: ShapeKind::Freeform,
        w: 100.0,
        h: 50.0,
        fill: Some(Rgb(0x11, 0x22, 0x33)),
        stroke: Some(Rgb(0x44, 0x55, 0x66)),
        stroke_width: 1.0,
        float: Float { rot: 30.0, flip_h: true, flip_v: false, ..Float::default() },
        story: None,
        freeform: Some(std::sync::Arc::new(freeform)),
        effects: Default::default(),
        extra: Default::default(),
    };
    let at = seed.sel.focus.clone();
    seed.doc.insert_object(&at, object, &CharProps::default()).unwrap();
    let original = io::save_bytes("fixture.docx", &seed.doc).unwrap();

    let mut model = DocxModel::open(&original).unwrap();
    assert!(model.render_png(0, 1.0).is_some(), "a document with editable DrawingML Bézier paths renders");
    if let Some(path) = std::env::var_os("GEUL_STAGE3_DOCX_CURVE_FIXTURE") {
        let bytes = std::fs::read(path).expect("generated Native DOCX fixture");
        let mut parsed = DocxModel::open(&bytes).expect("generated Native DOCX fixture parses in WordCraft");
        assert!(parsed.render_png(0, 1.0).is_some(), "generated quadratic/cubic fixture renders");
    }
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original).unwrap());
    let hit = reader.layout().find_object(0, |_| true).unwrap();
    let select = DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + hit.rect.w / 2.0,
        y: hit.rect.y + hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    assert_eq!(model.apply(&[select.clone()]).rejected, Vec::<usize>::new());

    let state = |model: &mut DocxModel| {
        let object = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (object["position"].as_str().unwrap().to_owned(), object["epoch"].as_u64().unwrap(), object)
    };
    let (position, epoch, selected) = state(&mut model);
    assert!(selected["operations"].as_array().unwrap().iter().any(|op| op == "pathPoint"));
    assert_eq!(selected["shape"]["rotation"], 30.0);
    assert_eq!(selected["shape"]["flipH"], true);
    assert_eq!(selected["shape"]["flipV"], false);
    assert_eq!(selected["drawingMlPaths"][0]["segments"][1]["command"], "quadBezTo");
    assert_eq!(selected["drawingMlPaths"][1]["segments"][1]["command"], "cubicBezTo");
    assert_eq!(selected["drawingMlPaths"][1]["segments"][1]["points"][0]["x"], 254000);
    let baseline = model.export().unwrap();
    let history = serde_json::to_value(model.view()).unwrap()["history"].clone();
    let mut direct = DocxModel::open(&original).unwrap();
    direct.apply(&[select]);
    let selected_start = hit.pos();
    let selected_end = wordcraft_engine::doc::Pos {
        off: selected_start.off + wordcraft_engine::doc::para::OBJ.len_utf8(),
        ..selected_start.clone()
    };
    let direct_select = direct.run_engine("select.range", json!({"anchor": selected_start, "focus": selected_end}));
    let direct_ok = direct.run_engine("shape.pathPoint", json!({"path": 1, "segment": 1, "point": 0, "x": 300_000, "y": 100_000}));
    let direct_bytes = direct.export().unwrap();
    let direct_same = direct.same_as(&direct_bytes);
    let direct_gate = service::check_saved(crate::document::Format::Docx, &original, &direct_bytes, None, direct_same);
    assert!(direct_select && direct_ok, "the engine path-point command selects and edits this freeform");
    assert!(direct_same && direct_gate.is_safe(), "the direct engine edit passes T009: {direct_gate:?}");
    let rejected = model.apply(&[DocxOp::ObjectEdit {
        position: position.clone(),
        epoch,
        edit: ObjectEdit::DocxPathPoint { path: 1, segment: 1, point: 0, x: 2_540_001, y: 100_000 },
    }]);
    assert_eq!(rejected.rejected, vec![0], "coordinates outside the path viewport fail closed");
    assert_eq!(model.export().unwrap(), baseline);
    assert_eq!(serde_json::to_value(model.view()).unwrap()["history"], history);

    let edit = model.apply(&[DocxOp::ObjectEdit {
        position,
        epoch,
        edit: ObjectEdit::DocxPathPoint { path: 1, segment: 1, point: 0, x: 300_000, y: 100_000 },
    }]);
    assert_eq!((edit.changed, edit.rejected), (1, Vec::new()));
    let after = model.export().unwrap();
    let gate = service::check_saved(crate::document::Format::Docx, &original, &after, None, model.same_as(&after));
    assert!(gate.is_safe(), "{gate:?}");

    let reopened = io::open_bytes("fixture.docx", &after).unwrap();
    let reopened_freeform = reopened.body.iter().filter_map(|block| block.as_para()).flat_map(|para| &para.objects).find_map(|object| match object {
        InlineObject::Shape { kind: ShapeKind::Freeform, freeform: Some(freeform), .. } => Some(freeform),
        _ => None,
    }).expect("independent saved file contains its editable custom geometry");
    let reopened_geometry = reopened_freeform.drawingml.as_ref().unwrap();
    assert_eq!(reopened_geometry.paths[0].commands.as_ref().unwrap()[1], Command::QuadraticTo { control: [127_000, 63_500], end: [254_000, 127_000] });
    assert_eq!(reopened_geometry.paths[1].commands.as_ref().unwrap()[1], Command::CubicTo { control1: [300_000, 100_000], control2: [508_000, 127_000], end: [762_000, 381_000] });
    assert_eq!(reopened_geometry.paths[0].attrs, vec![("w".into(), "1270000".into()), ("h".into(), "635000".into()), ("fill".into(), "norm".into()), ("stroke".into(), "1".into())]);
    let reopened_spin = reopened.body.iter().filter_map(|block| block.as_para()).flat_map(|para| &para.objects).find_map(|object| match object {
        InlineObject::Shape { kind: ShapeKind::Freeform, float, .. } => Some(float),
        _ => None,
    }).expect("independent saved file preserves freeform rotation and flips");
    assert_eq!(reopened_spin.rot, 30.0);
    assert!(reopened_spin.flip_h);
    assert!(!reopened_spin.flip_v);

    assert!(model.apply(&[DocxOp::Undo {}]).rejected.is_empty());
    assert_eq!(model.export().unwrap(), baseline, "undo restores the complete original custom geometry");
    assert!(model.apply(&[DocxOp::Redo {}]).rejected.is_empty());
    assert_eq!(model.export().unwrap(), after, "redo restores the accepted serialized edit");
}


#[test]
fn stage3_docx_path_vertex_edits_preserve_open_closed_t009_and_history() {
    use super::engine::{DocxPathVertexAction, ObjectEdit};
    use crate::services::save::service;
    use wordcraft_engine::doc::freeform::DrawingMlPathCommand as Command;
    use wordcraft_engine::doc::InlineObject;
    use wordcraft_engine::{io, Session};

    let fixture_dir = std::path::PathBuf::from(std::env::var_os("GEUL_STAGE3_DOCX_PATH_FIXTURES").expect("generated DOCX line-path fixtures"));
    let select = |model: &mut DocxModel, bytes: &[u8]| {
        let mut reader = Session::new(io::open_bytes("path.docx", bytes).unwrap());
        let hit = reader.layout().find_object(0, |_| true).unwrap();
        let result = model.apply(&[DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        }]);
        assert!(result.rejected.is_empty());
        let object = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (object["position"].as_str().unwrap().to_owned(), object["epoch"].as_u64().unwrap(), object)
    };
    let saved_freeform = |bytes: &[u8]| {
        let document = io::open_bytes("path.docx", bytes).unwrap();
        document.body.iter().filter_map(|block| block.as_para()).flat_map(|paragraph| &paragraph.objects).find_map(|object| match object {
            InlineObject::Shape { kind: wordcraft_engine::doc::para::ShapeKind::Freeform, freeform: Some(freeform), .. } => Some(freeform.clone()),
            _ => None,
        }).expect("saved document contains the editable freeform")
    };

    let open_bytes = std::fs::read(fixture_dir.join("open.docx")).expect("open-path fixture");
    let mut open_model = DocxModel::open(&open_bytes).unwrap();
    assert!(open_model.render_png(0, 1.0).is_some());
    let (position, epoch, selected) = select(&mut open_model, &open_bytes);
    assert!(selected["operations"].as_array().unwrap().iter().any(|operation| operation == "pathVertex"));
    let open_baseline = open_model.export().unwrap();
    let edit = open_model.apply(&[DocxOp::ObjectEdit {
        position: position.clone(), epoch,
        edit: ObjectEdit::DocxPathVertex { path: 0, segment: 1, action: DocxPathVertexAction::Insert, x: Some(50), y: Some(0) },
    }]);
    assert_eq!((edit.changed, edit.rejected), (1, Vec::new()));
    let open_inserted = open_model.export().unwrap();
    let gate = service::check_saved(crate::document::Format::Docx, &open_bytes, &open_inserted, None, open_model.same_as(&open_inserted));
    assert!(gate.is_safe(), "{gate:?}");
    let reopened = DocxModel::open(&open_inserted).unwrap();
    let commands = reopened.diagnostic_document().body.iter().filter_map(|block| block.as_para()).flat_map(|paragraph| &paragraph.objects).find_map(|object| match object {
        InlineObject::Shape { freeform: Some(freeform), .. } => Some(&freeform.drawingml.as_ref().unwrap().paths[0].commands),
        _ => None,
    }).unwrap().as_ref().unwrap();
    assert_eq!(commands, &[
        Command::MoveTo { point: [0, 0] },
        Command::LineTo { point: [50, 0] },
        Command::LineTo { point: [100, 0] },
        Command::LineTo { point: [200, 0] },
    ]);
    assert_eq!(open_model.apply(&[DocxOp::Undo {}]).rejected, Vec::<usize>::new());
    assert_eq!(open_model.export().unwrap(), open_baseline);
    assert_eq!(open_model.apply(&[DocxOp::Redo {}]).rejected, Vec::<usize>::new());
    assert_eq!(open_model.export().unwrap(), open_inserted);
    let open_history_after_redo = serde_json::to_value(open_model.view()).unwrap()["history"].clone();
    let (position, current_epoch, _) = select(&mut open_model, &open_inserted);
    let rejected = open_model.apply(&[DocxOp::ObjectEdit {
        position,
        epoch: current_epoch,
        edit: ObjectEdit::DocxPathVertex { path: 0, segment: 1, action: DocxPathVertexAction::Insert, x: Some(75), y: Some(1) },
    }]);
    assert_eq!(rejected.rejected, vec![0], "a non-collinear insertion is rejected before serialization");
    assert_eq!(open_model.export().unwrap(), open_inserted);
    assert_eq!(serde_json::to_value(open_model.view()).unwrap()["history"], open_history_after_redo);

    let closed_bytes = std::fs::read(fixture_dir.join("closed.docx")).expect("closed-path fixture");
    let mut direct = Session::new(io::open_bytes("path.docx", &closed_bytes).unwrap());
    direct.run("select.objects", &json!({"index": 0})).unwrap();
    direct.run("shape.pathVertex", &json!({"path": 0, "segment": 1, "action": "remove"})).unwrap();
    let direct_output = io::save_bytes("path.docx", &direct.doc).unwrap();
    let direct_reopened = io::open_bytes("path.docx", &direct_output).unwrap();
    let direct_same = wordcraft_engine::doc::roundtrip::compare_roundtrip(
        &direct.doc,
        &direct_reopened,
        &wordcraft_engine::doc::roundtrip::RoundTripLimits::default(),
    );
    let direct_equal = matches!(direct_same, Ok(wordcraft_engine::doc::roundtrip::Equivalence::Equivalent(_)));
    let direct_gate = service::check_saved(
        crate::document::Format::Docx,
        &closed_bytes,
        &direct_output,
        None,
        direct_equal,
    );
    assert!(direct_equal, "direct WordCraft path removal roundtrip: {direct_same:?}");
    assert!(direct_gate.is_safe(), "direct WordCraft path removal T009: {direct_gate:?}");
    let mut closed_model = DocxModel::open(&closed_bytes).unwrap();
    let (position, epoch, selected) = select(&mut closed_model, &closed_bytes);
    assert!(selected["operations"].as_array().unwrap().iter().any(|operation| operation == "pathVertex"));
    let closed_baseline = closed_model.export().unwrap();
    let remove = closed_model.apply(&[DocxOp::ObjectEdit {
        position: position.clone(), epoch,
        edit: ObjectEdit::DocxPathVertex { path: 0, segment: 1, action: DocxPathVertexAction::Remove, x: None, y: None },
    }]);
    assert_eq!((remove.changed, remove.rejected), (1, Vec::new()), "selected closed-path shape: {selected:?}");
    let closed_removed = closed_model.export().unwrap();
    let gate = service::check_saved(crate::document::Format::Docx, &closed_bytes, &closed_removed, None, closed_model.same_as(&closed_removed));
    assert!(gate.is_safe(), "{gate:?}");
    let reopened_freeform = saved_freeform(&closed_removed);
    let commands = reopened_freeform.drawingml.as_ref().unwrap().paths[0].commands.as_ref().unwrap();
    assert_eq!(commands, &[
        Command::MoveTo { point: [0, 0] },
        Command::LineTo { point: [100, 100] },
        Command::LineTo { point: [0, 100] },
        Command::Close,
    ]);
    assert_eq!(closed_model.apply(&[DocxOp::Undo {}]).rejected, Vec::<usize>::new());
    assert_eq!(closed_model.export().unwrap(), closed_baseline);
    assert_eq!(closed_model.apply(&[DocxOp::Redo {}]).rejected, Vec::<usize>::new());
    assert_eq!(closed_model.export().unwrap(), closed_removed);
    let (position, current_epoch, _) = select(&mut closed_model, &closed_removed);
    let rejected = closed_model.apply(&[DocxOp::ObjectEdit {
        position,
        epoch: current_epoch,
        edit: ObjectEdit::DocxPathVertex { path: 0, segment: 1, action: DocxPathVertexAction::Remove, x: None, y: None },
    }]);
    assert_eq!(rejected.rejected, vec![0], "a closed path retains at least three vertices");
    assert_eq!(closed_model.export().unwrap(), closed_removed);
}

#[test]
fn stage3_docx_picture_in_table_cell_admits_only_in_place_edits() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::InlineObject;
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run("insert.table", &json!({"rows": 1, "cols": 2}))
        .unwrap();
    source
        .run(
            "insert.picture",
            &json!({"data": tiny_png_b64(2, 2, [9, 9, 9])}),
        )
        .unwrap();
    source
        .run("picture.size", &json!({"width": 50, "height": 25}))
        .unwrap();
    let original = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original).unwrap());
    let hit = reader
        .layout()
        .find_object(0, |o| o.rect.w == 50.0)
        .unwrap();
    assert!(
        hit.pos().path.0.len() > 1,
        "picture is inside the table cell"
    );
    model.apply(&[DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + 25.0,
        y: hit.rect.y + 12.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
    assert_eq!(
        v["operations"],
        json!(["resize", "delete", "crop", "altText"])
    );
    let (position, epoch) = (
        v["position"].as_str().unwrap().to_owned(),
        v["epoch"].as_u64().unwrap(),
    );
    let baseline = model.export().unwrap();
    for edit in [
        ObjectEdit::Nudge { dx: 1.0, dy: 0.0 },
        ObjectEdit::Bounds {
            x: Some(10.0),
            y: Some(10.0),
            width: None,
            height: None,
        },
    ] {
        assert_eq!(
            model
                .apply(&[DocxOp::ObjectEdit {
                    position: position.clone(),
                    epoch,
                    edit
                }])
                .rejected,
            vec![0]
        );
    }
    assert_eq!(model.export().unwrap(), baseline);
    let resized = model.apply(&[DocxOp::ObjectEdit {
        position,
        epoch,
        edit: ObjectEdit::Bounds {
            x: None,
            y: None,
            width: Some(80.0),
            height: Some(40.0),
        },
    }]);
    assert_eq!(resized.changed, 1);
    let bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &bytes,
        None,
        model.same_as(&bytes)
    )
    .is_safe());
    let reopened = io::open_bytes("fixture.docx", &bytes).unwrap();
    let mut found = Vec::new();
    for path in reopened.para_paths(wordcraft_engine::doc::StoryRef::Body) {
        let para = reopened
            .para(wordcraft_engine::doc::StoryRef::Body, &path)
            .unwrap();
        for o in &para.objects {
            if let InlineObject::Image { w, h, .. } = o {
                found.push((path.0.len(), *w, *h));
            }
        }
    }
    assert_eq!(found.len(), 1);
    assert!(
        found[0].0 > 1 && found[0].1 == 80.0 && found[0].2 == 40.0,
        "{found:?}"
    );
    // Deleting it removes the picture and its now-unused media (table media proof).
    let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
    let deleted = model.apply(&[DocxOp::ObjectEdit {
        position: v["position"].as_str().unwrap().to_owned(),
        epoch: v["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::Delete {},
    }]);
    assert_eq!(deleted.changed, 1);
    let bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original,
        &bytes,
        None,
        model.same_as(&bytes)
    )
    .is_safe());
    assert!(io::open_bytes("fixture.docx", &bytes)
        .unwrap()
        .media
        .is_empty());
}

#[test]
fn stage3_docx_nested_cell_and_textbox_objects_admit_only_in_place_edits() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::{InlineObject, PartKind, StoryRef};
    use wordcraft_engine::{io, Session};

    // 1. Depth-2 nested table cell: outer table -> cell -> inner table -> cell -> picture + shape.
    let mut nested = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    nested.run("caret.docEnd", &json!({})).unwrap();
    nested.run("text.newParagraph", &json!({})).unwrap();
    nested.run("insert.table", &json!({"rows": 1, "cols": 2})).unwrap();
    nested.run("insert.table", &json!({"rows": 1, "cols": 2})).unwrap();
    nested
        .run("insert.picture", &json!({"data": tiny_png_b64(2, 2, [4, 5, 6])}))
        .unwrap();
    nested.run("picture.size", &json!({"width": 44, "height": 22})).unwrap();
    nested.run("select.collapse", &json!({"end": true})).unwrap();
    nested.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
    nested.run("picture.size", &json!({"width": 36, "height": 18})).unwrap();
    let nested_original = io::save_bytes("fixture.docx", &nested.doc).unwrap();

    let mut reader = Session::new(io::open_bytes("fixture.docx", &nested_original).unwrap());
    let layout = reader.layout();
    let click = |page: usize, x: f32, y: f32| DocxOp::Pointer {
        page: page as u32,
        x,
        y,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let pic_hit = layout
        .find_object(0, |o| o.path.0.len() > 4 && (o.rect.w - 44.0).abs() < 0.5)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();

    let mut model = DocxModel::open(&nested_original).unwrap();
    model.apply(&[pic_hit.clone()]);
    let obj_view = |m: &mut DocxModel| serde_json::to_value(m.view()).unwrap()["object"].clone();
    let v = obj_view(&mut model);
    assert_eq!(v["operations"], json!(["resize", "delete", "crop", "altText"]));
    let (pos_p, ep_p) = (v["position"].as_str().unwrap().to_owned(), v["epoch"].as_u64().unwrap());
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit { position: pos_p.clone(), epoch: ep_p, edit: ObjectEdit::Nudge { dx: 2.0, dy: 0.0 } }]).rejected,
        vec![0]
    );
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit {
            position: pos_p.clone(),
            epoch: ep_p,
            edit: ObjectEdit::Bounds { x: None, y: None, width: Some(66.0), height: Some(33.0) },
        }]).changed,
        1
    );
    let v = obj_view(&mut model);
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Crop { left: 0.1, top: 0.0, right: 0.0, bottom: 0.0 },
        }]).changed,
        1
    );
    let mid_nested = model.export().unwrap();
    let mut mid_reader = Session::new(io::open_bytes("fixture.docx", &mid_nested).unwrap());
    let shape_hit = mid_reader
        .layout()
        .find_object(0, |o| o.path.0.len() > 4 && (o.rect.w - 36.0).abs() < 0.5)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();
    model.apply(&[shape_hit]);
    let v = obj_view(&mut model);
    assert_eq!(v["operations"], json!(["resize", "delete", "altText", "fill", "outline"]));
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Fill { color: Some("336699".into()) },
        }]).changed,
        1
    );
    let saved_nested = model.export().unwrap();
    assert!(service::check_saved(crate::document::Format::Docx, &nested_original, &saved_nested, None, model.same_as(&saved_nested)).is_safe());
    let reopened = io::open_bytes("fixture.docx", &saved_nested).unwrap();
    assert!(reopened.para_paths(StoryRef::Body).iter().any(|path| {
        path.0.len() > 4 && reopened.para(StoryRef::Body, path).is_some_and(|p| {
            p.objects.iter().any(|o| matches!(o, InlineObject::Image { w, h, crop, .. } if *w == 66.0 && *h == 33.0 && (crop[0] - 0.1).abs() < 1e-4))
                && p.objects.iter().any(|o| matches!(o, InlineObject::Shape { fill: Some(c), .. } if c.hex() == "336699"))
        })
    }));
    // Delete picture inside depth-2 cell and verify media cleanup + Undo restore.
    model.apply(&[pic_hit]);
    let v = obj_view(&mut model);
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Delete {},
        }]).changed,
        1
    );
    let deleted_nested = model.export().unwrap();
    assert!(service::check_saved(crate::document::Format::Docx, &nested_original, &deleted_nested, None, model.same_as(&deleted_nested)).is_safe());
    assert!(io::open_bytes("fixture.docx", &deleted_nested).unwrap().media.is_empty());
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.diagnostic_document().media.len(), 1);

    // 2. Shapes and a picture inside a Body-hosted TextBox.
    let mut boxed = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    boxed.run("caret.docEnd", &json!({})).unwrap();
    boxed.run("text.newParagraph", &json!({})).unwrap();
    boxed.run("insert.textBox", &json!({"width": 240, "height": 180})).unwrap();
    boxed.run("text.insert", &json!({"text": "상자안"})).unwrap();
    boxed.run("insert.picture", &json!({"data": tiny_png_b64(16, 16, [140, 90, 40])})).unwrap();
    boxed.run("picture.size", &json!({"width": 40, "height": 20})).unwrap();
    boxed.run("select.collapse", &json!({"end": true})).unwrap();
    boxed.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
    boxed.run("picture.size", &json!({"width": 48, "height": 24})).unwrap();
    boxed.run("shape.fill", &json!({"color": "7A47A8"})).unwrap();
    boxed.run("select.collapse", &json!({"end": true})).unwrap();
    boxed.run("insert.shape", &json!({"kind": "ellipse"})).unwrap();
    boxed.run("picture.size", &json!({"width": 32, "height": 16})).unwrap();
    let boxed_draft = io::save_bytes("fixture.docx", &boxed.doc).unwrap();
    let boxed_original = io::save_bytes(
        "fixture.docx",
        &io::open_bytes("fixture.docx", &boxed_draft).unwrap(),
    ).unwrap();

    let mut box_reader = Session::new(io::open_bytes("fixture.docx", &boxed_original).unwrap());
    let box_layout = box_reader.layout();
    let tb_rect = box_layout
        .find_object(0, |o| matches!(o.story, StoryRef::Part(_)) && (o.rect.w - 48.0).abs() < 0.5)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();

    let mut tb_model = DocxModel::open(&boxed_original).unwrap();
    tb_model.apply(&[tb_rect.clone()]);
    let v = obj_view(&mut tb_model);
    assert_eq!(v["operations"], json!(["resize", "delete", "altText", "fill", "outline"]));
    let (r_pos, r_ep) = (v["position"].as_str().unwrap().to_owned(), v["epoch"].as_u64().unwrap());
    assert!(r_pos.starts_with("part"), "{r_pos}");
    assert_eq!(
        tb_model.apply(&[DocxOp::ObjectEdit { position: r_pos.clone(), epoch: r_ep, edit: ObjectEdit::Wrap { wrap: wordcraft_engine::doc::para::Wrap::Square } }]).rejected,
        vec![0]
    );
    assert_eq!(
        tb_model.apply(&[DocxOp::ObjectEdit {
            position: r_pos.clone(),
            epoch: r_ep,
            edit: ObjectEdit::AltText { text: "상자 도형".into() },
        }]).changed,
        1
    );
    let v = obj_view(&mut tb_model);
    assert_eq!(
        tb_model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Bounds { x: None, y: None, width: Some(60.0), height: Some(30.0) },
        }]).changed,
        1
    );
    let mid_boxed = tb_model.export().unwrap();
    let mut mid_box_reader = Session::new(io::open_bytes("fixture.docx", &mid_boxed).unwrap());
    let tb_shape = mid_box_reader
        .layout()
        .find_object(0, |o| matches!(o.story, StoryRef::Part(_)) && (o.rect.w - 32.0).abs() < 0.5)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();
    tb_model.apply(&[tb_shape]);
    let v = obj_view(&mut tb_model);
    assert_eq!(v["operations"], json!(["resize", "delete", "altText", "fill", "outline"]));
    assert_eq!(
        tb_model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Outline { color: Some("114488".into()), width: Some(2.0) },
        }]).changed,
        1
    );
    let saved_boxed = tb_model.export().unwrap();
    assert!(service::check_saved(crate::document::Format::Docx, &boxed_original, &saved_boxed, None, tb_model.same_as(&saved_boxed)).is_safe());
    let reopened_box = io::open_bytes("fixture.docx", &saved_boxed).unwrap();
    let (&tb_id, _) = reopened_box.parts.iter().find(|(_, p)| p.kind == PartKind::TextBox).unwrap();
    let tb_story = StoryRef::Part(tb_id);
    assert!(reopened_box.para_paths(tb_story).iter().any(|path| {
        reopened_box.para(tb_story, path).is_some_and(|p| {
            p.objects.iter().any(|o| matches!(o, InlineObject::Shape { w, h, float, .. } if *w == 60.0 && *h == 30.0 && float.alt.text == "상자 도형"))
                && p.objects.iter().any(|o| matches!(o, InlineObject::Shape { stroke: Some(c), stroke_width, .. } if c.hex() == "114488" && (*stroke_width - 2.0).abs() < 0.01))
        })
    }));
    // Delete the rectangle inside TextBox, verify T009, and Undo restore.
    tb_model.apply(&[tb_rect]);
    let v = obj_view(&mut tb_model);
    assert_eq!(
        tb_model.apply(&[DocxOp::ObjectEdit {
            position: v["position"].as_str().unwrap().to_owned(),
            epoch: v["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Delete {},
        }]).changed,
        1
    );
    let deleted_boxed = tb_model.export().unwrap();
    assert!(service::check_saved(crate::document::Format::Docx, &boxed_original, &deleted_boxed, None, tb_model.same_as(&deleted_boxed)).is_safe());
    let reopened_deleted = io::open_bytes("fixture.docx", &deleted_boxed).unwrap();
    let (&del_tb_id, _) = reopened_deleted.parts.iter().find(|(_, p)| p.kind == PartKind::TextBox).unwrap();
    assert_eq!(
        reopened_deleted.para_paths(StoryRef::Part(del_tb_id)).iter()
            .filter_map(|p| reopened_deleted.para(StoryRef::Part(del_tb_id), p))
            .map(|p| p.objects.len())
            .sum::<usize>(),
        2
    );
    assert_eq!(tb_model.apply(&[DocxOp::Undo {}]).changed, 1);

    // The nested picture is a separate object owned by the TextBox story, not a body picture or
    // the enclosing TextBox frame. Its media-backed edits stay fail-closed until that ownership
    // is explicitly admitted by the adapter.
    let nested_picture_hit = box_layout
        .find_object(0, |o| matches!(o.story, StoryRef::Part(_)) && (o.rect.w - 40.0).abs() < 0.5)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();
    let mut nested_picture_model = DocxModel::open(&boxed_original).unwrap();
    nested_picture_model.apply(&[nested_picture_hit]);
    let v = obj_view(&mut nested_picture_model);
    assert_eq!(v["kind"], "picture");
    assert_eq!(v["operations"], json!(["resize", "delete", "crop", "altText"]));
    let stale_position = v["position"].as_str().unwrap().to_owned();
    let stale_epoch = v["epoch"].as_u64().unwrap();
    let resized = nested_picture_model.apply(&[DocxOp::ObjectEdit {
        position: stale_position.clone(),
        epoch: stale_epoch,
        edit: ObjectEdit::Bounds { x: None, y: None, width: Some(54.0), height: Some(27.0) },
    }]);
    assert_eq!((resized.changed, resized.rejected), (1, vec![]));
    let v = obj_view(&mut nested_picture_model);
    let before_stale_edit = nested_picture_model.export().unwrap();
    assert_eq!(nested_picture_model.apply(&[DocxOp::ObjectEdit {
        position: stale_position,
        epoch: stale_epoch,
        edit: ObjectEdit::AltText { text: "stale edit".into() },
    }]).rejected, vec![0]);
    assert_eq!(nested_picture_model.export().unwrap(), before_stale_edit);
    let cropped = nested_picture_model.apply(&[DocxOp::ObjectEdit {
        position: v["position"].as_str().unwrap().to_owned(),
        epoch: v["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::Crop { left: 0.1, top: 0.05, right: 0.0, bottom: 0.0 },
    }]);
    assert_eq!((cropped.changed, cropped.rejected), (1, vec![]));
    let v = obj_view(&mut nested_picture_model);
    let described = nested_picture_model.apply(&[DocxOp::ObjectEdit {
        position: v["position"].as_str().unwrap().to_owned(),
        epoch: v["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::AltText { text: "텍스트 상자 안 그림".into() },
    }]);
    assert_eq!((described.changed, described.rejected), (1, vec![]));

    let nested_picture_saved = nested_picture_model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &boxed_original,
        &nested_picture_saved,
        None,
        nested_picture_model.same_as(&nested_picture_saved),
    ).is_safe());
    let before_pkg = crate::services::save::package::open(
        &boxed_original,
        crate::services::save::package::Side::Original,
    ).unwrap();
    let after_pkg = crate::services::save::package::open(
        &nested_picture_saved,
        crate::services::save::package::Side::Output,
    ).unwrap();
    assert_eq!(before_pkg.parts.keys().collect::<Vec<_>>(), after_pkg.parts.keys().collect::<Vec<_>>());
    for name in before_pkg.parts.keys().filter(|name| name.as_str() != "word/document.xml" && name.as_str() != "docProps/app.xml") {
        assert_eq!(before_pkg.get(name), after_pkg.get(name), "unrelated OPC part changed: {name}");
    }
    let reopened_picture = io::open_bytes("fixture.docx", &nested_picture_saved).unwrap();
    let (&textbox_id, textbox_part) = reopened_picture.parts.iter()
        .find(|(_, part)| part.kind == PartKind::TextBox)
        .unwrap();
    assert_eq!(textbox_part.kind, PartKind::TextBox);
    assert_eq!(reopened_picture.plain_text(StoryRef::Part(textbox_id)), "상자안");
    let nested_picture = reopened_picture.para_paths(StoryRef::Part(textbox_id)).iter()
        .filter_map(|path| reopened_picture.para(StoryRef::Part(textbox_id), path))
        .flat_map(|paragraph| paragraph.objects.iter())
        .find_map(|object| match object {
            InlineObject::Image { media, w, h, crop, alt, .. } => Some((media, *w, *h, *crop, alt.as_str())),
            _ => None,
        }).unwrap();
    assert_eq!((nested_picture.1, nested_picture.2), (54.0, 27.0));
    assert!((nested_picture.3[0] - 0.1).abs() < 1e-4 && (nested_picture.3[1] - 0.05).abs() < 1e-4);
    assert_eq!(nested_picture.4, "텍스트 상자 안 그림");
    assert!(reopened_picture.media.contains_key(nested_picture.0));

    // Undo and redo restore the nested picture metadata without changing story ownership.
    assert_eq!(nested_picture_model.apply(&[DocxOp::Undo {}]).changed, 1);
    let undone = nested_picture_model.diagnostic_document();
    let undone_picture = undone.para_paths(StoryRef::Part(textbox_id)).iter()
        .filter_map(|path| undone.para(StoryRef::Part(textbox_id), path))
        .flat_map(|paragraph| paragraph.objects.iter())
        .find_map(|object| match object {
            InlineObject::Image { alt, .. } => Some(alt.as_str()),
            _ => None,
        }).unwrap();
    assert_ne!(undone_picture, "텍스트 상자 안 그림");
    assert_eq!(nested_picture_model.apply(&[DocxOp::Redo {}]).changed, 1);
    let redone = nested_picture_model.diagnostic_document();
    let redone_picture = redone.para_paths(StoryRef::Part(textbox_id)).iter()
        .filter_map(|path| redone.para(StoryRef::Part(textbox_id), path))
        .flat_map(|paragraph| paragraph.objects.iter())
        .find_map(|object| match object {
            InlineObject::Image { alt, .. } => Some(alt.as_str()),
            _ => None,
        }).unwrap();
    assert_eq!(redone_picture, "텍스트 상자 안 그림");
    let redone_bytes = nested_picture_model.export().unwrap();
    let mut redone_reader = Session::new(io::open_bytes("fixture.docx", &redone_bytes).unwrap());
    let redone_hit = redone_reader.layout()
        .find_object(0, |object| object.story == StoryRef::Part(textbox_id) && (object.rect.w - 54.0).abs() < 0.5)
        .map(|hit| click(hit.page, hit.rect.x + hit.rect.w / 2.0, hit.rect.y + hit.rect.h / 2.0))
        .unwrap();
    nested_picture_model.apply(&[redone_hit]);
    let v = obj_view(&mut nested_picture_model);
    let deleted = nested_picture_model.apply(&[DocxOp::ObjectEdit {
        position: v["position"].as_str().unwrap().to_owned(),
        epoch: v["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::Delete {},
    }]);
    assert_eq!((deleted.changed, deleted.rejected), (1, vec![]));
    let nested_picture_deleted = nested_picture_model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &boxed_original,
        &nested_picture_deleted,
        None,
        nested_picture_model.same_as(&nested_picture_deleted),
    ).is_safe());
    let reopened_deleted_picture = io::open_bytes("fixture.docx", &nested_picture_deleted).unwrap();
    let deleted_textbox_id = *reopened_deleted_picture.parts.iter()
        .find(|(_, part)| part.kind == PartKind::TextBox)
        .unwrap().0;
    let deleted_textbox_objects = reopened_deleted_picture.para_paths(StoryRef::Part(deleted_textbox_id)).iter()
        .filter_map(|path| reopened_deleted_picture.para(StoryRef::Part(deleted_textbox_id), path))
        .flat_map(|paragraph| paragraph.objects.iter())
        .collect::<Vec<_>>();
    assert_eq!(deleted_textbox_objects.len(), 2);
    assert!(deleted_textbox_objects.iter().all(|object| !matches!(object, InlineObject::Image { .. })));
    assert_eq!(nested_picture_model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(nested_picture_model.diagnostic_document().media.len(), 1);
    assert_eq!(nested_picture_model.apply(&[DocxOp::Redo {}]).changed, 1);

    // A body textbox with source XML that WordCraft cannot round-trip stays read-only for its
    // media-backed child: the global document.xml T009 exemption cannot stand in for this proof.
    let source_package = crate::services::save::package::open(
        &boxed_original,
        crate::services::save::package::Side::Original,
    ).unwrap();
    let body_xml = std::str::from_utf8(source_package.get("word/document.xml").unwrap()).unwrap();
    let unknown_body = body_xml.replace("</w:txbxContent>", "<w:alien/></w:txbxContent>");
    assert_ne!(unknown_body, body_xml);
    let unsupported_entries = source_package.order.iter().map(|name| {
        if name == "word/document.xml" {
            entry(name, unknown_body.as_bytes())
        } else {
            entry(name, source_package.get(name).unwrap())
        }
    }).collect::<Vec<_>>();
    let unsupported_body = zip(&unsupported_entries, false);
    let mut unsupported_reader = Session::new(io::open_bytes("fixture.docx", &unsupported_body).unwrap());
    let unsupported_hit = unsupported_reader.layout()
        .find_object(0, |object| matches!(object.story, StoryRef::Part(id)
            if unsupported_reader.doc.parts.get(&id).is_some_and(|part| part.kind == PartKind::TextBox))
            && (object.rect.w - 40.0).abs() < 0.5)
        .map(|hit| click(hit.page, hit.rect.x + hit.rect.w / 2.0, hit.rect.y + hit.rect.h / 2.0))
        .unwrap();
    let mut unsupported_model = DocxModel::open(&unsupported_body).unwrap();
    unsupported_model.apply(&[unsupported_hit]);
    let unsupported_view = obj_view(&mut unsupported_model);
    assert_eq!(unsupported_view["kind"], "picture");
    assert_eq!(unsupported_view["operations"], json!([]));
    let unsupported_before = unsupported_model.export().unwrap();
    assert_eq!(unsupported_model.apply(&[DocxOp::ObjectEdit {
        position: unsupported_view["position"].as_str().unwrap().to_owned(),
        epoch: unsupported_view["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::Bounds { x: None, y: None, width: Some(55.0), height: Some(28.0) },
    }]).rejected, vec![0]);
    assert_eq!(unsupported_model.export().unwrap(), unsupported_before);

    // 3. Negative boundary: a drawing in a separate OPC Header part still prevents delete/renumbering
    // on Body/TextBox drawings, and Header objects cannot be selected or mutated.
    let mut with_hdr = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    with_hdr.run("insert.editHeader", &json!({})).unwrap();
    with_hdr
        .run("insert.picture", &json!({"data": tiny_png_b64(2, 2, [1, 2, 3])}))
        .unwrap();
    with_hdr.run("picture.size", &json!({"width": 40, "height": 20})).unwrap();
    with_hdr.run("insert.closeHeader", &json!({})).unwrap();
    with_hdr.run("caret.docEnd", &json!({})).unwrap();
    with_hdr.run("text.newParagraph", &json!({})).unwrap();
    with_hdr.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
    let hdr_bytes = io::save_bytes("fixture.docx", &with_hdr.doc).unwrap();
    let mut hdr_reader = Session::new(io::open_bytes("fixture.docx", &hdr_bytes).unwrap());
    let hdr_lay = hdr_reader.layout();
    let hdr_pic = hdr_lay
        .find_object(0, |o| matches!(o.story, StoryRef::Part(id) if hdr_reader.doc.parts.get(&id).is_some_and(|p| p.kind == PartKind::Header)))
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();
    let body_shape = hdr_lay
        .find_object(0, |o| o.story == StoryRef::Body)
        .map(|h| click(h.page, h.rect.x + h.rect.w / 2.0, h.rect.y + h.rect.h / 2.0))
        .unwrap();
    let mut hdr_model = DocxModel::open(&hdr_bytes).unwrap();
    hdr_model.apply(&[hdr_pic]);
    let header_object = serde_json::to_value(hdr_model.view()).unwrap()["object"].clone();
    assert_eq!(header_object["kind"], "picture");
    assert!(header_object["position"].as_str().unwrap().starts_with("part"));
    assert_eq!(header_object["operations"], json!(["resize", "altText"]));
    // Body shape still admits in-place resize/fill/outline/altText, but blocks delete/move when Header has a drawing.
    hdr_model.apply(&[body_shape]);
    let v = obj_view(&mut hdr_model);
    assert_eq!(v["operations"], json!(["resize", "altText", "fill", "outline", "convertShape"]));
    let no_op_export = hdr_model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &hdr_bytes,
        &no_op_export,
        None,
        hdr_model.same_as(&no_op_export),
    ).is_safe());
    let before = crate::services::save::package::open(
        &hdr_bytes,
        crate::services::save::package::Side::Original,
    ).unwrap();
    let after = crate::services::save::package::open(
        &no_op_export,
        crate::services::save::package::Side::Output,
    ).unwrap();
    assert_eq!(before.get("word/header1.xml"), after.get("word/header1.xml"));

    // Keep a deterministic, WordCraft-authored fixture available to the focused Native test.
    // Exporting it again must preserve document.xml before media-backed child edits are admitted
    // by the adapter's T009 source-envelope gate.
    let native_fixture_reader = Session::new(io::open_bytes("fixture.docx", &boxed_original).unwrap());
    let native_fixture_roundtrip = io::save_bytes("fixture.docx", &native_fixture_reader.doc).unwrap();
    assert!(crate::services::save::package::docx_body_source_roundtrips(
        &boxed_original,
        &native_fixture_roundtrip,
    ));
    if let Some(path) = std::env::var_os("GEUL_P5_TB_CONTROL_DOCX_FIXTURE_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .expect("create requested P5 textbox DOCX fixture");
        file.write_all(&boxed_original)
            .expect("write requested P5 textbox DOCX fixture");
        file.sync_all().expect("sync requested P5 textbox DOCX fixture");
    }
}

#[test]
fn stage3_docx_chart_and_smart_art_model_edits_save_and_reopen() {
    use super::engine::{ChartSeriesEdit, ObjectEdit, SmartArtItemEdit};
    use crate::services::save::service;
    use wordcraft_engine::doc::InlineObject;
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run("insert.chart", &json!({"type": "line", "title": "Revenue"}))
        .unwrap();
    source
        .run("select.collapse", &json!({"end": true}))
        .unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run("insert.smartArt", &json!({"layout": "process"}))
        .unwrap();
    let original = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original).unwrap());
    let layout = reader.layout();
    let find = |chart: bool| {
        let hit = layout
            .find_object(0, |hit| {
                let pos = hit.pos();
                reader
                    .doc
                    .para_at(&pos)
                    .and_then(|p| p.object_at(pos.off))
                    .is_some_and(|o| {
                        matches!(o,
                InlineObject::Graphic { graphic, .. } if graphic.chart.is_some() == chart)
                    })
            })
            .unwrap();
        DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        }
    };
    let (chart, diagram) = (find(true), find(false));
    let state = |model: &mut DocxModel| {
        let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (
            v["position"].as_str().unwrap().to_owned(),
            v["epoch"].as_u64().unwrap(),
            v,
        )
    };
    let apply = |model: &mut DocxModel, edit: ObjectEdit| {
        let (position, epoch, _) = state(model);
        model.apply(&[DocxOp::ObjectEdit {
            position,
            epoch,
            edit,
        }])
    };
    let safe = |model: &DocxModel| {
        let bytes = model.export().unwrap();
        let gate = service::check_saved(
            crate::document::Format::Docx,
            &original,
            &bytes,
            None,
            model.same_as(&bytes),
        );
        assert!(gate.is_safe(), "{gate:?}");
        bytes
    };

    model.apply(&[chart.clone()]);
    let (position, epoch, view) = state(&mut model);
    assert_eq!(view["operations"], json!(["chart"]));
    // Bounds and kind checks before the engine; SmartArt edits do not apply to a chart.
    for bad in [
        ObjectEdit::ChartType {
            plot: "radar".into(),
        },
        ObjectEdit::ChartTitle {
            text: Some(String::new()),
        },
        ObjectEdit::ChartData {
            categories: vec!["A".into()],
            series: vec![ChartSeriesEdit {
                name: "S".into(),
                values: vec![Some(1.0), Some(2.0)],
            }],
        },
        ObjectEdit::ChartData {
            categories: vec!["A".into()],
            series: vec![ChartSeriesEdit {
                name: "S".into(),
                values: vec![Some(f64::NAN)],
            }],
        },
    ] {
        assert!(!validate(&[DocxOp::ObjectEdit {
            position: position.clone(),
            epoch,
            edit: bad
        }]));
    }
    let baseline = model.export().unwrap();
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::SmartArtLayout {
                layout: "cycle".into()
            }
        )
        .rejected,
        vec![0]
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::Bounds {
                x: None,
                y: None,
                width: Some(200.0),
                height: Some(100.0)
            }
        )
        .rejected,
        vec![0]
    );
    assert_eq!(model.export().unwrap(), baseline);

    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::ChartTitle {
                text: Some("분기 매출".into())
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::ChartType {
                plot: "column".into()
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::ChartData {
                categories: vec!["1분기".into(), "2분기".into(), "3분기".into()],
                series: vec![
                    ChartSeriesEdit {
                        name: "매출".into(),
                        values: vec![Some(3.5), None, Some(7.25)]
                    },
                    ChartSeriesEdit {
                        name: "비용".into(),
                        values: vec![Some(1.0), Some(2.0), Some(3.0)]
                    }
                ]
            }
        )
        .changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert_eq!(view["graphic"]["title"], "분기 매출");
    assert_eq!(view["graphic"]["plot"], "column");
    assert_eq!(
        view["graphic"]["labels"],
        json!(["1분기", "2분기", "3분기"])
    );
    assert_eq!(
        view["graphic"]["series"][0]["values"],
        json!(["3.5", null, "7.25"])
    );
    let charted = safe(&model);

    model.apply(&[DocxOp::DeselectObject {}, diagram]);
    let (diagram_position, diagram_epoch, view) = state(&mut model);
    assert_eq!(view["operations"], json!(["smartArt"]));
    assert_eq!(
        model.apply(&[DocxOp::ObjectEdit {
            position: diagram_position,
            epoch: diagram_epoch.saturating_sub(1),
            edit: ObjectEdit::SmartArtLayout { layout: "cycle".into() },
        }]).rejected,
        vec![0]
    );
    assert_eq!(
        apply(&mut model, ObjectEdit::SmartArtLayout { layout: "unsupported".into() }).rejected,
        vec![0]
    );
    assert_eq!(
        apply(&mut model, ObjectEdit::ChartTitle { text: None }).rejected,
        vec![0]
    );
    assert_eq!(model.export().unwrap(), charted);
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::SmartArtItems {
                items: vec![
                    SmartArtItemEdit {
                        text: "계획".into(),
                        level: 0
                    },
                    SmartArtItemEdit {
                        text: "세부".into(),
                        level: 1
                    },
                    SmartArtItemEdit {
                        text: "실행".into(),
                        level: 0
                    }
                ]
            }
        )
        .changed,
        1
    );
    assert_eq!(
        apply(
            &mut model,
            ObjectEdit::SmartArtLayout {
                layout: "cycle".into()
            }
        )
        .changed,
        1
    );
    let (_, _, view) = state(&mut model);
    assert_eq!(view["graphic"]["layout"], "cycle");
    assert_eq!(
        view["graphic"]["items"][1],
        json!({"text": "세부", "level": 1})
    );
    let edited = safe(&model);

    // Independent reopen: the models carry the edits; the package changed only in owned parts.
    let reopened = io::open_bytes("fixture.docx", &edited).unwrap();
    let graphics: Vec<_> = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .filter_map(|o| match o {
            InlineObject::Graphic { graphic, .. } => Some(graphic.clone()),
            _ => None,
        })
        .collect();
    let spec = graphics.iter().find_map(|g| g.chart.clone()).unwrap();
    assert_eq!(spec.title.as_deref(), Some("분기 매출"));
    assert_eq!(spec.categories, ["1분기", "2분기", "3분기"]);
    assert_eq!(spec.series[0].values, [Some(3.5), None, Some(7.25)]);
    let art = graphics.iter().find_map(|g| g.smart_art.clone()).unwrap();
    assert_eq!(
        art.items
            .iter()
            .map(|i| (i.text.as_str(), i.level))
            .collect::<Vec<_>>(),
        [("계획", 0), ("세부", 1), ("실행", 0)]
    );
    let (before, after) = (
        crate::services::save::package::open(
            &original,
            crate::services::save::package::Side::Original,
        )
        .unwrap(),
        crate::services::save::package::open(&edited, crate::services::save::package::Side::Output)
            .unwrap(),
    );
    let changed: Vec<&String> = after
        .parts
        .keys()
        .filter(|k| before.get(k) != after.get(k))
        .collect();
    assert!(
        changed.iter().all(|k| [
            "word/document.xml",
            "docProps/app.xml",
            "word/charts/chart1.xml",
            "word/diagrams/data1.xml",
            "word/diagrams/drawing1.xml",
            "word/diagrams/layout1.xml"
        ]
        .contains(&k.as_str())),
        "{changed:?}"
    );
    assert!(before.parts.keys().eq(after.parts.keys()));

    // One history step per edit.
    assert_eq!(model.apply(&[DocxOp::Undo {}, DocxOp::Undo {}]).changed, 2);
    assert_eq!(model.export().unwrap(), charted);
    assert_eq!(model.apply(&[DocxOp::Redo {}, DocxOp::Redo {}]).changed, 2);
    assert_eq!(model.export().unwrap(), edited);
    assert_eq!(model.apply(&[DocxOp::Undo {}, DocxOp::Undo {}]).changed, 2);
    assert_eq!(
        model
            .apply(&[DocxOp::Undo {}, DocxOp::Undo {}, DocxOp::Undo {}])
            .changed,
        3
    );
    assert_eq!(model.export().unwrap(), baseline);
    assert!(model.same_as(&baseline));
}

#[test]
fn stage3_rich_object_clipboard_copies_and_pastes_pictures_shapes_and_text_boxes() {
    use super::engine::{BasicShape, ObjectEdit, ObjectPayload};
    use crate::services::save::service;
    use wordcraft_engine::doc::{InlineObject, PartKind, StoryRef};
    use wordcraft_engine::{io, Session};

    // Source: a cropped, described picture, a formatted ellipse and a text box with Korean text.
    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run(
            "insert.picture",
            &json!({"data": tiny_png_b64(3, 2, [200, 100, 50])}),
        )
        .unwrap();
    source
        .run("picture.size", &json!({"width": 90, "height": 60}))
        .unwrap();
    source.run("picture.crop", &json!({"left": 0.1})).unwrap();
    source
        .run("object.altText", &json!({"text": "원본 그림"}))
        .unwrap();
    let source_bytes = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let mut model = DocxModel::open(&source_bytes).unwrap();
    model.apply(&[
        mv(MoveTarget::DocEnd, false),
        DocxOp::Shape {
            kind: BasicShape::Ellipse,
        },
    ]);
    let mut reader =
        Session::new(io::open_bytes("fixture.docx", &model.export().unwrap()).unwrap());
    let layout = reader.layout();
    let click = |hit: &wordcraft_engine::layout::hit::ObjectHit| DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + hit.rect.w / 2.0,
        y: hit.rect.y + hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let picture = layout.find_object(0, |o| o.rect.w == 90.0).unwrap();
    let ellipse = layout.find_object(0, |o| o.rect.w == 108.0).unwrap();
    let key = |model: &mut DocxModel| {
        let v = serde_json::to_value(model.view()).unwrap()["object"].clone();
        (
            v["position"].as_str().unwrap().to_owned(),
            v["epoch"].as_u64().unwrap(),
        )
    };
    model.apply(&[click(&picture)]);
    let (position, epoch) = key(&mut model);
    assert!(
        model.clipboard_object(&position, epoch + 1).is_none(),
        "stale selection"
    );
    let picture_payload = model.clipboard_object(&position, epoch).unwrap();
    model.apply(&[DocxOp::DeselectObject {}, click(&ellipse)]);
    let (position, epoch) = key(&mut model);
    model.apply(&[DocxOp::ObjectEdit {
        position: position.clone(),
        epoch,
        edit: ObjectEdit::Fill {
            color: Some("AA3300".into()),
        },
    }]);
    let (position, epoch) = key(&mut model);
    let shape_payload = model.clipboard_object(&position, epoch).unwrap();
    model.apply(&[
        DocxOp::DeselectObject {},
        DocxOp::TextBox {},
        insert("글상자 내용"),
    ]);
    model.apply(&[DocxOp::LeaveTextBox {}]);
    let source_after = model.export().unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &source_after).unwrap());
    let layout = reader.layout();
    let boxes: Vec<_> = reader
        .doc
        .para_paths(StoryRef::Body)
        .into_iter()
        .flat_map(|path| {
            let para = reader.doc.para(StoryRef::Body, &path).unwrap().clone();
            para.object_offsets()
                .into_iter()
                .filter(move |&off| {
                    matches!(
                        para.object_at(off),
                        Some(InlineObject::Shape { story: Some(_), .. })
                    )
                })
                .map(move |off| wordcraft_engine::doc::Pos {
                    story: StoryRef::Body,
                    path: path.clone(),
                    off,
                })
        })
        .collect();
    let text_box = layout.object(&boxes[0], 0).unwrap();
    // The outer frame of a text box (its interior is the text box's own text).
    model.apply(&[DocxOp::Pointer {
        page: text_box.page as u32,
        x: text_box.rect.x + 0.5,
        y: text_box.rect.y + 0.5,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let (position, epoch) = key(&mut model);
    let box_payload = model.clipboard_object(&position, epoch).unwrap();
    assert!(picture_payload.contains("\"sha256\""));

    // Destination: a different document (cross-document paste).
    let target = fixture();
    let mut dest = DocxModel::open(&target).unwrap();
    let parse = |s: &str| serde_json::from_str::<ObjectPayload>(s).unwrap();
    let baseline = dest.export().unwrap();
    // Not at an eligible caret: refused without change.
    assert_eq!(
        dest.apply(&[DocxOp::PasteObject {
            payload: Box::new(parse(&picture_payload))
        }])
        .rejected,
        vec![0]
    );
    assert_eq!(dest.export().unwrap(), baseline);
    dest.apply(&[mv(MoveTarget::DocEnd, false)]);
    for payload in [&picture_payload, &shape_payload, &box_payload] {
        let r = dest.apply(&[DocxOp::PasteObject {
            payload: Box::new(parse(payload)),
        }]);
        assert_eq!(r.changed, 1, "{:?}", r.rejected);
    }
    let pasted = dest.export().unwrap();
    let gate = service::check_saved(
        crate::document::Format::Docx,
        &target,
        &pasted,
        None,
        dest.same_as(&pasted),
    );
    assert!(gate.is_safe(), "{gate:?}");
    let reopened = io::open_bytes("fixture.docx", &pasted).unwrap();
    let objects: Vec<_> = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| p.objects.clone())
        .collect();
    let image = objects
        .iter()
        .find_map(|o| match o {
            InlineObject::Image {
                media,
                w,
                crop,
                alt,
                ..
            } => Some((media.clone(), *w, *crop, alt.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!((image.1, image.3.as_str()), (90.0, "원본 그림"));
    assert!((image.2[0] - 0.1).abs() < 1e-6);
    assert_eq!(
        reopened.media.get(&image.0).map(|b| b.as_slice()),
        source.doc.media.values().next().map(|b| b.as_slice())
    );
    assert!(objects.iter().any(|o| matches!(o, InlineObject::Shape { fill: Some(c), story: None, .. } if c.hex() == "AA3300")));
    let (&id, _) = reopened
        .parts
        .iter()
        .find(|(_, p)| p.kind == PartKind::TextBox)
        .unwrap();
    assert_eq!(reopened.plain_text(StoryRef::Part(id)), "글상자 내용");

    // One history step per paste; undo removes the pasted media again (no orphan part on save).
    assert_eq!(
        dest.apply(&[DocxOp::Undo {}, DocxOp::Undo {}, DocxOp::Undo {}])
            .changed,
        3
    );
    assert!(dest.diagnostic_document().media.is_empty());
    let undone = dest.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &target,
        &undone,
        None,
        dest.same_as(&undone)
    )
    .is_safe());
    assert_eq!(dest.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(dest.diagnostic_document().media.len(), 1);

    // Same-document paste: the picture media is shared, not duplicated.
    let mut same = DocxModel::open(&source_bytes).unwrap();
    same.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]);
    assert_eq!(
        same.apply(&[DocxOp::PasteObject {
            payload: Box::new(parse(&picture_payload))
        }])
        .changed,
        1
    );
    assert_eq!(same.diagnostic_document().media.len(), 1);
    let bytes = same.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &source_bytes,
        &bytes,
        None,
        same.same_as(&bytes)
    )
    .is_safe());

    // Malformed payloads never reach the document.
    let mut fresh = DocxModel::open(&target).unwrap();
    fresh.apply(&[mv(MoveTarget::DocEnd, false)]);
    let before = fresh.export().unwrap();
    let mut bad = Vec::new();
    let mut p = parse(&picture_payload);
    p.media[0].sha256 = "00".repeat(32);
    bad.push(p);
    let mut p = parse(&picture_payload);
    p.media.clear();
    bad.push(p);
    let mut p = parse(&picture_payload);
    let extra = p.media[0].clone();
    p.media.push(super::engine::PayloadMedia {
        name: "other.png".into(),
        ..extra
    });
    bad.push(p);
    let mut p = parse(&picture_payload);
    p.media[0].data = wordcraft_engine::cmd::insert::base64_encode(b"GIF89a not allowed");
    p.media[0].sha256 = {
        use sha2::{Digest, Sha256};
        Sha256::digest(b"GIF89a not allowed")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    bad.push(p);
    let mut p = parse(&shape_payload);
    let block = p.fragment.blocks[0].clone();
    p.fragment.blocks.push(block);
    bad.push(p);
    let mut p = parse(&shape_payload);
    if let wordcraft_engine::doc::Block::Para(para) = &mut p.fragment.blocks[0] {
        if let Some(InlineObject::Shape { w, .. }) = para.object_at_mut(0) {
            *w = f32::NAN;
        }
    }
    bad.push(p);
    let mut p = parse(&box_payload);
    p.fragment.parts.clear();
    bad.push(p);
    for (i, payload) in bad.into_iter().enumerate() {
        let r = fresh.apply(&[DocxOp::PasteObject {
            payload: Box::new(payload),
        }]);
        assert_eq!(r.rejected, vec![0], "case {i}");
        assert_eq!(fresh.export().unwrap(), before, "case {i}");
    }
    assert!(!fresh.view().history.undo);
    // Oversized or structurally invalid payloads fail request validation too.
    assert!(!validate(&[DocxOp::PasteObject {
        payload: Box::new({
            let mut p = parse(&shape_payload);
            p.fragment.blocks.clear();
            p
        })
    }]));
}

#[test]
fn stage3_grouped_rich_clipboard_roundtrip_and_negative_acceptance() {
    use super::engine::{ObjectPayload, PayloadMedia, MAX_PAYLOAD_MEDIA, MAX_PAYLOAD_MEDIA_BYTES};
    use crate::services::save::service;
    use wordcraft_engine::doc::para::{Float, GroupChild, ShapeKind};
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{
        Block, CharProps, InlineObject, Paragraph, PartKind, StoryRef,
    };
    use wordcraft_engine::{io, Session};

    let group_media_b64 = tiny_png_b64(4, 3, [30, 140, 210]);
    let unrelated_media_b64 = tiny_png_b64(2, 2, [220, 40, 40]);

    // Build a source DOCX containing a flat Group with:
    // - a formatted child shape (fill, outline, rotation)
    // - a child picture (with media bytes)
    // - a child text box (with its own TextBox story containing Korean text)
    let mut src_sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    src_sess.run("caret.docEnd", &json!({})).unwrap();
    src_sess.run("text.newParagraph", &json!({})).unwrap();
    let child_img_bytes = wordcraft_engine::cmd::insert::base64_decode(&group_media_b64).unwrap();
    let child_media_key = src_sess.doc.add_media(child_img_bytes.clone(), "png");
    let tb_story = src_sess.doc.add_part(
        PartKind::TextBox,
        vec![Block::Para(Paragraph::with_text(
            "그룹 글상자",
            CharProps::default(),
        ))
        .into()],
    );
    let mut shape_float = Float::default();
    let mut spin = shape_float.spin();
    spin.deg = 15.0;
    shape_float.set_spin(spin);
    let group_obj = InlineObject::Group {
        w: 240.0,
        h: 160.0,
        float: Float::default(),
        ch_w: 240.0,
        ch_h: 160.0,
        canvas: None,
        children: vec![
            GroupChild {
                x: 10.0,
                y: 12.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::Ellipse,
                    w: 80.0,
                    h: 50.0,
                    fill: Some(Rgb(0x11, 0x22, 0x33)),
                    stroke: Some(Rgb(0xAA, 0x55, 0x00)),
                    stroke_width: 2.0,
                    float: shape_float,
                    story: None,
                    freeform: None,
                    effects: Default::default(),
                    extra: Default::default(),
                },
            },
            GroupChild {
                x: 100.0,
                y: 20.0,
                obj: InlineObject::Image {
                    media: child_media_key.clone(),
                    source_extents: None,
                    docpr_id: None,
                    picture_id: None,
                    w: 60.0,
                    h: 40.0,
                    alt: "그룹 그림".into(),
                    float: Float::default(),
                    crop: [0.0; 4],
                    ole: None,
                },
            },
            GroupChild {
                x: 20.0,
                y: 80.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::TextBox,
                    w: 140.0,
                    h: 50.0,
                    fill: Some(Rgb(0xFF, 0xEE, 0xDD)),
                    stroke: Some(Rgb(0x22, 0x22, 0x22)),
                    stroke_width: 1.0,
                    float: Float::default(),
                    story: Some(tb_story),
                    freeform: None,
                    effects: Default::default(),
                    extra: Default::default(),
                },
            },
        ],
    };
    let end_pos = src_sess.sel.focus.clone();
    src_sess
        .doc
        .insert_object(&end_pos, group_obj, &CharProps::default())
        .unwrap();
    let source_bytes = io::save_bytes("fixture.docx", &src_sess.doc).unwrap();
    let mut source_model = DocxModel::open(&source_bytes).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &source_bytes).unwrap());
    let layout = reader.layout();
    let group_hit = layout
        .find_object(0, |o| (o.rect.w - 240.0).abs() < 0.5)
        .unwrap();
    source_model.apply(&[DocxOp::Pointer {
        page: group_hit.page as u32,
        x: group_hit.rect.x + 1.0,
        y: group_hit.rect.y + 1.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let view = serde_json::to_value(source_model.view()).unwrap();
    assert_eq!(view["object"]["kind"], "group");
    let pos = view["object"]["position"].as_str().unwrap().to_owned();
    let epoch = view["object"]["epoch"].as_u64().unwrap();
    // Negative: stale selection copy must fail.
    assert!(source_model.clipboard_object(&pos, epoch + 1).is_none());
    let group_json = source_model.clipboard_object(&pos, epoch).unwrap();
    let group_payload: ObjectPayload = serde_json::from_str(&group_json).unwrap();
    assert_eq!(group_payload.media.len(), 1);
    assert_eq!(group_payload.fragment.parts.len(), 1);

    // 1) Paste into the SAME DOCX: media is shared (deduplicated), text box gets a distinct story part.
    let mut same_doc = DocxModel::open(&source_bytes).unwrap();
    same_doc.apply(&[
        mv(MoveTarget::DocEnd, false),
        DocxOp::NewParagraph,
        DocxOp::PasteObject {
            payload: Box::new(group_payload.clone()),
        },
    ]);
    assert_eq!(same_doc.diagnostic_document().media.len(), 1);
    let same_tb_ids: Vec<_> = same_doc
        .diagnostic_document()
        .parts
        .iter()
        .filter(|(_, p)| p.kind == PartKind::TextBox)
        .map(|(id, _)| *id)
        .collect();
    assert_eq!(same_tb_ids.len(), 2);
    let same_bytes = same_doc.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &source_bytes,
        &same_bytes,
        None,
        same_doc.same_as(&same_bytes)
    )
    .is_safe());

    // 2) Paste into a DIFFERENT DOCX that already owns an unrelated picture & story.
    let mut dst_sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    dst_sess.run("caret.docEnd", &json!({})).unwrap();
    dst_sess.run("text.newParagraph", &json!({})).unwrap();
    dst_sess
        .run("insert.picture", &json!({"data": unrelated_media_b64}))
        .unwrap();
    let dst_baseline_bytes = io::save_bytes("fixture.docx", &dst_sess.doc).unwrap();
    let dst_unrelated_bytes = wordcraft_engine::cmd::insert::base64_decode(&unrelated_media_b64).unwrap();
    let mut dest = DocxModel::open(&dst_baseline_bytes).unwrap();
    let orig_media_keys: Vec<String> = dest.diagnostic_document().media.keys().cloned().collect();
    assert_eq!(orig_media_keys.len(), 1);

    dest.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]);
    let pre_paste_bytes = dest.export().unwrap();
    let r = dest.apply(&[DocxOp::PasteObject {
        payload: Box::new(group_payload.clone()),
    }]);
    assert_eq!(r.changed, 1, "{:?}", r.rejected);
    assert_eq!(dest.diagnostic_document().media.len(), 2);
    let pasted_media_key = dest
        .diagnostic_document()
        .media
        .keys()
        .find(|k| !orig_media_keys.contains(k))
        .unwrap()
        .clone();
    assert_ne!(pasted_media_key, orig_media_keys[0]);

    let pasted_bytes = dest.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &dst_baseline_bytes,
        &pasted_bytes,
        None,
        dest.same_as(&pasted_bytes)
    )
    .is_safe());

    // Independent reopen: verify group geometry, child positions, child shape formatting,
    // child picture media bytes, destination-owned key, nested text-box content, and unrelated media.
    let reopened = io::open_bytes("fixture.docx", &pasted_bytes).unwrap();
    assert_eq!(
        reopened.media.get(&orig_media_keys[0]).map(|b| b.as_slice()),
        Some(dst_unrelated_bytes.as_slice())
    );
    assert_eq!(
        reopened.media.get(&pasted_media_key).map(|b| b.as_slice()),
        Some(child_img_bytes.as_slice())
    );
    let pasted_group = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .find_map(|o| match o {
            InlineObject::Group {
                w,
                h,
                ch_w,
                ch_h,
                children,
                ..
            } => Some((*w, *h, *ch_w, *ch_h, children.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!((pasted_group.0, pasted_group.1, pasted_group.2, pasted_group.3), (240.0, 160.0, 240.0, 160.0));
    assert_eq!(pasted_group.4.len(), 3);
    assert!((pasted_group.4[0].x - 10.0).abs() < 0.05 && (pasted_group.4[0].y - 12.0).abs() < 0.05);
    assert!(matches!(
        &pasted_group.4[0].obj,
        InlineObject::Shape {
            kind: ShapeKind::Ellipse,
            fill: Some(c),
            stroke: Some(s),
            stroke_width,
            float,
            ..
        } if c.hex() == "112233" && s.hex() == "AA5500" && (*stroke_width - 2.0).abs() < 0.05 && (float.spin().deg - 15.0).abs() < 0.05
    ));
    assert!(matches!(
        &pasted_group.4[1].obj,
        InlineObject::Image { media, alt, .. } if media == &pasted_media_key && alt == "그룹 그림"
    ));
    let pasted_story = match &pasted_group.4[2].obj {
        InlineObject::Shape { story: Some(id), .. } => *id,
        other => panic!("expected grouped text box, got {other:?}"),
    };
    assert_eq!(reopened.plain_text(StoryRef::Part(pasted_story)), "그룹 글상자");

    // Undo restores object & resource state (removes pasted group/media/story while keeping unrelated media); Redo restores it.
    assert_eq!(dest.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(dest.diagnostic_document().media.len(), 1);
    assert!(dest.diagnostic_document().parts.is_empty());
    assert_eq!(dest.export().unwrap(), pre_paste_bytes);
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &dst_baseline_bytes,
        &dest.export().unwrap(),
        None,
        dest.same_as(&dest.export().unwrap())
    )
    .is_safe());

    assert_eq!(dest.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(dest.diagnostic_document().media.len(), 2);
    assert_eq!(dest.diagnostic_document().parts.len(), 1);
    assert_eq!(dest.export().unwrap(), pasted_bytes);

    // Negative acceptance: every failed paste leaves document, media, parts, revision, and Undo history untouched.
    let mut bad_cases: Vec<(&str, ObjectPayload)> = Vec::new();
    // 1. Missing child media
    let mut p = group_payload.clone();
    p.media.clear();
    bad_cases.push(("missing child media", p));
    // 2. Corrupted media SHA-256
    let mut p = group_payload.clone();
    p.media[0].sha256 = "ff".repeat(32);
    bad_cases.push(("corrupted media sha256", p));
    // 3. Duplicate / conflicting media entries
    let mut p = group_payload.clone();
    let dup = p.media[0].clone();
    p.media.push(dup);
    bad_cases.push(("duplicate media entry", p));
    let mut p = group_payload.clone();
    let extra = p.media[0].clone();
    p.media.push(PayloadMedia {
        name: "extra.png".into(),
        ..extra
    });
    bad_cases.push(("unreferenced extra media entry", p));
    // 4. Missing text-box story
    let mut p = group_payload.clone();
    p.fragment.parts.clear();
    bad_cases.push(("missing text-box story", p));
    // 5. Invalid nested reference (object placeholder inside text-box story)
    let mut p = group_payload.clone();
    let sid = *p.fragment.parts.keys().next().unwrap();
    let bad_text = format!("bad {}", wordcraft_engine::doc::para::OBJ);
    p.fragment.parts.get_mut(&sid).unwrap().blocks = vec![Block::Para(Paragraph::with_text(
        &bad_text,
        CharProps::default(),
    ))
    .into()];
    bad_cases.push(("invalid nested object reference in story", p));
    // 6. Unsupported grouped child type (Graphic inside Group)
    let mut p = group_payload.clone();
    if let Block::Para(para) = &mut p.fragment.blocks[0] {
        if let Some(InlineObject::Group { children, .. }) = para.object_at_mut(0) {
            children.push(GroupChild {
                x: 0.0,
                y: 0.0,
                obj: InlineObject::Graphic {
                    w: 40.0,
                    h: 40.0,
                    alt: String::new(),
                    float: Float::default(),
                    graphic: std::sync::Arc::new(Default::default()),
                },
            });
        }
    }
    bad_cases.push(("unsupported grouped child type", p));
    // 7. Nested Group inside Group (excessive / unrepresentable group nesting)
    let mut p = group_payload.clone();
    if let Block::Para(para) = &mut p.fragment.blocks[0] {
        if let Some(InlineObject::Group { children, .. }) = para.object_at_mut(0) {
            children.push(GroupChild {
                x: 0.0,
                y: 0.0,
                obj: InlineObject::Group {
                    w: 20.0,
                    h: 20.0,
                    float: Float::default(),
                    ch_w: 20.0,
                    ch_h: 20.0,
                    children: Vec::new(),
                    canvas: None,
                },
            });
        }
    }
    bad_cases.push(("nested group inside group", p));
    // 8. Oversized payload (too many media entries or over media byte limit)
    let mut p = group_payload.clone();
    for i in 0..MAX_PAYLOAD_MEDIA {
        p.media.push(PayloadMedia {
            name: format!("m{i}.png"),
            sha256: group_payload.media[0].sha256.clone(),
            data: group_payload.media[0].data.clone(),
        });
    }
    bad_cases.push(("oversized media count", p));
    let mut p = group_payload.clone();
    p.media[0].data = "A".repeat(MAX_PAYLOAD_MEDIA_BYTES * 2);
    bad_cases.push(("oversized media bytes", p));

    for (label, bad_payload) in bad_cases {
        let mut clean = DocxModel::open(&dst_baseline_bytes).unwrap();
        let baseline_export = clean.export().unwrap();
        let baseline_media = clean.diagnostic_document().media.clone();
        let baseline_parts = clean.diagnostic_document().parts.len();
        let res = clean.apply(&[DocxOp::PasteObject {
            payload: Box::new(bad_payload),
        }]);
        assert_eq!(res.changed, 0, "{label} changed");
        assert_eq!(res.rejected, vec![0], "{label}");
        assert!(!clean.view().history.undo, "{label} undo history");
        assert_eq!(clean.diagnostic_document().media, baseline_media, "{label} media");
        assert_eq!(clean.diagnostic_document().parts.len(), baseline_parts, "{label} parts");
        assert_eq!(clean.export().unwrap(), baseline_export, "{label} export bytes");
    }

    // 9. Unsupported paste destination (non-collapsed selection)
    let mut prot = DocxModel::open(&dst_baseline_bytes).unwrap();
    prot.apply(&[mv(MoveTarget::DocStart, false), mv(MoveTarget::Right, true)]);
    let prot_before = prot.export().unwrap();
    let res = prot.apply(&[DocxOp::PasteObject {
        payload: Box::new(group_payload),
    }]);
    assert_eq!(res.changed, 0);
    assert_eq!(res.rejected, vec![0]);
    assert!(!prot.view().history.undo);
    assert_eq!(prot.export().unwrap(), prot_before);
}

#[test]
fn stage3_docx_freeform_geometry_edit_preserves_paths_and_roundtrips() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::freeform::{FreePath, Freeform};
    use wordcraft_engine::doc::para::{Float, ShapeKind};
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{CharProps, InlineObject};
    use wordcraft_engine::{io, Session};

    let mut sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let body_end = sess.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    sess.run("caret.set", &json!({"pos": body_end})).unwrap();
    sess.run("text.newParagraph", &json!({})).unwrap();
    let free = Freeform {
        w: 120.0,
        h: 80.0,
        paths: vec![FreePath {
            pts: vec![[0.0, 0.0], [120.0, 40.0], [30.0, 80.0]],
            closed: true,
        }],
        drawingml: None,
        alpha: 1.0,
        ink: None,
        order: None,
    };
    let obj = InlineObject::Shape {
        kind: ShapeKind::Freeform,
        w: 120.0,
        h: 80.0,
        fill: Some(Rgb(0x22, 0x44, 0x66)),
        stroke: Some(Rgb(0x10, 0x20, 0x30)),
        stroke_width: 1.5,
        float: Float::default(),
        story: None,
        freeform: Some(std::sync::Arc::new(free)),
        effects: Default::default(),
        extra: Default::default(),
    };
    let at = sess.sel.focus.clone();
    sess.doc.insert_object(&at, obj, &CharProps::default()).unwrap();
    let original_bytes = io::save_bytes("fixture.docx", &sess.doc).unwrap();

    let mut model = DocxModel::open(&original_bytes).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original_bytes).unwrap());
    let layout = reader.layout();
    let hit = layout.find_object(0, |o| (o.rect.w - 120.0).abs() < 0.5).unwrap();
    model.apply(&[DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + 10.0,
        y: hit.rect.y + 10.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let view = serde_json::to_value(model.view()).unwrap();
    assert_eq!(view["object"]["kind"], "shape");
    let ops = view["object"]["operations"].as_array().unwrap();
    for required in ["move", "resize", "delete", "wrap", "fill", "outline", "rotate", "zOrder"] {
        assert!(ops.iter().any(|v| v == required), "missing op {required}: {ops:?}");
    }
    let pos = view["object"]["position"].as_str().unwrap().to_owned();
    let epoch = view["object"]["epoch"].as_u64().unwrap();

    let edits = model.apply(&[
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch,
            edit: ObjectEdit::Bounds { x: None, y: None, width: Some(180.0), height: Some(110.0) },
        },
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch: epoch + 1,
            edit: ObjectEdit::Rotate { degrees: 35.0, flip_h: true, flip_v: false },
        },
        DocxOp::ObjectEdit {
            position: pos,
            epoch: epoch + 2,
            edit: ObjectEdit::Fill { color: Some("44AA88".into()) },
        },
    ]);
    assert_eq!(edits.changed, 3, "{:?}", edits.rejected);
    let edited_bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original_bytes,
        &edited_bytes,
        None,
        model.same_as(&edited_bytes),
    )
    .is_safe());

    let reopened = io::open_bytes("fixture.docx", &edited_bytes).unwrap();
    let freeform_after = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .find(|o| matches!(o, InlineObject::Shape { kind: ShapeKind::Freeform, .. }))
        .unwrap();
    match freeform_after {
        InlineObject::Shape { w, h, fill, float, freeform: Some(f), .. } => {
            assert!((*w - 180.0).abs() < 0.01 && (*h - 110.0).abs() < 0.01);
            assert_eq!(fill.map(|c| c.hex()), Some("44AA88".into()));
            assert!((float.rot - 35.0).abs() < 0.01 && float.flip_h && !float.flip_v);
            assert_eq!(f.paths.len(), 1);
            assert_eq!(f.paths[0].pts.len(), 3);
            assert!(f.paths[0].closed);
        }
        other => panic!("unexpected shape {other:?}"),
    }
}

#[test]
fn stage3_docx_group_geometry_rotate_layer_roundtrips() {
    use super::engine::ObjectEdit;
    use crate::services::save::service;
    use wordcraft_engine::doc::para::{Float, GroupChild, ShapeKind, Wrap};
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{CharProps, InlineObject};
    use wordcraft_engine::{io, Session};

    let mut sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let body_end = sess.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    sess.run("caret.set", &json!({"pos": body_end})).unwrap();
    sess.run("text.newParagraph", &json!({})).unwrap();
    let group_obj = InlineObject::Group {
        w: 200.0,
        h: 120.0,
        float: Float::default(),
        ch_w: 200.0,
        ch_h: 120.0,
        canvas: None,
        children: vec![
            GroupChild {
                x: 10.0,
                y: 10.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::Rectangle,
                    w: 80.0,
                    h: 50.0,
                    fill: Some(Rgb(0x33, 0x66, 0x99)),
                    stroke: Some(Rgb(0x11, 0x22, 0x33)),
                    stroke_width: 1.0,
                    float: Float::default(),
                    story: None,
                    freeform: None,
                    effects: Default::default(),
                    extra: Default::default(),
                },
            },
            GroupChild {
                x: 100.0,
                y: 40.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::Ellipse,
                    w: 70.0,
                    h: 50.0,
                    fill: Some(Rgb(0xCC, 0x88, 0x44)),
                    stroke: None,
                    stroke_width: 1.0,
                    float: Float::default(),
                    story: None,
                    freeform: None,
                    effects: Default::default(),
                    extra: Default::default(),
                },
            },
        ],
    };
    let at = sess.sel.focus.clone();
    sess.doc.insert_object(&at, group_obj, &CharProps::default()).unwrap();
    let original_bytes = io::save_bytes("fixture.docx", &sess.doc).unwrap();

    let mut model = DocxModel::open(&original_bytes).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original_bytes).unwrap());
    let layout = reader.layout();
    let hit = layout.find_object(0, |o| (o.rect.w - 200.0).abs() < 0.5).unwrap();
    model.apply(&[DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + 20.0,
        y: hit.rect.y + 20.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let view = serde_json::to_value(model.view()).unwrap();
    assert_eq!(view["object"]["kind"], "group");
    assert_eq!(view["object"]["shape"]["widthPt"], 200.0);
    let ops = view["object"]["operations"].as_array().unwrap();
    for required in ["move", "resize", "delete", "wrap", "altText", "rotate", "zOrder"] {
        assert!(ops.iter().any(|v| v == required), "missing group op {required}: {ops:?}");
    }
    let pos = view["object"]["position"].as_str().unwrap().to_owned();
    let epoch = view["object"]["epoch"].as_u64().unwrap();

    let res = model.apply(&[
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch,
            edit: ObjectEdit::Bounds { x: None, y: None, width: Some(260.0), height: Some(150.0) },
        },
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch: epoch + 1,
            edit: ObjectEdit::Wrap { wrap: Wrap::Square },
        },
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch: epoch + 2,
            edit: ObjectEdit::Rotate { degrees: 25.0, flip_h: true, flip_v: false },
        },
        DocxOp::ObjectEdit {
            position: pos.clone(),
            epoch: epoch + 3,
            edit: ObjectEdit::Layer { front: false },
        },
        DocxOp::ObjectEdit {
            position: pos,
            epoch: epoch + 4,
            edit: ObjectEdit::Bounds { x: Some(90.0), y: Some(140.0), width: None, height: None },
        },
    ]);
    assert_eq!(res.changed, 5, "{:?}", res.rejected);
    let view_after = serde_json::to_value(model.view()).unwrap();
    let pos_after = view_after["object"]["position"].as_str().unwrap().to_owned();
    let epoch_after = view_after["object"]["epoch"].as_u64().unwrap();
    assert_eq!(view_after["object"]["shape"]["rotation"], 25.0);
    assert_eq!(view_after["object"]["shape"]["flipH"], true);
    let del_res = model.apply(&[
        DocxOp::ObjectEdit {
            position: pos_after,
            epoch: epoch_after,
            edit: ObjectEdit::Delete {},
        },
        DocxOp::Undo {},
    ]);
    assert_eq!(del_res.changed, 2, "{:?}", del_res.rejected);
    let edited_bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original_bytes,
        &edited_bytes,
        None,
        model.same_as(&edited_bytes),
    )
    .is_safe());

    let reopened = io::open_bytes("fixture.docx", &edited_bytes).unwrap();
    let group_after = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .find(|o| matches!(o, InlineObject::Group { .. }))
        .unwrap();
    match group_after {
        InlineObject::Group { w, h, ch_w, ch_h, float, children, .. } => {
            assert!((*w - 260.0).abs() < 0.01 && (*h - 150.0).abs() < 0.01);
            assert!((*ch_w - 200.0).abs() < 0.01 && (*ch_h - 120.0).abs() < 0.01);
            assert_eq!(float.wrap, Wrap::BehindText);
            assert!((float.rot - 25.0).abs() < 0.01 && float.flip_h && !float.flip_v);
            assert_eq!(children.len(), 2);
        }
        other => panic!("unexpected group {other:?}"),
    }
}

#[test]
fn stage3_docx_group_child_geometry_t009_preserves_nested_resources() {
    use super::engine::ObjectEdit;
    use crate::services::save::{package, service};
    use wordcraft_engine::doc::para::{Float, GroupChild, ShapeKind};
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{CharProps, InlineObject};
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let body_end = source.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    source.run("caret.set", &json!({"pos": body_end})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source.run("insert.picture", &json!({"data": tiny_png_b64(3, 2, [40, 90, 170]), "width": 24.0})).unwrap();
    let (picture_pos, mut picture) = wordcraft_engine::cmd::objects::selected(&source).expect("inserted picture");
    source.doc.delete_range(&picture_pos, &wordcraft_engine::doc::Pos {
        off: picture_pos.off + wordcraft_engine::doc::para::OBJ.len_utf8(),
        ..picture_pos.clone()
    }).unwrap();
    let InlineObject::Image { w, h, float, .. } = &mut picture else { panic!("expected image child") };
    *w = 30.0;
    *h = 20.0;
    *float = Float::default();

    let shape = InlineObject::Shape {
        kind: ShapeKind::Rectangle,
        w: 22.0,
        h: 18.0,
        fill: Some(Rgb(0x33, 0x66, 0x99)),
        stroke: Some(Rgb(0x11, 0x22, 0x33)),
        stroke_width: 1.0,
        float: Float::default(),
        story: None,
        freeform: None,
        effects: Default::default(),
        extra: Default::default(),
    };
    let nested = InlineObject::Group {
        w: 80.0,
        h: 60.0,
        float: Float::default(),
        ch_w: 80.0,
        ch_h: 60.0,
        canvas: None,
        children: vec![
            GroupChild { x: 5.0, y: 6.0, obj: shape },
            GroupChild { x: 42.0, y: 20.0, obj: picture },
        ],
    };
    let sibling = InlineObject::Shape {
        kind: ShapeKind::Ellipse,
        w: 42.0,
        h: 32.0,
        fill: Some(Rgb(0xCC, 0x88, 0x44)),
        stroke: None,
        stroke_width: 1.0,
        float: Float::default(),
        story: None,
        freeform: None,
        effects: Default::default(),
        extra: Default::default(),
    };
    let root_group = InlineObject::Group {
        w: 220.0,
        h: 130.0,
        float: Float::default(),
        ch_w: 220.0,
        ch_h: 130.0,
        canvas: None,
        children: vec![
            GroupChild { x: 10.0, y: 10.0, obj: nested },
            GroupChild { x: 120.0, y: 35.0, obj: sibling.clone() },
        ],
    };
    let insert_at = source.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    source.doc.insert_object(&insert_at, root_group, &CharProps::default()).unwrap();
    let generated_bytes = io::save_bytes("fixture.docx", &source.doc).unwrap();
    let native_fixture: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../scripts/tests/fixtures/stage3a-p4-dx-group.docx"
    ));
    let generated = package::open(&generated_bytes, package::Side::Original).unwrap();
    let fixture_package = package::open(native_fixture, package::Side::Original).unwrap();
    assert_eq!(generated.parts.keys().collect::<Vec<_>>(), fixture_package.parts.keys().collect::<Vec<_>>());
    for name in generated.parts.keys() {
        assert_eq!(generated.get(name), fixture_package.get(name), "native fixture differs from generated source part: {name}");
    }
    let original_bytes = native_fixture.to_vec();
    let mut model = DocxModel::open(&original_bytes).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &original_bytes).unwrap());
    let layout = reader.layout();
    let hit = layout.find_object(0, |object| (object.rect.w - 220.0).abs() < 0.5).expect("outer group layout");
    let select_group = || DocxOp::Pointer {
        page: hit.page as u32,
        x: hit.rect.x + 1.0,
        y: hit.rect.y + 1.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let selected = model.apply(&[select_group()]);
    assert_eq!(selected.applied, 1, "{:?}", selected.rejected);
    let view = serde_json::to_value(model.view()).unwrap();
    assert_eq!(view["object"]["kind"], "group");
    assert_eq!(view["object"]["operations"].as_array().unwrap().iter().any(|op| op == "groupChildGeometry"), true);
    assert_eq!(view["object"]["groupChildren"]["children"].as_array().unwrap().len(), 2);
    assert_eq!(view["object"]["groupChildren"]["children"][0]["kind"], "group");
    assert_eq!(view["object"]["groupChildren"]["children"][1]["kind"], "ellipse");

    let position = view["object"]["position"].as_str().unwrap().to_owned();
    let epoch = view["object"]["epoch"].as_u64().unwrap();
    let moved = model.apply(&[DocxOp::ObjectEdit {
        position: position.clone(),
        epoch,
        edit: ObjectEdit::DocxGroupChildMove { index: 0, id: 1, inst_id: 0, x: 20.0, y: 15.0 },
    }]);
    assert_eq!(moved.changed, 1, "{:?}", moved.rejected);
    assert_eq!(serde_json::to_value(model.view()).unwrap()["object"]["groupChildren"]["children"][0]["x"], 20.0);

    let undone = model.apply(&[DocxOp::Undo {}]);
    assert_eq!(undone.changed, 1, "{:?}", undone.rejected);
    assert_eq!(model.apply(&[select_group()]).applied, 1);
    assert_eq!(serde_json::to_value(model.view()).unwrap()["object"]["groupChildren"]["children"][0]["x"], 10.0);
    let redone = model.apply(&[DocxOp::Redo {}]);
    assert_eq!(redone.changed, 1, "{:?}", redone.rejected);
    assert_eq!(model.apply(&[select_group()]).applied, 1);
    assert_eq!(serde_json::to_value(model.view()).unwrap()["object"]["groupChildren"]["children"][0]["x"], 20.0);

    let current = serde_json::to_value(model.view()).unwrap();
    let resize = model.apply(&[DocxOp::ObjectEdit {
        position: current["object"]["position"].as_str().unwrap().to_owned(),
        epoch: current["object"]["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::DocxGroupChildResize { index: 0, id: 1, inst_id: 0, width: 70.0, height: 50.0 },
    }]);
    assert_eq!(resize.changed, 1, "{:?}", resize.rejected);
    let edited_bytes = model.export().unwrap();
    assert!(model.same_as(&edited_bytes), "edited WordCraft model must match independent reopen");
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &original_bytes,
        &edited_bytes,
        None,
        model.same_as(&edited_bytes),
    ).is_safe());

    let before_package = package::open(&original_bytes, package::Side::Original).unwrap();
    let after_package = package::open(&edited_bytes, package::Side::Output).unwrap();
    assert_eq!(before_package.parts.keys().collect::<Vec<_>>(), after_package.parts.keys().collect::<Vec<_>>());
    for name in before_package.parts.keys() {
        if name != "word/document.xml" && name != "docProps/app.xml" {
            assert_eq!(before_package.get(name), after_package.get(name), "unrelated OPC part changed: {name}");
        }
    }
    assert_eq!(before_package.get("word/_rels/document.xml.rels"), after_package.get("word/_rels/document.xml.rels"));

    let reopened = io::open_bytes("fixture.docx", &edited_bytes).unwrap();
    let persisted = reopened.body.iter().filter_map(|block| block.as_para()).flat_map(|para| &para.objects)
        .find(|object| matches!(object, InlineObject::Group { .. })).expect("group after reopen");
    let InlineObject::Group { children, .. } = persisted else { unreachable!() };
    assert_eq!(children.len(), 2);
    assert_eq!((children[1].x, children[1].y), (120.0, 35.0), "unrelated sibling placement remains unchanged");
    let InlineObject::Shape { kind, w, h, fill, stroke, .. } = &children[1].obj else { panic!("sibling shape changed kind") };
    assert_eq!((*kind, *w, *h, *fill, *stroke), (ShapeKind::Ellipse, 42.0, 32.0, Some(Rgb(0xCC, 0x88, 0x44)), None));
    assert_eq!((children[0].x, children[0].y), (20.0, 15.0));
    let InlineObject::Group { w, h, children: descendants, .. } = &children[0].obj else { panic!("nested group was flattened") };
    assert_eq!((*w, *h), (70.0, 50.0));
    assert_eq!(descendants.len(), 2);
    assert!(matches!(descendants[0].obj, InlineObject::Shape { .. }));
    let InlineObject::Image { media, .. } = &descendants[1].obj else { panic!("nested picture lost") };
    assert!(reopened.media.contains_key(media), "nested picture relationship resolves to its media");

    let mut source_package = package::open(&original_bytes, package::Side::Original).unwrap();
    let body = source_package.parts.get_mut("word/document.xml").unwrap();
    let xml = std::str::from_utf8(&body.1).unwrap();
    let at = xml.rfind("</wpg:wgp>").expect("outer group end tag");
    let mut with_unknown = xml.to_owned();
    with_unknown.insert_str(at, "<wpg:unsupportedMember/>\n");
    body.1 = with_unknown.into_bytes();
    let entries: Vec<_> = source_package.order.iter().map(|name| {
        crate::document::testutil::entry(name, source_package.get(name).unwrap())
    }).collect();
    let unsupported_bytes = zip(&entries, false);
    let mut guarded = DocxModel::open(&unsupported_bytes).unwrap();
    let selected = guarded.apply(&[select_group()]);
    assert_eq!(selected.applied, 1, "{:?}", selected.rejected);
    let guarded_view = serde_json::to_value(guarded.view()).unwrap();
    assert!(!guarded_view["object"]["operations"].as_array().unwrap().iter().any(|op| op == "groupChildGeometry"));
    assert!(guarded_view["object"].get("groupChildren").is_none());
    let guarded_before = guarded.export().unwrap();
    let edit = guarded.apply(&[DocxOp::ObjectEdit {
        position: guarded_view["object"]["position"].as_str().unwrap().to_owned(),
        epoch: guarded_view["object"]["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::DocxGroupChildMove { index: 0, id: 1, inst_id: 0, x: 20.0, y: 15.0 },
    }]);
    assert_eq!(edit.changed, 0);
    assert_eq!(edit.rejected, vec![0]);
    assert_eq!(guarded.export().unwrap(), guarded_before, "unsupported original member blocks child mutation atomically");

    let mut scaled_package = package::open(&original_bytes, package::Side::Original).unwrap();
    let body = scaled_package.parts.get_mut("word/document.xml").unwrap();
    let xml = std::str::from_utf8(&body.1).unwrap();
    let identity_axes = "<a:chExt cx=\"2794000\" cy=\"1651000\"/>";
    assert!(xml.contains(identity_axes), "native fixture must use an identity group coordinate space");
    body.1 = xml.replacen(identity_axes, "<a:chExt cx=\"5588000\" cy=\"1651000\"/>", 1).into_bytes();
    let entries: Vec<_> = scaled_package.order.iter().map(|name| {
        crate::document::testutil::entry(name, scaled_package.get(name).unwrap())
    }).collect();
    let scaled_bytes = zip(&entries, false);
    let mut scaled = DocxModel::open(&scaled_bytes).unwrap();
    let selected = scaled.apply(&[select_group()]);
    assert_eq!(selected.applied, 1, "{:?}", selected.rejected);
    let scaled_view = serde_json::to_value(scaled.view()).unwrap();
    assert!(scaled_view["object"].get("groupChildren").is_none(), "scaled group coordinates stay fail-closed");
    let scaled_before = scaled.export().unwrap();
    let edit = scaled.apply(&[DocxOp::ObjectEdit {
        position: scaled_view["object"]["position"].as_str().unwrap().to_owned(),
        epoch: scaled_view["object"]["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::DocxGroupChildMove { index: 0, id: 1, inst_id: 0, x: 20.0, y: 15.0 },
    }]);
    assert_eq!(edit.changed, 0);
    assert_eq!(edit.rejected, vec![0]);
    assert_eq!(scaled.export().unwrap(), scaled_before, "scaled group rejection is atomic");
}

#[test]
fn stage3_docx_clipboard_expands_textbox_story_and_remaps_colliding_shape_ids() {
    use super::engine::ObjectPayload;
    use crate::services::save::service;
    use wordcraft_engine::doc::connector::{ConnEnd, ShapeExtra};
    use wordcraft_engine::doc::para::{Float, GroupChild, ShapeKind};
    use wordcraft_engine::doc::props::Rgb;
    use wordcraft_engine::doc::{CharProps, InlineObject, PartKind, StoryRef};
    use wordcraft_engine::{io, Session};

    // 1. Source document with a Body-hosted TextBox containing an inner shape, AND a Group
    //    holding a shape with non-zero docPr `extra.id = 42` and dangling `ConnEnd` connector glue.
    let mut sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    let body_end = sess.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    sess.run("caret.set", &json!({"pos": body_end})).unwrap();
    sess.run("text.newParagraph", &json!({})).unwrap();
    sess.run("insert.textBox", &json!({"width": 200, "height": 120})).unwrap();
    sess.run("text.insert", &json!({"text": "상자안:"})).unwrap();
    sess.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
    sess.run("picture.size", &json!({"width": 60, "height": 40})).unwrap();

    let body_end = sess.doc.end_of(wordcraft_engine::doc::StoryRef::Body);
    sess.run("caret.set", &json!({"pos": body_end})).unwrap();
    sess.run("text.newParagraph", &json!({})).unwrap();
    let group_with_ids = InlineObject::Group {
        w: 180.0,
        h: 80.0,
        float: Float::default(),
        ch_w: 180.0,
        ch_h: 80.0,
        canvas: None,
        children: vec![
            GroupChild {
                x: 10.0,
                y: 10.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::Rectangle,
                    w: 50.0,
                    h: 40.0,
                    fill: Some(Rgb(0x33, 0x66, 0x99)),
                    stroke: None,
                    stroke_width: 1.0,
                    float: Float::default(),
                    story: None,
                    freeform: None,
                    effects: Default::default(),
                    extra: ShapeExtra { id: 42, ..Default::default() },
                },
            },
            GroupChild {
                x: 60.0,
                y: 10.0,
                obj: InlineObject::Shape {
                    kind: ShapeKind::StraightConnector,
                    w: 80.0,
                    h: 20.0,
                    fill: None,
                    stroke: Some(Rgb(0x44, 0x44, 0x44)),
                    stroke_width: 1.5,
                    float: Float::default(),
                    story: None,
                    freeform: None,
                    effects: Default::default(),
                    extra: ShapeExtra {
                        start: Some(ConnEnd { id: 42, site: 1 }),
                        end: Some(ConnEnd { id: 998, site: 3 }),
                        ..Default::default()
                    },
                },
            },
        ],
    };
    let at2 = sess.sel.focus.clone();
    sess.doc.insert_object(&at2, group_with_ids, &CharProps::default()).unwrap();
    let src_bytes = io::save_bytes("fixture.docx", &sess.doc).unwrap();

    // Copying a Header object must remain refused.
    let mut hdr_sess = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    hdr_sess.run("insert.editHeader", &json!({})).unwrap();
    hdr_sess.run("insert.shape", &json!({"kind": "rectangle"})).unwrap();
    hdr_sess.run("insert.closeHeader", &json!({})).unwrap();
    let hdr_bytes = io::save_bytes("fixture.docx", &hdr_sess.doc).unwrap();
    let mut hdr_model = DocxModel::open(&hdr_bytes).unwrap();
    let mut hdr_reader = Session::new(io::open_bytes("fixture.docx", &hdr_bytes).unwrap());
    let hdr_lay = hdr_reader.layout();
    if let Some(h) = hdr_lay.find_object(0, |o| matches!(o.story, StoryRef::Part(id) if hdr_reader.doc.parts.get(&id).is_some_and(|p| p.kind == PartKind::Header))) {
        hdr_model.apply(&[DocxOp::Pointer {
            page: h.page as u32,
            x: h.rect.x + h.rect.w / 2.0,
            y: h.rect.y + h.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        }]);
        assert!(serde_json::to_value(hdr_model.view()).unwrap()["object"].is_null());
    }

    let mut model = DocxModel::open(&src_bytes).unwrap();
    let mut reader = Session::new(io::open_bytes("fixture.docx", &src_bytes).unwrap());
    let layout = reader.layout();

    // 2. Copy the shape INSIDE the Body TextBox story (`PartKind::TextBox`) and paste at Body end.
    let inner_hit = layout
        .find_object(0, |o| matches!(o.story, StoryRef::Part(_)) && (o.rect.w - 60.0).abs() < 0.5)
        .unwrap();
    model.apply(&[DocxOp::Pointer {
        page: inner_hit.page as u32,
        x: inner_hit.rect.x + inner_hit.rect.w / 2.0,
        y: inner_hit.rect.y + inner_hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let tb_view = serde_json::to_value(model.view()).unwrap();
    let tb_pos_str = tb_view["object"]["position"].as_str().unwrap().to_owned();
    assert!(tb_pos_str.starts_with("part"), "{tb_pos_str}");
    let tb_epoch = tb_view["object"]["epoch"].as_u64().unwrap();
    let tb_payload: ObjectPayload =
        serde_json::from_str(&model.clipboard_object(&tb_pos_str, tb_epoch).unwrap()).unwrap();
    model.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]);
    let p_res = model.apply(&[DocxOp::PasteObject { payload: Box::new(tb_payload) }]);
    assert_eq!(p_res.changed, 1, "{:?}", p_res.rejected);

    // 3. Copy the Group with colliding `extra.id = 42` & connector glue and paste into the SAME doc.
    let grp_hit = layout.find_object(0, |o| (o.rect.w - 180.0).abs() < 0.5).unwrap();
    model.apply(&[DocxOp::Pointer {
        page: grp_hit.page as u32,
        x: grp_hit.rect.x + 20.0,
        y: grp_hit.rect.y + 20.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    }]);
    let grp_view = serde_json::to_value(model.view()).unwrap();
    let grp_pos = grp_view["object"]["position"].as_str().unwrap().to_owned();
    let grp_epoch = grp_view["object"]["epoch"].as_u64().unwrap();
    let grp_payload: ObjectPayload =
        serde_json::from_str(&model.clipboard_object(&grp_pos, grp_epoch).unwrap()).unwrap();
    model.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]);
    let g_res = model.apply(&[DocxOp::PasteObject { payload: Box::new(grp_payload) }]);
    assert_eq!(g_res.changed, 1, "{:?}", g_res.rejected);

    let out_bytes = model.export().unwrap();
    assert!(service::check_saved(
        crate::document::Format::Docx,
        &src_bytes,
        &out_bytes,
        None,
        model.same_as(&out_bytes),
    )
    .is_safe());

    // Verify reopened pasted group got a fresh non-colliding `extra.id != 42` preserved for its internal connector
    // while dangling external glue (`end: 998`) was cleared.
    let reopened = io::open_bytes("fixture.docx", &out_bytes).unwrap();
    let group_ids: Vec<(u32, Option<u32>, bool)> = reopened
        .body
        .iter()
        .filter_map(|b| b.as_para())
        .flat_map(|p| &p.objects)
        .filter_map(|o| match o {
            InlineObject::Group { children, .. } if children.len() == 2 => {
                let target_id = match &children[0].obj {
                    InlineObject::Shape { extra, .. } => extra.id,
                    _ => 0,
                };
                match &children[1].obj {
                    InlineObject::Shape { extra, .. } => {
                        Some((target_id, extra.start.map(|s| s.id), extra.end.is_none()))
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    assert_eq!(group_ids.len(), 2);
    assert_eq!(group_ids[0].0, 42);
    assert_eq!(group_ids[0].1, Some(42));
    assert_ne!(group_ids[1].0, 0);
    assert_ne!(group_ids[1].0, 42);
    assert_eq!(group_ids[1].1, Some(group_ids[1].0));
    assert!(group_ids[1].2, "external connector glue must be cleared on paste");
}

#[test]
fn stage3a_edits_docx_story_picture_descriptions_without_moving_owners() {
    use crate::document::Format;
    use crate::services::save::{package, service};
    use super::engine::ObjectEdit;
    use wordcraft_engine::doc::{para::NoteKind, para_block, props::CharProps, InlineObject, Paragraph, PartKind, StoryRef};
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source.run("insert.picture", &json!({ "data": tiny_png_b64(2, 2, [140, 90, 40]) })).unwrap();
    source.run("picture.size", &json!({ "width": 28, "height": 22 })).unwrap();
    source.run("object.altText", &json!({ "text": "body picture" })).unwrap();
    let (_, picture) = wordcraft_engine::cmd::objects::selected(&source).unwrap();
    let props = CharProps::default();
    let stories = [
        (PartKind::Header, "header", None, "word/header1.xml"),
        (PartKind::Footer, "footer", None, "word/footer1.xml"),
        (PartKind::Footnote, "footnote", Some(NoteKind::Footnote), "word/footnotes.xml"),
        (PartKind::Endnote, "endnote", Some(NoteKind::Endnote), "word/endnotes.xml"),
    ];
    for (kind, label, note, _) in stories {
        let id = source.doc.add_part(kind, Vec::new());
        let mut para = Paragraph::with_text(&format!("{label} text "), props.clone());
        if let Some(kind) = note {
            let marker = InlineObject::NoteRef { kind, id, custom: String::new() };
            para.insert_object(0, marker.clone(), &props).unwrap();
            let end = source.doc.end_of(StoryRef::Body);
            source.doc.insert_object(&end, marker, &props).unwrap();
        }
        let mut picture = picture.clone();
        picture.set_alt_text(label);
        para.insert_object(para.len(), picture, &props).unwrap();
        source.doc.set_story(StoryRef::Part(id), vec![para_block(para)]).unwrap();
        match kind {
            PartKind::Header => source.doc.last_section.headers.default = Some(id),
            PartKind::Footer => source.doc.last_section.footers.default = Some(id),
            _ => {}
        }
    }
    let draft = io::save_bytes("story.docx", &source.doc).unwrap();
    // Use the pinned writer's canonical OPC identities in the publication tests.
    let original = io::save_bytes("story.docx", &io::open_bytes("story.docx", &draft).unwrap()).unwrap();
    let mut baseline = Session::new(io::open_bytes("story.docx", &original).unwrap());
    let layout = baseline.layout();
    let mut positions = serde_json::Map::new();
    for (kind, label, note, part) in stories {
        let id = *baseline.doc.parts.iter().find(|(_, p)| p.kind == kind).unwrap().0;
        let story = StoryRef::Part(id);
        let hit = layout.find_object(0, |object| object.story == story).unwrap_or_else(|| panic!("missing displayed {label} picture"));
        let (x, y) = (hit.rect.x + hit.rect.w / 2.0, hit.rect.y + hit.rect.h / 2.0);
        positions.insert(label.into(), json!({"page":hit.page,"x":x,"y":y,"part":part}));
        let click = DocxOp::Pointer { page: hit.page as u32, x, y,
            extend: false, before_insert: false, drag: false, select_object: true };
        let mut model = DocxModel::open(&original).unwrap();
        assert_eq!(model.apply(&[click.clone()]).changed, 0);
        let selected = serde_json::to_value(model.view()).unwrap();
        let selected = &selected["object"];
        assert_eq!(selected["position"], format!("part{id}:{}:{}", hit.path, hit.off));
        let expected_operations =
            if note.is_some() || matches!(kind, PartKind::Header | PartKind::Footer) {
                json!(["move", "resize", "delete", "altText"])
            } else {
                json!(["resize", "altText"])
            };
        assert_eq!(selected["operations"], expected_operations);
        assert_eq!(selected["picture"]["description"], label);

        let position = selected["position"].as_str().unwrap().to_owned();
        let epoch = selected["epoch"].as_u64().unwrap();
        let command = DocxOp::ObjectEdit { position: position.clone(), epoch,
            edit: ObjectEdit::AltText { text: format!("{label} edited") } };
        let before = model.export().unwrap();
        let wrong = DocxOp::ObjectEdit { position: "body:0:0".into(), epoch,
            edit: ObjectEdit::AltText { text: "wrong owner".into() } };
        let stale = DocxOp::ObjectEdit { position, epoch: epoch - 1,
            edit: ObjectEdit::AltText { text: "stale owner".into() } };
        assert_eq!(model.apply(&[wrong, stale]).rejected, vec![0, 1]);
        assert_eq!(model.export().unwrap(), before);
        assert!(!model.view().history.undo);
        let result = model.apply(&[command]);
        if result.changed != 1 {
            let mut isolated = Session::new(io::open_bytes("story.docx", &original).unwrap());
            let at = hit.pos();
            let end = wordcraft_engine::doc::Pos { off: at.off + 3, ..at.clone() };
            isolated.run("select.range", &json!({"anchor":at,"focus":end})).unwrap();
            isolated.run("object.altText", &json!({"text":format!("{label} edited")})).unwrap();
            let candidate = io::save_bytes("story.docx", &isolated.doc).unwrap();
            let restored = io::open_bytes("story.docx", &candidate).unwrap();
            let same = wordcraft_engine::doc::roundtrip::roundtrip_equivalent(&isolated.doc, &restored);
            let gate = service::check_saved(Format::Docx, &original, &candidate, None, matches!(same, Ok(true)));
            panic!("{label} edit rejected: {same:?} with {gate:?}");
        }
        let after = model.export().unwrap();
        assert!(model.same_as(&after));
        assert!(service::check_saved(Format::Docx, &original, &after, None, true).is_safe());
        let left = package::open(&original, package::Side::Original).unwrap();
        let mut right = package::open(&after, package::Side::Output).unwrap();
        assert_eq!(left.parts.keys().collect::<Vec<_>>(), right.parts.keys().collect::<Vec<_>>());
        for name in left.parts.keys().filter(|name| name.as_str() != part) {
            assert_eq!(left.get(name), right.get(name), "unrelated part changed: {name}");
        }
        let edited = io::open_bytes("story.docx", &after).unwrap();
        let reopened = edited.parts.values().find(|p| p.kind == kind).unwrap();
        let p = match reopened.blocks[0].as_ref() {
            wordcraft_engine::doc::Block::Para(p) => p,
            _ => panic!("picture left its paragraph"),
        };
        let alt = p.object_offsets().iter().find_map(|off| match p.object_at(*off) {
            Some(InlineObject::Image { alt, .. }) => Some(alt.as_str()),
            _ => None,
        });
        assert_eq!(alt, Some(format!("{label} edited").as_str()));
        assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), before);
        assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), after);
        // A change to only one mirrored description must not be treated as the
        // description edit WordCraft issued. No additions, mutations or remapping
        // of the target's relationship are part of this contract.
        let (_, part_bytes) = right.parts.get_mut(part).unwrap();
        let xml = std::str::from_utf8(part_bytes).unwrap();
        let descr = format!("descr=\"{label} edited\"");
        assert_eq!(xml.matches(&descr).count(), 2);
        *part_bytes = xml.replacen(&descr, "descr=\"unpaired\"", 1).into_bytes();
        assert!(package::compare_saved_docx(&left, &right).iter().any(|f| f.part.as_deref() == Some(part)));

        let mut model = DocxModel::open(&after).unwrap();
        assert!(model.apply(&[click]).rejected.is_empty());
        let view = serde_json::to_value(model.view()).unwrap();
        let object = &view["object"];
        let resize = |edit| DocxOp::ObjectEdit {
            position: object["position"].as_str().unwrap().into(),
            epoch: object["epoch"].as_u64().unwrap(),
            edit,
        };
        let moved = resize(ObjectEdit::Bounds {
            x: Some(20.0), y: Some(30.0), width: Some(35.0), height: Some(27.5),
        });
        assert_eq!(model.apply(&[moved]).rejected, vec![0]);
        assert_eq!(model.export().unwrap(), after);
        assert!(!model.view().history.undo);
        let size = resize(ObjectEdit::Bounds {
            x: None, y: None, width: Some(35.0), height: Some(27.5),
        });
        assert_eq!(model.apply(&[size]).changed, 1, "{label} resize refused");
        let resized = model.export().unwrap();
        assert!(model.same_as(&resized));
        assert!(service::check_saved(Format::Docx, &original, &resized, None, true).is_safe());
        let before_size = package::open(&after, package::Side::Original).unwrap();
        let mut after_size = package::open(&resized, package::Side::Output).unwrap();
        assert_eq!(before_size.parts.keys().collect::<Vec<_>>(), after_size.parts.keys().collect::<Vec<_>>());
        let from = "cx=\"355600\" cy=\"279400\"";
        let to = "cx=\"444500\" cy=\"349250\"";
        let before_xml = std::str::from_utf8(before_size.get(part).unwrap()).unwrap();
        assert_eq!(before_xml.matches(from).count(), 2);
        let target = before_xml.replace(from, to);
        assert_eq!(after_size.get(part), Some(target.as_bytes()));
        for name in before_size.parts.keys().filter(|n| n.as_str() != part) {
            assert_eq!(before_size.get(name), after_size.get(name));
        }
        let (_, part_bytes) = after_size.parts.get_mut(part).unwrap();
        *part_bytes = target.replacen(to, from, 1).into_bytes();
        assert!(package::compare_saved_docx(&before_size, &after_size).iter().any(|f| f.part.as_deref() == Some(part)));
        assert_eq!(serde_json::to_value(model.view()).unwrap()["object"]["picture"]["widthPt"], 35.0);
        assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), after);
        assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), resized);
    }
    if let Some(out) = std::env::var_os("GEUL_STAGE3A_STORY_OUT") {
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("a-p5-story-original.docx"), original).unwrap();
        std::fs::write(out.join("a-p5-story-layout.json"), serde_json::to_vec(&positions).unwrap()).unwrap();
    }
}

#[test]
fn stage3a_resizes_noncanonical_docx_story_picture_extents_losslessly() {
    use super::engine::ObjectEdit;
    use crate::document::Format;
    use crate::document::testutil::{entry, zip};
    use crate::services::save::{package, service};
    use wordcraft_engine::doc::{para_block, props::CharProps, Paragraph, PartKind, StoryRef};
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source.run("insert.picture", &json!({ "data": tiny_png_b64(2, 2, [140, 90, 40]) })).unwrap();
    source.run("picture.size", &json!({ "width": 28, "height": 22 })).unwrap();
    let (_, picture) = wordcraft_engine::cmd::objects::selected(&source).unwrap();
    let props = CharProps::default();
    let mut story_ids = Vec::new();
    for (kind, label) in [(PartKind::Header, "header"), (PartKind::Footer, "footer")] {
        let id = source.doc.add_part(kind, Vec::new());
        let mut para = Paragraph::with_text(&format!("{label} "), props.clone());
        let mut story_picture = picture.clone();
        story_picture.set_alt_text(label);
        para.insert_object(para.len(), story_picture, &props).unwrap();
        source.doc.set_story(StoryRef::Part(id), vec![para_block(para)]).unwrap();
        match kind {
            PartKind::Header => source.doc.last_section.headers.default = Some(id),
            PartKind::Footer => source.doc.last_section.footers.default = Some(id),
            _ => unreachable!(),
        }
        story_ids.push((kind, id, label));
    }
    let draft = io::save_bytes("story.docx", &source.doc).unwrap();
    let canonical = io::save_bytes("story.docx", &io::open_bytes("story.docx", &draft).unwrap()).unwrap();
    let source_package = package::open(&canonical, package::Side::Original).unwrap();
    let mut entries = Vec::new();
    for name in &source_package.order {
        let mut data = source_package.get(name).unwrap().to_vec();
        if name == "word/header1.xml" {
            let xml = std::str::from_utf8(&data).unwrap();
            let original = r#"<a:ext cx="355600" cy="279400"/>"#;
            assert_eq!(xml.matches(original).count(), 1, "expected one header picture transform extent");
            data = xml.replace(original, r#"<a:ext cx="711200" cy="558800"/>"#).into_bytes();
        }
        entries.push(entry(name, &data));
    }
    let noncanonical = zip(&entries, false);
    let original_package = package::open(&noncanonical, package::Side::Original).unwrap();
    let original_header = std::str::from_utf8(original_package.get("word/header1.xml").unwrap()).unwrap();
    assert!(original_header.contains(r#"<wp:extent cx="355600" cy="279400"/>"#));
    assert!(original_header.contains(r#"<a:ext cx="711200" cy="558800"/>"#));
    let original_footer = original_package.get("word/footer1.xml").unwrap().to_vec();

    let mut view_session = Session::new(io::open_bytes("story.docx", &noncanonical).unwrap());
    let layout = view_session.layout();
    let (_, header_id, _) = story_ids.iter().find(|(kind, _, _)| *kind == PartKind::Header).unwrap();
    let header_hit = layout.find_object(0, |object| object.story == StoryRef::Part(*header_id)).unwrap();
    let mut model = DocxModel::open(&noncanonical).unwrap();
    let click = DocxOp::Pointer {
        page: header_hit.page as u32,
        x: header_hit.rect.x + header_hit.rect.w / 2.0,
        y: header_hit.rect.y + header_hit.rect.h / 2.0,
        extend: false,
        before_insert: false,
        drag: false,
        select_object: true,
    };
    let initial_export = model.export().unwrap();
    assert!(crate::services::save::docx_story_drawings::resize_source_supported(&noncanonical, &initial_export, 2));
    let initial_package = package::open(&initial_export, package::Side::Output).unwrap();
    assert_eq!(original_package.get("word/header1.xml"), initial_package.get("word/header1.xml"));
    assert_eq!(original_package.get("word/footer1.xml"), initial_package.get("word/footer1.xml"));
    assert_eq!(model.apply(&[click]).changed, 0);
    let selected = serde_json::to_value(model.view()).unwrap();
    assert!(selected["object"]["operations"].as_array().unwrap().contains(&json!("resize")),
        "a noncanonical header extent pair should keep resize available");
    let before = model.export().unwrap();
    let edit = DocxOp::ObjectEdit {
        position: selected["object"]["position"].as_str().unwrap().into(),
        epoch: selected["object"]["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::Bounds { x: None, y: None, width: Some(35.0), height: Some(27.5) },
    };
    assert_eq!(model.apply(&[edit]).changed, 1, "noncanonical owned picture resize refused");
    let resized = model.export().unwrap();
    assert!(model.same_as(&resized));
    let reopened = DocxModel::open(&resized).unwrap();
    assert!(reopened.same_as(&resized), "a fresh model must accept the saved story-picture transform");
    assert!(service::check_saved(Format::Docx, &noncanonical, &resized, None, true).is_safe());
    let after_package = package::open(&resized, package::Side::Output).unwrap();
    let before_xml = std::str::from_utf8(original_package.get("word/header1.xml").unwrap()).unwrap();
    let expected = before_xml
        .replace(r#"<wp:extent cx="355600" cy="279400"/>"#, r#"<wp:extent cx="444500" cy="349250"/>"#)
        .replace(r#"<a:ext cx="711200" cy="558800"/>"#, r#"<a:ext cx="889000" cy="698500"/>"#);
    assert_eq!(after_package.get("word/header1.xml"), Some(expected.as_bytes()));
    assert_eq!(after_package.get("word/footer1.xml"), Some(original_footer.as_slice()));
    for name in original_package.parts.keys().filter(|name| name.as_str() != "word/header1.xml") {
        assert_eq!(original_package.get(name), after_package.get(name), "unrelated part changed: {name}");
    }
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), before);
    assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), resized);

    let mut unauthorized = package::open(&resized, package::Side::Output).unwrap();
    let (_, header) = unauthorized.parts.get_mut("word/header1.xml").unwrap();
    let xml = std::str::from_utf8(header).unwrap();
    let wrong_inner = xml.replace(r#"<a:ext cx="889000" cy="698500"/>"#, r#"<a:ext cx="889001" cy="698500"/>"#);
    assert_ne!(wrong_inner, xml);
    *header = wrong_inner.into_bytes();
    let unauthorized_entries: Vec<_> = unauthorized.order.iter().map(|name| {
        entry(name, unauthorized.get(name).unwrap())
    }).collect();
    assert!(!service::check_saved(Format::Docx, &noncanonical, &zip(&unauthorized_entries, false), None, true).is_safe(),
        "a changed inner extent with no corresponding size transform must be rejected");
}

#[test]
fn stage3a_deletes_docx_pictures_from_owned_stories() {
    use super::engine::ObjectEdit;
    use crate::document::Format;
    use crate::services::save::{package, service};
    use wordcraft_engine::doc::{
        para::NoteKind, para_block, props::CharProps, table::Table, Block, InlineObject, Paragraph,
        PartKind, StoryRef,
    };
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run(
            "insert.picture",
            &json!({ "data": tiny_png_b64(2, 2, [140, 90, 40]) }),
        )
        .unwrap();
    source
        .run("picture.size", &json!({ "width": 28, "height": 22 }))
        .unwrap();
    let (_, picture) = wordcraft_engine::cmd::objects::selected(&source).unwrap();
    let stories = [
        (PartKind::Header, "header", None, "word/header1.xml"),
        (PartKind::Footer, "footer", None, "word/footer1.xml"),
        (
            PartKind::Footnote,
            "footnote",
            Some(NoteKind::Footnote),
            "word/footnotes.xml",
        ),
        (
            PartKind::Endnote,
            "endnote",
            Some(NoteKind::Endnote),
            "word/endnotes.xml",
        ),
    ];
    for (kind, label, note, _) in stories {
        let id = source.doc.add_part(kind, Vec::new());
        let mut para = Paragraph::with_text(&format!("{label} text "), CharProps::default());
        if matches!(kind, PartKind::Footnote | PartKind::Endnote) {
            let note_kind = note.unwrap();
            let marker = InlineObject::NoteRef {
                kind: note_kind,
                id,
                custom: String::new(),
            };
            para.insert_object(0, marker.clone(), &CharProps::default())
                .unwrap();
            let end = source.doc.end_of(StoryRef::Body);
            source.doc.insert_object(&end, marker, &CharProps::default()).unwrap();
        }
        let mut owned_picture = picture.clone();
        owned_picture.set_alt_text(label);
        para.insert_object(para.len(), owned_picture, &CharProps::default())
            .unwrap();
        let blocks = if kind == PartKind::Footer {
            let mut table = Table::new(1, 1, 180.0);
            table.rows[0].cells[0].blocks = vec![para_block(para)];
            vec![std::sync::Arc::new(Block::Table(table))]
        } else {
            vec![para_block(para)]
        };
        source.doc.set_story(StoryRef::Part(id), blocks).unwrap();
        match kind {
            PartKind::Header => source.doc.last_section.headers.default = Some(id),
            PartKind::Footer => source.doc.last_section.footers.default = Some(id),
            _ => {}
        }
    }
    let draft = io::save_bytes("story-delete.docx", &source.doc).unwrap();
    let original = io::save_bytes(
        "story-delete.docx",
        &io::open_bytes("story-delete.docx", &draft).unwrap(),
    )
    .unwrap();
    let original_package = package::open(&original, package::Side::Original).unwrap();
    let mut model = DocxModel::open(&original).unwrap();
    let baseline = model.export().unwrap();
    assert!(model.same_as(&baseline));
    let mut snapshots = vec![baseline.clone()];
    let mut changed_parts: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for (kind, label, _, part) in stories {
        let current = model.export().unwrap();
        let mut reader = Session::new(io::open_bytes("story-delete.docx", &current).unwrap());
        let layout = reader.layout();
        let id = *reader
            .doc
            .parts
            .iter()
            .find(|(_, part)| part.kind == kind)
            .unwrap()
            .0;
        let story = StoryRef::Part(id);
        let hit = layout
            .find_object(0, |object| object.story == story)
            .unwrap_or_else(|| panic!("missing owned {label} picture"));
        let click = DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        };
        assert_eq!(model.apply(&[click]).changed, 0);
        let selected = serde_json::to_value(model.view()).unwrap()["object"].clone();
        assert!(
            selected["operations"]
                .as_array()
                .is_some_and(|operations| operations.iter().any(|operation| operation == "delete")),
            "{label} picture deletion is unavailable: {:#}",
            selected["operations"]
        );
        let position = selected["position"].as_str().unwrap().to_owned();
        if kind == PartKind::Footer {
            assert!(position.starts_with(&format!("part{id}:")));
            let path = position.split(':').nth(1).unwrap();
            assert!(path.split('.').count() > 1, "footer fixture picture must be table-owned: {position}");
        }
        let epoch = selected["epoch"].as_u64().unwrap();
        let undo_before_rejection = model.view().history.undo;
        let wrong_owner = DocxOp::ObjectEdit {
            position: "body:0:0".into(),
            epoch,
            edit: ObjectEdit::Delete {},
        };
        let stale = DocxOp::ObjectEdit {
            position: position.clone(),
            epoch: epoch.saturating_sub(1),
            edit: ObjectEdit::Delete {},
        };
        assert_eq!(model.apply(&[wrong_owner, stale]).rejected, vec![0, 1]);
        assert_eq!(model.export().unwrap(), current);
        assert_eq!(model.view().history.undo, undo_before_rejection);

        let deleted = model.apply(&[DocxOp::ObjectEdit {
            position,
            epoch,
            edit: ObjectEdit::Delete {},
        }]);
        assert_eq!(deleted.changed, 1, "{label} picture delete failed");
        assert!(serde_json::to_value(model.view()).unwrap()["object"].is_null());
        let after = model.export().unwrap();
        assert!(model.same_as(&after));
        assert!(
            service::check_saved(Format::Docx, &original, &after, None, true).is_safe(),
            "{label} picture T009 rejection"
        );
        let output_package = package::open(&after, package::Side::Output).unwrap();
        let missing_parts: std::collections::BTreeSet<_> = original_package
            .parts
            .keys()
            .filter(|name| !output_package.parts.contains_key(*name))
            .map(|name| name.as_str())
            .collect();
        let added_parts: std::collections::BTreeSet<_> = output_package
            .parts
            .keys()
            .filter(|name| !original_package.parts.contains_key(*name))
            .map(|name| name.as_str())
            .collect();
        assert!(added_parts.is_empty(), "story deletion added OPC parts: {added_parts:?}");
        assert!(
            missing_parts.iter().all(|name| name.ends_with(".rels")
                && changed_parts.iter().copied().chain(std::iter::once(part)).any(|part| {
                    let Some((directory, filename)) = part.rsplit_once('/') else {
                        return false;
                    };
                    format!("{directory}/_rels/{filename}.rels") == *name
                })),
            "only an empty relationship part for an already deleted story picture may be removed: {missing_parts:?}"
        );
        assert_eq!(
            original_package.get("word/document.xml"),
            output_package.get("word/document.xml"),
            "story deletion preserves body content and all note references"
        );
        for name in original_package.parts.keys().filter(|name| {
            name.ends_with(".rels") || name.starts_with("word/media/")
        }) {
            if missing_parts.contains(name.as_str()) {
                continue;
            }
            assert_eq!(original_package.get(name), output_package.get(name),
                "story deletion preserves surviving relationship/media resource {name}");
        }
        changed_parts.insert(part);
        for name in original_package.parts.keys().filter(|name| {
            !changed_parts.contains(name.as_str())
                && !missing_parts.contains(name.as_str())
                && name.as_str() != "docProps/app.xml"
        }) {
            assert_eq!(
                original_package.get(name),
                output_package.get(name),
                "unrelated OPC part changed: {name}"
            );
        }
        let reopened = io::open_bytes("story-delete.docx", &after).unwrap();
        let story = reopened.parts.get(&id).expect("same story owner reopens");
        assert!(story.blocks.iter().any(|block| block.as_table().is_some()) || kind != PartKind::Footer);
        let paragraphs = reopened
            .para_paths(StoryRef::Part(id))
            .into_iter()
            .map(|path| reopened.para(StoryRef::Part(id), &path).unwrap())
            .collect::<Vec<_>>();
        assert!(paragraphs.iter().any(|para| para.text_without(&[]).contains(&format!("{label} text"))));
        assert!(paragraphs.iter().all(|para| {
            para.object_offsets().iter().all(|&off| {
                !matches!(para.object_at(off), Some(InlineObject::Image { .. }))
            })
        }), "deleted {label} picture remains in its owning story");
        assert!(reopened.media.len() >= 1, "shared body media must remain");
        snapshots.push(after);
    }

    assert_eq!(changed_parts.len(), 4);
    for index in (0..stories.len()).rev() {
        assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), snapshots[index]);
    }
    for snapshot in snapshots.iter().skip(1) {
        assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), *snapshot);
    }
    let final_bytes = snapshots.last().unwrap();
    assert!(
        service::check_saved(Format::Docx, &original, final_bytes, None, true).is_safe(),
        "combined header/footer/footnote/endnote deletion must pass the final T009 save"
    );
    let mut unauthorized = package::open(final_bytes, package::Side::Output).unwrap();
    let (_, bytes) = unauthorized.parts.get_mut("word/footer1.xml").unwrap();
    let footer = std::str::from_utf8(bytes).unwrap();
    assert!(footer.contains("footer text"));
    *bytes = footer
        .replacen("footer text", "footer altered", 1)
        .into_bytes();
    assert!(
        package::compare_saved_docx(&original_package, &unauthorized)
            .iter()
            .any(|finding| finding.part.as_deref() == Some("word/footer1.xml")),
        "T009 must reject unrelated footer text changes combined with deletion"
    );
    let mut changed_media = package::open(final_bytes, package::Side::Output).unwrap();
    let media = changed_media
        .parts
        .keys()
        .find(|name| name.starts_with("word/media/"))
        .unwrap()
        .clone();
    let (_, bytes) = changed_media.parts.get_mut(&media).unwrap();
    bytes.push(0);
    assert!(
        package::compare_saved_docx(&original_package, &changed_media)
            .iter()
            .any(|finding| finding.part.as_deref() == Some(media.as_str())),
        "T009 must reject mutation of a media resource still shared with the body"
    );
}

#[test]
fn stage3a_moves_docx_pictures_within_owned_headers_and_footers() {
    use super::engine::ObjectEdit;
    use crate::document::Format;
    use crate::services::save::{package, service};
    use wordcraft_engine::doc::{
        para_block, props::CharProps, InlineObject, Paragraph, PartKind, StoryRef,
    };
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run(
            "insert.picture",
            &json!({ "data": tiny_png_b64(2, 2, [140, 90, 40]) }),
        )
        .unwrap();
    source
        .run("picture.size", &json!({ "width": 28, "height": 22 }))
        .unwrap();
    let (_, picture) = wordcraft_engine::cmd::objects::selected(&source).unwrap();
    let stories = [
        (PartKind::Header, "header", "word/header1.xml"),
        (PartKind::Footer, "footer", "word/footer1.xml"),
    ];
    for (kind, label, _) in stories {
        let id = source.doc.add_part(kind, Vec::new());
        let mut first = Paragraph::with_text(&format!("{label} source "), CharProps::default());
        let picture_props = CharProps {
            size: Some(24.0),
            italic: Some(true),
            ..CharProps::default()
        };
        first
            .insert_object(first.len(), picture.clone(), &picture_props)
            .unwrap();
        let second = Paragraph::with_text(
            &format!("{label} destination paragraph"),
            CharProps::default(),
        );
        source
            .doc
            .set_story(
                StoryRef::Part(id),
                vec![para_block(first), para_block(second)],
            )
            .unwrap();
        match kind {
            PartKind::Header => source.doc.last_section.headers.default = Some(id),
            PartKind::Footer => source.doc.last_section.footers.default = Some(id),
            _ => unreachable!(),
        }
    }
    let draft = io::save_bytes("header-footer-move.docx", &source.doc).unwrap();
    let original = io::save_bytes(
        "header-footer-move.docx",
        &io::open_bytes("header-footer-move.docx", &draft).unwrap(),
    )
    .unwrap();
    let original_package = package::open(&original, package::Side::Original).unwrap();
    let baseline = Session::new(io::open_bytes("header-footer-move.docx", &original).unwrap());
    let mut composite = DocxModel::open(&original).unwrap();
    let mut first_move = None;

    for (kind, label, part) in stories {
        let current = composite.export().unwrap();
        let mut reader = Session::new(io::open_bytes("header-footer-move.docx", &current).unwrap());
        let layout = reader.layout();
        let id = *reader
            .doc
            .parts
            .iter()
            .find(|(_, data)| data.kind == kind)
            .unwrap()
            .0;
        let story = StoryRef::Part(id);
        let hit = layout
            .find_object(0, |object| object.story == story)
            .expect("header/footer picture is displayed in its owning part");
        let destination = (hit.page, hit.rect.x + 18.0, hit.rect.y + 12.0);
        let click = DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        };
        assert_eq!(composite.apply(&[click]).changed, 0);
        let object = serde_json::to_value(composite.view()).unwrap()["object"].clone();
        assert!(
            object["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|operation| operation == "move"),
            "{label}: {:#}",
            object["operations"]
        );
        let position = object["position"].as_str().unwrap().to_owned();
        let epoch = object["epoch"].as_u64().unwrap();
        let undo_before_invalid = composite.view().history.undo;
        let invalid = DocxOp::ObjectEdit {
            position: position.clone(),
            epoch,
            edit: ObjectEdit::Bounds {
                x: Some(destination.1),
                y: Some(destination.2),
                width: Some(30.0),
                height: None,
            },
        };
        assert_eq!(composite.apply(&[invalid]).rejected, vec![0]);
        assert_eq!(composite.export().unwrap(), current);
        assert_eq!(composite.view().history.undo, undo_before_invalid);
        let movement = DocxOp::ObjectEdit {
            position,
            epoch,
            edit: ObjectEdit::Bounds {
                x: Some(destination.1),
                y: Some(destination.2),
                width: None,
                height: None,
            },
        };
        assert_eq!(
            composite.apply(&[movement]).changed,
            1,
            "{label} movement failed"
        );
        if kind == PartKind::Header {
            first_move = Some(composite.export().unwrap());
        }
        assert!(
            service::check_saved(
                Format::Docx,
                &original,
                &composite.export().unwrap(),
                None,
                true,
            )
            .is_safe(),
            "{label} T009 rejection"
        );
        let output_package =
            package::open(&composite.export().unwrap(), package::Side::Output).unwrap();
        assert_ne!(original_package.get(part), output_package.get(part));
    }

    let combined = composite.export().unwrap();
    assert!(composite.same_as(&combined));
    let after_header = first_move.expect("header movement was applied first");
    assert_eq!(composite.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), after_header);
    assert_eq!(composite.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), original);
    assert_eq!(composite.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), after_header);
    assert_eq!(composite.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), combined);
    assert!(
        service::check_saved(Format::Docx, &original, &combined, None, true).is_safe(),
        "T009 must independently prove movements in linked header and footer parts"
    );

    let output_package = package::open(&combined, package::Side::Output).unwrap();
    assert_eq!(
        original_package.parts.keys().collect::<Vec<_>>(),
        output_package.parts.keys().collect::<Vec<_>>(),
        "header/footer movement cannot change the OPC inventory"
    );
    assert_eq!(
        original_package.get("word/document.xml"),
        output_package.get("word/document.xml"),
        "header/footer references and the body stay byte-identical"
    );
    for name in original_package
        .parts
        .keys()
        .filter(|name| !stories.iter().any(|(_, _, part)| *part == name.as_str()))
    {
        assert_eq!(
            original_package.get(name),
            output_package.get(name),
            "unrelated OPC part changed: {name}"
        );
    }
    for (kind, label, _) in stories {
        let id = *baseline
            .doc
            .parts
            .iter()
            .find(|(_, data)| data.kind == kind)
            .unwrap()
            .0;
        let reopened = io::open_bytes("header-footer-move.docx", &combined).unwrap();
        let story = reopened.parts.get(&id).expect("same owning part reopens");
        let paragraph = story.blocks[0].as_para().expect("source paragraph remains");
        let moved_off = paragraph
            .object_offsets()
            .into_iter()
            .find(|&off| matches!(paragraph.object_at(off), Some(InlineObject::Image { .. })))
            .expect("picture remains in its header/footer owner");
        assert_eq!(paragraph.props_of_char(moved_off).size, Some(24.0));
        assert_eq!(paragraph.props_of_char(moved_off).italic, Some(true));
        assert!(
            matches!(paragraph.object_at(moved_off), Some(InlineObject::Image { float, .. })
            if float.wrap == wordcraft_engine::doc::para::Wrap::Square),
            "{label}"
        );

        let mut reopened_reader =
            Session::new(io::open_bytes("header-footer-move.docx", &combined).unwrap());
        let reopened_hit = reopened_reader
            .layout()
            .find_object(0, |object| object.story == StoryRef::Part(id))
            .expect("saved header/footer picture reopens in its original story");
        let reopened_click = DocxOp::Pointer {
            page: reopened_hit.page as u32,
            x: reopened_hit.rect.x + reopened_hit.rect.w / 2.0,
            y: reopened_hit.rect.y + reopened_hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        };
        let mut reopened_model = DocxModel::open(&combined).unwrap();
        assert_eq!(reopened_model.apply(&[reopened_click]).changed, 0);
        let reopened_object =
            serde_json::to_value(reopened_model.view()).unwrap()["object"].clone();
        assert!(
            reopened_object
                .get("operations")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|operations| operations.iter().any(|operation| operation == "move")),
            "saved H/F anchor remains movable: {reopened_object:#}"
        );
        let nudge = DocxOp::ObjectEdit {
            position: reopened_object["position"].as_str().unwrap().into(),
            epoch: reopened_object["epoch"].as_u64().unwrap(),
            edit: ObjectEdit::Bounds {
                x: Some(reopened_hit.rect.x + 5.0),
                y: Some(reopened_hit.rect.y + 5.0),
                width: None,
                height: None,
            },
        };
        assert_eq!(
            reopened_model.apply(&[nudge]).changed,
            1,
            "saved H/F anchor can move again"
        );
        let moved_again = reopened_model.export().unwrap();
        assert!(reopened_model.same_as(&moved_again));
        assert!(service::check_saved(Format::Docx, &combined, &moved_again, None, true).is_safe());
    }

    let mut unauthorized = package::open(&combined, package::Side::Output).unwrap();
    let (_, bytes) = unauthorized.parts.get_mut("word/footer1.xml").unwrap();
    let xml = std::str::from_utf8(bytes).unwrap();
    assert!(xml.contains("footer destination paragraph"));
    *bytes = xml
        .replacen(
            "footer destination paragraph",
            "footer altered paragraph",
            1,
        )
        .into_bytes();
    assert!(
        package::compare_saved_docx(&original_package, &unauthorized)
            .iter()
            .any(|finding| finding.part.as_deref() == Some("word/footer1.xml")),
        "T009 rejects a movement combined with unrelated footer text changes"
    );
}

#[test]
fn stage3a_moves_docx_pictures_within_owned_notes() {
    use super::engine::ObjectEdit;
    use crate::document::Format;
    use crate::services::save::{package, service};
    use wordcraft_engine::doc::{
        para::NoteKind, para_block, props::CharProps, InlineObject, Paragraph, PartKind, Path,
        StoryRef,
    };
    use wordcraft_engine::{io, Session};

    let mut source = Session::new(io::open_bytes("fixture.docx", &fixture()).unwrap());
    source.run("caret.docEnd", &json!({})).unwrap();
    source.run("text.newParagraph", &json!({})).unwrap();
    source
        .run(
            "insert.picture",
            &json!({ "data": tiny_png_b64(2, 2, [140, 90, 40]) }),
        )
        .unwrap();
    source
        .run("picture.size", &json!({ "width": 28, "height": 22 }))
        .unwrap();
    let (_, picture) = wordcraft_engine::cmd::objects::selected(&source).unwrap();
    let stories = [
        (
            PartKind::Footnote,
            NoteKind::Footnote,
            "footnote",
            "word/footnotes.xml",
        ),
        (
            PartKind::Endnote,
            NoteKind::Endnote,
            "endnote",
            "word/endnotes.xml",
        ),
    ];
    for (part_kind, note_kind, label, _) in stories {
        let id = source.doc.add_part(part_kind, Vec::new());
        let marker = InlineObject::NoteRef {
            kind: note_kind,
            id,
            custom: String::new(),
        };
        let body_end = source.doc.end_of(StoryRef::Body);
        source
            .doc
            .insert_object(&body_end, marker, &CharProps::default())
            .unwrap();
        let mut first = Paragraph::with_text(&format!("{label} source "), CharProps::default());
        let picture_props = CharProps {
            size: Some(24.0),
            italic: Some(true),
            ..CharProps::default()
        };
        first
            .insert_object(first.len(), picture.clone(), &picture_props)
            .unwrap();
        let second = Paragraph::with_text(
            &format!("{label} destination paragraph"),
            CharProps::default(),
        );
        source
            .doc
            .set_story(
                StoryRef::Part(id),
                vec![para_block(first), para_block(second)],
            )
            .unwrap();
    }
    let draft = io::save_bytes("note-move.docx", &source.doc).unwrap();
    let original = io::save_bytes(
        "note-move.docx",
        &io::open_bytes("note-move.docx", &draft).unwrap(),
    )
    .unwrap();
    let mut baseline = Session::new(io::open_bytes("note-move.docx", &original).unwrap());
    let layout = baseline.layout();

    for (part_kind, _, label, part) in stories {
        let id = *baseline
            .doc
            .parts
            .iter()
            .find(|(_, data)| data.kind == part_kind)
            .unwrap()
            .0;
        let story = StoryRef::Part(id);
        let hit = layout
            .find_object(0, |object| object.story == story)
            .expect("note picture is laid out in its owning note");
        let destination = layout
            .pages
            .iter()
            .enumerate()
            .find_map(|(page, placed)| {
                placed.items.iter().find_map(|item| match item {
                    wordcraft_engine::layout::Placed::Lines {
                        story: owner,
                        path,
                        l0: 0,
                        x,
                        y,
                        ..
                    } if *owner == story && *path == Path::top(1) => Some((page, *x, *y)),
                    _ => None,
                })
            })
            .expect("second note paragraph is laid out");
        let click = DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        };
        let mut model = DocxModel::open(&original).unwrap();
        assert_eq!(model.apply(&[click]).changed, 0);
        let object = serde_json::to_value(model.view()).unwrap()["object"].clone();
        assert_eq!(
            object["position"].as_str().unwrap().split(':').next(),
            Some(format!("part{id}").as_str())
        );
        assert!(
            object["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|operation| operation == "move"),
            "{label}: {:#}",
            object["operations"]
        );
        let position = object["position"].as_str().unwrap().to_owned();
        let epoch = object["epoch"].as_u64().unwrap();
        let before = model.export().unwrap();
        let left = package::open(&before, package::Side::Original).unwrap();
        let invalid = DocxOp::ObjectEdit {
            position: position.clone(),
            epoch,
            edit: ObjectEdit::Bounds {
                x: Some(destination.1),
                y: Some(destination.2),
                width: Some(30.0),
                height: None,
            },
        };
        assert_eq!(
            model.apply(&[invalid]).rejected,
            vec![0],
            "move and resize cannot be combined for a note picture"
        );
        assert_eq!(model.export().unwrap(), before);
        assert!(!model.view().history.undo);

        let move_picture = DocxOp::ObjectEdit {
            position,
            epoch,
            edit: ObjectEdit::Bounds {
                x: Some(destination.1),
                y: Some(destination.2),
                width: None,
                height: None,
            },
        };
        assert_eq!(
            model.apply(&[move_picture]).changed,
            1,
            "{label} move rejected"
        );
        let after = model.export().unwrap();
        assert!(model.same_as(&after));
        assert!(
            service::check_saved(Format::Docx, &before, &after, None, true).is_safe(),
            "{label} T009 rejection"
        );
        let right = package::open(&after, package::Side::Output).unwrap();
        assert_eq!(
            left.parts.keys().collect::<Vec<_>>(),
            right.parts.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            left.get("word/document.xml"),
            right.get("word/document.xml"),
            "note references and body drawings stay byte-identical"
        );
        assert_eq!(
            left.get("word/_rels/document.xml.rels"),
            right.get("word/_rels/document.xml.rels")
        );
        assert!(
            left.get(part) != right.get(part),
            "only the note story contains the movement"
        );
        for name in left.parts.keys().filter(|name| name.as_str() != part) {
            assert_eq!(
                left.get(name),
                right.get(name),
                "unrelated OPC part changed: {name}"
            );
        }

        let reopened = io::open_bytes("note-move.docx", &after).unwrap();
        let moved = reopened.parts.get(&id).expect("same note id reopens");
        let second = match moved.blocks[1].as_ref() {
            wordcraft_engine::doc::Block::Para(para) => para,
            _ => panic!("note target paragraph changed shape"),
        };
        let moved_off = second
            .object_offsets()
            .into_iter()
            .find(|&off| matches!(second.object_at(off), Some(InlineObject::Image { .. })))
            .expect("picture is in the selected note's second paragraph");
        assert_eq!(second.props_of_char(moved_off).size, Some(24.0));
        assert_eq!(second.props_of_char(moved_off).italic, Some(true));
        assert!(
            matches!(second.object_at(moved_off), Some(InlineObject::Image { float, .. })
            if float.wrap == wordcraft_engine::doc::para::Wrap::Square)
        );
        assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), before);
        assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
        assert_eq!(model.export().unwrap(), after);

        let mut reopened_reader = Session::new(io::open_bytes("note-move.docx", &after).unwrap());
        let reopened_hit = reopened_reader.layout().find_object(0, |object| object.story == story)
            .expect("saved note picture reopens in the same story");
        let reopened_click = DocxOp::Pointer { page: reopened_hit.page as u32,
            x: reopened_hit.rect.x + reopened_hit.rect.w / 2.0,
            y: reopened_hit.rect.y + reopened_hit.rect.h / 2.0,
            extend: false, before_insert: false, drag: false, select_object: true };
        let mut reopened_model = DocxModel::open(&after).unwrap();
        assert_eq!(reopened_model.apply(&[reopened_click]).changed, 0);
        let reopened_object = serde_json::to_value(reopened_model.view()).unwrap()["object"].clone();
        assert!(reopened_object["operations"].as_array().unwrap().iter().any(|operation| operation == "move"),
            "saved square anchor remains safely movable");
        let reopened_position = reopened_object["position"].as_str().unwrap().to_owned();
        let reopened_epoch = reopened_object["epoch"].as_u64().unwrap();
        let nudge = DocxOp::ObjectEdit { position: reopened_position, epoch: reopened_epoch,
            edit: ObjectEdit::Bounds { x: Some(reopened_hit.rect.x + 5.0), y: Some(reopened_hit.rect.y + 5.0), width: None, height: None } };
        assert_eq!(reopened_model.apply(&[nudge]).changed, 1, "a saved note anchor can move again");
        let moved_again = reopened_model.export().unwrap();
        assert!(reopened_model.same_as(&moved_again));
        assert!(service::check_saved(Format::Docx, &after, &moved_again, None, true).is_safe());

        let mut collateral = package::open(&after, package::Side::Output).unwrap();
        let (_, bytes) = collateral.parts.get_mut(part).unwrap();
        let xml = std::str::from_utf8(bytes).unwrap();
        let source_text = format!("{label} destination paragraph");
        let changed_text = format!("{label} altered paragraph");
        assert!(xml.contains(&source_text));
        *bytes = xml.replacen(&source_text, &changed_text, 1).into_bytes();
        assert!(
            package::compare_saved_docx(&left, &collateral)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(part)),
            "T009 rejects a move combined with unrelated note-text mutation"
        );

        let mut unsafe_wrap = package::open(&after, package::Side::Output).unwrap();
        let (_, bytes) = unsafe_wrap.parts.get_mut(part).unwrap();
        let xml = std::str::from_utf8(bytes).unwrap();
        assert!(xml.contains("wrapText=\"bothSides\""));
        *bytes = xml
            .replacen("wrapText=\"bothSides\"", "wrapText=\"left\"", 1)
            .into_bytes();
        assert!(
            package::compare_saved_docx(&left, &unsafe_wrap)
                .iter()
                .any(|finding| finding.part.as_deref() == Some(part)),
            "T009 rejects an unsupported note picture wrap change"
        );
    }

    // The Native scenario publishes both moves in one document revision. Exercise that exact
    // transaction: separate per-part checks do not prove the combined OPC comparison admits it.
    let mut composite = DocxModel::open(&original).unwrap();
    let mut after_footnote = None;
    for (part_kind, _, label, _) in stories {
        let current = composite.export().unwrap();
        let mut reader = Session::new(io::open_bytes("note-move.docx", &current).unwrap());
        let layout = reader.layout();
        let id = *baseline
            .doc
            .parts
            .iter()
            .find(|(_, data)| data.kind == part_kind)
            .unwrap()
            .0;
        let story = StoryRef::Part(id);
        let hit = layout
            .find_object(0, |object| object.story == story)
            .expect("composite note picture remains in its owner");
        let destination = layout
            .pages
            .iter()
            .enumerate()
            .find_map(|(page, placed)| {
                placed.items.iter().find_map(|item| match item {
                    wordcraft_engine::layout::Placed::Lines {
                        story: owner,
                        path,
                        l0: 0,
                        x,
                        y,
                        ..
                    } if *owner == story && *path == Path::top(1) => Some((page, *x, *y)),
                    _ => None,
                })
            })
            .expect("composite note target paragraph is laid out");
        let click = DocxOp::Pointer {
            page: hit.page as u32,
            x: hit.rect.x + hit.rect.w / 2.0,
            y: hit.rect.y + hit.rect.h / 2.0,
            extend: false,
            before_insert: false,
            drag: false,
            select_object: true,
        };
        assert_eq!(composite.apply(&[click]).changed, 0);
        let object = serde_json::to_value(composite.view()).unwrap()["object"].clone();
        let position = object["position"].as_str().unwrap().to_owned();
        let epoch = object["epoch"].as_u64().unwrap();
        let movement = DocxOp::ObjectEdit {
            position,
            epoch,
            edit: ObjectEdit::Bounds {
                x: Some(destination.1),
                y: Some(destination.2),
                width: None,
                height: None,
            },
        };
        assert_eq!(composite.apply(&[movement]).changed, 1, "{label} composite move rejected");
        if part_kind == PartKind::Footnote {
            after_footnote = Some(composite.export().unwrap());
        }
    }
    let combined = composite.export().unwrap();
    assert!(composite.same_as(&combined));
    let after_footnote = after_footnote.expect("footnote movement was applied first");
    assert_eq!(composite.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), after_footnote);
    assert_eq!(composite.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), original);
    assert_eq!(composite.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), after_footnote);
    assert_eq!(composite.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(composite.export().unwrap(), combined);
    assert!(
        service::check_saved(Format::Docx, &original, &combined, None, true).is_safe(),
        "T009 must independently prove a footnote and endnote move in one save"
    );
    let original_package = package::open(&original, package::Side::Original).unwrap();
    let combined_package = package::open(&combined, package::Side::Output).unwrap();
    assert_eq!(
        original_package.parts.keys().collect::<Vec<_>>(),
        combined_package.parts.keys().collect::<Vec<_>>(),
        "composite note movement cannot change the OPC inventory"
    );
    for (part_kind, _, _, part) in stories {
        assert_ne!(original_package.get(part), combined_package.get(part));
        let id = *baseline
            .doc
            .parts
            .iter()
            .find(|(_, data)| data.kind == part_kind)
            .unwrap()
            .0;
        let reopened = io::open_bytes("note-move.docx", &combined).unwrap();
        let note = reopened.parts.get(&id).expect("the same note id must reopen");
        let target = match note.blocks[1].as_ref() {
            wordcraft_engine::doc::Block::Para(para) => para,
            _ => panic!("the composite note target paragraph changed shape"),
        };
        let moved = target
            .object_offsets()
            .into_iter()
            .find(|&off| matches!(target.object_at(off), Some(InlineObject::Image { .. })))
            .expect("both moved pictures reopen in their destination paragraph");
        assert_eq!(target.props_of_char(moved).size, Some(24.0));
        assert_eq!(target.props_of_char(moved).italic, Some(true));
    }
    for name in original_package.parts.keys().filter(|name| {
        name.as_str() != "word/footnotes.xml" && name.as_str() != "word/endnotes.xml"
    }) {
        assert_eq!(
            original_package.get(name),
            combined_package.get(name),
            "composite note movement changed unrelated OPC part: {name}"
        );
    }
    let mut unauthorized = package::open(&combined, package::Side::Output).unwrap();
    let (_, bytes) = unauthorized.parts.get_mut("word/endnotes.xml").unwrap();
    let xml = std::str::from_utf8(bytes).unwrap();
    assert!(xml.contains("endnote destination paragraph"));
    *bytes = xml
        .replacen("endnote destination paragraph", "unauthorized note text", 1)
        .into_bytes();
    assert!(
        !package::compare_saved_docx(&original_package, &unauthorized).is_empty(),
        "a valid footnote move cannot authorize unrelated endnote content changes"
    );
}

#[test]
fn stage3a_p6_docx_converts_canonical_round_rect_to_rect() {
    use crate::document::Format;
    use crate::services::save::{package, service};
    use super::engine::{BasicShape, ObjectEdit};
    use wordcraft_engine::doc::para::ShapeKind;
    use wordcraft_engine::{io, Session};

    const MAIN: &str = "word/document.xml";
    const RECT: &str = "prst=\"rect\"><a:avLst/>";
    const ROUND: &str = "prst=\"roundRect\"><a:avLst/>";
    let mut seed = model();
    seed.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph,
        DocxOp::Shape { kind: BasicShape::Rectangle }]);
    let seed = seed.export().unwrap();
    let package = package::open(&seed, package::Side::Original).unwrap();
    let body = std::str::from_utf8(package.get(MAIN).unwrap()).unwrap();
    assert_eq!(body.matches(RECT).count(), 1);
    let fixture = |geometry: &str| {
        let xml = body.replacen(RECT, geometry, 1);
        let entries = package.order.iter().map(|name| {
            let bytes = if name == MAIN { xml.as_bytes() } else { package.get(name).unwrap() };
            entry(name, bytes)
        }).collect::<Vec<_>>();
        zip(&entries, false)
    };
    let source = fixture(ROUND);
    let reader = io::open_bytes("rounded.docx", &source).unwrap();
    let mut reader = Session::new(reader);
    let hit = reader.layout().find_object(0, |object| object.rect.w == 108.0).unwrap();
    let select = DocxOp::Pointer {
        page: hit.page as u32, x: hit.rect.x + hit.rect.w / 2.0, y: hit.rect.y + hit.rect.h / 2.0,
        extend: false, before_insert: false, drag: false, select_object: true,
    };
    let selection = |model: &mut DocxModel| serde_json::to_value(model.view()).unwrap()["object"].clone();
    let request = |object: &serde_json::Value, position: &str| DocxOp::ObjectEdit {
        position: position.into(), epoch: object["epoch"].as_u64().unwrap(),
        edit: ObjectEdit::ConvertShape { to: BasicShape::Rectangle },
    };
    for unsupported in [
        "prst=\"round1Rect\"><a:avLst/>",
        "prst=\"roundRect\"><a:avLst><a:gd name=\"adj\" fmla=\"val 25000\"/></a:avLst>",
    ] {
        let mut rejected = DocxModel::open(&fixture(unsupported)).unwrap();
        rejected.apply(&[select.clone()]);
        let object = selection(&mut rejected);
        assert_eq!(object["kind"], "shape");
        assert!(object["convertShape"].is_null());
        let before = rejected.export().unwrap();
        assert_eq!(rejected.apply(&[request(&object, object["position"].as_str().unwrap())]).rejected, vec![0]);
        assert_eq!(rejected.export().unwrap(), before);
        assert_eq!(rejected.apply(&[DocxOp::Undo {}]).changed, 0);
    }
    let mut model = DocxModel::open(&source).unwrap();
    model.apply(&[select.clone()]);
    let object = selection(&mut model);
    assert_eq!(object["convertShape"], "rectangle");
    let before = model.export().unwrap();
    assert_eq!(model.apply(&[request(&object, "part0:0:0")]).rejected, vec![0]);
    assert_eq!(model.export().unwrap(), before);
    let edit = request(&object, object["position"].as_str().unwrap());
    assert_eq!(model.apply(&[edit.clone()]).changed, 1);
    assert_eq!(model.apply(&[edit]).rejected, vec![0]);
    let after = model.export().unwrap();
    assert!(model.same_as(&after));
    assert!(service::check_saved(Format::Docx, &source, &after, None, true).is_safe());
    let original = package::open(&source, package::Side::Original).unwrap();
    let saved = package::open(&after, package::Side::Output).unwrap();
    assert_eq!(original.parts.keys().collect::<Vec<_>>(), saved.parts.keys().collect::<Vec<_>>());
    for name in original.parts.keys().filter(|name| name.as_str() != MAIN) {
        assert_eq!(original.get(name), saved.get(name), "unrelated OPC part {name}");
    }
    assert_eq!(saved.get(MAIN), Some(body.as_bytes()));
    assert_eq!(model.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), before);
    assert_eq!(model.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(model.export().unwrap(), after);
    let reopened = io::open_bytes("rect.docx", &after).unwrap();
    assert!(reopened.body.iter().filter_map(|block| block.as_para()).any(|para| {
        para.objects.iter().any(|object| matches!(object, wordcraft_engine::doc::InlineObject::Shape {
            kind: ShapeKind::Rectangle, ..
        }))
    }));
    let mut reopened_model = DocxModel::open(&after).unwrap();
    reopened_model.apply(&[select]);
    assert_eq!(selection(&mut reopened_model)["convertShape"], "ellipse");
    if let Some(directory) = std::env::var_os("GEUL_STAGE3_OUT") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("a-p6-round-rect-original.docx"), &source).unwrap();
        std::fs::write(directory.join("a-p6-round-rect-edited.docx"), &after).unwrap();
    }
}

#[test]
fn stage3a_p6_docx_converts_plain_shapes_and_reopens_freeform_import() {
    use crate::document::Format;
    use crate::services::save::{package, service};
    use super::engine::{BasicShape, HwpxPolygon, ObjectEdit};
    use wordcraft_engine::doc::{para::ShapeKind, InlineObject, StoryRef};
    use wordcraft_engine::{io, Session};

    let mut m = model();
    assert_eq!(m.apply(&[mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph,
        DocxOp::Shape { kind: BasicShape::Rectangle }]).changed, 2);
    let original = m.export().unwrap();
    let mut reader = Session::new(io::open_bytes("p6.docx", &original).unwrap());
    let hit = reader.layout().find_object(0, |o| o.rect.w == 108.0).unwrap();
    let select = DocxOp::Pointer {
        page: hit.page as u32, x: hit.rect.x + hit.rect.w / 2.0, y: hit.rect.y + hit.rect.h / 2.0,
        extend: false, before_insert: false, drag: false, select_object: true,
    };
    assert!(m.apply(&[select.clone()]).rejected.is_empty());
    assert_eq!(serde_json::to_value(m.view()).unwrap()["object"]["convertShape"], "ellipse");
    let edit = |m: &mut DocxModel, to| {
        let view = serde_json::to_value(m.view()).unwrap();
        let object = &view["object"];
        let position = object["position"].as_str().unwrap().into();
        let epoch = object["epoch"].as_u64().unwrap();
        DocxOp::ObjectEdit { position, epoch, edit: ObjectEdit::ConvertShape { to } }
    };
    let same_type = edit(&mut m, BasicShape::Rectangle);
    assert_eq!(m.apply(&[same_type]).rejected, vec![0]);
    assert_eq!(m.export().unwrap(), original);
    let to_ellipse = edit(&mut m, BasicShape::Ellipse);
    assert_eq!(m.apply(&[to_ellipse]).changed, 1);
    let ellipse = m.export().unwrap();
    assert!(m.same_as(&ellipse));
    assert!(service::check_saved(Format::Docx, &original, &ellipse, None, true).is_safe());
    let before = package::open(&original, package::Side::Original).unwrap();
    let after = package::open(&ellipse, package::Side::Output).unwrap();
    let main = "word/document.xml";
    for name in before.parts.keys().filter(|name| name.as_str() != main) {
        assert_eq!(before.get(name), after.get(name));
    }
    let xml = std::str::from_utf8(before.get(main).unwrap()).unwrap();
    assert_eq!(xml.replacen("prst=\"rect\"", "prst=\"ellipse\"", 1).as_bytes(), after.get(main).unwrap());
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.export().unwrap(), original);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.export().unwrap(), ellipse);
    m.apply(&[select]);
    let to_rectangle = edit(&mut m, BasicShape::Rectangle);
    assert_eq!(m.apply(&[to_rectangle]).changed, 1);
    assert_eq!(m.export().unwrap(), original);

    m.apply(&[DocxOp::DeselectObject {}, mv(MoveTarget::DocEnd, false), DocxOp::NewParagraph]);
    let before_import = m.export().unwrap();
    let polygon = HwpxPolygon { width: 10800, height: 7200, points: vec![[1600,1300],[9700,700],[6400,6500]],
        fill: "442277".into(), description: "HWPX polygon".into() };
    let mut invalid = polygon.clone();
    invalid.points[1][0] = 10801;
    assert!(!validate(&[DocxOp::PasteHwpxPolygon { polygon: invalid.clone() }]));
    assert_eq!(m.apply(&[DocxOp::PasteHwpxPolygon { polygon: invalid }]).rejected, vec![0]);
    assert_eq!(m.export().unwrap(), before_import);
    assert_eq!(m.apply(&[DocxOp::PasteHwpxPolygon { polygon }]).changed, 1);
    let imported = m.export().unwrap();
    assert!(m.same_as(&imported));
    assert!(service::check_saved(Format::Docx, &before_import, &imported, None, true).is_safe());
    let reopened = io::open_bytes("import.docx", &imported).unwrap();
    let last = reopened.para_at(&reopened.end_of(StoryRef::Body)).unwrap();
    let Some(InlineObject::Shape { kind: ShapeKind::Freeform, freeform: Some(path), fill: Some(fill), stroke: None, float, .. }) = last.object_at(0)
        else { panic!("import did not remain an editable freeform"); };
    assert_eq!(fill.hex(), "442277");
    assert_eq!(float.alt.text, "HWPX polygon");
    assert_eq!(path.paths[0].pts, vec![[16.,13.],[97.,7.],[64.,65.]]);
    assert!(path.paths[0].closed);
    assert_eq!(m.apply(&[DocxOp::Undo {}]).changed, 1);
    assert_eq!(m.export().unwrap(), before_import);
    assert_eq!(m.apply(&[DocxOp::Redo {}]).changed, 1);
    assert_eq!(m.export().unwrap(), imported);

    if let Some(out) = std::env::var_os("GEUL_STAGE3A_P6_OUT") {
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("a-p6-rect-original.docx"), original).unwrap();
        std::fs::write(out.join("a-p6-import-destination.docx"), before_import).unwrap();
    }
}
