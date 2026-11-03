// Thumbnails for the queue page (requirements R8). Pages never display an original
// image: a drawing can be ~100 megapixels, and showing it even at 40 px makes the browser
// decode and resample it on every repaint.

export const THUMB_WIDTH = 240;
const MAX_ASPECT = 4; // very tall images are limited by height instead

// A small WebP of `blob`, at most THUMB_WIDTH wide (and 4× that tall). Throws if the
// browser cannot decode the image.
export async function makeThumb(blob, width = THUMB_WIDTH) {
  // Resizing while decoding avoids holding the full-size bitmap.
  let bmp = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'medium' });
  if (bmp.height > width * MAX_ASPECT) {
    bmp.close();
    bmp = await createImageBitmap(blob, { resizeHeight: width * MAX_ASPECT, resizeQuality: 'medium' });
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
}
