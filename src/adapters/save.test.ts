// T009 저장 계약: 응답 검사(보존 판정·사전 검사·저장 결과·저장 오류)와 저장 요청 프레임. 백엔드 직렬화
// (src-tauri/src/services/save/)와 모양이 같아야 한다.
import { describe, expect, it } from "vitest";
import { createTauriBackend, saveFrame } from "./backend";
import { parseBackendError, parsePreservation, parseSaveCheck, parseSaveOutcome } from "./contract";

const session = { sessionId: 3, format: "hwp", engine: "rhwp", revision: 2, state: "ready", displayName: "a.hwp", dirty: false, sequence: 9, loadGeneration: 1 };

describe("저장 응답 검사", () => {
  it("보존 판정은 계약 모양만 받는다(safe는 근거가 없을 때만)", () => {
    expect(parsePreservation({ outcome: "safe", findings: [] })).toEqual({ outcome: "safe", findings: [] });
    expect(parsePreservation({ outcome: "unsafe", findings: [{ code: "partMissing", part: "customXml/item1.xml" }, { code: "reopenMismatch" }] }))
      .toEqual({ outcome: "unsafe", findings: [{ code: "partMissing", part: "customXml/item1.xml" }, { code: "reopenMismatch" }] });
    for (const bad of [
      { outcome: "safe", findings: [{ code: "partMissing" }] },
      { outcome: "unsafe", findings: [] },
      { outcome: "maybe", findings: [] },
      { outcome: "unknown", findings: [{ code: "somethingNew" }] },
      { outcome: "unknown", findings: [{ code: "partChanged", part: 3 }] },
      { outcome: "unknown", findings: [{ code: "partChanged", part: "x".repeat(129) }] },
      { outcome: "unknown", findings: [{ code: "partChanged", extra: 1 }] },
      { outcome: "unknown", findings: Array.from({ length: 33 }, () => ({ code: "partChanged" })) },
      { outcome: "unknown", findings: [], more: true },
    ]) expect(parsePreservation(bad)).toBeNull();
  });

  it("사전 검사·저장 결과·저장 오류", () => {
    expect(parseSaveCheck({ preservation: { outcome: "safe", findings: [] }, platformSupported: true })).not.toBeNull();
    expect(parseSaveCheck({ preservation: { outcome: "safe", findings: [] } })).toBeNull();
    expect(parseSaveOutcome({ session, bytes: 10, durable: true })).toEqual({ session, bytes: 10, durable: true });
    expect(parseSaveOutcome({ session, bytes: -1, durable: true })).toBeNull();
    expect(parseBackendError({ code: "UnsafeSave", preservation: { outcome: "unknown", findings: [{ code: "preflightMissing" }] } })).not.toBeNull();
    expect(parseBackendError({ code: "UnsafeSave", preservation: { outcome: "safe", findings: [] } })).toBeNull(); // 안전한데 거부는 계약 밖
    expect(parseBackendError({ code: "SaveUnsupported", reason: "hard-link" })).not.toBeNull();
    // T009 안정화: 읽기 전용 원본, 교체로 잃을 메타데이터(확장 속성·ACL·플래그), 낡은 미리보기.
    expect(parseBackendError({ code: "SaveUnsupported", reason: "read-only" })).not.toBeNull();
    expect(parseBackendError({ code: "SaveUnsupported", reason: "metadata" })).not.toBeNull();
    // T009 3차 안정화: 다른 사용자가 쓸 수 있는 원본·디렉터리.
    expect(parseBackendError({ code: "SaveUnsupported", reason: "shared-file" })).not.toBeNull();
    expect(parseBackendError({ code: "SaveUnsupported", reason: "shared-directory" })).not.toBeNull();
    expect(parsePreservation({ outcome: "unsafe", findings: [{ code: "previewStale", part: "PrvText" }] })).not.toBeNull();
    expect(parseBackendError({ code: "SaveUnsupported", reason: "nfs" })).toBeNull();
    expect(parseBackendError({ code: "SaveFailure", stage: "write", io: "storage-full" })).not.toBeNull();
    expect(parseBackendError({ code: "SaveFailure", stage: "write" })).not.toBeNull();
    expect(parseBackendError({ code: "SaveFailure", stage: "write", io: "eio: disk failure" })).toBeNull();
    expect(parseBackendError({ code: "FileConflict" })).not.toBeNull();
    expect(parseBackendError({ code: "SaveInProgress", sessionId: 3 })).not.toBeNull();
  });
});

describe("저장 요청 프레임", () => {
  it("GSV1·세션·시도·판(u64 LE)·메타 길이(u32 LE)·메타 JSON·바이트", () => {
    const frame = saveFrame(3, 2 ** 40 + 5, 9, { contentLoss: null }, new Uint8Array([7, 8]));
    const view = new DataView(frame.buffer);
    expect([...frame.subarray(0, 4)]).toEqual([0x47, 0x53, 0x56, 0x31]);
    expect([view.getUint32(4, true), view.getUint32(8, true)]).toEqual([3, 0]);
    expect([view.getUint32(12, true), view.getUint32(16, true)]).toEqual([5, 256]);
    expect(view.getUint32(20, true)).toBe(9);
    const length = view.getUint32(28, true);
    expect(new TextDecoder().decode(frame.subarray(32, 32 + length))).toBe('{"contentLoss":null}');
    expect([...frame.subarray(32 + length)]).toEqual([7, 8]);
  });

  it("rhwp 저장 IPC는 원시 본문으로 보내고 응답의 세션을 확인한다", async () => {
    const calls: [string, unknown][] = [];
    const backend = createTauriBackend(async (command, args) => {
      calls.push([command, args]);
      if (command === "document_original") return new Uint8Array([1, 2]).buffer;
      if (command === "document_preflight") return { preservation: { outcome: "safe", findings: [] }, platformSupported: true };
      return { session: { ...session, sessionId: command === "document_save" ? 3 : 4 }, bytes: 2, durable: true };
    });
    expect(await backend.original(3, 1)).toEqual({ ok: true, value: new Uint8Array([1, 2]) });
    expect((await backend.preflight(3, 1, new Uint8Array([1]), { count: 0 })).ok).toBe(true);
    const reopen = { formatEqual: true, pagesEqual: true, textEqual: true, controlsEqual: true };
    expect((await backend.save(3, 1, 2, new Uint8Array([1]), { count: 0 }, reopen)).ok).toBe(true);
    expect(calls[0]).toEqual(["document_original", { sessionId: 3, loadGeneration: 1 }]);
    expect(calls[1]![1]).toBeInstanceOf(Uint8Array);
    expect(calls[2]![1]).toBeInstanceOf(Uint8Array);
    // 다른 세션의 저장 응답은 계약 위반.
    const wrong = createTauriBackend(async () => ({ session: { ...session, sessionId: 4 }, bytes: 2, durable: true }));
    expect(await wrong.save(3, 1, 2, new Uint8Array([1]), null, reopen)).toEqual({ ok: false, error: { code: "Protocol" } });
  });
});
