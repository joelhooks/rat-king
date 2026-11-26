import { Effect } from "effect";
import { EnvelopeFailure } from "./failure.js";
export declare const p256Order = 115792089210356248762697446949407573529996955224135760342422259061068512044369n;
export declare const normalizeSignature: (signature: Uint8Array) => Uint8Array<ArrayBuffer>;
export declare const lowS: (signature: Uint8Array) => boolean;
export type Es256Signer = (bytes: Uint8Array) => Effect.Effect<Uint8Array, EnvelopeFailure>;
export declare const sign: (key: CryptoKey | Es256Signer, bytes: Uint8Array<ArrayBufferLike>) => Effect.Effect<Uint8Array<ArrayBufferLike>, EnvelopeFailure, never>;
export declare const verify: (key: CryptoKey, bytes: Uint8Array<ArrayBufferLike>, signature: Uint8Array<ArrayBufferLike>) => Effect.Effect<boolean, EnvelopeFailure, never>;
