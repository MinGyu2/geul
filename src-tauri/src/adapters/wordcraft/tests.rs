//! T008 WordCraft 어댑터 시험. 픽스처는 실행할 때 엔진 명령으로 만든다(tests/fixtures/wordcraft/basic.rs).

#[path = "../../../../tests/fixtures/wordcraft/basic.rs"]
mod basic;

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
            "inTable",
            "pages",
            "paragraphText",
            "selection"
        ]
    );
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
