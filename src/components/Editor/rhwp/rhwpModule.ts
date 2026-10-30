import { canonical, identityFrom, sha256 } from "./rhwpArtifactIdentity";

// rhwp WASM 모듈 불러오기와 이 앱이 쓰는 API의 형식(T007, R-A).
//
// - 모듈은 scripts/build-rhwp-wasm.sh가 고정 커밋(external/rhwp)에서 만든 public/rhwp/generations/<id>/의 산출물이다(Git에
//   넣지 않는 빌드 산출물). 앱은 실행할 때 같은 출처의 URL로 불러오므로 타입 검사·테스트·프런트엔드 빌드는 이 산출물
//   없이도 된다(CI는 submodule을 받지 않는다). 산출물이 없거나 초기화에 실패하면 EngineFailure(init)이다.
// - WebAssembly 컴파일에는 CSP script-src의 'wasm-unsafe-eval'만 더했다('unsafe-eval'은 주지 않는다).
// - 아래 인터페이스는 rhwp `src/wasm_api.rs`(고정 커밋)의 #[wasm_bindgen] 내보내기 중 이 앱이 부르는 것만 옮긴 것이며
//   rhwp의 공개 계약이 아니다. JSON 문자열을 돌려주는 API의 모양은 rhwpTypes.ts에서 검사한다.

export interface RhwpExport {
  /** content-loss 보고서(JSON). */
  contentLoss(): string;
  takeBytes(): Uint8Array;
  free(): void;
}

export interface RhwpDocument {
  free(): void;
  pageCount(): number;
  getPageInfo(page: number): string;
  getSourceFormat(): string;
  renderPageToCanvas(page: number, canvas: HTMLCanvasElement, scale: number): void;
  /** 그 쪽 그리기 입력(레이어 트리) JSON(고정 rhwp `getPageLayerTreeWithProfile`). 바뀐 곳을 정하는 데만 쓴다. */
  getPageLayerTreeWithProfile?(page: number, profile: string, omitImageBytes: boolean, omitFontBytes: boolean): string;
  /**
   * 같은 크기로 이미 그린 Canvas의 page-space 사각형을 그 자리에서 다시 그린다(고정 rhwp `renderPagePatchToCanvasFilteredWithProfile`).
   * Canvas 크기를 다시 정하지 않는다(나머지 픽셀 유지). 크기·사각형이 맞지 않으면 그리기 전에 예외.
   */
  renderPagePatchToCanvasFilteredWithProfile?(
    page: number, canvas: HTMLCanvasElement, scale: number, layerKind: string, profile: string,
    x: number, y: number, width: number, height: number,
  ): void;
  hitTest(page: number, x: number, y: number): string;
  getCursorRect(section: number, paragraph: number, offset: number): string;
  getCursorRectInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number): string;
  getParagraphCount(section: number): number;
  getParagraphLength(section: number, paragraph: number): number;
  getCellParagraphCount(section: number, parentParagraph: number, control: number, cell: number): number;
  getCellParagraphLength(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number): number;
  getLineInfo(section: number, paragraph: number, offset: number): string;
  getLineInfoInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number): string;
  getTableDimensions(section: number, parentParagraph: number, control: number): string;
  moveVertical(
    section: number, paragraph: number, offset: number, delta: number, preferredX: number,
    parentParagraph: number, control: number, cell: number, cellParagraph: number,
  ): string;
  getSelectionRects(section: number, startParagraph: number, startOffset: number, endParagraph: number, endOffset: number): string;
  getSelectionRectsInCell(
    section: number, parentParagraph: number, control: number, cell: number,
    startCellParagraph: number, startOffset: number, endCellParagraph: number, endOffset: number,
  ): string;
  getTextRange(section: number, paragraph: number, offset: number, count: number): string;
  getTextInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number, count: number): string;
  insertText(section: number, paragraph: number, offset: number, text: string): string;
  insertTextInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number, text: string): string;
  deleteText(section: number, paragraph: number, offset: number, count: number): string;
  /** 글자 서식(T010 서식, HWPX만 쓴다): 문단의 [start, end) 범위에 `props`(예: `{"bold":true}`)를 적용한다. */
  applyCharFormat?(section: number, paragraph: number, start: number, end: number, props: string): string;
  applyCharFormatInCell?(
    section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, start: number, end: number, props: string,
  ): string;
  /** 위치의 글자 서식 JSON(`bold`·`italic`·`underline`·`strikethrough` 등). */
  getCharPropertiesAt?(section: number, paragraph: number, offset: number): string;
  getCellCharPropertiesAt?(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number): string;
  deleteTextInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number, count: number): string;
  deleteRange(section: number, startParagraph: number, startOffset: number, endParagraph: number, endOffset: number): string;
  deleteRangeInCell(
    section: number, parentParagraph: number, control: number, cell: number,
    startCellParagraph: number, startOffset: number, endCellParagraph: number, endOffset: number,
  ): string;
  splitParagraph(section: number, paragraph: number, offset: number): string;
  splitParagraphInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number, offset: number): string;
  mergeParagraph(section: number, paragraph: number): string;
  mergeParagraphInCell(section: number, parentParagraph: number, control: number, cell: number, cellParagraph: number): string;
  exportHwpWithReport(): RhwpExport;
  exportHwpxWithReport(): RhwpExport;
  // 스냅숏(T010 Phase 2 실행 취소 기록, rhwpHistory.ts). 고정 rhwp: saveSnapshot·snapshotCapacity는 u32, restoreSnapshot은 성공 JSON 또는
  // 예외("스냅샷 N 없음"), discardSnapshot은 반환 없음.
  saveSnapshot(): number;
  restoreSnapshot(id: number): string;
  discardSnapshot(id: number): void;
  snapshotCapacity(): number;
}

export interface RhwpModule {
  /** 문서 바이트로 문서를 만든다. 형식이 맞지 않으면 예외. */
  openDocument(bytes: Uint8Array): RhwpDocument;
  /**
   * 모듈 WASM 선형 메모리의 지금 크기(바이트). 줄지 않는 상한선(high-water)이라 살아 있는 메모리가 아니고, 문서 하나의 크기도
   * 아니다(같은 모듈의 다른 문서·해제한 빈 공간을 포함). 실행 취소 기록의 예산 어림과 증가 감시에만 쓴다(rhwpHistory.ts). 모르면 없음.
   */
  memoryBytes?(): number;
}

type GeneratedModule = {
  default: (options: { module_or_path: ArrayBuffer }) => Promise<unknown>;
  HwpDocument: new (bytes: Uint8Array) => RhwpDocument;
};

/** 유일한 가변 게시 참조. 선택 후에는 같은 불변 generation만 사용한다. */
export const RHWP_BUILD_URL = "/rhwp/BUILD.json";

type FetchArtifact = (url: string, options?: RequestInit) => Promise<Response>;

async function bytesFrom(fetcher: FetchArtifact, url: string, cache: RequestCache): Promise<ArrayBuffer> {
  const response = await fetcher(url, { cache });
  if (!response.ok) throw new Error(`rhwp artifact fetch ${response.status}`);
  return response.arrayBuffer();
}

let loading: Promise<RhwpModule> | null = null;

/**
 * 모듈을 한 번만 불러온다. 실패하면 다음 호출에서 다시 시도한다(실패를 캐시하지 않음).
 * `importer`는 테스트 주입용이다.
 */
export function loadRhwpModule(importer: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url), fetcher: FetchArtifact = (url, options) => fetch(url, options)): Promise<RhwpModule> {
  loading ??= (async () => {
    const selected = await identityFrom(JSON.parse(new TextDecoder().decode(await bytesFrom(fetcher, RHWP_BUILD_URL, "no-store"))));
    const base = `/rhwp/generations/${selected.generation}`;
    const immutable = await identityFrom(JSON.parse(new TextDecoder().decode(await bytesFrom(fetcher, `${base}/BUILD.json`, "force-cache"))));
    if (canonical(immutable) !== canonical(selected)) throw new Error("rhwp immutable identity mismatch");
    const [js, wasm] = await Promise.all([bytesFrom(fetcher, `${base}/rhwp.js`, "force-cache"), bytesFrom(fetcher, `${base}/rhwp_bg.wasm`, "force-cache")]);
    if (await sha256(js) !== selected.artifacts["rhwp.js"] || await sha256(wasm) !== selected.artifacts["rhwp_bg.wasm"]) throw new Error("rhwp artifact hash mismatch");
    // The publisher never overwrites this URL. Module caching is therefore
    // generation-specific; wasm-bindgen receives the exact verified bytes.
    const generated = (await importer(`${base}/rhwp.js`)) as GeneratedModule;
    if (typeof generated?.default !== "function" || typeof generated.HwpDocument !== "function") {
      throw new Error("rhwp module shape");
    }
    const exports = await generated.default({ module_or_path: wasm });
    const HwpDocument = generated.HwpDocument;
    const memory = (exports as { memory?: unknown } | null)?.memory;
    return {
      openDocument: (bytes: Uint8Array) => new HwpDocument(bytes),
      ...(memory instanceof WebAssembly.Memory ? { memoryBytes: () => memory.buffer.byteLength } : {}),
    };
  })().catch((reason: unknown) => {
    loading = null;
    throw reason;
  });
  return loading;
}
