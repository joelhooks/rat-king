import { Schema } from "effect";
import type { Socket } from "effect/socket";

const Frame = Schema.Struct({ data: Schema.String });

const Close = Schema.Struct({ code: Schema.Finite, reason: Schema.String });

export class BarrierSocket implements Socket.WebSocketLike {
  readonly socket: WebSocket;
  private readonly listeners = new Map<
    (event: Socket.WebSocketEvent) => void,
    EventListener
  >();
  private readonly pending: (() => void)[] = [];
  private mode: "held" | "released";
  private readonly onAuth: () => void;

  constructor(url: string, held: boolean, onAuth: () => void) {
    this.onAuth = onAuth;
    this.socket = new WebSocket(url);
    this.mode = held ? "held" : "released";
  }

  get readyState() {
    return this.socket.readyState;
  }

  release() {
    this.mode = "released";

    for (const notify of this.pending.splice(0)) {
      notify();
    }
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean }
  ) {
    const wrapper: EventListener = (event) => {
      if (type === "message") {
        const frame = Schema.decodeUnknownSync(Frame)(event);

        const notify = () => {
          listener(frame);
        };

        if (this.mode === "held") {
          this.pending.push(notify);
        } else {
          notify();
        }
      } else if (type === "close") {
        listener(Schema.decodeUnknownSync(Close)(event));
      } else {
        listener({ type });
      }
    };

    this.listeners.set(listener, wrapper);
    this.socket.addEventListener(type, wrapper, options);
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void
  ) {
    const wrapper = this.listeners.get(listener);

    if (wrapper !== undefined) {
      this.socket.removeEventListener(type, wrapper);
    }

    this.listeners.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    this.socket.send(data);

    if (this.mode === "held") {
      this.onAuth();
    }
  }

  close(code?: number, reason?: string) {
    this.socket.close(code, reason);
  }
}
