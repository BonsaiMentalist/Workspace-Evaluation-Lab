// Small progressive enhancements. The lab works without this file.
// Prevents a second submit while a form is being saved (for example a double-click on "Save").
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
  window.setTimeout(() => form.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = true; }), 0);
});
