// This page owns the shortcut, including when Pointer Lock belongs to its canvas.
export function createWorldShortcuts(canvas, inventoryDialog, openInventory, closeInventory) {
  const document = canvas.ownerDocument;
  const window = document.defaultView;
  const keydown = event => {
    if (event.code !== "KeyE" || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    const dialog = inventoryDialog();
    const modal = document.querySelector("dialog[open]");
    if (modal && modal !== dialog) return;
    if (document.pointerLockElement && document.pointerLockElement !== canvas) return;
    if (!canvas.isConnected) return;
    event.preventDefault();
    // Keep a remapped movement key from reaching the game while opening a modal.
    event.stopImmediatePropagation();
    if (dialog?.open) closeInventory();
    else openInventory();
  };
  window.addEventListener("keydown", keydown, true);
  return {dispose() { window.removeEventListener("keydown", keydown, true); }};
}
