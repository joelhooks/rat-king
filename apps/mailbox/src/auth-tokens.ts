import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "./bindings.ts";

export class AuthTokens extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tokens (issuer TEXT NOT NULL, jti TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY(issuer,jti))"
    );
  }
  consume(issuer: string, jti: string, exp: number, now: number) {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM tokens WHERE exp <= ?",
        Math.floor(now / 1000)
      );

      const existing = this.ctx.storage.sql
        .exec("SELECT jti FROM tokens WHERE issuer=? AND jti=?", issuer, jti)
        .toArray();

      if (existing.length) {
        return false;
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO tokens (issuer,jti,exp) VALUES (?,?,?)",
        issuer,
        jti,
        exp
      );

      return true;
    });
  }
}
