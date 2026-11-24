/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Upstream validates the PLC operation and serializes the public DID document in these adapter signatures. */
declare module "@atproto/pds" {
  import type { Server } from "node:http";

  interface ServiceRequest {
    readonly get: (name: string) => string | undefined;
  }

  interface ServiceResponse {
    readonly sendStatus: (status: number) => ServiceResponse;
    readonly set: (name: string, value: string) => ServiceResponse;
    readonly json: (value: unknown) => ServiceResponse;
  }

  interface Application {
    readonly get: (
      path: string,
      handle: (request: ServiceRequest, response: ServiceResponse) => void
    ) => Application;
    listen: (port: number, host?: string) => Server;
  }

  export const PDS: {
    readonly run: (options: {
      readonly env: {
        readonly acceptingImports: boolean;
        readonly adminPassword: string;
        readonly blobstoreDiskLocation: string;
        readonly blobstoreDiskTmpLocation: string;
        readonly dataDirectory: string;
        readonly didPlcUrl: string | undefined;
        readonly hostname: string;
        readonly inviteRequired: boolean;
        readonly jwtSecret: string;
        readonly plcRotationKeyK256PrivateKeyHex: string;
        readonly port: number;
        readonly rateLimitsEnabled: boolean;
        readonly serviceDid: string;
        readonly synchronousFull: boolean;
        readonly trustedProxies: string[];
      };
      readonly onCreated: (pds: { readonly app: Application }) => void;
      readonly onStarted:
        | ((pds: { readonly server?: Server }) => void)
        | undefined;
      readonly signal: AbortSignal | undefined;
    }) => Promise<void>;
  };
}

declare module "@did-plc/lib" {
  export function assureValidCreationOp(
    did: string,
    op: unknown
  ): Promise<unknown>;
  export function formatDidDoc(data: unknown): {
    readonly id: string;
    readonly alsoKnownAs: readonly string[];
    readonly service: readonly { readonly serviceEndpoint: string }[];
  };
}
