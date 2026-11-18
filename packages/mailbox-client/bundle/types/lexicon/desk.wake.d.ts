import { Schema } from "effect";
import * as Runtime from "./runtime.js";
export declare const Main: Schema.StructWithRest<Schema.Struct<{
    readonly $type: Schema.Literal<"sh.mschf.ratking.desk.wake">;
    readonly messageId: Schema.brand<Schema.String, "Lexicon:tid">;
    readonly name: Schema.String;
    readonly recordedAt: Schema.brand<Schema.String, "Lexicon:datetime">;
    readonly seq: Schema.optionalKey<Schema.Int>;
    readonly wake: Schema.Literal<true>;
}>, readonly [Schema.$Record<Schema.String, Schema.Codec<Runtime.LexValue, Runtime.LexJson, never, never>>]>;
export type MainValue = typeof Main.Type;
export declare const RecordMetadata: {
    readonly collection: "sh.mschf.ratking.desk.wake";
    readonly key: "tid";
};
