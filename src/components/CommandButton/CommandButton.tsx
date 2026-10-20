import { forwardRef } from "react";
import { Icon, type IconName } from "../../assets/icons";
import { commandState, executeCommand, type CommandContext } from "../../commands/commands";
import { commandDefinition, shortcutLabel } from "../../commands/registry";
import { isMac } from "../../commands/shortcuts";
import type { MessageKey } from "../../language";
import { useTranslation } from "../../language/LanguageContext";

interface CommandButtonProps {
  id: string;
  labelKey: MessageKey;
  icon: IconName;
  context: CommandContext;
  variant?: "large" | "small" | "icon";
  tabIndex?: number;
}

/**
 * 명령 하나를 실행하는 버튼. 사용할 수 없는 명령은 `aria-disabled`로 표시해 키보드 초점과 설명은 유지하되
 * 실행은 하지 않는다(누르면 상태 표시줄에 이유만 알린다).
 *
 * 편집 입력(.rhwp-input)에 초점이 있을 때 포인터로 누르면 초점을 가져가지 않는다(mousedown 기본 동작을 막음, T010 마무리 안정화
 * 경계 C). 입력기는 누름에서 조합을 확정하며 그 확정을 두 반쪽(빈 끝 → 최종 글자)으로 보내는데(실측 WebKitGTK 2.54 + ibus-hangul),
 * 그 사이 초점이 단추로 옮겨 가면 뒤 반쪽이 편집할 수 없는 단추로 가 음절이 사라질 수 있다. 초점이 편집 입력에 남으면 늦은 확정도
 * 편집 입력의 IME 규칙(imeInput.ts)이 받는다. 클릭은 그대로 명령을 실행하고, 키보드 초점 이동(Tab)·활성화(Enter·Space)는 그대로다.
 */
export const CommandButton = forwardRef<HTMLButtonElement, CommandButtonProps>(function CommandButton(
  { id, labelKey, icon, context, variant = "small", tabIndex },
  ref,
) {
  const { t } = useTranslation();
  const label = t(labelKey);
  const state = commandState(id, context);
  const unavailable = !state.available;
  const pressed = state.available ? state.pressed : undefined;
  const shortcut = commandDefinition(id)?.shortcuts?.[0];
  const named = shortcut ? `${label} (${shortcutLabel(shortcut, isMac())})` : label;
  const title = unavailable ? `${named} — ${t(`command.reason.${state.reason}` as MessageKey)}` : named;
  return (
    <button
      ref={ref}
      type="button"
      className={`command command--${variant}`}
      data-command={id}
      aria-disabled={unavailable || undefined}
      aria-pressed={pressed}
      aria-label={variant === "icon" ? label : undefined}
      title={title}
      tabIndex={tabIndex}
      onMouseDown={(event) => {
        if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("rhwp-input")) event.preventDefault();
      }}
      onClick={() => executeCommand(id, labelKey, context)}
    >
      <Icon name={icon} size={variant === "large" ? 24 : 18} />
      {variant !== "icon" && <span className="command__label">{label}</span>}
    </button>
  );
});
