/**
 * Request-image targets: the shape one provider request asks the attachment
 * service to produce.
 *
 * An attachment is stored NORMALIZED, not request-ready — `readImage()` answers
 * the full normalized original, which is what admission accepted. Every request
 * should carry a REQUEST VERSION instead (`readImageRequest()`): the same image
 * re-encoded to a route target and cached under it. On this route that matters
 * three times over, because both transports inline every historical image as
 * base64: bytes become context, latency, and progress against the gateway's
 * undocumented ~50 MB body cap (see the request image budget in `./adapter.ts`).
 *
 * The target IS the projected geometry — `{ width, height, maxBytes }` — which
 * the attachment service passes straight to its encoder.
 *
 * @module dsh-commandcode-provider/image-request
 */

import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'

/**
 * Long edge one request image may keep, in pixels.
 *
 * 1568 is Anthropic's documented ceiling — their API downscales anything larger
 * before the model sees it — and it sits inside the high-detail band of the
 * OpenAI and Gemini tile schemes, so no upstream this gateway reaches reads
 * more detail than the target keeps. Screenshots from a Retina display are the
 * case this is for: 2880x1800 becomes 1568x980, a 3.4x pixel cut, and the
 * models lose nothing they would not have downscaled themselves.
 */
export const REQUEST_IMAGE_MAX_LONG_EDGE = 1568

/**
 * Encoded bytes one request image may keep, before base64 expansion. The same
 * 1 MiB budget the harness's own multi-provider adapter defaults to; the
 * attachment service keeps its smallest quality-ladder output when no quality
 * fits, so this bounds bytes without ever refusing an image.
 */
export const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1024 * 1024

/**
 * Aspect-preserving projection onto a long-edge budget; never enlarges, and
 * never returns a zero dimension (a 1-px degenerate side is what the round of
 * an extreme aspect ratio can produce, and a 0 would make the encoder refuse).
 *
 * `dsh-attachment` exports an equivalent `longEdgeDimensions`, but it does not
 * guard its inputs: a reference whose declared size is 0 or NaN — a malformed
 * or fabricated attachment record — would project to a zero-sized target and
 * make the encoder refuse the whole request. The guard is the reason this stays
 * local; `tests/image-tokens.test.ts` pins the degenerate cases.
 */
export function longEdgeDimensions(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    // Defensive: a malformed reference must not become a zero-sized target.
    return { width: Math.max(1, Math.round(width) || 1), height: Math.max(1, Math.round(height) || 1) }
  }
  if (longEdge >= Math.max(width, height)) return { width, height }
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) }
    : { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge }
}

/**
 * The request target for one normalized attachment: its aspect ratio under the
 * long-edge budget, plus the encoded-byte budget.
 */
export function requestImageTarget(ref: ImageAttachmentRef): ImageRequestTarget {
  const projected = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE)
  return {
    width: projected.width,
    height: projected.height,
    maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES,
  }
}
