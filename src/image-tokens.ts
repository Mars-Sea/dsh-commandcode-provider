/**
 * Vision-token accounting for the model families Command Code routes to.
 *
 * The harness's token meter prices request images through
 * `LlmAdapter.imageRequestPricing(provider, model).priceImages(blocks)` and,
 * when a route declares nothing, falls back to a structural estimate that
 * charges a handful of tokens for ANY image. On an image-heavy session that is
 * not a rounding error: a screenshot loop can carry dozens of full-size images
 * that the heuristic prices at ~0 tokens each, so context pressure is
 * under-reported and the session walks into its own context window.
 *
 * This route is a gateway in front of many upstreams — one catalog id per model,
 * but the visual-token rule belongs to whoever serves it. So the estimate is per
 * FAMILY, using each vendor's published rule, and the families are recognised by
 * the catalog id (which names the vendor). Every formula is stated here rather
 * than imported: the only in-tree implementations live inside the official
 * adapters, and this plugin deliberately does not depend on those protocols.
 *
 * These are ESTIMATES for context accounting, not invoices — the provider's own
 * usage remains authoritative for a completed request, exactly as the published
 * per-token rates the session-cost readout uses are.
 *
 * @module dsh-commandcode-provider/image-tokens
 */

import { longEdgeDimensions } from './image-request.ts'

/** The published visual-token rules this route can tell apart. */
export type ImageTokenFamily = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'generic'

/**
 * Which family prices one catalog model id.
 *
 * `generic` is not "we do not know the model" but "we cannot tell its visual
 * rule apart from the known ones" — the Qwen, MiniMax, xAI, moonshot and
 * sakana families all publish patch- or tile-based accounting close to the
 * Anthropic rule, so the conservative fallback below covers them without
 * pretending to more precision than we have.
 */
export function imageTokenFamily(modelId: string): ImageTokenFamily {
  const id = modelId.toLowerCase()
  const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : ''
  if (id.startsWith('claude')) return 'anthropic'
  if (id.startsWith('gpt') || /^o[1-9]/.test(id)) return 'openai'
  if (vendor === 'google' || id.startsWith('gemini')) return 'google'
  if (vendor === 'deepseek') return 'deepseek'
  return 'generic'
}

/**
 * Visual tokens one request image costs on the given family, at the dimensions
 * this route would actually send (see `./image-request.ts`).
 */
export function imageTokenCost(family: ImageTokenFamily, width: number, height: number): number {
  switch (family) {
    case 'anthropic': return anthropicImageTokens(width, height)
    case 'openai': return openAiImageTokens(width, height)
    case 'google': return googleImageTokens(width, height)
    case 'deepseek': return deepSeekImageTokens(width, height)
    default: return genericImageTokens(width, height)
  }
}

/** Convenience for callers that have a model id: family lookup plus the rule. */
export function commandCodeImageTokens(modelId: string, width: number, height: number): number {
  return imageTokenCost(imageTokenFamily(modelId), width, height)
}

/**
 * Anthropic: the image is first scaled so its long edge is at most 1568 px
 * (never enlarged), then charged roughly one token per 750 pixels.
 * Source: Anthropic vision documentation, "Image size and token usage".
 */
function anthropicImageTokens(width: number, height: number): number {
  const projected = longEdgeDimensions(width, height, 1568)
  return Math.max(1, Math.ceil((projected.width * projected.height) / 750))
}

/**
 * OpenAI (high detail): scale to fit inside 2048x2048, then scale the shortest
 * side to 768 px, then charge an 85-token base plus 170 tokens per 512x512
 * tile. Source: OpenAI vision documentation, "Calculating costs".
 */
function openAiImageTokens(width: number, height: number): number {
  let scaled = { width: Math.max(1, width), height: Math.max(1, height) }
  const longest = Math.max(scaled.width, scaled.height)
  if (longest > 2048) scaled = scaleBy(scaled, 2048 / longest)
  const shortest = Math.min(scaled.width, scaled.height)
  if (shortest > 768) scaled = scaleBy(scaled, 768 / shortest)
  const tiles = Math.ceil(scaled.width / 512) * Math.ceil(scaled.height / 512)
  return 85 + 170 * tiles
}

/**
 * Google Gemini: an image whose both sides are at most 384 px costs a flat 258
 * tokens; anything larger is cropped into 768x768 tiles of 258 tokens each.
 * Source: Gemini image-understanding documentation.
 */
function googleImageTokens(width: number, height: number): number {
  if (width <= 384 && height <= 384) return 258
  return 258 * Math.ceil(width / 768) * Math.ceil(height / 768)
}

/** 14-px patches, merged 3x3 into one token cell. */
const DEEPSEEK_PATCH_SIZE = 14
const DEEPSEEK_DOWNSAMPLE_RATIO = 3
/** The provider's cap on tokens for one request image. */
const DEEPSEEK_MAX_IMAGE_TOKENS = 1024
/** Total-pixel floor; a smaller image is enlarged before grid projection. */
const DEEPSEEK_MIN_PIXELS = 544 * 544

/**
 * DeepSeek: pad to 14-px patches, merge each 3x3 patch block into one token
 * cell, charge one token per cell plus one separator per row plus two framing
 * tokens, and cap one image at 1024 tokens by downscaling it aspect-preserving
 * (images below 544x544 are enlarged first).
 *
 * Mirrors `deepSeekImageTokens` in the official `dsh-llm-deepseek` adapter
 * (its `PATCH_SIZE`, `DOWNSAMPLE_RATIO`, `MAX_IMAGE_TOKENS` and `MIN_PIXELS`).
 * The official solver picks the largest grid that fits the cap; this restates
 * that as a bounded search over the scale factor, which lands on the same grid
 * without vendoring the closed-form solver.
 */
function deepSeekImageTokens(width: number, height: number): number {
  let scaled = { width: Math.max(1, width), height: Math.max(1, height) }
  const pixels = scaled.width * scaled.height
  if (pixels < DEEPSEEK_MIN_PIXELS) scaled = scaleBy(scaled, Math.sqrt(DEEPSEEK_MIN_PIXELS / pixels))

  const direct = deepSeekGridTokens(scaled.width, scaled.height)
  if (direct <= DEEPSEEK_MAX_IMAGE_TOKENS) return direct

  // Over the cap: the provider keeps the aspect ratio and downsamples until the
  // grid fits, so the charge is the largest fitting grid — never above the cap.
  let low = 0
  let high = 1
  let best = direct
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    const tokens = deepSeekGridTokens(
      Math.max(1, Math.round(scaled.width * mid)),
      Math.max(1, Math.round(scaled.height * mid)),
    )
    if (tokens <= DEEPSEEK_MAX_IMAGE_TOKENS) {
      low = mid
      best = tokens
    } else {
      high = mid
    }
  }
  return best
}

/** One token grid's charge: every row carries a separator, plus two framing tokens. */
function deepSeekGridTokens(width: number, height: number): number {
  const cellsWide = cellCount(width)
  const cellsHigh = cellCount(height)
  return cellsHigh * (cellsWide + 1) + 2
}

/** Token cells along one padded pixel axis. */
function cellCount(length: number): number {
  const patches = Math.ceil(length / DEEPSEEK_PATCH_SIZE)
  return Math.ceil(patches / DEEPSEEK_DOWNSAMPLE_RATIO)
}

/**
 * The conservative fallback for a family we cannot price exactly: the MOST
 * expensive of the three simple published rules at these dimensions.
 *
 * Chosen deliberately. Under-reporting context is what lets a session walk into
 * its own context window, while over-reporting only makes the meter cautious;
 * for the real families this covers (Qwen's 28-px patches, MiniMax, xAI,
 * moonshot, sakana) the Anthropic rule is the close one, and it is the maximum
 * at every size except the sub-384-px band, where Gemini's flat 258 wins.
 */
function genericImageTokens(width: number, height: number): number {
  return Math.max(
    anthropicImageTokens(width, height),
    openAiImageTokens(width, height),
    googleImageTokens(width, height),
  )
}

/** Scale one dimension pair by a positive factor, rounded to whole pixels. */
function scaleBy(
  size: { width: number; height: number },
  factor: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  }
}
