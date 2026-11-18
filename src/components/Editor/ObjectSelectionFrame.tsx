import type { ObjectSelection } from "../../commands/objectSelection";
import { useTranslation } from "../../language/LanguageContext";

export function ObjectSelectionFrame({ selection, scale }: { selection: ObjectSelection; scale: number }) {
  const { t } = useTranslation();
  const { x, y, width, height } = selection.frame;
  return (
    <div className="object-selection-frame" data-object-kind={selection.kind}
      style={{ left: x * scale, top: y * scale, width: width * scale, height: height * scale }}>
      <span role="status" className="object-selection-frame__label">
        {t("editor.object.readOnly", { kind: t(`editor.object.kind.${selection.kind}`) })}
      </span>
    </div>
  );
}
