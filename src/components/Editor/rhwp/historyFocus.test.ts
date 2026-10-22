// rhwp 실행 취소 타자 그룹의 초점 경계(T010 Phase 2 안정화 B1–B3). 실제 입력 처리기(ImeInput)의 blur·detach가 세션의 그룹을 끊고,
// 조합·provisional·늦은 최종 글자가 열려 있으면 그 트랜잭션이 닫힐 때 끊는지 본다. 시간은 performance.now를 시험이 정한다(1.5초
// 쉼 정책 — 실제로 기다리지 않음). 가짜 문서(FakeDocument), 입력은 ImeInput 메서드 호출(입력기 아님).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImeContext, ImeInput } from "./imeInput";
import { readySession } from "./testing";
import { HISTORY_IDLE_MS } from "./rhwpHistory";

let now = 0;
afterEach(() => {
  vi.restoreAllMocks();
  now = 0;
});

async function setup(text = ["가나다"]) {
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const s = await readySession(text);
  const ime = new ImeInput(s.editor, new ImeContext());
  const type = (chars: string) => {
    for (const ch of chars) {
      ime.keyDown();
      ime.input(ch, "insertText", false);
      now += 50;
    }
  };
  const undoAll = () => {
    const seen: string[] = [];
    while (s.editor.undo()) seen.push(s.doc.paragraphs[0]!);
    return seen;
  };
  return { ...s, ime, type, undoAll };
}

describe("초점 경계와 타자 그룹", () => {
  it("대조: 초점을 잃지 않고 같은 자리에서 이어 치면 한 단계", async () => {
    const s = await setup();
    s.type("abc");
    s.type("def");
    expect(s.undoAll()).toEqual(["가나다"]);
  });

  it("초점 잃음 뒤 1.5초 안에 같은 자리로 돌아와 친 글자는 새 단계(첫 실행 취소는 def만, 둘째는 abc)", async () => {
    const s = await setup();
    s.type("abc");
    const revision = s.editor.localRevision;
    s.ime.blur();
    expect([s.doc.paragraphs[0], s.editor.localRevision]).toEqual(["abc가나다", revision]); // 초점 잃음은 문서·revision을 바꾸지 않음
    s.type("def");
    expect(s.undoAll()).toEqual(["abc가나다", "가나다"]);
  });

  it("표면 사라짐(탭 전환 detach)도 같은 경계", async () => {
    const s = await setup();
    s.type("abc");
    s.ime.detach();
    s.type("def");
    expect(s.undoAll()).toEqual(["abc가나다", "가나다"]);
  });

  it("초점을 잃었다 돌아오기만 하면(타자 없음) 단계·revision·문서가 그대로", async () => {
    const s = await setup();
    s.type("ab");
    const before = { text: s.doc.paragraphs[0], revision: s.editor.localRevision, history: s.editor.snapshot().history };
    s.ime.blur();
    s.ime.blur();
    s.ime.detach();
    expect({ text: s.doc.paragraphs[0], revision: s.editor.localRevision, history: s.editor.snapshot().history }).toEqual(before);
    expect(s.undoAll()).toEqual(["가나다"]);
  });

  it("쉼: 1.5초 안이면 이어 쓰고, 넘으면 새 단계(초점은 그대로)", async () => {
    const s = await setup();
    s.type("a");
    now += HISTORY_IDLE_MS - 100;
    s.type("b");
    now += HISTORY_IDLE_MS + 1;
    s.type("c");
    expect(s.undoAll()).toEqual(["ab가나다", "가나다"]);
  });

  it("키보드 이동이 그룹을 끊는다", async () => {
    const s = await setup();
    s.type("ab");
    s.editor.moveHorizontal(-1, false);
    s.editor.moveHorizontal(1, false);
    s.type("c");
    expect(s.undoAll()).toEqual(["ab가나다", "가나다"]);
  });

  it("조합 중 초점 잃음: 조합 글자는 보존(앱 확정), 늦은 최종 글자 뒤 새 타자는 이전 그룹에 묶이지 않음", async () => {
    const s = await setup();
    s.type("ab");
    s.ime.compositionStart();
    s.ime.input("가", "insertCompositionText", true);
    s.ime.blur(); // 조합 중 초점 잃음: 보이는 조합을 그 자리에 둔다(provisional)
    expect(s.doc.paragraphs[0]).toBe("ab가가나다");
    s.ime.compositionEnd("간"); // 입력기의 늦은 최종 글자
    expect(s.doc.paragraphs[0]).toBe("ab간가나다");
    s.type("x");
    const states = s.undoAll();
    expect(states[0]).toBe("ab간가나다"); // 첫 실행 취소는 x만
    expect(states.at(-1)).toBe("가나다");
    expect(s.doc.paragraphs[0]).toBe("가나다");
  });

  it("provisional 해결 중 초점 잃음: 해결이 단계를 닫은 뒤에 끊는다", async () => {
    const s = await setup();
    s.type("a");
    s.editor.beginComposition();
    s.editor.updateComposition("하");
    s.editor.endComposition("하", { provisional: true });
    s.ime.blur(); // 열린 트랜잭션 중의 끊기
    s.editor.resolveProvisional("한");
    s.type("b");
    expect(s.undoAll()).toEqual(["a한가나다", "가나다"]);
  });

  it("선택 지운 뒤 조합 취소 + 초점 잃음: 실행 취소가 지운 글자를 되살리고 뒤 타자와 섞이지 않음", async () => {
    const s = await setup();
    s.editor.moveHorizontal(1, true);
    s.editor.moveHorizontal(1, true);
    s.ime.compositionStart();
    s.ime.input("ㄱ", "insertCompositionText", true);
    s.ime.compositionEnd("");
    expect(s.doc.paragraphs[0]).toBe("다");
    s.ime.blur();
    s.type("z");
    expect(s.undoAll()).toEqual(["다", "가나다"]);
    expect(s.editor.caret.offset - s.editor.anchor.offset).toBe(2);
  });

  it("빈 끝 뒤 최종 글자 기다림 중 초점 잃음: 늦은 글자는 그 자리에 한 번 들어가고 뒤 타자는 새 단계", async () => {
    const s = await setup();
    s.type("a");
    s.ime.compositionStart();
    s.ime.input("ㅎ", "insertCompositionText", true);
    s.ime.input("", "deleteCompositionText", true);
    s.ime.compositionEnd(""); // WebKitGTK: 빈 끝 뒤 최종 글자가 따로 온다
    s.ime.blur();
    s.ime.input("한", "insertFromComposition", true);
    s.ime.compositionEnd("한");
    expect(s.doc.paragraphs[0]).toBe("a한가나다");
    s.type("b");
    const states = s.undoAll();
    expect(states[0]).toBe("a한가나다");
    expect(s.doc.paragraphs[0]).toBe("가나다");
  });
});
