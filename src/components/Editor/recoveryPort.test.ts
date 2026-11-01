import { describe, expect, it } from "vitest";
import { createTauriRecoveryPort, parseRecoveryCandidate } from "./recoveryPort";

const validCandidate = {
  id: "0123456789abcdef0123456789abcdef.recovery",
  valid: true,
  name: "draft.docx",
  revision: 4,
  format: "docx",
  createdAt: 1_800_000_000_000,
  stale: false,
};

describe("recovery IPC candidate parsing", () => {
  it("accepts only bounded metadata for a valid private recovery candidate", () => {
    expect(parseRecoveryCandidate(validCandidate)).toEqual(validCandidate);
    expect(parseRecoveryCandidate({ ...validCandidate, name: "/home/user/draft.docx" })).toBeNull();
    expect(parseRecoveryCandidate({ ...validCandidate, id: "../../draft.docx" })).toBeNull();
    expect(parseRecoveryCandidate({ ...validCandidate, revision: -1 })).toBeNull();
    expect(parseRecoveryCandidate({ ...validCandidate, extra: "payload" })).toBeNull();
  });

  it("represents corrupt records without exposing a path or offering document metadata", () => {
    const invalid = {
      id: "0123456789abcdef0123456789abcdef.pending",
      valid: false,
      name: "",
      revision: null,
      format: null,
      createdAt: null,
      stale: false,
    };
    expect(parseRecoveryCandidate(invalid)).toEqual(invalid);
    expect(parseRecoveryCandidate({ ...invalid, name: "private.docx" })).toBeNull();
    expect(parseRecoveryCandidate({ ...invalid, stale: true })).toBeNull();
  });

  it("accepts absolute restore paths from supported desktop platforms and rejects relative responses", async () => {
    let response: unknown = "C:\\Recovery\\restored.docx";
    const port = createTauriRecoveryPort(async () => response);
    expect(await port.restore(validCandidate.id, "C:\\Recovery\\restored.docx")).toEqual({
      ok: true, value: "C:\\Recovery\\restored.docx",
    });
    response = "restored.docx";
    expect(await port.restore(validCandidate.id, "restored.docx")).toEqual({ ok: false, error: { code: "Protocol" } });
  });
});
