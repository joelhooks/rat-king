import { Resource } from "alchemy";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Option, Schema } from "effect";

import { absent } from "./absent.ts";
import { refuse } from "./files.ts";
import { HostShell } from "./host-shell.ts";
import {
  deleteUnit,
  needsUpdate,
  readUnit,
  reconcileUnit,
  unitPath,
  validateUnit,
  UnitSchema,
} from "./systemd.ts";
import type { UnitAttributes, UnitProps } from "./systemd.ts";
import { UnitStartup } from "./unit-startup.ts";

export interface NodeProps extends UnitProps {
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly version: "v0.6.1";
}

export interface NodeAttributes extends UnitAttributes {
  readonly publicUrl: string;
  readonly internalUrl: string;
  readonly version: "v0.6.1";
}

export type CelldNodeResource = Resource<
  "Celld.Node",
  NodeProps,
  NodeAttributes
>;

export const NodeResource = Resource<CelldNodeResource>("Celld.Node");

const urls = (props: NodeProps) => ({
  internalUrl: props.internalUrl,
  publicUrl: props.publicUrl,
  version: props.version,
});

export const NodeProvider = () =>
  Provider.effect(
    NodeResource,
    Effect.gen(function* provider() {
      const shell = yield* HostShell;
      const startup = yield* Effect.serviceOption(UnitStartup);

      return NodeResource.Provider.of({
        delete: ({ output }) => deleteUnit(shell, output),
        diff: Effect.fn("Celld.Node.diff")(function* operation({
          news,
          output,
        }) {
          if (!isResolved(news)) {
            return absent;
          }

          yield* validateUnit(news);

          if (output === undefined) {
            return { action: "update" };
          }

          if (unitPath(news) !== output.path) {
            if ((yield* readUnit(shell, news)) !== undefined) {
              return yield* refuse("Replacement node unit already exists.");
            }

            return { action: "replace", deleteFirst: true };
          }

          const changed =
            needsUpdate(news, output, yield* readUnit(shell, news)) ||
            news.publicUrl !== output.publicUrl ||
            news.internalUrl !== output.internalUrl ||
            news.version !== output.version;

          return { action: changed ? "update" : "noop" };
        }),
        list: () => Effect.succeed([]),
        read: Effect.fn("Celld.Node.read")(function* operation({
          olds,
          output,
        }) {
          if (output === undefined && !Schema.is(UnitSchema)(olds)) {
            return absent;
          }

          const unit = yield* readUnit(shell, olds);

          if (unit === undefined) {
            return absent;
          }

          const live = { ...unit, ...urls(olds) };

          return output === undefined
            ? Unowned(live)
            : {
                ...live,
                configSha256: output.configSha256,
                sha256: output.sha256,
              };
        }),
        reconcile: Effect.fn("Celld.Node.reconcile")(function* operation({
          news,
          olds,
          output,
        }) {
          const adopt = yield* Effect.serviceOption(AdoptPolicy).pipe(
            Effect.map(Option.getOrElse(() => false))
          );

          if (Option.isSome(startup)) {
            yield* startup.value.beforeStart(news.name, news.home);
          }

          const unit = yield* reconcileUnit(
            shell,
            news,
            olds === undefined ? undefined : output,
            adopt
          );

          if (Option.isSome(startup)) {
            yield* startup.value.afterStart(news.name);
          }

          return { ...unit, ...urls(news) };
        }),
      });
    })
  );
