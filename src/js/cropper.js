/**
 * Choosing the square of a picture that becomes an avatar.
 *
 * Avatars are shown small and square, so a photograph handed over whole is
 * almost never right: a wide holiday shot becomes a thin strip of face between
 * two strangers. This asks which square to keep, and uploads only that.
 *
 * The crop window and the file that leaves it are drawn by the same function
 * from the same three numbers — the centre of the square and its side, in the
 * picture's own pixels — so what is uploaded is exactly what was on screen.
 * Nothing about the original file is sent: it is re-encoded from the canvas,
 * which also throws away the camera metadata that a holiday photo carries
 * around with it, location included.
 */

/** The crop window, in CSS pixels. The canvas itself is this times the DPR. */
const VIEW = 288;

/** Uploaded pictures are at most this square. Beyond it nothing is gained. */
const OUT_MAX = 512;
const OUT_MIN = 96;

/** Zoom runs from the whole square down to a sixth of it. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;

/** WebP is smaller than JPEG at the same quality; the bucket takes both. */
const TYPE = 'image/webp';
const QUALITY = 0.9;

/** How far an arrow key nudges the picture, in crop-window pixels. */
const NUDGE = 12;

/**
 * Ask for the square to keep.
 *
 * @param {File} file  what the player picked
 * @returns {Promise<Blob|null>}  the square, or null if they backed out
 */
export async function cropToSquare(file) {
  const image = await loadImage(file);
  try {
    return await choose(image);
  } finally {
    image.close?.();
  }
}

/**
 * A phone photograph is usually stored sideways with a tag saying which way up
 * it goes. `createImageBitmap` is asked to apply that tag, so the picture
 * arrives the way it looked on the phone. The fallback path is for browsers
 * without it; there an <img> applies the tag itself.
 */
async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Older Safari refuses the options argument rather than ignoring it.
      try {
        return await createImageBitmap(file);
      } catch {
        // Fall through to the <img> path.
      }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // Safe once decoded: the bitmap is the browser's now, not the URL's.
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (image) => ({
  w: image.naturalWidth ?? image.width,
  h: image.naturalHeight ?? image.height,
});

/**
 * The square actually being shown, from where the player has dragged and
 * zoomed to.
 *
 * Zoom 1 is the largest square the picture holds — the whole of it on its
 * short side — so a wide photograph starts as its middle rather than as a
 * strip, and no amount of zooming out can pull in an edge that is not there.
 * The centre is then held far enough inside the picture for the square to
 * stay on it, which is what stops a drag from running off into blank canvas.
 *
 * Pure, and exported, because it is the whole of the cropper that can be
 * wrong in a way nobody would notice by looking.
 */
export function cropBounds({ w, h, zoom, cx, cy }) {
  const limited = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
  const side = Math.min(w, h) / limited;
  return {
    side,
    zoom: limited,
    cx: Math.min(Math.max(cx, side / 2), w - side / 2),
    cy: Math.min(Math.max(cy, side / 2), h - side / 2),
  };
}

function choose(image) {
  const { w, h } = sizeOf(image);

  let zoom = ZOOM_MIN;
  let side = Math.min(w, h);
  let cx = w / 2;
  let cy = h / 2;

  const clamp = () => {
    ({ side, cx, cy, zoom } = cropBounds({ w, h, zoom, cx, cy }));
  };

  /* ---- the dialog ---- */

  const dialog = document.createElement('dialog');
  dialog.className = 'cropper';

  const title = document.createElement('h2');
  title.className = 'cropper__title';
  title.textContent = 'Choose your picture';

  const hint = document.createElement('p');
  hint.className = 'cropper__hint';
  hint.textContent = 'Drag to move, scroll or use the slider to zoom.';

  const frame = document.createElement('div');
  frame.className = 'cropper__frame';

  const canvas = document.createElement('canvas');
  canvas.className = 'cropper__canvas';
  canvas.width = VIEW;
  canvas.height = VIEW;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Picture. Drag or use the arrow keys to move it.');
  frame.append(canvas);

  const zoomRow = document.createElement('label');
  zoomRow.className = 'cropper__zoom';
  const zoomLabel = document.createElement('span');
  zoomLabel.textContent = 'Zoom';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(ZOOM_MIN * 100);
  slider.max = String(ZOOM_MAX * 100);
  slider.value = String(zoom * 100);
  slider.step = '1';
  zoomRow.append(zoomLabel, slider);

  const actions = document.createElement('div');
  actions.className = 'cropper__actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--quiet';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn btn--primary';
  confirm.textContent = 'Use this picture';
  actions.append(cancel, confirm);

  dialog.append(title, hint, frame, zoomRow, actions);
  document.body.append(dialog);

  /* ---- drawing ---- */

  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  canvas.width = Math.round(VIEW * dpr);
  canvas.height = Math.round(VIEW * dpr);

  const draw = () => {
    clamp();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      image,
      cx - side / 2, cy - side / 2, side, side,
      0, 0, canvas.width, canvas.height
    );
  };

  /* ---- moving it about ---- */

  // One crop-window pixel is this many of the picture's own pixels, which is
  // what turns a drag in screen space into a move in image space.
  const perPixel = () => side / VIEW;

  let dragging = null;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const scale = perPixel();
    cx -= (event.clientX - dragging.x) * scale;
    cy -= (event.clientY - dragging.y) * scale;
    dragging = { x: event.clientX, y: event.clientY };
    draw();
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    canvas.releasePointerCapture?.(event.pointerId);
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const setZoom = (next) => {
    zoom = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX);
    slider.value = String(Math.round(zoom * 100));
    draw();
  };

  slider.addEventListener('input', () => setZoom(Number(slider.value) / 100));

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    // A notch is a fixed proportion rather than a fixed amount, so zooming
    // feels the same whether the picture is barely or heavily cropped.
    setZoom(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  canvas.addEventListener('keydown', (event) => {
    const scale = perPixel();
    const moves = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      cx += dx * NUDGE * scale;
      cy += dy * NUDGE * scale;
      draw();
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(zoom * 1.12); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); setZoom(zoom / 1.12); }
  });

  draw();

  /* ---- the answer ---- */

  return new Promise((resolve) => {
    let settled = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => done(null));
    // Escape, and the backdrop on browsers that close on it.
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); done(null); });
    dialog.addEventListener('close', () => done(null));

    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = 'Working…';
      try {
        done(await render(image, cx, cy, side));
      } catch {
        done(null);
      }
    });

    dialog.showModal();
    canvas.focus({ preventScroll: true });
  });
}

/**
 * The chosen square as a file.
 *
 * Never larger than the square actually contains: enlarging it would upload
 * more bytes than there is detail to put in them.
 */
function render(image, cx, cy, side) {
  const out = Math.max(OUT_MIN, Math.min(OUT_MAX, Math.round(side)));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, cx - side / 2, cy - side / 2, side, side, 0, 0, out, out);

  return new Promise((resolve, reject) => {
    // A browser that cannot write the type it was asked for quietly writes a
    // PNG instead, which the bucket also accepts — so whatever comes back is
    // used as it is rather than checked against what was requested.
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be prepared.'))),
      TYPE,
      QUALITY
    );
  });
}
