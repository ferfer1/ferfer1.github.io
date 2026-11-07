// Turns album covers into images for the G2 display.
//
// The glasses show 16 shades of green (4-bit greyscale), where black = off.
// We convert the cover to 16 grey levels ourselves (no dithering, which looks
// noisy on the display) so the phone preview matches what the glasses show.
// The result is sent as PNG bytes; the Even app converts it for the glasses.

export const ART_SIZE = 120; // px, square. Image containers allow up to 288x144.

const cache = new Map(); // url -> Promise<{ png: Uint8Array, gray: Uint8ClampedArray }>
const MAX_CACHE = 8;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // Spotify's image server allows this, so we can read the pixels
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load album art"));
    img.src = url;
  });
}

/** Grey levels (0-255, one per pixel) quantised to 16 shades, with the contrast stretched. */
function toSixteenShades(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const lum = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Stretch contrast between the 2nd and 98th percentile so dull covers still read well.
  // Skip the stretch for low-contrast covers (e.g. mostly white), or they'd turn black.
  const sorted = Uint8ClampedArray.from(lum).sort();
  let lo = sorted[Math.floor(n * 0.02)];
  let hi = sorted[Math.floor(n * 0.98)];
  if (hi - lo < 64) { lo = 0; hi = 255; }
  const range = hi - lo;

  for (let i = 0; i < n; i++) {
    const v = ((lum[i] - lo) / range) * 255;
    lum[i] = Math.round(Math.min(255, Math.max(0, v)) / 17) * 17; // 16 levels: 0, 17, ..., 255
  }
  return lum;
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Couldn't encode album art"));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

async function render(url) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ART_SIZE;
  const ctx = canvas.getContext("2d");

  let gray;
  if (url) {
    const img = await loadImage(url);
    // Crop to a centred square, then scale to ART_SIZE.
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, ART_SIZE, ART_SIZE);
    gray = toSixteenShades(ctx.getImageData(0, 0, ART_SIZE, ART_SIZE));
  } else {
    gray = new Uint8ClampedArray(ART_SIZE * ART_SIZE); // blank (all off)
  }

  const out = ctx.createImageData(ART_SIZE, ART_SIZE);
  gray.forEach((v, i) => {
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(out, 0, 0);
  return { png: await canvasToPng(canvas), gray };
}

/** Get (and cache) the glasses-ready version of a cover. url "" = blank image. */
export function getArt(url) {
  if (!cache.has(url)) {
    const job = render(url).catch(() => render("")); // on failure, show nothing rather than break
    cache.set(url, job);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  return cache.get(url);
}

/** Draw the 16-shade image onto a preview canvas, tinted green like the glasses. */
export function drawGreenPreview(canvas, gray) {
  canvas.width = canvas.height = ART_SIZE;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(ART_SIZE, ART_SIZE);
  gray.forEach((v, i) => {
    out.data[i * 4] = v * 0.24;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v * 0.48;
    out.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(out, 0, 0);
}
