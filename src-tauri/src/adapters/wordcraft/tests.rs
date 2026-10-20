//! T008 WordCraft 어댑터 시험. 픽스처는 실행할 때 엔진 명령으로 만든다(tests/fixtures/wordcraft/basic.rs).

#[path = "../../../../tests/fixtures/wordcraft/basic.rs"]
pub(crate) mod basic;

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
            DocxOp::Pointer { page: 0, x: 1.5, y: 2.0, extend: false, before_insert: true },
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
            "caret",
            "caretKey",
            "caretOffset",
            "collapsed",
            "format",
            "formatAccess",
            "history",
            "inTable",
            "pages",
            "paragraphText",
            "selection"
        ]
    );
    // T010: 엔진 기록·서식(프런트엔드 parseDocxView가 정확히 이 키만 받는다).
    assert_eq!(
        value["view"]["history"],
        json!({"undo": false, "redo": false})
    );
    assert_eq!(
        value["view"]["format"],
        json!({"bold": false, "italic": false, "underline": false, "strikethrough": false})
    );
    assert_eq!(value["view"]["formatAccess"], "allowed");
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
        vec![paste("a\n", true), paste("b", false), DocxOp::DeleteSelection]
    );
    assert!(parse(json!([{"op": "pasteText", "text": "a", "raw": false}])).is_err());
}

#[test]
fn 선택_지우기는_선택이_있을_때만_문서를_바꾼다() {
    let mut m = model();
    assert_eq!(
        m.apply(&[DocxOp::DeleteSelection]).changed,
        0,
        "선택 없음: 문서·revision 그대로(앞 글자를 지우지 않음)"
    );
    assert_eq!(m.view().paragraph_text, basic::PARAGRAPHS[0]);
    let outcome = m.apply(&[
        mv(MoveTarget::Right, true),
        mv(MoveTarget::Right, true),
        DocxOp::DeleteSelection,
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
        DocxOp::DeleteSelection,
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
