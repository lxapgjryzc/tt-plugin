// Image rules shared by the queue page and the service worker (requirements R1.2).
// Pure: works on anything with `type` and `size` (File, Blob).

// Message key for what is wrong with one image, or null.
export function imageProblem(target, blob) {
  if (!blob) return 'errNoImage';
  if (!String(blob.type).startsWith('image/')) return 'errNotImage';
  if (!target.imageTypes.includes(blob.type)) return 'errImageType';
  if (blob.size === 0) return 'errEmptyFile';
  if (blob.size > target.maxUploadBytes) return 'errTooLarge';
  return null;
}

// Message key for what is wrong with a set of images sent as one round, or null.
export function imageSetProblem(target, blobs) {
  if (!blobs?.length) return 'errNoImage';
  if (blobs.length > target.maxImagesPerSubmission) return 'errTooManyImages';
  for (const b of blobs) {
    const p = imageProblem(target, b);
    if (p) return p;
  }
  return null;
}
