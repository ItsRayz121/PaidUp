// Shrink a picked photo to a data: URL small enough for the 2MB ticket-image
// cap (api/src/routes/app.ts's TICKET_IMAGE_MAX_BYTES) before it ever leaves
// the browser — a phone camera photo can be 5-10MB, and there is no reason to
// spend that bandwidth on a support screenshot. Unlike
// profile/settings' toCompressedDataUrl, this keeps the original aspect
// ratio: a screenshot is not square.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

export function toTicketImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that photo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not a photo."));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Could not read that photo.")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
