import { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";

export const failure = (error: string, status = 400, message = error) =>
  new XrpcFailure({ error, message, response: { error, message }, status });
