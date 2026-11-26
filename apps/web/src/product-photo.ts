export async function prepareProductPhoto(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG, or WebP image under 12 MB.');
  }
  const photo = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable.');
    for (const edge of [640, 480, 320, 240]) {
      const scale = Math.min(1, edge / Math.max(photo.width, photo.height));
      canvas.width = Math.max(1, Math.round(photo.width * scale));
      canvas.height = Math.max(1, Math.round(photo.height * scale));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(photo, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.72);
      if (image.length <= 81000) return image;
    }
    throw new Error('This photo is too large after compression. Choose a smaller photo.');
  } finally {
    photo.close();
  }
}
