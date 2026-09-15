/**
 * Vision-token accounting and request-image targets.
 *
 * Both modules are pure and version-neutral, so they are driven directly here:
 * `image-tokens.ts` decides what one image costs on the family that serves a
 * catalog model, and `image-request.ts` decides what one request asks the
 * attachment service to encode. The adapter-level wiring (which payload each
 * engine generation hands over, and that the priced dimensions are the ones the
 * request actually carries) is pinned in `tests/adapter.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commandCodeImageTokens,
  imageTokenCost,
  imageTokenFamily,
} from '../src/image-tokens.ts'
import {
  REQUEST_IMAGE_MAX_ENCODED_BYTES,
  REQUEST_IMAGE_MAX_LONG_EDGE,
  longEdgeDimensions,
  requestImageTarget,
} from '../src/image-request.ts'
import { KNOWN_IMAGE_MODELS } from '../src/capabilities.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** One reference at the given intrinsic size. */
function refAt(width: number, height: number): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:priced-image'),
    mediaType: 'image/png',
    bytes: 1024,
    width,
    height,
  }
}

test('imageTokenFamily() reads the vendor out of the catalog id', () => {
  assert.equal(imageTokenFamily('claude-sonnet-5'), 'anthropic')
  assert.equal(imageTokenFamily('claude-haiku-4-5-20251001'), 'anthropic')
  assert.equal(imageTokenFamily('gpt-6-astra'), 'openai')
  assert.equal(imageTokenFamily('o3-mini'), 'openai')
  assert.equal(imageTokenFamily('google/gemini-3.7-flash'), 'google')
  assert.equal(imageTokenFamily('gemini-2.0-flash'), 'google')
  assert.equal(imageTokenFamily('deepseek/deepseek-v4.1-flash'), 'deepseek')
  // Families whose published rule we cannot tell apart from the known ones:
  // Qwen's 28-px patches, MiniMax, xAI, moonshot and sakana all fall back.
  assert.equal(imageTokenFamily('Qwen/Qwen3.8-Max'), 'generic')
  assert.equal(imageTokenFamily('MiniMaxAI/MiniMax-M3'), 'generic')
  assert.equal(imageTokenFamily('xai/grok-5'), 'generic')
  assert.equal(imageTokenFamily('sakana/fugu-ultra'), 'generic')
})

test('every advertised vision model resolves to a family, and its cost is positive', () => {
  // Guards the join the adapter relies on: the pricing path is only reached for
  // models this snapshot calls image-capable, so every one of them must price.
  const families = new Set<string>()
  for (const model of KNOWN_IMAGE_MODELS) {
    const family = imageTokenFamily(model)
    families.add(family)
    assert.ok(commandCodeImageTokens(model, 1568, 980) > 0, `${model} priced zero tokens`)
  }
  // The families the catalog actually reaches, so a new vendor shows up here.
  assert.deepEqual([...families].sort(), ['anthropic', 'deepseek', 'generic', 'google', 'openai'])
})

test('the Anthropic rule projects onto 1568 px, then charges one token per 750 px', () => {
  // At or below the ceiling the source is used as-is.
  assert.equal(imageTokenCost('anthropic', 750, 750), 750)
  // A 3136x1568 source is downscaled to 1568x784 before pricing, exactly as
  // Anthropic's API does, so the estimate tracks what the model receives.
  assert.equal(imageTokenCost('anthropic', 3136, 1568), Math.ceil((1568 * 784) / 750))
  assert.ok(imageTokenCost('anthropic', 3136, 1568) < imageTokenCost('anthropic', 1568, 1568))
})

test('the OpenAI rule reproduces the documented high-detail examples', () => {
  // Published examples: 1024x1024 -> 765 tokens, 2048x4096 -> 1105 tokens.
  assert.equal(imageTokenCost('openai', 1024, 1024), 765)
  assert.equal(imageTokenCost('openai', 2048, 4096), 1105)
})

test('the Gemini rule charges 258 for a small image and 258 per 768-px crop', () => {
  assert.equal(imageTokenCost('google', 384, 384), 258)
  assert.equal(imageTokenCost('google', 385, 300), 258)
  assert.equal(imageTokenCost('google', 1536, 1536), 258 * 4)
})

test('the DeepSeek rule charges a token grid, enlarged below its pixel floor and capped at 1024', () => {
  // 1024x1024 -> 74x74 patches -> 25x25 cells -> 25 * 26 + 2 framing tokens.
  assert.equal(imageTokenCost('deepseek', 1024, 1024), 25 * 26 + 2)
  // The provider caps one image at 1024 tokens, so nothing can price above it
  // however large the source is.
  for (const size of [4096, 8192, 16384]) {
    const tokens = imageTokenCost('deepseek', size, size)
    assert.ok(tokens <= 1024, `${size}px priced ${tokens} tokens, above the provider cap`)
    assert.ok(tokens > 900, `${size}px priced ${tokens} tokens, implausibly far below the cap`)
  }
  // The pixel floor enlarges a tiny image before projection, so a 1-px image is
  // not charged one token.
  assert.ok(imageTokenCost('deepseek', 1, 1) > 1)
  // Monotonic: a bigger source never costs fewer tokens.
  let previous = 0
  for (let size = 64; size <= 4096; size *= 2) {
    const tokens = imageTokenCost('deepseek', size, size)
    assert.ok(tokens >= previous, `${size}px priced below the smaller source`)
    previous = tokens
  }
})

test('the unknown-family fallback never undercuts a known rule', () => {
  const cases: [number, number][] = [[300, 300], [512, 512], [1024, 768], [1568, 980], [4000, 3000]]
  for (const [width, height] of cases) {
    const generic = imageTokenCost('generic', width, height)
    for (const family of ['anthropic', 'openai', 'google'] as const) {
      assert.ok(
        generic >= imageTokenCost(family, width, height),
        `generic ${generic} undercuts ${family} at ${width}x${height}`,
      )
    }
  }
})

test('longEdgeDimensions() projects onto the long edge and never enlarges', () => {
  assert.deepEqual(longEdgeDimensions(2880, 1800, 1568), { width: 1568, height: 980 })
  assert.deepEqual(longEdgeDimensions(1800, 2880, 1568), { width: 980, height: 1568 })
  assert.deepEqual(longEdgeDimensions(320, 200, 1568), { width: 320, height: 200 })
  assert.deepEqual(longEdgeDimensions(1568, 1568, 1568), { width: 1568, height: 1568 })
  // Degenerate input must not become a zero dimension the encoder would refuse.
  assert.deepEqual(longEdgeDimensions(0, 0, 1568), { width: 1, height: 1 })
  assert.deepEqual(longEdgeDimensions(Number.NaN, 10, 1568), { width: 1, height: 10 })
  // An extreme aspect ratio keeps a 1-px short side rather than rounding to 0.
  assert.deepEqual(longEdgeDimensions(20000, 3, 1568), { width: 1568, height: 1 })
})

test('requestImageTarget() speaks both attachment generations at once', () => {
  const target = requestImageTarget(refAt(2880, 1800))
  // <=0.1.5 reads maxPixels; >=0.1.6 reads width/height. Both must describe the
  // SAME geometry, or the two generations would encode differently sized images.
  assert.deepEqual(target, {
    maxPixels: 1568 * 980,
    width: 1568,
    height: 980,
    maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES,
  })
  assert.equal(target.maxPixels, target.width * target.height)
  // A source already inside the budget is requested unchanged.
  assert.deepEqual(requestImageTarget(refAt(800, 600)), {
    maxPixels: 800 * 600,
    width: 800,
    height: 600,
    maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES,
  })
  assert.equal(REQUEST_IMAGE_MAX_LONG_EDGE, 1568)
  assert.equal(REQUEST_IMAGE_MAX_ENCODED_BYTES, 1024 * 1024)
})
