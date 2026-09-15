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
 * ONE target serves both attachment generations, although they disagree on the
 * shape AND on where the projection happens:
 *
 *   ≤ 0.1.5 — `readImageRequest(ref, policy)` takes `{ maxPixels, maxBytes }` and
 *             applies the pixel budget itself, aspect-preserving.
 *   ≥ 0.1.6 — `readImageRequest(ref, target)` takes the ALREADY PROJECTED
 *             `{ width, height, maxBytes }`; there is no pixel budget any more.
 *
 * So the target carries both vocabularies: the projected dimensions, plus the
 * pixel area they came from. Each generation reads the fields it knows and
 * ignores the rest — which is why the object is BUILT HERE and passed as a
 * variable: an object literal at the call site would be rejected by the
 * excess-property check of whichever generation's types this checkout compiles
 * against, and those types are a release behind the engine at runtime.
 *
 * Nothing in here may import a version-specific helper (`longEdgeDimensions`
 * only exists from 0.1.6), so the projection is restated locally.
 *
 * @module dsh-commandcode-provider/image-request
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

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
 * One image's request target, in both generations' vocabulary at once. See the
 * module note: the extra fields are deliberate, not leftovers.
 */
export interface RequestImageTarget {
  /** ≤0.1.5's pixel budget: the projected area this target came from. */
  maxPixels: number
  /** ≥0.1.6's target width, already projected. */
  width: number
  /** ≥0.1.6's target height, already projected. */
  height: number
  /** Both generations' encoded-byte budget. */
  maxBytes: number
}

/**
 * Aspect-preserving projection onto a long-edge budget; never enlarges, and
 * never returns a zero dimension (a 1-px degenerate side is what the round of
 * an extreme aspect ratio can produce, and a 0 would make the encoder refuse).
 *
 * A local restatement of the helper 0.1.6 exports from `dsh-attachment`, which
 * 0.1.2–0.1.5 do not have; the math is the whole contract, so keeping the copy
 * here costs less than a version probe would.
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
 * long-edge budget, plus the byte budget every generation honours.
 *
 * The area is computed from the PROJECTED dimensions rather than the source's,
 * so ≤0.1.5's own pixel projection lands on the same geometry instead of
 * re-deriving a slightly different one from the original.
 */
export function requestImageTarget(ref: ImageAttachmentRef): RequestImageTarget {
  const projected = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE)
  return {
    maxPixels: projected.width * projected.height,
    width: projected.width,
    height: projected.height,
    maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES,
  }
}
