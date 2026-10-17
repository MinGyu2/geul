// 입력 textarea의 키보드·IME 이벤트를 편집 세션 연산으로 바꾸는 규칙(T007 안정화). DOM에 묶이지 않는다.
//
// 조합 하나(트랜잭션)는 끝이 정확히 한 번이다: 확정(글자를 남기고 변경 하나) 또는 취소(남기지 않음).
// - 조합 중 input(isComposing)은 문서의 조합 범위를 바꾼다. 시작 이벤트 없이 와도 그 자리에서 조합을 시작한다
//   (실측 WebKitGTK 2.54 + ibus-hangul: compositionstart·compositionupdate 없이 input과 compositionend만 온다).
// - compositionend는 진행 중인 조합을 끝낸다. 조합이 없는데 바로 앞 이벤트도 compositionend였으면 같은 조합의 중복
//   끝이므로 무시한다. 그렇지 않은 시작 없는 확정은 그 자리에 넣는다.
// - 조합 끝 바로 다음에 같은 글자로 오는 input(insertFromComposition·insertCompositionText, isComposing=false)은
//   같은 조합의 뒤따르는 알림(Safari 계열)이라 무시한다. 글자가 같다는 것만으로는 버리지 않는다(붙여넣기·일반 입력의
//   같은 글자는 새 입력이다).
// - 클릭(pointerDown)은 진행 중인 조합을 끝낸다. 페이지에 조합 글자가 보이면 그것을 원래 자리에 확정하고, 이후 IME가
//   늦게 보내는 같은 조합의 input·compositionend는 소비한다(다시 넣거나 옮기지 않음). 페이지가 조합 글자를 받지
//   못했으면(미리보기 없는 플랫폼) 클릭 전 커서를 기억하고, 다음 키 입력 전에 도착한 확정을 그 자리에 넣는다.
//   새 compositionstart·keydown·다른 입력은 이 기다림을 끝낸다. blur()가 플랫폼 IME 조합을 바로 끝낸다고 가정하지 않는다
//   (늦은 이벤트는 위 규칙으로 처리).
// - 초점을 잃었는데 조합 끝이 오지 않으면 보이는 조합 글자를 확정하고, 늦게 오는 끝은 소비한다.
import type { RhwpEditorSession } from "./RhwpEditorSession";
import type { DocPosition } from "./rhwpText";

type Session = Pick<
  RhwpEditorSession,
  | "composing" | "compositionText" | "compositionAnchor" | "caret"
  | "beginComposition" | "updateComposition" | "endComposition" | "insertCommittedAt" | "typeText"
>;

/** 클릭으로 끝낸 조합. finalized면 이미 확정했고, 아니면 늦게 올 확정을 anchor에 넣는다(text = 마지막 조합 입력). */
interface Interrupted {
  anchor: DocPosition;
  finalized: boolean;
  text: string;
}

const COMPOSITION_INPUT_TYPES = new Set(["insertFromComposition", "insertCompositionText"]);

export class ImeInput {
  /** 바로 앞 조합 끝에서 확정한 글자(뒤따르는 같은 조합 알림을 알아보는 데만, 다음 이벤트 하나 동안). */
  private ghost: string | null = null;
  /** 바로 앞 이벤트가 조합을 끝낸 compositionend였음. */
  private ended = false;
  private interrupted: Interrupted | null = null;

  constructor(private readonly session: Session) {}

  keyDown(): void {
    this.settleInterrupted();
    this.ghost = null;
    this.ended = false;
  }

  compositionStart(): void {
    this.settleInterrupted();
    this.ghost = null;
    this.ended = false;
    this.session.beginComposition();
  }

  /** input 이벤트. text는 textarea 값(조합 중) 또는 입력된 글자. */
  input(text: string, inputType: string, isComposing: boolean): void {
    const ghost = this.ghost;
    this.ghost = null;
    this.ended = false;
    const session = this.session;
    if (session.composing || isComposing) {
      if (!session.composing && this.interrupted) {
        // 클릭으로 끝낸 조합의 늦은 입력: 이미 확정했으면 버리고, 아니면 기억만 한다(클릭한 곳에 넣지 않음).
        if (!this.interrupted.finalized) this.interrupted.text = text;
        return;
      }
      if (!session.composing) session.beginComposition();
      session.updateComposition(text);
      return;
    }
    this.settleInterrupted();
    if (!text) return;
    if (ghost !== null && text === ghost && COMPOSITION_INPUT_TYPES.has(inputType)) return;
    session.typeText(text);
  }

  compositionEnd(finalText: string): void {
    this.ghost = null;
    const session = this.session;

    if (session.composing) {
      const committed = session.endComposition(finalText);
      this.ended = true;
      this.ghost = committed || null;
      return;
    }
    const interrupted = this.interrupted;
    if (interrupted) {
      this.interrupted = null;
      this.ended = true;
      const text = finalText || interrupted.text;
      if (!interrupted.finalized && text) {
        session.insertCommittedAt(interrupted.anchor, text);
        this.ghost = text;
      }
      return;
    }
    if (this.ended || !finalText) return; // 같은 조합의 중복 끝·빈 확정
    session.beginComposition(); // 시작·조합 입력 없이 확정만 온 조합
    const committed = session.endComposition(finalText);
    this.ended = true;
    this.ghost = committed || null;
  }

  /** 페이지를 누르기 직전(커서를 옮기기 전). */
  pointerDown(): void {
    this.ghost = null;
    this.ended = false;
    const session = this.session;
    if (session.composing) {
      const anchor = session.compositionAnchor!;
      session.endComposition(session.compositionText);
      this.interrupted = { anchor, finalized: true, text: "" };
      return;
    }
    this.settleInterrupted();
    this.interrupted = { anchor: session.caret, finalized: false, text: "" };
  }

  /** textarea가 초점을 잃음. 조합 끝 없이 초점을 잃었으면 보이는 조합 글자를 그 자리에 확정한다. */
  blur(): void {
    const session = this.session;
    if (!session.composing) return;
    const anchor = session.compositionAnchor!;
    session.endComposition(session.compositionText);
    this.interrupted = { anchor, finalized: true, text: "" };
    this.ghost = null;
    this.ended = false;
  }

  /** 끝을 기다리던 중단된 조합을 정리한다. 끝 없이 조합 입력만 왔으면 그 마지막 글자를 원래 자리에 확정한다. */
  private settleInterrupted() {
    const interrupted = this.interrupted;
    this.interrupted = null;
    if (interrupted && !interrupted.finalized && interrupted.text) {
      this.session.insertCommittedAt(interrupted.anchor, interrupted.text);
    }
  }
}
