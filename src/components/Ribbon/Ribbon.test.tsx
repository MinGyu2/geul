// 형식별 리본과 명령 연결(T011). 앱 전체(App → DocumentWorkspace → 편집 세션 → 명령 실행 경계)를 그리고, 백엔드만 가짜다:
// rhwp는 FakeDocument(WASM 흉내), WordCraft는 FakeDocx(Rust Session 흉내)이며 엔진 동작의 증거가 아니다. 여기서 보는 것은 탭 표시가
// 백엔드 투영의 형식(SessionInfo.format)을 따르는지, 사라진 탭의 대신 고르기·초점, 명령이 활성 세션에만 가는지, 쓸 수 없는 명령이
// 아무것도 바꾸지 않고 이유를 알리는지, 리본 누름이 편집 입력의 초점·조합을 건드리지 않는지다. 실제 입력기(native IME) 근거가 아니다.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { DocumentBackend } from "../../adapters/backend";
import type { DocumentFormat, Result, SessionInfo, SessionState } from "../../adapters/contract";
import { DocumentSessions } from "../../adapters/sessions";
import type { CommandContext } from "../../commands/commands";
import { initialLayout } from "../../hooks/layoutState";
import { LanguageProvider } from "../../language/LanguageContext";
import type { Message } from "../../language";
import { DocumentWorkspace } from "../Editor/documentWorkspace";
import type { RhwpDocument, RhwpModule } from "../Editor/rhwp/rhwpModule";
import { FakeDocument, FIXED_MEMORY_BYTES, info as rhwpInfo, loaded } from "../Editor/rhwp/testing";
import { decodeFake, docxInfo, FakeDocx, flush, stubScreenContext } from "../Editor/wordcraft/testing";
import { Ribbon } from "./Ribbon";

const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });

/**
 * 세 형식이 함께 열린 작업 공간. 1 = a.hwp, 2 = b.hwpx(rhwp), 3 = c.docx(WordCraft). 백엔드는 바로 답한다(세션 기록을 흉내 내어
 * load → loading, setState → 상태, commit → revision). 닫기는 목록에서 뺀다.
 */
function mixedWorkspace() {
  stubScreenContext();
  const fake = new FakeDocx(["DOCX 본문"]);
  fake.info = docxInfo({ sessionId: 3, displayName: "c.docx" });
  const records = new Map<number, SessionInfo>();
  const initial: Record<string, SessionInfo> = {
    "/a.hwp": rhwpInfo({ sessionId: 1, format: "hwp", displayName: "a.hwp" }),
    "/b.hwpx": rhwpInfo({ sessionId: 2, format: "hwpx", displayName: "b.hwpx" }),
    "/c.docx": fake.info,
  };
  const record = (id: number) => (id === 3 ? fake.info : records.get(id)!);
  const update = (id: number, patch: Partial<SessionInfo>) => {
    const next = { ...record(id), ...patch, sequence: record(id).sequence + 1 };
    if (id === 3) fake.info = next;
    else records.set(id, next);
    return { ...next };
  };
  const backend = {
    open: (path: string) => {
      const value = { ...initial[path]! };
      if (value.sessionId !== 3) records.set(value.sessionId, value);
      return ok(value);
    },
    session: (id: number) => ok({ ...record(id) }),
    sessions: () => ok([]),
    load: (id: number) => {
      const generation = record(id).loadGeneration + 1;
      update(id, { state: "loading", loadGeneration: generation });
      return Promise.resolve(loaded(new Uint8Array([1]), generation));
    },
    setState: (id: number, _generation: number, _from: SessionState, to: SessionState) => ok(update(id, { state: to })),
    commit: (id: number, _generation: number, baseRevision: number, count: number) =>
      ok(update(id, { revision: baseRevision + count, dirty: true })),
    close: (sessionId: number) => ok({ sessionId, alreadyClosed: false }),
  } as unknown as DocumentBackend;
  const docs = new Map<DocumentFormat, FakeDocument>();
  let opened = 0;
  const module: RhwpModule = {
    openDocument: () => {
      // 1(a.hwp)이 먼저, 2(b.hwpx)가 다음에 불러온다(시험이 차례로 연다).
      const format = opened++ === 0 ? "hwp" : "hwpx";
      const doc = new FakeDocument([`${format} 본문`]);
      doc.format = format;
      docs.set(format, doc);
      return doc as unknown as RhwpDocument;
    },
    memoryBytes: () => FIXED_MEMORY_BYTES,
  };
  const workspace = new DocumentWorkspace(
    new DocumentSessions(backend),
    backend, async () => module, undefined, fake, decodeFake,
  );
  return { workspace, sessions: workspace.sessions, fake, docs };
}

const docxEdits = (fake: FakeDocx) => fake.calls.filter((call) => call.method === "edit").map((call) => call.args[3]);
const ribbonTabs = () => within(screen.getByRole("tablist", { name: "리본 탭" }));
const pathInput = () => document.querySelector<HTMLInputElement>(".document-bar input")!;
const ribbonTabNames = () => ribbonTabs().getAllByRole("tab").map((tab) => tab.textContent);
const statusMessage = () => document.querySelector<HTMLElement>(".statusbar__message")!;

async function renderMixed(paths: string[] = ["/a.hwp", "/b.hwpx", "/c.docx"]) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  const harness = mixedWorkspace();
  const user = userEvent.setup();
  const view = render(
    <App initialLanguage="ko" settingsStore={{ read: () => null, write: () => true }} documentWorkspace={harness.workspace} />,
  );
  for (const path of paths) {
    await act(async () => {
      await harness.workspace.open(path);
      await flush();
    });
  }
  return { ...harness, user, view };
}

/** ARIA 탭 관계가 한 벌로 맞는다: 고른 탭 하나·탭 정지점 하나·패널은 고른 탭이 이름을 줌. */
function expectConsistentTabs(selectedName: string) {
  const tabs = ribbonTabs().getAllByRole("tab");
  const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
  expect(selected.map((tab) => tab.textContent)).toEqual([selectedName]);
  expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual(selected);
  const panel = screen.getByRole("tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", selected[0]!.id);
  expect(selected[0]).toHaveAttribute("aria-controls", panel.id);
  expect(tabs.filter((tab) => tab !== selected[0] && tab.hasAttribute("aria-controls"))).toEqual([]);
  expect(panel).toHaveAccessibleName(selectedName);
}

const COMMON = ["파일", "홈", "삽입", "그리기", "디자인", "레이아웃", "검토", "보기", "도움말"];
const HANGUL = ["파일", "홈", "삽입", "그리기", "디자인", "레이아웃", "한글 도구", "검토", "보기", "도움말"];
const DOCX = ["파일", "홈", "삽입", "그리기", "디자인", "레이아웃", "참조", "편지", "검토", "보기", "도움말"];

describe("T011 형식별 리본 탭(앱)", () => {
  it("A01–A05 문서 없음 → HWP → HWPX → DOCX → 다시 HWP: 활성 문서 형식의 탭만 보인다", async () => {
    const { sessions, workspace } = await renderMixed([]);
    expect(ribbonTabNames()).toEqual(COMMON);
    expect(screen.getByRole("region", { name: "리본" })).toHaveAttribute("data-ribbon-format", "none");

    await act(async () => { await workspace.open("/a.hwp"); await flush(); });
    expect(sessions.snapshot().activeId).toBe(1);
    expect(ribbonTabNames()).toEqual(HANGUL);

    await act(async () => { await workspace.open("/b.hwpx"); await flush(); });
    expect(sessions.snapshot().activeId).toBe(2);
    expect(ribbonTabNames()).toEqual(HANGUL);
    expect(screen.getByRole("region", { name: "리본" })).toHaveAttribute("data-ribbon-format", "hwpx");

    await act(async () => { await workspace.open("/c.docx"); await flush(); });
    expect(sessions.snapshot().activeId).toBe(3);
    expect(ribbonTabNames()).toEqual(DOCX);

    await act(async () => { sessions.select(1); await flush(); });
    expect(ribbonTabNames()).toEqual(HANGUL);
    expectConsistentTabs("홈");
  });

  it("A03/A04 한글 도구 탭은 HWP/HWPX 전용 안내와 함께 보이고, 제품 빌드의 장평·자간(시험 빌드 전용)과 표 밖의 표 계산은 쓸 수 없으며 눌러도 문서를 바꾸지 않는다", async () => {
    const { user, docs } = await renderMixed(["/a.hwp", "/b.hwpx"]);
    await user.click(ribbonTabs().getByRole("tab", { name: "한글 도구" }));
    expectConsistentTabs("한글 도구");
    expect(screen.getByText("HWP/HWPX 문서 전용 도구입니다.")).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: "한글 도구" });
    for (const button of within(toolbar).getAllByRole("button")) expect(button).toHaveAttribute("aria-disabled", "true");
    expect(within(toolbar).getByRole("button", { name: /장평/ }).title).toContain("이 문서 형식에서 지원하지 않음");
    expect(within(toolbar).getByRole("button", { name: /자간/ }).title).toContain("이 문서 형식에서 지원하지 않음");
    expect(within(toolbar).getByRole("button", { name: /표 계산/ }).title).toContain("커서가 표 셀 안에 있지 않음");
    const before = docs.get("hwpx")!.paragraphs.join("\n");
    await user.click(within(toolbar).getByRole("button", { name: /장평/ }));
    expect(statusMessage()).toHaveTextContent("장평: 이 문서 형식에서는 지원하지 않습니다.");
    await user.click(within(toolbar).getByRole("button", { name: /표 계산/ }));
    expect(statusMessage()).toHaveTextContent("표 계산: 먼저 커서를 표 셀 안에 두세요.");
    expect(screen.queryByTestId("command-input-dialog")).not.toBeInTheDocument();
    expect(docs.get("hwpx")!.paragraphs.join("\n")).toBe(before);
  });

  it("T012 표 계산: 리본 → 입력 창(모달) → 읽기 전용 결과를 알리고 문서는 그대로. 창이 열린 동안 문서가 바뀌거나 다른 문서로 바뀌면 적용하지 않는다", async () => {
    const { user, docs, sessions, workspace } = await renderMixed(["/a.hwp", "/b.hwpx"]);
    const doc = docs.get("hwpx")! as FakeDocument & Record<string, unknown>;
    const formulas: unknown[][] = [];
    Object.assign(doc, {
      getTableDimensions: () => JSON.stringify({ rowCount: 2, colCount: 2, cellCount: 4 }),
      getCellInfo: (_s: number, _p: number, _c: number, cell: number) => JSON.stringify({ row: cell >> 1, col: cell & 1, rowSpan: 1, colSpan: 1 }),
      evaluateTableFormula: (...args: unknown[]) => { formulas.push(args); return JSON.stringify({ ok: true, result: 7, formula: args[5] }); },
    });
    const editor = workspace.editorFor(2)!;
    const inCell = { section: 0, paragraph: 0, offset: 0, cell: { parentParagraph: 0, control: 0, cell: 1, cellParagraph: 0 } };
    editor.caret = editor.anchor = inCell;
    await user.click(ribbonTabs().getByRole("tab", { name: "한글 도구" }));
    const toolbar = () => screen.getByRole("toolbar", { name: "한글 도구" });
    const formulaButton = () => within(toolbar()).getByRole("button", { name: /표 계산/ });
    expect(formulaButton()).not.toHaveAttribute("aria-disabled");
    const before = [...doc.paragraphs];

    await user.click(formulaButton());
    const dialog = screen.getByTestId("command-input-dialog");
    expect(dialog).toHaveTextContent("B1 셀 기준");
    // 창이 열린 동안은 다른 명령도 모달로 막힌다.
    expect(formulaButton()).toHaveAttribute("aria-disabled", "true");
    await user.type(screen.getByTestId("command-input-value"), "=SUM(A1:B2)");
    await user.click(screen.getByTestId("command-input-confirm"));
    expect(screen.queryByTestId("command-input-dialog")).not.toBeInTheDocument();
    expect(formulas).toEqual([[0, 0, 0, 0, 1, "=SUM(A1:B2)", false]]);
    expect(statusMessage()).toHaveTextContent("표 계산: =SUM(A1:B2) = 7 (결과만 표시, 표는 바꾸지 않음)");
    expect(doc.paragraphs).toEqual(before);
    expect(sessions.get(2)).toMatchObject({ revision: 0, dirty: false });

    // 창을 연 뒤 문서가 바뀌면(revision) 확인해도 계산하지 않는다.
    await user.click(formulaButton());
    await act(async () => {
      editor.caret = editor.anchor = { section: 0, paragraph: 0, offset: 0 };
      editor.typeText("가");
      await flush();
      editor.caret = editor.anchor = inCell;
    });
    await user.type(screen.getByTestId("command-input-value"), "=A1");
    await user.click(screen.getByTestId("command-input-confirm"));
    expect(formulas).toHaveLength(1);
    expect(statusMessage()).toHaveTextContent("표 계산: 창이 열린 동안 문서가 바뀌어 적용하지 않았습니다.");

    // 다른 문서로 바꾸면 창을 버린다(그 문서에 적용하지 않음).
    await user.click(formulaButton());
    expect(screen.getByTestId("command-input-dialog")).toBeInTheDocument();
    await act(async () => { sessions.select(1); await flush(); });
    expect(screen.queryByTestId("command-input-dialog")).not.toBeInTheDocument();
    await act(async () => { sessions.select(2); await flush(); });
    expect(screen.queryByTestId("command-input-dialog")).not.toBeInTheDocument();
    expect(formulas).toHaveLength(1);
  });

  it("T013 새 메모·각주: DOCX 선택 → 검토 탭 → 입력 창 → comment 연산 하나, 커서 → 참조 탭 → footnote 연산 하나. 선택 없음·HWP는 막히고 목차·추적은 계획 명령이다", async () => {
    const { user, fake, workspace } = await renderMixed();
    const editor = workspace.docxEditorFor(3)!;
    await user.click(ribbonTabs().getByRole("tab", { name: "검토" }));
    const toolbar = () => screen.getByRole("toolbar", { name: "검토" });
    const commentButton = () => within(toolbar()).getByRole("button", { name: /새 메모/ });
    expect(commentButton()).toHaveAttribute("aria-disabled", "true");
    expect(commentButton().title).toContain("한 문단 안의 글자 선택 필요");
    expect(within(toolbar()).getByRole("button", { name: /변경 내용 추적/ }).title).toContain("아직 연결되지 않은 명령");

    await act(async () => { editor.move("right", true); editor.move("right", true); await flush(); });
    expect(commentButton()).not.toHaveAttribute("aria-disabled");
    await user.click(commentButton());
    expect(screen.getByTestId("command-input-dialog")).toHaveAttribute("data-command", "review.comment");
    await user.type(screen.getByTestId("command-input-value"), "검토 필요");
    await user.click(screen.getByTestId("command-input-confirm"));
    await act(async () => { await flush(); });
    expect(screen.queryByTestId("command-input-dialog")).not.toBeInTheDocument();
    expect(docxEdits(fake).at(-1)).toEqual([{ op: "comment", text: "검토 필요" }]);
    expect(fake.comments.map((comment) => comment.text)).toEqual(["검토 필요"]);

    await user.click(ribbonTabs().getByRole("tab", { name: "참조" }));
    const references = () => screen.getByRole("toolbar", { name: "참조" });
    // 목차(T013 Stage 2): 선택이 남아 있으면 넣기는 커서 필요, 목차가 없으면 갱신은 목차 필요.
    expect(within(references()).getByRole("button", { name: "목차" }).title).toContain("본문 문단의 커서 필요");
    expect(within(references()).getByRole("button", { name: /목차 업데이트/ }).title).toContain("본문에 목차 없음");
    // 각주(T013): 선택이 남아 있으면 막히고, 커서만 두면 입력 창 → footnote 연산 하나.
    const footnoteButton = () => within(references()).getByRole("button", { name: /각주/ });
    expect(footnoteButton()).toHaveAttribute("aria-disabled", "true");
    expect(footnoteButton().title).toContain("본문 문단의 커서 필요");
    await act(async () => { editor.move("right", false); await flush(); });
    expect(footnoteButton()).not.toHaveAttribute("aria-disabled");
    await user.click(footnoteButton());
    expect(screen.getByTestId("command-input-dialog")).toHaveAttribute("data-command", "references.footnote");
    await user.type(screen.getByTestId("command-input-value"), "출처");
    await user.click(screen.getByTestId("command-input-confirm"));
    await act(async () => { await flush(); });
    expect(docxEdits(fake).at(-1)).toEqual([{ op: "footnote", text: "출처" }]);
    expect(fake.notes.map((note) => [note.kind, note.text])).toEqual([["footnote", "출처"]]);
    expect(within(references()).getByRole("button", { name: /미주/ })).not.toHaveAttribute("aria-disabled");
  });

  it("A06/A07 DOCX의 참조 탭을 고른 채 HWP로 바꾸거나 DOCX를 닫으면 홈으로 바뀌고 ARIA 관계가 맞는다(돌아와도 되살리지 않음)", async () => {
    const { user, sessions, workspace } = await renderMixed();
    await user.click(ribbonTabs().getByRole("tab", { name: "참조" }));
    expectConsistentTabs("참조");
    expect(screen.getByText("DOCX 문서 전용 도구입니다.")).toBeInTheDocument();

    await act(async () => { sessions.select(2); await flush(); });
    expect(ribbonTabs().queryByRole("tab", { name: "참조" })).not.toBeInTheDocument();
    expectConsistentTabs("홈");
    expect(screen.queryByRole("toolbar", { name: "참조" })).not.toBeInTheDocument();

    await act(async () => { sessions.select(3); await flush(); });
    expectConsistentTabs("홈");

    // 활성 DOCX를 닫으면 이웃(HWPX)이 활성이 되고 DOCX 전용 탭이 사라진다.
    await user.click(ribbonTabs().getByRole("tab", { name: "편지" }));
    expectConsistentTabs("편지");
    await act(async () => { await workspace.close(3, { discard: true }); await flush(); });
    expect(sessions.snapshot().activeId).toBe(2);
    expect(ribbonTabNames()).toEqual(HANGUL);
    expectConsistentTabs("홈");

    // 모두 닫으면 공통 탭만 남는다.
    await act(async () => {
      await workspace.close(2, { discard: true });
      await workspace.close(1, { discard: true });
      await flush();
    });
    expect(sessions.snapshot().activeId).toBeNull();
    expect(ribbonTabNames()).toEqual(COMMON);
    expectConsistentTabs("홈");
  });

  it("A07 사라진 탭에 초점이 있었어도 초점이 사라진 요소·body에 남지 않는다(앱: 편집 표면이 받거나, 받을 곳이 없으면 고른 탭)", async () => {
    const { user, sessions, workspace } = await renderMixed(["/a.hwp", "/c.docx"]);
    // 열린 문서의 편집 입력이 초점을 가진다: 탭을 포인터로 눌러도 초점은 편집 입력에 남는다(경계 C). 키보드 사용자처럼 탭에 초점을 둔다.
    expect(document.activeElement).toHaveClass("rhwp-input");
    const references = ribbonTabs().getByRole("tab", { name: "참조" });
    await user.click(references);
    expect(document.activeElement).toHaveClass("rhwp-input");
    references.focus();
    expect(references).toHaveFocus();
    // 다른 형식 문서로 바꾸면 그 편집 표면이 초점을 받는다(기존 표면 동작). 사라진 탭에 남지 않는다.
    await act(async () => { sessions.select(1); await flush(); });
    expect(references).not.toBeInTheDocument();
    expect(document.activeElement).toHaveClass("rhwp-input");
    expectConsistentTabs("홈");

    // 마지막 문서를 닫아 초점을 받을 편집 표면이 없으면 리본이 고른 탭으로 옮긴다.
    await act(async () => { await workspace.close(1, { discard: true }); await flush(); });
    await user.click(ribbonTabs().getByRole("tab", { name: "참조" }));
    ribbonTabs().getByRole("tab", { name: "참조" }).focus();
    await act(async () => { await workspace.close(3, { discard: true }); await flush(); });
    expect(sessions.snapshot().activeId).toBeNull();
    expect(ribbonTabs().getByRole("tab", { name: "홈" })).toHaveFocus();
  });

  it("A08 화살표·Home·End는 보이는 탭 사이만 돈다", async () => {
    const { user } = await renderMixed(["/a.hwp"]);
    ribbonTabs().getByRole("tab", { name: "레이아웃" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(ribbonTabs().getByRole("tab", { name: "한글 도구" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(ribbonTabs().getByRole("tab", { name: "검토" })).toHaveFocus();
    expectConsistentTabs("검토");
    await user.keyboard("{End}");
    expectConsistentTabs("도움말");
    await user.keyboard("{ArrowRight}");
    expectConsistentTabs("파일");
    await user.keyboard("{ArrowLeft}");
    expectConsistentTabs("도움말");
  });
});

describe("T011 리본 명령의 대상과 차단(앱)", () => {
  it("A09/A11/A15 리본 굵게·Ctrl+B는 활성 DOCX 세션에만 가고, 빠르게 바꾼 뒤에는 마지막 활성 문서의 상태로 정한다", async () => {
    const { user, sessions, fake, docs } = await renderMixed();
    const bold = () => screen.getByRole("button", { name: "굵게" });
    expect(bold()).not.toHaveAttribute("aria-disabled");
    await act(async () => { await user.click(bold()); await flush(); });
    expect(docxEdits(fake)).toEqual([[{ op: "format", format: "bold" }]]);

    // DOCX → HWP → HWPX → DOCX → HWPX를 한 번에: 명령은 마지막 활성(HWPX, 2)의 상태로 정해지고 DOCX에 가지 않는다.
    await act(async () => {
      sessions.select(1); sessions.select(2); sessions.select(3); sessions.select(2);
      await flush();
    });
    expect(bold()).toHaveAttribute("aria-disabled", "true");
    expect(bold().title).toContain("이 문서 형식에서 지원하지 않음");
    const hwpx = docs.get("hwpx")!.paragraphs.join("\n");
    await act(async () => { await user.click(bold()); await flush(); });
    expect(statusMessage()).toHaveTextContent("굵게: 이 문서 형식에서는 지원하지 않습니다.");
    document.querySelector<HTMLTextAreaElement>(".rhwp-input")!.focus();
    await act(async () => { await user.keyboard("{Control>}b{/Control}"); await flush(); });
    expect(statusMessage()).toHaveTextContent("굵게: 이 문서 형식에서는 지원하지 않습니다.");
    expect(docxEdits(fake)).toHaveLength(1);
    expect(docs.get("hwpx")!.paragraphs.join("\n")).toBe(hwpx);
    expect(sessions.get(2)).toMatchObject({ revision: 0, dirty: false });

    // 다시 DOCX: 단축키도 리본과 같은 세션·같은 판정.
    await act(async () => { sessions.select(3); await flush(); });
    document.querySelector<HTMLTextAreaElement>(".rhwp-input")!.focus();
    await act(async () => { await user.keyboard("{Control>}b{/Control}"); await flush(); });
    expect(docxEdits(fake)).toHaveLength(2);
    expect(bold()).toHaveAttribute("aria-pressed", "false");
  });

  it("A10/A13 HWP·HWPX에서 실행 취소·다시 실행·글자 서식은 제품 빌드에서 엔진 미지원으로 막히고 모델·revision을 바꾸지 않는다", async () => {
    const { user, sessions, docs } = await renderMixed(["/a.hwp", "/b.hwpx"]);
    for (const id of [1, 2]) {
      await act(async () => { sessions.select(id); await flush(); });
      const format = id === 1 ? "hwp" : "hwpx";
      const before = docs.get(format)!.paragraphs.join("\n");
      for (const name of ["실행 취소", "다시 실행", "굵게", "기울임꼴", "밑줄", "취소선"]) {
        const button = within(screen.getByRole("toolbar", { name: "홈" })).getByRole("button", { name });
        expect(button, `${format} ${name}`).toHaveAttribute("aria-disabled", "true");
        expect(button.title).toContain("이 문서 형식에서 지원하지 않음");
        await act(async () => { await user.click(button); await flush(); });
      }
      expect(docs.get(format)!.paragraphs.join("\n")).toBe(before);
      expect(sessions.get(id)).toMatchObject({ revision: 0, dirty: false });
    }
    // 저장은 두 엔진에서 지원(T009 저장 절차) — 연결 상태만 확인하고 실행하지 않는다.
    expect(within(screen.getByRole("toolbar", { name: "홈" })).queryByRole("button", { name: "저장" })).toBeNull();
    await user.click(ribbonTabs().getByRole("tab", { name: "파일" }));
    expect(within(screen.getByRole("toolbar", { name: "파일" })).getByRole("button", { name: "저장" })).not.toHaveAttribute("aria-disabled");
  });
});

describe("T011 리본 누름과 편집 입력의 초점·조합(경계 C, 합성 사건)", () => {
  it("A14 HWP 조합 중 리본 탭·접기 단추·명령 단추를 눌러도 편집 입력의 초점과 조합이 그대로이고 확정은 그 문서에 한 번 들어간다", async () => {
    const { sessions, workspace, docs } = await renderMixed(["/a.hwp", "/c.docx"]);
    await act(async () => { sessions.select(1); await flush(); });
    const input = document.querySelector<HTMLTextAreaElement>(".rhwp-input")!;
    input.focus();
    const editor = workspace.editorFor(1)!;
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      input.value = "하";
      input.dispatchEvent(new InputEvent("input", { data: "하", inputType: "insertCompositionText", isComposing: true, bubbles: true }));
    });
    expect(editor.composing).toBe(true);

    for (const target of [
      ribbonTabs().getByRole("tab", { name: "삽입" }),
      screen.getByRole("button", { name: "리본 접기" }),
    ]) {
      // 포인터 누름의 기본 동작(초점 옮김)을 막는다: fireEvent는 막혔으면 false.
      expect(fireEvent.mouseDown(target)).toBe(false);
      expect(input).toHaveFocus();
    }
    act(() => void ribbonTabs().getByRole("tab", { name: "삽입" }).click());
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("삽입");
    expect(input).toHaveFocus();
    act(() => void ribbonTabs().getByRole("tab", { name: "홈" }).click());
    const bold = screen.getByRole("button", { name: "굵게" });
    expect(fireEvent.mouseDown(bold)).toBe(false);
    act(() => void bold.click());
    expect(statusMessage()).toHaveTextContent("굵게:");
    expect(input).toHaveFocus();
    expect(editor.composing).toBe(true);
    expect(editor.compositionText).toBe("하");

    act(() => {
      input.value = "하";
      input.dispatchEvent(new CompositionEvent("compositionend", { data: "하" }));
    });
    await act(flush);
    expect(editor.composing).toBe(false);
    expect(docs.get("hwp")!.paragraphs[0]).toBe("하hwp 본문");
    expect(sessions.get(1)?.revision).toBe(1);
    expect(sessions.get(3)).toMatchObject({ revision: 0, dirty: false });
  });

  it("편집 입력 밖(리본 안·다른 입력 칸)에 초점이 있으면 탭 누름의 기본 동작을 막지 않는다(키보드·포인터 접근성 유지)", async () => {
    await renderMixed(["/c.docx"]);
    const insert = ribbonTabs().getByRole("tab", { name: "삽입" });
    pathInput().focus();
    expect(fireEvent.mouseDown(insert)).toBe(true);
    insert.focus();
    expect(fireEvent.mouseDown(ribbonTabs().getByRole("tab", { name: "참조" }))).toBe(true);
  });
});

describe("T011 리본 구성 요소", () => {
  function renderRibbon(context: Partial<CommandContext>, format: DocumentFormat | null) {
    const notices: Message[] = [];
    const full: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: (message) => notices.push(message), document: null, ...context };
    const view = render(
      <LanguageProvider language="en" onLanguageChange={() => {}}>
        <Ribbon context={full} format={format} />
      </LanguageProvider>,
    );
    return { view, notices, full };
  }

  it("A12 확인 창이 열린 동안 보이는 모든 탭의 명령은 dialogOpen으로 막히고 실행하지 않는다(탭 고르기도 막힘 — 안정화 B)", async () => {
    const user = userEvent.setup();
    const notices: Message[] = [];
    const context = (modal: boolean): CommandContext => ({ layout: initialLayout, dispatch: () => {}, notify: (m) => notices.push(m), document: null, modal });
    const tree = (modal: boolean) => (
      <LanguageProvider language="en" onLanguageChange={() => {}}>
        <Ribbon context={context(modal)} format="docx" />
      </LanguageProvider>
    );
    const view = render(tree(false));
    const tabs = () => within(screen.getByRole("tablist", { name: "Ribbon tabs" })).getAllByRole("tab");
    const labels = tabs().map((tab) => tab.textContent!);
    expect(labels).toContain("References");
    for (const label of labels) {
      // 탭은 창이 없을 때 고르고(창이 열린 동안의 탭 고르기는 막힌다), 그 탭의 명령을 창이 열린 상태로 본다.
      view.rerender(tree(false));
      await user.click(screen.getByRole("tab", { name: label }));
      view.rerender(tree(true));
      for (const button of within(screen.getByRole("tabpanel")).getAllByRole("button")) {
        expect(button, button.dataset.command).toHaveAttribute("aria-disabled", "true");
        expect(button.title).toContain("A dialog is open");
      }
      const other = labels.find((candidate) => candidate !== label)!;
      await user.click(screen.getByRole("tab", { name: other }));
      expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    }
    view.rerender(tree(false));
    await user.click(screen.getByRole("tab", { name: "View" }));
    view.rerender(tree(true));
    await user.click(screen.getByRole("button", { name: "Dark Theme" }));
    expect(notices.map((notice) => notice.key)).toEqual(["command.unavailable.dialogOpen"]);
  });

  it("A07 형식이 바뀌어 사라진 탭·그 도구 모음의 초점은 고른 탭으로, 리본 밖·편집 입력의 초점은 그대로", async () => {
    const user = userEvent.setup();
    const context: CommandContext = { layout: initialLayout, dispatch: () => {}, notify: () => {}, document: null };
    const tree = (format: DocumentFormat | null) => (
      <LanguageProvider language="en" onLanguageChange={() => {}}>
        <Ribbon context={context} format={format} />
        <button type="button">outside</button>
        <textarea className="rhwp-input" aria-label="editor input" />
      </LanguageProvider>
    );
    const view = render(tree("docx"));
    const home = () => screen.getByRole("tab", { name: "Home" });

    screen.getByRole("tab", { name: "References" }).focus();
    await user.keyboard("{Enter}");
    view.rerender(tree("hwp"));
    expect(screen.queryByRole("tab", { name: "References" })).not.toBeInTheDocument();
    expect(home()).toHaveFocus();
    expect(home()).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Hangul Tools" }));
    within(screen.getByRole("toolbar", { name: "Hangul Tools" })).getAllByRole("button")[1]!.focus();
    view.rerender(tree(null));
    expect(home()).toHaveFocus();

    view.rerender(tree("docx"));
    await user.click(screen.getByRole("tab", { name: "Mailings" }));
    screen.getByRole("button", { name: "outside" }).focus();
    view.rerender(tree("hwpx"));
    expect(screen.getByRole("button", { name: "outside" })).toHaveFocus();
    expect(home()).toHaveAttribute("aria-selected", "true");

    view.rerender(tree("docx"));
    await user.click(screen.getByRole("tab", { name: "References" }));
    screen.getByRole("textbox", { name: "editor input" }).focus();
    view.rerender(tree(null));
    expect(screen.getByRole("textbox", { name: "editor input" })).toHaveFocus();
  });

  it("A17 영어로 그려도 형식 전용 탭·안내가 번역되고 키가 보이지 않는다", async () => {
    const user = userEvent.setup();
    renderRibbon({}, "hwpx");
    await user.click(screen.getByRole("tab", { name: "Hangul Tools" }));
    expect(screen.getByText("These tools apply to HWP/HWPX documents only.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ribbon\.|command\./);
    expect(screen.getByRole("button", { name: "Collapse ribbon" }).title).toBe("Collapse ribbon (Ctrl+F1)");
  });
});

// ---- T011 안정화(2026-11-04): 리본 빈 곳 누름의 편집 초점(문제 A)·모달 중 리본 배치 명령(문제 B) ----

const editorInput = () => document.querySelector<HTMLTextAreaElement>(".editor__scroll .rhwp-input")!;
/** 리본에서 단추·탭이 아닌 면(그룹 배경·라벨·도구 모음·패널·탭 줄 배경·안내·리본 자체). */
const EMPTY_SURFACES = [".ribbon__panel", ".ribbon__toolbar", ".ribbon__group", ".ribbon__group-label", ".ribbon__group-commands",
  ".ribbon__note", ".ribbon__tabs", ".ribbon__bar", "section.ribbon"];

describe("T011 안정화 A: 리본 빈 곳 누름과 편집 입력 초점", () => {
  it("A1/A2 편집 입력에 초점이 있을 때 리본의 단추가 아닌 면을 실제 클릭해도 초점이 편집 입력에 남고 기본 동작을 막는다", async () => {
    const { user } = await renderMixed(["/a.hwp"]);
    await user.click(ribbonTabs().getByRole("tab", { name: "한글 도구" })); // 안내(ribbon__note)가 있는 탭
    for (const css of EMPTY_SURFACES) {
      editorInput().focus();
      const surface = document.querySelector<HTMLElement>(css)!;
      expect(surface, css).not.toBeNull();
      expect(fireEvent.mouseDown(surface), `${css} mousedown 기본 동작`).toBe(false);
      editorInput().focus();
      await user.click(surface);
      expect(document.activeElement, css).toBe(editorInput());
    }
  });

  it("A3–A5 빈 곳 처리 뒤에도 단추는 실행하고 탭은 바뀌고 접기·펼치기는 동작한다(초점은 편집 입력)", async () => {
    const { user, fake } = await renderMixed(["/c.docx"]);
    editorInput().focus();
    await user.click(document.querySelector<HTMLElement>(".ribbon__group")!);
    await act(async () => { await user.click(screen.getByRole("button", { name: "굵게" })); await flush(); });
    expect(docxEdits(fake)).toEqual([[{ op: "format", format: "bold" }]]);
    await user.click(ribbonTabs().getByRole("tab", { name: "참조" }));
    expectConsistentTabs("참조");
    await user.click(screen.getByRole("button", { name: "리본 접기" }));
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "리본 펼치기" }));
    expectConsistentTabs("참조");
    expect(document.activeElement).toBe(editorInput());
  });

  it("A6 다른 입력 칸(경로)에 초점이 있으면 빈 곳 누름은 막지 않고 편집 입력으로 초점을 끌어오지 않는다", async () => {
    const { user } = await renderMixed(["/c.docx"]);
    pathInput().focus();
    const panel = document.querySelector<HTMLElement>(".ribbon__panel")!;
    expect(fireEvent.mouseDown(panel)).toBe(true);
    pathInput().focus();
    await user.click(panel);
    expect(document.activeElement).not.toBe(editorInput());
    expect(document.activeElement).not.toBe(pathInput()); // 브라우저 기본: 초점 받을 수 없는 곳을 누르면 body
  });

  it("A7 키보드: 리본 탭에서 화살표·도구 모음 이동은 그대로", async () => {
    const { user } = await renderMixed(["/c.docx"]);
    ribbonTabs().getByRole("tab", { name: "홈" }).focus();
    await user.keyboard("{ArrowRight}");
    expectConsistentTabs("삽입");
    expect(ribbonTabs().getByRole("tab", { name: "삽입" })).toHaveFocus();
    await user.keyboard("{Home}");
    expectConsistentTabs("파일");
    const toolbar = screen.getByRole("toolbar", { name: "파일" });
    const buttons = within(toolbar).getAllByRole("button");
    buttons[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
  });

  it("A8–A10 HWP 조합 중 리본 빈 곳을 누르면 조합·초점이 그대로이고 확정은 한 번, 이어 친 글자도 같은 문서에 들어가며 다른 문서는 그대로", async () => {
    const { user, sessions, workspace, docs, fake } = await renderMixed(["/a.hwp", "/b.hwpx", "/c.docx"]);
    await act(async () => { sessions.select(1); await flush(); });
    const input = editorInput();
    input.focus();
    const editor = workspace.editorFor(1)!;
    const compose = (text: string) => act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      input.value = text;
      input.dispatchEvent(new InputEvent("input", { data: text, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
    });
    const commit = async (text: string) => {
      act(() => {
        input.value = text;
        input.dispatchEvent(new CompositionEvent("compositionend", { data: text }));
      });
      await act(flush);
    };
    compose("하");
    for (const css of [".ribbon__panel", ".ribbon__group", ".ribbon__group-label", ".ribbon__toolbar"]) {
      await user.click(document.querySelector<HTMLElement>(css)!);
      expect(document.activeElement, css).toBe(input);
      expect(editor.composing, css).toBe(true);
      expect(editor.compositionText).toBe("하");
    }
    await commit("하");
    expect(docs.get("hwp")!.paragraphs[0]).toBe("하hwp 본문");
    expect(sessions.get(1)?.revision).toBe(1);
    // 이어 친 글자(A9): 같은 문서·같은 자리.
    await user.click(document.querySelector<HTMLElement>(".ribbon__group")!);
    compose("글");
    await commit("글");
    expect(docs.get("hwp")!.paragraphs[0]).toBe("하글hwp 본문");
    expect(sessions.get(1)?.revision).toBe(2);
    expect(document.activeElement).toBe(input);
    // A10: 다른 문서는 그대로.
    expect(docs.get("hwpx")!.paragraphs[0]).toBe("hwpx 본문");
    expect(sessions.get(2)).toMatchObject({ revision: 0, dirty: false });
    expect(sessions.get(3)).toMatchObject({ revision: 0, dirty: false });
    expect(docxEdits(fake)).toEqual([]);
  });
});

describe("T011 안정화 B: 모달 중 리본 배치 명령", () => {
  const collapseButton = () => document.querySelector<HTMLButtonElement>(".ribbon__collapse")!;
  const expanded = () => collapseButton().getAttribute("aria-expanded") === "true" && screen.queryByRole("tabpanel") !== null;

  /** DOCX를 고쳐 둔 뒤 탭 닫기 단추를 눌러 버리기 확인 창(모달)을 연다. */
  async function openDiscardDialog(harness: Awaited<ReturnType<typeof renderMixed>>) {
    await act(async () => { harness.workspace.docxEditorFor(3)!.typeText("x"); await flush(); });
    const opener = document.activeElement;
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".document-tab[data-active=true] .document-tab__close")!.click();
      await flush();
    });
    const dialog = screen.getByRole("alertdialog");
    expect(screen.getByTestId("discard-cancel")).toHaveFocus();
    return { dialog, opener };
  }

  it("B1/B2 모달이 없으면 접기 단추와 Ctrl+F1이 같은 결과(접기·펼치기)를 낸다", async () => {
    const { user } = await renderMixed(["/c.docx"]);
    await user.click(collapseButton());
    expect(expanded()).toBe(false);
    await user.keyboard("{Control>}{F1}{/Control}");
    expect(expanded()).toBe(true);
    await user.keyboard("{Control>}{F1}{/Control}");
    expect(expanded()).toBe(false);
    await user.click(collapseButton());
    expect(expanded()).toBe(true);
  });

  it("B3–B6/B8–B10 모달 중: 접기 단추·탭(직접 클릭 포함)·Ctrl+F1은 배치·선택을 바꾸지 않고 문서 명령·알림·초점 이동도 없다", async () => {
    const harness = await renderMixed(["/a.hwp", "/c.docx"]);
    const { user, fake, sessions } = harness;
    // 펼친 리본에서(홈 선택) 모달.
    const { opener } = await openDiscardDialog(harness);
    const cancel = screen.getByTestId("discard-cancel");
    const message = statusMessage().textContent;
    const editsBefore = docxEdits(fake).length;
    const revision = sessions.get(3)!.revision;
    // 합성 직접 클릭(실제 포인터는 배경이 막지만 그것에 기대지 않는다)과 Ctrl+F1: 배치·선택·알림·초점 모두 그대로.
    act(() => collapseButton().click());
    act(() => ribbonTabs().getByRole("tab", { name: "삽입" }).click());
    await user.keyboard("{Control>}{F1}{/Control}");
    await act(flush);
    expect(expanded()).toBe(true);
    expectConsistentTabs("홈");
    expect(statusMessage().textContent).toBe(message);
    expect(cancel).toHaveFocus();
    // B9: 문서 명령(굵게)은 공통 실행 경계가 dialogOpen으로 거절한다(기존 CommandButton 계약: 이유만 알림, 문서 그대로).
    act(() => screen.getByRole("button", { name: "굵게" }).click());
    await act(flush);
    expect(statusMessage()).toHaveTextContent("굵게: 확인 창을 닫은 뒤 다시 시도하세요.");
    expect(docxEdits(fake)).toHaveLength(editsBefore);
    expect(sessions.get(3)!.revision).toBe(revision);
    expect(cancel).toHaveFocus();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // B8: 모달 안 Tab은 창 안에서 돌고 Escape는 취소(창 닫힘)·초점 복원.
    await user.keyboard("{Tab}");
    expect(screen.getByTestId("discard-confirm")).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    await act(flush);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener); // 기존 계약: 창을 열기 전 초점 요소로 복원(여기서는 편집 입력)
    expect(opener).toBe(editorInput());
    // B7: 닫힌 뒤에는 보통처럼 동작.
    await user.click(ribbonTabs().getByRole("tab", { name: "삽입" }));
    expectConsistentTabs("삽입");
    await user.click(collapseButton());
    expect(expanded()).toBe(false);
  });

  it("B5 모달 중 접힌 리본: 탭 클릭은 펼치지도 선택을 바꾸지도 않고, 모달이 닫히면 탭 클릭이 펼친다", async () => {
    const harness = await renderMixed(["/c.docx"]);
    const { user } = harness;
    await user.click(collapseButton());
    expect(expanded()).toBe(false);
    await openDiscardDialog(harness);
    act(() => ribbonTabs().getByRole("tab", { name: "참조" }).click());
    act(() => collapseButton().click());
    await user.keyboard("{Control>}{F1}{/Control}");
    expect(expanded()).toBe(false);
    expect(ribbonTabs().getByRole("tab", { name: "홈" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("discard-cancel")).toHaveFocus();
    await user.keyboard("{Escape}");
    await act(flush);
    await user.click(ribbonTabs().getByRole("tab", { name: "참조" }));
    expect(expanded()).toBe(true);
    expectConsistentTabs("참조");
  });

  it("B6 구성 요소 직접: modal 문맥이면 접기 단추·탭 클릭이 dispatch를 부르지 않고, 아니면 view.ribbon 명령(toggleRibbon)으로 간다", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const notices: Message[] = [];
    const tree = (modal: boolean, collapsed: boolean) => (
      <LanguageProvider language="en" onLanguageChange={() => {}}>
        <Ribbon context={{ layout: { ...initialLayout, ribbonCollapsed: collapsed }, dispatch, notify: (m) => notices.push(m), document: null, modal }} format="docx" />
      </LanguageProvider>
    );
    const view = render(tree(true, true));
    await user.click(screen.getByRole("button", { name: "Expand ribbon" }));
    await user.click(screen.getByRole("tab", { name: "References" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
    view.rerender(tree(true, false));
    await user.click(screen.getByRole("button", { name: "Collapse ribbon" }));
    await user.click(screen.getByRole("tab", { name: "References" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
    expect(notices).toEqual([]);
    view.rerender(tree(false, false));
    await user.click(screen.getByRole("button", { name: "Collapse ribbon" }));
    expect(dispatch.mock.calls).toEqual([[{ type: "toggleRibbon" }]]);
    view.rerender(tree(false, true));
    await user.click(screen.getByRole("tab", { name: "References" }));
    expect(dispatch.mock.calls.at(-1)).toEqual([{ type: "setRibbonCollapsed", collapsed: false }]);
    expect(screen.getByRole("tab", { name: "References" })).toHaveAttribute("aria-selected", "true");
    expect(notices).toEqual([]);
  });
});

// ---- 문서 탭·탭 닫기 단추 누름과 편집 입력 초점(2026-11-04, 경계 C를 문서 탭 줄에 확장). 같은 세 형식 작업 공간을 쓴다. ----

describe("문서 탭 줄 누름과 편집 입력 초점", () => {
  const docTab = (name: string) => [...document.querySelectorAll<HTMLElement>(".document-tab__select")]
    .find((tab) => tab.textContent!.includes(name) && !tab.textContent!.includes(`${name}x`))!;
  const closeOf = (name: string) => docTab(name).parentElement!.querySelector<HTMLElement>(".document-tab__close")!;

  it("D1 편집 입력에 초점이 있으면 문서 탭·닫기 단추·탭 줄 빈 곳 누름의 기본 동작을 막고, 탭을 누르면 문서만 바뀌고 초점은 새 문서의 편집 입력", async () => {
    const { user, sessions } = await renderMixed(["/a.hwp", "/b.hwpx", "/c.docx"]);
    for (const target of [docTab("a.hwp"), closeOf("b.hwpx"), document.querySelector<HTMLElement>(".document-tabs")!]) {
      editorInput().focus();
      expect(fireEvent.mouseDown(target), target.className).toBe(false);
    }
    editorInput().focus();
    await act(async () => { await user.click(docTab("a.hwp")); await flush(); });
    expect(sessions.snapshot().activeId).toBe(1);
    expect(document.activeElement).toBe(editorInput());
    expect(document.activeElement).not.toBe(docTab("a.hwp"));
    // 이미 활성인 탭을 다시 눌러도 초점은 편집 입력에 남는다.
    await act(async () => { await user.click(docTab("a.hwp")); await flush(); });
    expect(document.activeElement).toBe(editorInput());
  });

  it("D2 HWP 조합 중 HWPX 탭을 누르면 조합은 HWP에 한 번 확정되고 HWPX·DOCX는 그대로, 이어 친 글자는 HWPX에 들어간다", async () => {
    const { user, sessions, workspace, docs, fake } = await renderMixed(["/a.hwp", "/b.hwpx", "/c.docx"]);
    await act(async () => { sessions.select(1); await flush(); });
    let input = editorInput();
    input.focus();
    act(() => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      input.value = "하";
      input.dispatchEvent(new InputEvent("input", { data: "하", inputType: "insertCompositionText", isComposing: true, bubbles: true }));
    });
    expect(workspace.editorFor(1)!.composing).toBe(true);
    await act(async () => { await user.click(docTab("b.hwpx")); await flush(); });
    expect(sessions.snapshot().activeId).toBe(2);
    expect(docs.get("hwp")!.paragraphs[0]).toBe("하hwp 본문");
    expect(docs.get("hwpx")!.paragraphs[0]).toBe("hwpx 본문");
    input = editorInput();
    expect(document.activeElement).toBe(input);
    // 새 문서에서 이어 친 글자(새 조합)는 HWPX에만.
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, isComposing: false, bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      input.value = "글";
      input.dispatchEvent(new InputEvent("input", { data: "글", inputType: "insertCompositionText", isComposing: true, bubbles: true }));
      input.dispatchEvent(new CompositionEvent("compositionend", { data: "글" }));
    });
    await act(flush);
    expect(docs.get("hwpx")!.paragraphs[0]).toBe("글hwpx 본문");
    expect(docs.get("hwp")!.paragraphs[0]).toBe("하hwp 본문");
    expect(docxEdits(fake)).toEqual([]);
  });

  it("D3 다른 입력 칸(경로)에 초점이 있으면 문서 탭 누름을 막지 않는다(전과 같이 탭이 초점을 받음)", async () => {
    const { user } = await renderMixed(["/a.hwp", "/c.docx"]);
    pathInput().focus();
    expect(fireEvent.mouseDown(docTab("a.hwp"))).toBe(true);
    pathInput().focus();
    await act(async () => { await user.click(closeOf("c.docx")); await flush(); });
    // 깨끗한 DOCX는 바로 닫히고(확인 없음) 남은 HWP 표면이 초점을 받는다(기존 표면 동작).
    expect(document.querySelector(".document-tab__select")!.textContent).toContain("a.hwp");
  });

  it("D4 키보드: 문서 탭에 초점을 두고 Enter로 고르면 그대로 동작한다", async () => {
    const { user, sessions } = await renderMixed(["/a.hwp", "/c.docx"]);
    docTab("a.hwp").focus();
    await act(async () => { await user.keyboard("{Enter}"); await flush(); });
    expect(sessions.snapshot().activeId).toBe(1);
  });

  it("D5 편집 중 고친 문서의 닫기 단추를 누르면 확인 창이 초점을 받고, 취소하면 초점이 편집 입력으로 돌아온다", async () => {
    const { user, workspace } = await renderMixed(["/a.hwp", "/c.docx"]);
    await act(async () => { workspace.docxEditorFor(3)!.typeText("x"); await flush(); });
    const input = editorInput();
    input.focus();
    await act(async () => { await user.click(closeOf("c.docx")); await flush(); });
    expect(screen.getByTestId("discard-cancel")).toHaveFocus();
    await user.keyboard("{Escape}");
    await act(flush);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(editorInput());
  });
});

// ---- 모달 중 리본 키보드 이동(2026-11-04, T011 마무리): 클릭과 같이 키보드 roving도 모달 경계를 따른다 ----

describe("모달 중 리본 키보드 이동", () => {
  function renderModalRibbon(modal: boolean) {
    const dispatch = vi.fn();
    const notices: Message[] = [];
    const tree = (isModal: boolean, format: DocumentFormat | null = "docx") => (
      <LanguageProvider language="en" onLanguageChange={() => {}}>
        <Ribbon context={{ layout: initialLayout, dispatch, notify: (m) => notices.push(m), document: null, modal: isModal }} format={format} />
      </LanguageProvider>
    );
    const view = render(tree(modal));
    return { view, tree, dispatch, notices };
  }
  const tabState = () => {
    const tabs = within(screen.getByRole("tablist", { name: "Ribbon tabs" })).getAllByRole("tab");
    return {
      selected: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => tab.textContent),
      stops: tabs.filter((tab) => tab.tabIndex === 0).map((tab) => tab.textContent),
      panel: screen.queryByRole("tabpanel")?.getAttribute("aria-labelledby") ?? null,
    };
  };

  it("A01–A05 모달 중 탭 줄에 화살표·Home·End가 와도 선택·roving tabIndex·DOM 초점·배치가 바뀌지 않는다", () => {
    const { dispatch, notices } = renderModalRibbon(true);
    const home = screen.getByRole("tab", { name: "Home" });
    home.focus(); // 시험이 일부러 둔 초점(모달이 초점을 가두는 실제 앱에서는 닿기 어려운 경로)
    const before = tabState();
    expect(before).toEqual({ selected: ["Home"], stops: ["Home"], panel: "ribbon-tab-home" });
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      const notPrevented = fireEvent.keyDown(home, { key });
      expect(tabState(), key).toEqual(before);
      expect(document.activeElement, key).toBe(home); // 처리기가 초점을 옮기지 않음
      expect(notPrevented, key).toBe(true); // 막힌 이동은 기본 동작도 건드리지 않는다
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it("A05 모달 중 도구 모음의 화살표도 단추 사이 초점·tabIndex를 바꾸지 않는다", () => {
    renderModalRibbon(true);
    const toolbar = screen.getByRole("toolbar", { name: "Home" });
    const buttons = within(toolbar).getAllByRole("button");
    const stops = () => buttons.map((button) => button.tabIndex);
    buttons[0]!.focus();
    const before = stops();
    for (const key of ["ArrowRight", "End", "Home", "ArrowLeft"]) {
      fireEvent.keyDown(buttons[0]!, { key });
      expect(document.activeElement, key).toBe(buttons[0]);
      expect(stops(), key).toEqual(before);
    }
  });

  it("A06 모달이 닫히면 화살표·Home·End·도구 모음 이동이 다시 동작한다", async () => {
    const user = userEvent.setup();
    const { view, tree } = renderModalRibbon(true);
    view.rerender(tree(false));
    screen.getByRole("tab", { name: "Home" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(tabState()).toEqual({ selected: ["Insert"], stops: ["Insert"], panel: "ribbon-tab-insert" });
    expect(screen.getByRole("tab", { name: "Insert" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(tabState().selected).toEqual(["Help"]);
    await user.keyboard("{Home}");
    expect(tabState().selected).toEqual(["File"]);
    await user.keyboard("{ArrowLeft}");
    expect(tabState().selected).toEqual(["Help"]);
    const buttons = within(screen.getByRole("toolbar", { name: "Help" })).getAllByRole("button");
    buttons[0]!.focus();
    await user.keyboard("{End}");
    expect(buttons.at(-1)).toHaveFocus();
  });

  it("A09 모달 중에도 형식 변경으로 사라진 탭의 대신 고르기(내부 맞춤)는 한다", async () => {
    const user = userEvent.setup();
    const { view, tree } = renderModalRibbon(false);
    await user.click(screen.getByRole("tab", { name: "References" }));
    view.rerender(tree(true, "hwpx"));
    expect(screen.queryByRole("tab", { name: "References" })).toBeNull();
    expect(tabState()).toEqual({ selected: ["Home"], stops: ["Home"], panel: "ribbon-tab-home" });
  });
});

describe("모달 중 리본 키보드 이동(앱, 버리기 확인 창)", () => {
  it("A07/A08/A10 창이 열린 동안 탭 줄로 옮겨진 초점에서 화살표를 눌러도 리본·문서가 그대로이고, 창의 Tab·Escape·복원은 그대로", async () => {
    const harness = await renderMixed(["/a.hwp", "/c.docx"]);
    const { user, fake, sessions, workspace } = harness;
    await act(async () => { workspace.docxEditorFor(3)!.typeText("x"); await flush(); });
    const opener = document.activeElement;
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".document-tab[data-active=true] .document-tab__close")!.click();
      await flush();
    });
    const cancel = screen.getByTestId("discard-cancel");
    expect(cancel).toHaveFocus();
    const message = statusMessage().textContent;
    const edits = docxEdits(fake).length;
    const revision = sessions.get(3)!.revision;
    const home = ribbonTabs().getByRole("tab", { name: "홈" });
    act(() => home.focus()); // 창 밖으로 초점을 옮기는 프로그램 조작(시험)
    for (const key of ["{ArrowRight}", "{ArrowLeft}", "{Home}", "{End}"]) {
      await user.keyboard(key);
      expectConsistentTabs("홈");
      expect(home).toHaveFocus();
    }
    // A07: 클릭·Ctrl+F1 제한은 그대로.
    act(() => ribbonTabs().getByRole("tab", { name: "삽입" }).click());
    act(() => document.querySelector<HTMLButtonElement>(".ribbon__collapse")!.click());
    await user.keyboard("{Control>}{F1}{/Control}");
    expectConsistentTabs("홈");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
    // A10: 문서·알림 그대로.
    expect(docxEdits(fake)).toHaveLength(edits);
    expect(sessions.get(3)!.revision).toBe(revision);
    expect(statusMessage().textContent).toBe(message);
    // A08: 창으로 돌아가면 Tab 가두기·Escape·복원이 그대로.
    act(() => cancel.focus());
    await user.keyboard("{Tab}");
    expect(screen.getByTestId("discard-confirm")).toHaveFocus();
    await user.keyboard("{Escape}");
    await act(flush);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    // 닫힌 뒤 키보드 이동은 다시 동작한다.
    ribbonTabs().getByRole("tab", { name: "홈" }).focus();
    await user.keyboard("{ArrowRight}");
    expectConsistentTabs("삽입");
  });
});
