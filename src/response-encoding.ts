/**
 * Ask Command Code for plain response bodies. A DSH host using an incompatible
 * undici global dispatcher can lose response headers and leave compressed
 * JSON, SSE, and pre-stream error bodies undecoded.
 */
export const IDENTITY_ENCODING_HEADER = { 'accept-encoding': 'identity' } as const
