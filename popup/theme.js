// Apply the theme chosen in Settings before the popup's first paint. Settings load
// asynchronously, so popup.js keeps this copy in localStorage up to date.
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable: follow the system theme.
}
