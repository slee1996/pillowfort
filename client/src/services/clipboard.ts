/** Call only from an explicit copy action: the fallback reveals the requested text. */
export async function copyTextWithFallback(text: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return !signal?.aborted;
    }
  } catch {
    // A denied or unavailable clipboard still permits manual copying.
  }
  if (signal?.aborted) return false;

  const previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = "xp-window dialog-window";
  dialog.setAttribute("aria-label", "Copy manually");
  dialog.style.padding = "0";
  dialog.style.margin = "auto";
  dialog.style.maxWidth = "calc(100vw - 24px)";
  dialog.style.maxHeight = "calc(100dvh - 24px)";
  dialog.style.overflowY = "auto";

  const title = document.createElement("div");
  title.className = "xp-title-bar";
  title.textContent = "Copy manually";
  const body = document.createElement("div");
  body.className = "xp-window-body";
  const instructions = document.createElement("p");
  instructions.textContent = "Your browser couldn't copy this automatically. Copy the selected text below. Keep any password private.";
  const field = document.createElement("textarea");
  field.className = "xp-input";
  field.setAttribute("aria-label", "Text to copy manually");
  field.readOnly = true;
  field.rows = 4;
  field.value = text;
  const actions = document.createElement("div");
  actions.className = "auth-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "xp-btn";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  actions.append(close);
  body.append(instructions, field, actions);
  dialog.append(title, body);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    signal?.removeEventListener("abort", cleanup);
    dialog.removeEventListener("close", cleanup);
    if (dialog.open) dialog.close();
    field.value = "";
    dialog.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  };
  dialog.addEventListener("close", cleanup, { once: true });
  signal?.addEventListener("abort", cleanup, { once: true });
  if (signal?.aborted) {
    cleanup();
    return false;
  }
  document.body.append(dialog);
  try {
    dialog.showModal();
    field.focus();
    field.select();
  } catch {
    cleanup();
  }
  return false;
}
