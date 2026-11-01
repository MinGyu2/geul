import { parseBackendError, parseSessionInfo, type DocumentFormat, type Result, type SessionInfo } from "../../adapters/contract";
import type { Invoke } from "../../adapters/backend";

export interface FileDialogRequest {
  mode: "open" | "save";
  format?: DocumentFormat;
  title: string;
  accept: string;
  cancel: string;
}

/** Native file operations used by the editor. The browser never synthesizes a path. */
export interface FilePort {
  chooseFile(request: FileDialogRequest): Promise<Result<string | null>>;
  createDocx(path: string): Promise<Result<SessionInfo>>;
}

const INVALID = Symbol("invalid IPC response");
type Parsed<T> = T | typeof INVALID;

async function invokeFile<T>(
  invoke: Invoke,
  command: string,
  args: Record<string, unknown>,
  parse: (value: unknown) => Parsed<T>,
): Promise<Result<T>> {
  let value: unknown;
  try {
    value = await invoke(command, args);
  } catch (reason) {
    const error = parseBackendError(reason);
    return { ok: false, error: error ?? { code: "Protocol" } };
  }
  const parsed = parse(value);
  return parsed === INVALID ? { ok: false, error: { code: "Protocol" } } : { ok: true, value: parsed };
}

const parsePath = (value: unknown): Parsed<string | null> =>
  value === null ? null : typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : INVALID;

function parseCreatedDocx(value: unknown): Parsed<SessionInfo> {
  const session = parseSessionInfo(value);
  if (!session || session.format !== "docx" || session.engine !== "wordcraft" || session.state !== "identified"
    || session.revision !== 0 || session.sequence !== 0 || session.loadGeneration !== 0
    || !session.displayName.toLowerCase().endsWith(".docx") || /[\\/\0]/.test(session.displayName)) return INVALID;
  return session;
}

export function createTauriFilePort(invoke: Invoke): FilePort {
  return {
    chooseFile: (request) => {
      const args: Record<string, unknown> = {
        mode: request.mode,
        title: request.title,
        accept: request.accept,
        cancel: request.cancel,
      };
      if (request.format !== undefined) args.format = request.format;
      return invokeFile(invoke, "document_file_dialog", args, parsePath);
    },
    createDocx: (path) => invokeFile(invoke, "document_new", { path }, parseCreatedDocx),
  };
}
