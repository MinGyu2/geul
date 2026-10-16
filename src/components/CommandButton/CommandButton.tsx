import { forwardRef } from "react";
import { Icon, type IconName } from "../../assets/icons";
import { commandState, executeCommand, type CommandContext } from "../../commands/commands";
import { t, type MessageKey } from "../../language";

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
 */
export const CommandButton = forwardRef<HTMLButtonElement, CommandButtonProps>(function CommandButton(
  { id, labelKey, icon, context, variant = "small", tabIndex },
  ref,
) {
  const label = t(labelKey);
  const state = commandState(id, context.layout);
  const unavailable = !state.available;
  const pressed = state.available ? state.pressed : undefined;
  const title = unavailable ? `${label} — ${t("command.unavailable.hint")}` : label;
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
      onClick={() => executeCommand(id, label, context)}
    >
      <Icon name={icon} size={variant === "large" ? 24 : 18} />
      {variant !== "icon" && <span className="command__label">{label}</span>}
    </button>
  );
});
