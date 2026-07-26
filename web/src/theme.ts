/**
 * Theme follows the OS by default. An explicit choice is stamped on <html> as
 * data-theme, which the stylesheet's [data-theme] blocks use to override the
 * prefers-color-scheme media query in both directions — so "light" holds on a
 * machine set to dark, not just the other way round.
 *
 * Applied from the bundle rather than an inline script in index.html: the CSP
 * is script-src 'self', so an inline bootstrap would be blocked. That costs a
 * frame of the OS theme before an overriding choice lands, which is only
 * visible when the two disagree.
 */
export type Theme = "system" | "light" | "dark";

const THEME_KEY = "triago.theme";

export function storedTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/** Persist and apply. "system" is stored as absence, so it tracks later OS changes. */
export function setTheme(theme: Theme): void {
  if (theme === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}
