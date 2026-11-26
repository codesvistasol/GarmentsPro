import { z } from 'zod';

export const productImage = z.string().max(82000).transform((value, ctx) => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match) {
    const [, mimeType, encoded] = match;
    const content = Buffer.from(encoded, 'base64');
    const signature =
      (mimeType === 'image/jpeg' && content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
      (mimeType === 'image/png' && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mimeType === 'image/webp' && content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP');
    if (signature && content.length <= 60 * 1024 && content.toString('base64') === encoded) {
      return { mimeType, content: new Uint8Array(content) };
    }
  }
  ctx.addIssue({ code: 'custom', message: 'Upload a JPEG, PNG, or WebP photo under 60 KB after compression' });
  return z.NEVER;
}).nullable().optional();
