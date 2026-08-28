/** Copy text in the browser or Tauri webview (clipboard API often denied). */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error("nothing to copy");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through */
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "0";
  el.style.left = "0";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, el.value.length);
  const ok = document.execCommand("copy");
  el.remove();
  if (!ok) throw new Error("clipboard blocked");
}
