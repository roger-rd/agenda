/** VisualViewport puede reducirse por teclado o zoom; ambos necesitan espacio visible. */
export function dialogViewport(layoutHeight: number, viewport?: { height: number; offsetTop: number }) {
  const height = Math.max(0, Math.min(layoutHeight, viewport?.height ?? layoutHeight));
  const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
  const keyboardInset = Math.max(0, layoutHeight - height - offsetTop);
  return { height, offsetTop, keyboardInset, staticFooter: height < 420 };
}
