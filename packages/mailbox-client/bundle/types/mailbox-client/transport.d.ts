import { Transport } from "../lexicon/transport.js";
import { Layer } from "effect";
import { HttpClient } from "effect/http";
import type { RuntimeIdentity } from "./identity.js";
export declare const transportLayer: (endpoint: string, audience: string, identity: RuntimeIdentity) => Layer.Layer<Transport, never, HttpClient.HttpClient>;
