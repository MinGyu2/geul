// 공유 ImeContext의 문서 소유 경계(RHWP·WordCraft 표면 전환, 다시 불러오기)와 GTK XIM 재확정 기록(2026-11-04).
// Editor처럼 표면 A를 unmount(detach)하고 같은 ImeContext로 표면 B를 mount해 전환한다. DOM 사건 순서는 실측한
// WebKitGTK 2.54 + ibus-x11(XIM)·ibus GTK 모듈 순서를 재생한 합성 사건이며 native IME 통과 근거가 아니다
// (native 근거와 한계: docs/architecture/editor-surface-decision.md "공유 IME 문맥의 문서 소유 경계").
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../../language/LanguageContext";
import { ImeContext } from "./rhwp/imeInput";
import { RhwpSurface } from "./rhwp/RhwpSurface";
import { flush, info, loaded, ok, readySession } from "./rhwp/testing";
import { DocxSurface } from "./wordcraft/DocxSurface";
import { readyDocx, stubScreenContext } from "./wordcraft/testing";

type Step =
  | ["ime", boolean] // keydown 229(key "Unidentified"), isComposing
  | ["key", string] // 일반 키 keydown(조합 아님)
  | ["xim"] // GTK XIM 확정 운반 keydown(실측: key·code "Unidentified", keyCode 0, isComposing=false)
  | ["start"]
  | ["input", string, string, boolean] // data, inputType, isComposing
  | ["end", string]
  | ["mousedown"]; // 쪽을 실제 mousedown으로 누름

interface Surface {
  kind: "rhwp" | "docx";
  text(): string;
  revision(): number;
  play(steps: Step[]): Promise<void>;
  unmount(): void;
  reload?(): Promise<void>;
}

function player(container: HTMLElement, pageSelector: string) {
  const input = () => container.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
  const fire = (event: Event) => act(() => void input().dispatchEvent(event));
  return async (steps: Step[]) => {
    for (const step of steps) {
      switch (step[0]) {
        case "ime":
          fire(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, isComposing: step[1], bubbles: true, cancelable: true }));
          break;
        case "key":
          fire(new KeyboardEvent("keydown", { key: step[1], code: step[1] === " " ? "Space" : step[1], keyCode: step[1] === " " ? 32 : 65, bubbles: true, cancelable: true }));
          break;
        case "xim":
          fire(new KeyboardEvent("keydown", { key: "Unidentified", code: "Unidentified", keyCode: 0, isComposing: false, bubbles: true, cancelable: true }));
          break;
        case "start": fire(new CompositionEvent("compositionstart", { data: "" })); break;
        case "input": {
          const [, value, inputType, isComposing] = step;
          input().value = value;
          fire(new InputEvent("input", { data: inputType === "deleteCompositionText" ? null : value, inputType, isComposing }));
          break;
        }
        case "end":
          input().value = step[1];
          fire(new CompositionEvent("compositionend", { data: step[1] }));
          break;
        case "mousedown": {
          const page = container.querySelector<HTMLElement>(pageSelector)!;
          act(() => void page.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 25 })));
          break;
        }
      }
    }
    await act(flush);
  };
}

async function rhwp(context: ImeContext, text = "가나다"): Promise<Surface> {
  const t = await readySession([text, "abc"]);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <RhwpSurface session={t.editor} zoom={100} imeContext={context} />
    </LanguageProvider>,
  );
  return {
    kind: "rhwp",
    text: () => t.doc.paragraphs[0]!,
    revision: () => t.editor.localRevision,
    play: player(view.container, ".rhwp-page"),
    unmount: () => view.unmount(),
    reload: async () => {
      const reloading = t.editor.load({ discard: true });
      t.take("load").reply(loaded(undefined, 2));
      await act(flush);
      t.take("session").reply(ok(info({ state: "loading", sequence: 5, loadGeneration: 2 })));
      t.take("setState").reply(ok(info({ state: "ready", sequence: 6, loadGeneration: 2 })));
      await act(async () => { await reloading; });
      await act(flush);
    },
  };
}

async function docx(context: ImeContext, text = "가나다"): Promise<Surface> {
  stubScreenContext();
  const t = await readyDocx([text]);
  const view = render(
    <LanguageProvider language="ko" onLanguageChange={() => {}}>
      <DocxSurface session={t.editor} zoom={100} imeContext={context} />
    </LanguageProvider>,
  );
  await act(flush);
  return {
    kind: "docx",
    text: () => t.fake.paragraphs[0]!,
    revision: () => t.sessions.get(1)?.revision ?? -1,
    play: player(view.container, ".docx-page"),
    unmount: () => view.unmount(),
  };
}

const compose = (text: string): Step[] => [["ime", false], ["start"], ["input", text, "insertCompositionText", true]];
/** WebView가 조합을 스스로 확정(실측: 조합 중 포인터). XIM 재확정(운반 keydown + insertText)은 뒤에 따로 보낸다. */
const viewConfirm = (text: string): Step[] => [
  ["input", "", "deleteCompositionText", true], ["input", text, "insertFromComposition", true], ["end", text],
];
const ximRepeat = (text: string): Step[] => [["xim"], ["input", text, "insertText", false]];
/** 실측 XIM 일반 입력: 229 keydown + compositionstart + preedit, 확정은 빈 끝 뒤 운반 keydown + insertText. */
const ximTyped = (text: string): Step[] => [
  ...compose(text), ["ime", true], ["input", "", "deleteCompositionText", true], ["end", ""], ...ximRepeat(text),
];

const makers = { rhwp, docx } as const;
const pairs = [["rhwp", "rhwp"], ["rhwp", "docx"], ["docx", "rhwp"], ["docx", "docx"]] as const;

describe("같은 문서: XIM 재확정 중복 억제(속성 C)", () => {
  for (const kind of ["rhwp", "docx"] as const) {
    it(`${kind}: WebView 확정 뒤 XIM 재확정은 한 번만 넣고 revision 1`, async () => {
      const a = await makers[kind](new ImeContext());
      await a.play([...compose("가"), ...viewConfirm("가"), ...ximRepeat("가")]);
      expect(a.text()).toBe("가가나다");
      expect(a.revision()).toBe(1);
    });

    it(`${kind}: 조합 중 실제 mousedown 뒤 WebView 확정·XIM 재확정도 원래 자리에 한 번`, async () => {
      const a = await makers[kind](new ImeContext());
      await a.play([...compose("가"), ["mousedown"], ...viewConfirm("가"), ...ximRepeat("가")]);
      expect(a.text()).toBe("가가나다");
      expect(a.revision()).toBe(1);
    });

    it(`${kind}: blur 뒤에 온 같은 문서의 XIM 재확정도 한 번`, async () => {
      const a = await makers[kind](new ImeContext());
      await a.play([...compose("가"), ...viewConfirm("가")]);
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      await a.play(ximRepeat("가"));
      expect(a.text()).toBe("가가나다");
      expect(a.revision()).toBe(1);
    });

    it(`${kind}: 연속한 정상 XIM 같은 음절 입력은 모두 남는다`, async () => {
      const a = await makers[kind](new ImeContext());
      await a.play([...ximTyped("가"), ...ximTyped("가")]);
      expect(a.text()).toBe("가가가나다");
      expect(a.revision()).toBe(2);
    });
  }
});

describe("문서 전환: 공유 기록의 소유 경계(속성 A·B·D·E)", () => {
  for (const [from, to] of pairs) {
    it(`${from}→${to}: A의 XIM 재확정이 전환 뒤 B에 와도 B는 그대로, A는 한 번`, async () => {
      const context = new ImeContext();
      const a = await makers[from](context);
      await a.play([...compose("가"), ...viewConfirm("가")]);
      a.unmount();
      const b = await makers[to](context, "xyz");
      await b.play(ximRepeat("가"));
      expect(b.text()).toBe("xyz");
      expect(b.revision()).toBe(0);
      expect(a.text()).toBe("가가나다");
      expect(a.revision()).toBe(1);
    });

    it(`${from}→${to}: 전환 뒤 B의 실측 형태 정상 입력(조합 시작부터)은 같은 글자여도 B에 한 번`, async () => {
      const context = new ImeContext();
      const a = await makers[from](context);
      await a.play([...compose("가"), ...viewConfirm("가")]);
      a.unmount();
      const b = await makers[to](context, "xyz");
      await b.play(ximTyped("가"));
      expect(b.text()).toBe("가xyz");
      expect(b.revision()).toBe(1);
      expect(a.text()).toBe("가가나다");
    });

    it(`${from}→${to}: A의 재확정을 A가 이미 소비했으면 B의 같은 글자 정상 입력·일반 키 입력은 B에 들어간다`, async () => {
      const context = new ImeContext();
      const a = await makers[from](context);
      await a.play([...compose("가"), ...viewConfirm("가"), ...ximRepeat("가")]);
      a.unmount();
      const b = await makers[to](context, "xyz");
      await b.play([...ximTyped("가"), ["key", " "], ["input", " ", "insertText", false]]);
      expect(b.text()).toBe("가 xyz");
      expect(b.revision()).toBe(2);
      expect(a.text()).toBe("가가나다");
      expect(a.revision()).toBe(1);
    });
  }

  it("관측상 구별할 수 없는 형태: 전환 뒤 B의 첫 사건이 조합 없는 운반 keydown + 같은 글자 insertText면 A의 늦은 재확정으로 보고 넣지 않는다", async () => {
    // A의 늦은 XIM 재확정과 B의 (조합 사건 없는) 같은 글자 확정은 DOM에서 같다(네이티브 거래 ID 없음). 지금 계약은 다른 문서에
    // 옛 글자를 넣지 않는 쪽(보수적 소비)이다. 실측 XIM에서는 B의 정상 입력이 언제나 조합 시작부터 오고, A의 재확정은 전환 전에 A에서
    // 소비됐다(이 형태 자체는 관측되지 않음).
    const context = new ImeContext();
    const a = await rhwp(context);
    await a.play([...compose("가"), ...viewConfirm("가")]);
    a.unmount();
    const b = await docx(context, "xyz");
    await b.play([["mousedown"], ...ximRepeat("가")]);
    expect(b.text()).toBe("xyz");
    expect(b.revision()).toBe(0);
  });

  it("전환 뒤 B의 일반 키·새 조합 시작은 A의 기록을 지워 그 뒤 같은 글자 XIM 확정을 B에 넣는다", async () => {
    for (const boundary of [[["key", " "], ["input", " ", "insertText", false]], [["ime", false], ["start"]]] as Step[][]) {
      const context = new ImeContext();
      const a = await rhwp(context);
      await a.play([...compose("가"), ...viewConfirm("가")]);
      a.unmount();
      const b = await rhwp(context, "xyz");
      await b.play(boundary);
      if (boundary[1]![0] === "start") await b.play([["input", "가", "insertCompositionText", true], ["ime", true],
        ["input", "", "deleteCompositionText", true], ["end", ""]]);
      await b.play(ximRepeat("가"));
      expect(b.text()).toBe(boundary[0]![0] === "key" ? " 가xyz" : "가xyz");
    }
  });
});

describe("다시 불러오기: 옛 세대의 기록(속성 D)", () => {
  it("rhwp: WebView 확정 뒤 다시 불러오면 옛 거래의 XIM 재확정은 새 모델을 바꾸지 않고, 새 정상 입력은 들어간다", async () => {
    const a = await rhwp(new ImeContext());
    await a.play([...compose("가"), ...viewConfirm("가")]);
    await a.reload!();
    const fresh = a.text();
    const revision = a.revision();
    await a.play(ximRepeat("가"));
    expect(a.text()).toBe(fresh);
    expect(a.revision()).toBe(revision);
    await a.play(ximTyped("나"));
    expect(a.text()).toBe(`나${fresh}`);
    expect(a.revision()).toBe(revision + 1);
  });
});
