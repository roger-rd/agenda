// Session-only files. Object URLs belong to the mounted preview and are revoked on unmount.
export const attachmentFiles = new Map<string, File>();

export function mountAttachmentPreview(element: HTMLImageElement, file: File): () => void {
  const url = URL.createObjectURL(file);
  element.src = url;
  return () => URL.revokeObjectURL(url);
}
