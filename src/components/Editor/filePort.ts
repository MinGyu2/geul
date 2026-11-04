import { ENGINE_FOR_FORMAT, parseBackendError, parseSessionInfo, type DocumentFormat, type Result, type SessionInfo } from "../../adapters/contract";
import type { Invoke } from "../../adapters/backend";
import type { BlankExport } from "./rhwp/createBlank";

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
  createDocument(format: DocumentFormat, path: string, blank?: BlankExport): Promise<Result<SessionInfo>>;
}

const INVALID = Symbol("invalid IPC response");
type Parsed<T> = T | typeof INVALID;

async function invokeFile<T>(
  invoke: Invoke,
  command: string,
  args: Record<string, unknown> | Uint8Array,
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

function parseCreated(value: unknown, format: DocumentFormat): Parsed<SessionInfo> {
  const session = parseSessionInfo(value);
  if (!session || session.format !== format || session.engine !== ENGINE_FOR_FORMAT[format] || session.state !== "identified"
    || session.revision !== 0 || session.sequence !== 0 || session.loadGeneration !== 0
    || !session.displayName.toLowerCase().endsWith(`.${format}`) || /[\\/\0]/.test(session.displayName)) return INVALID;
  return session;
}

export function newDocumentFrame(format: DocumentFormat, path: string, blank?: BlankExport): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ path, format, contentLoss: blank?.contentLoss ?? null }));
  const bytes = blank?.bytes ?? new Uint8Array();
  if (meta.length > 8192 || bytes.length > 65536 || (format === "docx" ? blank !== undefined : blank === undefined)) throw new Error("creation frame");
  const frame = new Uint8Array(8 + meta.length + bytes.length);
  frame.set([0x47, 0x4e, 0x43, 0x31]);
  new DataView(frame.buffer).setUint32(4, meta.length, true);
  frame.set(meta, 8);
  frame.set(bytes, 8 + meta.length);
  return frame;
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
    createDocument: (format, path, blank) => invokeFile(invoke, "document_new", newDocumentFrame(format, path, blank), value => parseCreated(value, format)),
  };
}
