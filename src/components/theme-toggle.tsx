/**
 * Light/dark switch (browser only — inside the Darth desktop shell the theme
 * follows prefers-color-scheme and the account menu says "Theme · set in
 * Darth"; lib/listing-layout THEME_BOOT_SCRIPT). The current theme is
 * whatever `.dark` on <html> says (set pre-hydration by that script), so no
 * state is needed — CSS picks the label/icon and this just flips the class.
 */
export function toggleTheme(): void {
  const next = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', next);
  try {
    localStorage.setItem('theme', next ? 'dark' : 'light');
  } catch {
    /* private browsing */
  }
}
