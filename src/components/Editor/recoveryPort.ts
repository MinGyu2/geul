import { call, type Invoke } from "../../adapters/backend";
import { DOCUMENT_FORMATS, type DocumentFormat, type Result } from "../../adapters/contract";

export interface RecoveryCandidate {
  /** Opaque store identifier, never a path. */
  id: string;
  valid: boolean;
  /** Target file name only; recovery payload and original path are never returned. */
  name: string;
  revision: number | null;
  format: DocumentFormat | null;
  createdAt: number | null;
  stale: boolean;
}

export interface RecoveryPort {
  list(): Promise<Result<RecoveryCandidate[]>>;
  restore(id: string, destination: string): Promise<Result<string>>;
  discard(id: string): Promise<Result<null>>;
  forgetSession(sessionId: number): Promise<Result<null>>;
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Fields, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}\.(?:pending|recovery)$/.test(value);
const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0")
  && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));

export function parseRecoveryCandidate(value: unknown): RecoveryCandidate | null {
  const keys = ["id", "valid", "name", "revision", "format", "createdAt", "stale"];
  if (!isRecord(value) || !hasExactly(value, keys) || !isId(value.id)) return null;
  if (typeof value.valid !== "boolean" || typeof value.name !== "string" || typeof value.stale !== "boolean") return null;
  const valid = value.valid;
  if (!valid) {
    if (value.name !== "" || value.revision !== null || value.format !== null || value.createdAt !== null || value.stale) return null;
    return { id: value.id, valid, name: "", revision: null, format: null, createdAt: null, stale: false };
  }
  if (value.name.length === 0 || /[\\/\0]/.test(value.name) || !isCount(value.revision) || !isCount(value.createdAt)
    || typeof value.format !== "string" || !(DOCUMENT_FORMATS as readonly string[]).includes(value.format)) return null;
  return {
    id: value.id,
    valid,
    name: value.name,
    revision: value.revision,
    format: value.format as DocumentFormat,
    createdAt: value.createdAt,
    stale: value.stale,
  };
}

function parseRecoveryList(value: unknown): RecoveryCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const candidates = value.map(parseRecoveryCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  const ids = candidates.map((candidate) => candidate!.id);
  return new Set(ids).size === ids.length ? candidates as RecoveryCandidate[] : null;
}

async function callNull(invoke: Invoke, command: string, args: Record<string, unknown>): Promise<Result<null>> {
  const result = await call(invoke, command, args, (value) => value === null ? true : null);
  return result.ok ? { ok: true, value: null } : result;
}

export function createTauriRecoveryPort(invoke: Invoke): RecoveryPort {
  return {
    list: () => call(invoke, "recovery_list", {}, parseRecoveryList),
    restore: (id, destination) => call(invoke, "recovery_restore", { id, path: destination }, (value) => isAbsolutePath(value) ? value : null),
    discard: (id) => callNull(invoke, "recovery_discard", { id }),
    forgetSession: (sessionId) => callNull(invoke, "recovery_forget_session", { sessionId }),
  };
}
