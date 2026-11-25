/**
 * Compiled Collector payload descriptor (design 2.1: the compiled constant is authoritative; the
 * packaged `collector-payload.json` is informational).
 *
 * In a development or test build this module is exactly what you read: no payload is embedded.
 * `npm run package:windows:stage` replaces the staged copy of the emitted module
 * (`scripts/embed-collector-payload.mjs`) with one that carries the descriptor built from the
 * pinned Collector ZIP and the Host files. The composition root treats "not embedded" as a hard
 * failure in a packaged app and as "feature off" in a development build.
 */
export const COLLECTOR_PAYLOAD_EMBEDDED: boolean = false;
export const COMPILED_COLLECTOR_PAYLOAD: unknown = null;
