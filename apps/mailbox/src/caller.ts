import { Context } from "effect";

export class Caller extends Context.Service<Caller, { readonly did: string }>()(
  "mailbox/Caller"
) {}
