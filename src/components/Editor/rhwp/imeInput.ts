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
//   입력으로 다룬다(실측: 미리보기만 바꾸는 키는 keydown도 없다). blur()가 플랫폼 IME 조합을 바로 끝낸다고 가정하지
//   않는다(늦은 이벤트는 위 규칙으로 처리).
// - IME 입력 문맥은 WebView에 하나이므로 중단·정상 완료 기록은 편집 표면 사이에서 공유한다(ImeContext). 탭을 바꾼 뒤
//   새 표면에 도착한 옛 조합의 늦은 확정은 새 문서에 넣지 않는다. 페이지가 받지 못한 조합(이벤트가 없음)은 이 규칙으로
//   막을 수 없다(플랫폼 한계, editor-surface-decision.md).
import type { RhwpEditorSession } from "./RhwpEditorSession";
import type { DocPosition } from "./rhwpText";

type Session = Pick<
  RhwpEditorSession,
  | "composing" | "compositionText" | "compositionAnchor" | "caret"
  | "beginComposition" | "updateComposition" | "endComposition" | "insertCommittedAt" | "typeText"
>;

/** 끊긴 조합. finalized면 이미 확정(또는 취소)했고, 아니면 늦게 올 확정을 session의 anchor에 넣는다(text = 마지막 조합 입력). */
type Interrupted =
  | { finalized: true; text: string }
  | { finalized: false; session: Session; anchor: DocPosition; text: string };

/** WebView 하나의 IME 문맥. 완료 기록은 문자열 하나만 유지하며 모델 참조를 갖지 않는다.
 * keydown·compositionstart·새 조합 입력·일반 입력이 새 트랜잭션 경계다. 그 전의 같은 조합 계열 후속 알림은
 * 완료한 트랜잭션에 속한다. 네이티브 transaction ID가 없으므로 경계 없이 온 독립된 같은 확정은 구별할 수 없다.
 */
export class ImeContext {
  interrupted: Interrupted | null = null;
  terminal: { text: string } | null = null;
}

const COMPOSITION_INPUT_TYPES = new Set(["insertFromComposition", "insertCompositionText"]);

export class ImeInput {
  constructor(
    private readonly session: Session,
    private readonly context: ImeContext = new ImeContext(),
  ) {}

  keyDown(): void {
    this.settleInterrupted();
    this.context.terminal = null;
  }

  compositionStart(): void {
    this.settleInterrupted();
    this.context.terminal = null;
    this.session.beginComposition();
  }

  /** input 이벤트. text는 textarea 값(조합 중) 또는 입력된 글자. */
  input(text: string, inputType: string, isComposing: boolean): void {
    const session = this.session;
    const compositionType = COMPOSITION_INPUT_TYPES.has(inputType);
    const interrupted = this.context.interrupted;
    if (!session.composing && interrupted && (isComposing || compositionType)) {
      // 끊긴 조합의 늦은 이벤트: 클릭한 자리·다른 문서에 넣지 않는다.
      if (isComposing) {
        if (!interrupted.finalized) interrupted.text = text;
        return;
      }
      // 조합 아닌 확정 입력(Safari 순서): 원래 자리에 한 번 넣고, 뒤따를 compositionend는 소비하도록 남겨 둔다.
      if (!interrupted.finalized && text) interrupted.session.insertCommittedAt(interrupted.anchor, text);
      this.context.interrupted = { finalized: true, text: "" };
      return;
    }
    if (session.composing || isComposing) {
      this.context.terminal = null;
      if (!session.composing) session.beginComposition();
      session.updateComposition(text);
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
      const committed = session.endComposition(finalText);
      this.context.terminal = { text: committed };
      return;
    }
    const interrupted = this.context.interrupted;
    if (interrupted) {
      this.context.interrupted = null;
      if (!interrupted.finalized && finalText) interrupted.session.insertCommittedAt(interrupted.anchor, finalText);
      // 이미 확정했든 지금 확정했든, 바로 뒤따르는 같은 글자의 조합 알림(Safari 순서)은 이 조합의 것이다.
      this.context.terminal = { text: finalText };
      return;
    }
    if (this.context.terminal || !finalText) return; // 같은 조합의 중복 끝·빈 확정(취소)
    session.beginComposition(); // 시작·조합 입력 없이 확정만 온 조합
    const committed = session.endComposition(finalText);
    this.context.terminal = { text: committed };
  }

  /** 페이지를 누르기 직전(커서를 옮기기 전). */
  pointerDown(): void {
    if (this.finalizeVisible() || this.context.terminal) return;
    // 끊긴 조합이 아직 끝나지 않았으면(확정했거나 그 조합의 입력이 이미 옴) 그 트랜잭션의 자리를 그대로 둔다.
    // 아무 증거가 없으면 이번 클릭 전 커서를 기억한다(마지막 클릭 기준, 클릭 사이 미리보기 키는 페이지가 모른다).
    const current = this.context.interrupted;
    if (current && (current.finalized || current.text)) return;
    this.context.interrupted = { session: this.session, anchor: this.session.caret, finalized: false, text: "" };
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
    session.endComposition(session.compositionText);
    this.context.terminal = null;
    this.context.interrupted = { finalized: true, text: "" };
    return true;
  }

  /** 끝을 기다리던 끊긴 조합을 닫는다. 끝 없이 조합 입력만 왔으면 그 마지막 글자를 원래 자리에 확정한다. */
  private settleInterrupted() {
    const interrupted = this.context.interrupted;
    this.context.interrupted = null;
    if (interrupted && !interrupted.finalized && interrupted.text) {
      interrupted.session.insertCommittedAt(interrupted.anchor, interrupted.text);
    }
  }
}
