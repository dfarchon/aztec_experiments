import { useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
  hidden?: boolean;
  "aria-label"?: string;
}

// A shared select-only combobox. The popover stays in the top layer, so wallet
// and settings scroll containers cannot clip it. Focus remains on the trigger.
export function Select({
  id,
  value,
  options,
  onChange,
  disabled,
  hidden,
  "aria-label": label,
}: SelectProps) {
  const generatedId = useId();
  const triggerId = id || generatedId;
  const listId = `${triggerId}-options`;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const expanded = open && !disabled && !hidden;
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options.flatMap((option, index) =>
    option.disabled ? [] : [index]
  );
  const show = (last = false) => {
    setActive(
      enabled.includes(selected)
        ? selected
        : ((last ? enabled.at(-1) : enabled[0]) ?? -1)
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    const popup = list.current;
    // React 18's DOM types predate popover; use the platform attribute directly.
    popup?.setAttribute("popover", "manual");
    if (!expanded || !popup) {
      popup?.hidePopover();
      return;
    }
    const position = () => {
      const button = trigger.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetX = viewport?.offsetLeft ?? 0;
      const offsetY = viewport?.offsetTop ?? 0;
      const below = height + offsetY - rect.bottom - 12;
      const above = rect.top - offsetY - 12;
      const up = below < 200 && above > below;
      const menuWidth = Math.min(rect.width, width - 24);
      popup.style.width = `${menuWidth}px`;
      popup.style.left = `${Math.max(offsetX + 12, Math.min(rect.left, offsetX + width - menuWidth - 12))}px`;
      popup.style.maxHeight = `${Math.max(40, Math.min(320, up ? above : below))}px`;
      popup.style.top = up ? "auto" : `${rect.bottom + 6}px`;
      popup.style.bottom = up
        ? `${window.innerHeight - rect.top + 6}px`
        : "auto";
    };
    position();
    popup.showPopover();
    const dismiss = () => setOpen(false);
    const outside = (event: Event) => {
      if (root.current && !event.composedPath().includes(root.current))
        dismiss();
    };
    // Capture before parent panels can stop propagation or move focus.
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      popup.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [expanded]);

  useEffect(() => {
    if (expanded)
      list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active, expanded]);

  return (
    <div className="select" ref={root} hidden={hidden}>
      <button
        id={triggerId}
        ref={trigger}
        className="select-trigger"
        type="button"
        role="combobox"
        aria-label={label}
        aria-controls={listId}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-activedescendant={
          expanded && active >= 0 ? `${listId}-${active}` : undefined
        }
        disabled={disabled || !enabled.length}
        onClick={() => (expanded ? setOpen(false) : show())}
        onKeyDown={(event) => {
          const key = event.key;
          if (key === "Tab") {
            setOpen(false);
            return;
          }
          if (key === "Escape" && expanded) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
          if (
            ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)
          ) {
            event.preventDefault();
            if (!expanded) {
              show(key === "ArrowUp" || key === "End");
              return;
            }
            if (key === "Enter" || key === " ") {
              choose(active);
              return;
            }
            const index = enabled.indexOf(active);
            const next =
              key === "Home"
                ? 0
                : key === "End"
                  ? enabled.length - 1
                  : (index + (key === "ArrowDown" ? 1 : -1) + enabled.length) %
                    enabled.length;
            setActive(enabled[next]);
          } else if (
            key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            const now = Date.now();
            search.current = {
              text:
                now - search.current.time > 700
                  ? key
                  : search.current.text + key,
              time: now,
            };
            const index = enabled.find((i) =>
              options[i].label
                .toLowerCase()
                .startsWith(search.current.text.toLowerCase())
            );
            if (index !== undefined) {
              setActive(index);
              setOpen(true);
            }
          }
        }}
      >
        <span>{options[selected]?.label || "Select…"}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        ref={list}
        id={listId}
        className="select-options"
        role="listbox"
        aria-label={label}
        aria-labelledby={label ? undefined : triggerId}
        hidden={!expanded}
      >
        {options.map((option, index) => (
          <div
            id={`${listId}-${index}`}
            key={option.value}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            className={`select-option${active === index ? " active" : ""}`}
            onPointerMove={() => {
              if (!option.disabled) setActive(index);
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            <span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
