import { Icon } from "./Icon";
import { toggleTheme, useTheme } from "./theme";

export function ThemeToggle() {
  const theme = useTheme();
  const light = theme === "light";
  return (
    <button
      type="button"
      className="header-control theme-toggle"
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      title={light ? "Switch to dark theme" : "Switch to light theme"}
      onClick={toggleTheme}
    >
      <Icon name={light ? "moon" : "sun"} />
    </button>
  );
}
