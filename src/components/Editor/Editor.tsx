import type { CSSProperties } from "react";
import { useTranslation } from "../../language/LanguageContext";

interface EditorProps {
  zoom: number;
}

/**
 * 중앙 편집 영역. 지금은 문서 세션이 없으므로 안내 막대와 편집할 수 없는 빈 페이지만 보여 준다.
 * 엔진별 편집 표면(rhwp WASM 캔버스, WordCraft 페이지 래스터 + 오버레이)은
 * docs/architecture/editor-surface-decision.md에 따라 T007/T008에서 페이지 자리에 붙인다.
 */
export function Editor({ zoom }: EditorProps) {
  const { t } = useTranslation();
  const pageStyle = { "--zoom": zoom / 100 } as CSSProperties;
  return (
    <main className="editor" aria-label={t("editor.label")}>
      <div className="editor__notice" role="note">
        <h1 className="editor__notice-title">{t("editor.emptyTitle")}</h1>
        <p>{t("editor.emptyBody")}</p>
      </div>
      <div className="editor__scroll">
        <div className="editor__canvas">
          <div className="editor__page" style={pageStyle} title={t("editor.emptyHint")} aria-hidden="true" />
        </div>
      </div>
    </main>
  );
}
