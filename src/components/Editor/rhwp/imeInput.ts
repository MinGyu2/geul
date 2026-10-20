// 입력 textarea의 키보드·IME 이벤트를 편집 세션 연산으로 바꾸는 규칙(T007 안정화). DOM에 묶이지 않는다.
//
// 조합 하나(트랜잭션)는 끝이 정확히 한 번이다: 확정(글자를 남기고 변경 하나) 또는 취소(남기지 않음).
// - 조합 중 input(isComposing)은 문서의 조합 범위를 바꾼다. 시작 이벤트 없이 와도 그 자리에서 조합을 시작한다
//   (실측 WebKitGTK 2.54 + ibus-hangul: compositionstart·compositionupdate 없이 input과 compositionend만 온다).
// - compositionend는 진행 중인 조합을 끝낸다. 조합이 없는데 새 입력 경계 전 공유 완료 기록이 있으면 중복
//   끝이므로 무시한다. 그렇지 않은 시작 없는 확정은 그 자리에 넣는다. 빈 확정은 취소다(글자를 넣지 않음).
// - 완료 기록을 유지한 동안 같은 글자로 오는 input(insertFromComposition·insertCompositionText, isComposing=false)은
//   같은 조합의 뒤따르는 알림(Safari 계열)이라 무시한다. 글자가 같다는 것만으로는 버리지 않는다(붙여넣기·일반 입력의
//   같은 글자는 새 입력이다).
// - 클릭(pointerDown)·초점 잃음(blur)·표면 사라짐(detach)은 진행 중인 조합을 끊는다(중단된 트랜잭션). 페이지에 조합
//   글자가 보이면 그것을 원래 자리에 확정한다(finalized). 보이지 않으면(미리보기 없는 플랫폼, 클릭만) 클릭 전 커서를
//   기억하고 IME가 늦게 보내는 그 조합의 확정을 그 자리에 한 번 넣는다. 중단된 트랜잭션의 늦은 이벤트(조합 입력,
//   조합 계열의 조합 아닌 input, compositionend)는 새 입력이 아니다: 확정은 원래 문서·자리에 최대 한 번이고, 이미
//   확정했으면 소비한다. 트랜잭션은 새 입력의 시작(keydown·compositionstart·조합 계열이 아닌
//   input)으로 닫힌다. 클릭 뒤 keydown이 먼저 오면 그 뒤 확정이 옛 조합인지 새 조합인지 페이지는 알 수 없으므로 새
//   입력으로 다룬다(preedit 없는 플랫폼의 실측: 미리보기만 바꾸는 키는 keydown도 없다). blur()가 플랫폼 IME 조합을 바로
//   끝낸다고 가정하지 않는다(늦은 이벤트는 위 규칙으로 처리).
// - 보이던 조합을 앱이 확정한 경우(클릭·초점 잃음·표면 사라짐)에는 입력기가 그 조합을 끝내며 보내는 꼬리를 기다린다.
//   실측 WebKitGTK 2.54 + ibus-hangul(preedit 사용, editor-surface-decision.md): 클릭의 mousedown이 먼저 오고, 그 뒤
//   keydown(229) → input(deleteCompositionText) → compositionend("") → keydown(229) → input(insertFromComposition, 최종
//   글자) → compositionend(최종 글자)가 온다. 이 꼬리의 229 keydown과 빈 끝은 트랜잭션을 닫지 않고, 최종 글자의 끝에서
//   닫는다(클릭한 곳에 다시 넣지 않음). 최종 글자가 앱이 확정한 글자와 다르면(페이지가 입력을 따라가지 못한 채 클릭)
//   원래 자리의 글자를 입력기의 최종 글자로 고친다(변경 하나 더). 꼬리 없이 새 조합 시작·입력기가 처리하지 않은 키·조합
//   계열이 아닌 input이 오면 닫는다(앱이 확정한 글자는 남김).
// - WebView가 스스로 확정한 조합(조합 중에 insertFromComposition이 옴, 실측: 창 초점 잃음)은 입력기가 같은 조합을 한 번 더
//   확정한다(WebKitGTK 2.54 + ibus: tao/wry 없는 탐침의 일반 textarea에도 '하하'가 남음). 그 끝 뒤 229 keydown만 지나 조합
//   시작 없이 오는 같은 글자의 insertFromComposition과 그 끝은 소비한다. 새 조합 시작·입력기가 처리하지 않은 키·다른 입력은
//   이 기록을 지운다(사용자가 다시 친 같은 음절은 조합 시작과 함께 오므로 남는다).
// - 조합이 끝 이벤트 없이 편집 세션 쪽에서 끝나면(엔진 예외·편집 중지) 그 조합의 늦은 이벤트도 끊긴 트랜잭션의 것이다
//   (이미 끝남): 다시 불러온 모델이나 이어진 편집에 넣지 않는다. 끝의 완료 기록은 IME가 보낸 최종 글자로 남긴다(실패해
//   문서에 남지 않았어도 같은 조합의 뒤따르는 알림을 소비).
// - IME 입력 문맥은 WebView에 하나이므로 중단·정상 완료 기록은 편집 표면 사이에서 공유한다(ImeContext). 탭을 바꾼 뒤
//   새 표면에 도착한 옛 조합의 늦은 확정은 새 문서에 넣지 않는다. 페이지가 받지 못한 조합(이벤트가 없음)은 이 규칙으로
//   막을 수 없다(플랫폼 한계, editor-surface-decision.md).
// - 이 규칙은 엔진과 무관하다(T008): rhwp 편집 세션(T007, 조합 글자를 문서 모델에 넣음)과 WordCraft 편집 세션(T008, 조합
//   글자를 커서 자리에 겹쳐 그리고 확정만 백엔드에 보냄)이 같은 ImeSession 계약으로 쓴다. 세션 사이의 끊긴 조합도 같은
//   ImeContext로 다룬다(자리 값은 그 자리를 만든 세션만 해석한다).

/** 조합을 받는 편집 세션. 자리(markCaret이 돌려준 값)는 그 세션의 insertCommittedAt에만 돌려준다. */
export interface ImeSession {
  readonly composing: boolean;
  readonly compositionText: string;
  /** 지금 커서 자리. 끊긴 조합의 늦은 확정을 넣을 자리로 기억한다(클릭 직전). */
  markCaret(): unknown;
  beginComposition(): void;
  updateComposition(text: string): void;
  endComposition(finalText: string, options?: { provisional?: boolean }): string;
  insertCommittedAt(at: unknown, text: string): boolean;
  resolveProvisional(finalText?: string): void;
  typeText(text: string): boolean;
}

type Session = ImeSession;

/** 끊긴 조합. finalized면 이미 확정(또는 취소)했고, 아니면 늦게 올 확정을 session의 anchor에 넣는다(text = 마지막 조합 입력).
 * visible은 페이지에 보이던 조합을 앱이 확정한 경우다: 입력기가 그 조합을 끝내며 보내는 꼬리(아래 ImeInput 설명)를 기다린다. */
type Interrupted =
  | { finalized: true; text: string; visible?: VisibleTail }
  | { finalized: false; session: Session; anchor: unknown; text: string; split?: true };

/** 앱이 먼저 끝낸 보이는 조합. 글자는 session 모델에 있고 아직 세지 않았다(session.resolveProvisional로 끝냄). */
interface VisibleTail {
  session: Session;
  /** 꼬리에 빈 끝(입력기의 조합 지우기)이 왔다. */
  emptied?: boolean;
  /** 빈 끝 없이 확정 입력이 왔다: WebView가 스스로 확정했고 입력기의 확정이 한 번 더 올 수 있다. */
  confirmedByView?: boolean;
}

/** WebView 하나의 IME 문맥. 완료 기록은 문자열 하나만 유지하며 모델 참조를 갖지 않는다.
 * keydown·compositionstart·새 조합 입력·일반 입력이 새 트랜잭션 경계다. 그 전의 같은 조합 계열 후속 알림은
 * 완료한 트랜잭션에 속한다. 네이티브 transaction ID가 없으므로 경계 없이 온 독립된 같은 확정은 구별할 수 없다.
 */
export class ImeContext {
  interrupted: Interrupted | null = null;
  /** confirmedByView: WebView가 스스로 확정해 끝난 조합(입력기가 같은 조합을 한 번 더 확정할 수 있음). */
  terminal: { text: string; confirmedByView?: true } | null = null;
}

const COMPOSITION_INPUT_TYPES = new Set(["insertFromComposition", "insertCompositionText"]);

export class ImeInput {
  /** 진단 추적용 상태(T010 마무리 안정화, imeTrace.ts). 글자는 담지 않는다. */
  phase(): Record<string, string | boolean> {
    const interrupted = this.context.interrupted;
    const terminal = this.context.terminal;
    return {
      composing: this.session.composing,
      interrupted: !interrupted ? "none"
        : interrupted.finalized ? (interrupted.visible ? (interrupted.visible.emptied ? "visibleEmptied" : "visible") : "finalized")
        : interrupted.split ? "split" : interrupted.text ? "anchoredText" : "anchored",
      terminal: !terminal ? "none" : terminal.text ? (terminal.confirmedByView ? "textByView" : "text") : "empty",
    };
  }

  constructor(
    private readonly session: Session,
    private readonly context: ImeContext = new ImeContext(),
  ) {}

  /** keydown. ime는 입력기가 처리 중인 키(keyCode 229 또는 isComposing)다. */
  keyDown(ime = false): void {
    // WebView가 스스로 확정한 조합 뒤 입력기가 같은 조합을 다시 확정할 때도 그 앞에 229 keydown이 온다.
    if (!(ime && this.context.terminal?.confirmedByView)) this.context.terminal = null;
    // 보이는 조합을 앱이 확정한 뒤 입력기가 그 조합을 끝내는 꼬리, 빈 끝과 확정 절반 사이의 클릭 뒤에도 229 keydown이
    // 섞여 온다(새 입력이 아님).
    const interrupted = this.context.interrupted;
    if (ime && interrupted && (interrupted.finalized ? interrupted.visible : interrupted.split)) return;
    this.settleInterrupted();
  }

  compositionStart(): void {
    this.settleInterrupted();
    this.context.terminal = null;
    this.viewConfirming = false;
    this.session.beginComposition();
  }

  /** 진행 중인 조합에 확정 입력(insertFromComposition)이 왔다: 입력기가 아니라 WebView가 조합을 확정하고 있다. */
  private viewConfirming = false;

  /** input 이벤트. text는 textarea 값(조합 중) 또는 입력된 글자. */
  input(text: string, inputType: string, isComposing: boolean): void {
    const session = this.session;
    const compositionType = COMPOSITION_INPUT_TYPES.has(inputType);
    const interrupted = this.context.interrupted;
    if (!session.composing && interrupted && (isComposing || compositionType)) {
      // 끊긴 조합의 늦은 이벤트: 클릭한 자리·다른 문서에 넣지 않는다.
      if (isComposing) {
        if (!interrupted.finalized) interrupted.text = text;
        else if (interrupted.visible && inputType === "insertFromComposition" && !interrupted.visible.emptied) {
          interrupted.visible.confirmedByView = true;
        }
        return;
      }
      // 조합 아닌 확정 입력(Safari 순서): 원래 자리에 한 번 넣고, 뒤따를 compositionend는 소비하도록 남겨 둔다.
      if (!interrupted.finalized && text) interrupted.session.insertCommittedAt(interrupted.anchor, text);
      // 앱이 먼저 끝낸 보이는 조합이면 이 입력이 입력기의 최종 글자다: 원래 자리를 고치고 그 조합을 한 번 센다.
      if (interrupted.finalized && interrupted.visible) {
        if (!text) return; // 글자 없는 알림은 끝을 정하지 않는다
        interrupted.visible.session.resolveProvisional(text);
        this.context.terminal = { text };
      }
      this.context.interrupted = { finalized: true, text: "" };
      return;
    }
    const terminal = this.context.terminal;
    if (!session.composing && isComposing && inputType === "insertFromComposition" && terminal?.confirmedByView
      && terminal.text === text) {
      // WebView가 확정한 조합을 입력기가 같은 글자로 한 번 더 확정했다(실측 WebKitGTK 2.54 + ibus: 창 초점 잃음).
      // 조합 시작 없이 온 같은 글자이므로 새 입력이 아니다. 뒤따르는 끝은 남은 완료 기록이 소비한다.
      this.context.terminal = { text };
      return;
    }
    if (session.composing || isComposing) {
      if (session.composing && inputType === "insertFromComposition") this.viewConfirming = true;
      this.context.terminal = null;
      if (!session.composing) session.beginComposition();
      session.updateComposition(text);
      // 편집 세션이 조합을 끝냈다(엔진 예외·편집 중지·시작 실패): 이 조합의 나머지 이벤트는 끝난 트랜잭션의 것이다.
      if (!session.composing) this.context.interrupted = { finalized: true, text: "" };
      return;
    }
    if (compositionType && this.context.terminal && (!text || this.context.terminal.text === text)) return;
    this.settleInterrupted();
    this.context.terminal = null; // 일반 입력·붙여넣기는 글자가 같아도 새 입력이다
    if (!text) return;
    session.typeText(text);
    if (compositionType) this.context.terminal = { text }; // input → compositionend 순서
  }

  compositionEnd(finalText: string): void {
    const session = this.session;

    if (session.composing) {
      session.endComposition(finalText);
      this.context.terminal = this.viewConfirming && finalText ? { text: finalText, confirmedByView: true } : { text: finalText };
      this.viewConfirming = false;
      return;
    }
    const interrupted = this.context.interrupted;
    if (interrupted?.finalized && interrupted.visible) {
      // 꼬리의 빈 끝(조합 지우기) 뒤에는 확정 절반(insertFromComposition → 끝)이 온다. 끝까지 같은 트랜잭션이다.
      if (!finalText) {
        interrupted.visible.emptied = true;
        return;
      }
      const { session: owner, confirmedByView } = interrupted.visible;
      this.context.interrupted = null;
      // 입력기의 최종 글자로 끝낸다: 앱이 확정한 글자와 다르면(페이지가 입력을 따라가지 못한 채 클릭) 원래 자리에서 고치고,
      // 그 조합 전체를 변경 하나로 센다.
      owner.resolveProvisional(finalText);
      this.context.terminal = confirmedByView ? { text: finalText, confirmedByView } : { text: finalText };
      return;
    }
    if (interrupted) {
      this.context.interrupted = null;
      if (!interrupted.finalized && finalText) interrupted.session.insertCommittedAt(interrupted.anchor, finalText);
      // 이미 확정했든 지금 확정했든, 바로 뒤따르는 같은 글자의 조합 알림(Safari 순서)은 이 조합의 것이다.
      this.context.terminal = { text: finalText };
      return;
    }
    if (this.context.terminal || !finalText) return; // 같은 조합의 중복 끝·빈 확정(취소)
    session.beginComposition(); // 시작·조합 입력 없이 확정만 온 조합
    session.endComposition(finalText);
    this.context.terminal = { text: finalText };
  }

  /** 페이지를 누르기 직전(커서를 옮기기 전). */
  pointerDown(): void {
    if (this.finalizeVisible()) return;
    const terminal = this.context.terminal;
    if (terminal && terminal.text) return; // 막 확정한 조합 뒤의 클릭
    // 끊긴 조합이 아직 끝나지 않았으면(확정했거나 그 조합의 입력이 이미 옴) 그 트랜잭션의 자리를 그대로 둔다.
    // 아무 증거가 없으면 이번 클릭 전 커서를 기억한다(마지막 클릭 기준, 클릭 사이 미리보기 키는 페이지가 모른다).
    const current = this.context.interrupted;
    if (current && (current.finalized || current.text)) return;
    this.context.interrupted = terminal
      // 빈 끝 바로 뒤의 클릭: WebKitGTK는 확정을 빈 끝 + 확정 절반(insertFromComposition → 끝)으로 나눠 보낸다. 그 사이에
      // mousedown이 오면(실측) 확정 절반은 이 자리(빈 끝의 조합 자리)의 것이다. 그 사이 229 keydown은 이를 닫지 않는다.
      ? { session: this.session, anchor: this.session.markCaret(), finalized: false, text: "", split: true }
      : { session: this.session, anchor: this.session.markCaret(), finalized: false, text: "" };
  }

  /** textarea가 초점을 잃음. 조합 끝 없이 초점을 잃었으면 보이는 조합 글자를 그 자리에 확정한다. */
  blur(): void {
    this.finalizeVisible();
  }

  /** 표면이 사라짐(탭 전환 등, 초점 잃음 이벤트가 없을 수 있음). 보이는 조합을 그 문서에 확정한다. */
  detach(): void {
    this.finalizeVisible();
  }

  /** 문서에 보이는 조합이 있으면 그 자리에 확정하고, 그 조합의 늦은 이벤트를 소비하도록 기록한다. */
  private finalizeVisible(): boolean {
    const session = this.session;
    if (!session.composing) return false;
    this.viewConfirming = false;
    const committed = session.endComposition(session.compositionText, { provisional: true });
    this.context.terminal = null;
    this.context.interrupted = committed
      ? { finalized: true, text: "", visible: { session } }
      : { finalized: true, text: "" };
    return true;
  }

  /** 끝을 기다리던 끊긴 조합을 닫는다. 끝 없이 조합 입력만 왔으면 그 마지막 글자를 원래 자리에 확정한다. */
  private settleInterrupted() {
    const interrupted = this.context.interrupted;
    this.context.interrupted = null;
    // 입력기의 끝 없이 새 입력이 시작됐다: 앱이 끝낸 조합을 모델 그대로 한 번 센다.
    if (interrupted?.finalized && interrupted.visible) interrupted.visible.session.resolveProvisional();
    if (interrupted && !interrupted.finalized && interrupted.text) {
      interrupted.session.insertCommittedAt(interrupted.anchor, interrupted.text);
    }
  }
}
