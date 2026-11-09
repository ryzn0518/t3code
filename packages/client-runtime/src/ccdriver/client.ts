import * as Schema from "effect/Schema";
import {
  CCDriverRequests,
  CCDriverNativeSession,
  CCDriverControlReceipt,
  CCDriverControlReply,
  type CCDriverControlMarker,
  CCDriverDescriptor,
  CCDriverSessionSecret,
  CCDriverWorkspace,
  CCDriverMessage,
  CCDriverMessagePage,
  CCDriverTask,
  type CCDriverConnection,
} from "@t3tools/contracts/ccdriver";

import type { CCDriverAnswer } from "./requests.ts";
const decodeRequests = Schema.decodeUnknownSync(CCDriverRequests);
const decodeNativeSession = Schema.decodeUnknownSync(Schema.NullOr(CCDriverNativeSession));
const decodeControlHistory = Schema.decodeUnknownSync(Schema.Array(CCDriverControlReceipt));
const decodeControlReply = Schema.decodeUnknownSync(CCDriverControlReply);
const decodeDescriptor = Schema.decodeUnknownSync(CCDriverDescriptor);
const decodeSessionSecret = Schema.decodeUnknownSync(CCDriverSessionSecret);
const decodeWorkspace = Schema.decodeUnknownSync(CCDriverWorkspace);
const decodeMessagePage = Schema.decodeUnknownSync(CCDriverMessagePage);
const decodeTasks = Schema.decodeUnknownSync(Schema.Array(CCDriverTask));
const decodeMessage = Schema.decodeUnknownSync(CCDriverMessage);

export class CCDriverError extends Schema.TaggedError<CCDriverError>()("CCDriverError", {
  code: Schema.Literals(["address", "network", "identity", "protocol", "http"]),
  status: Schema.Number,
}) {
  override get message() {
    return this.code === "http"
      ? `ccdriver request failed (${this.status})`
      : `ccdriver ${this.code} error`;
  }
}

export function normalizeCCDriverOrigin(input: string, allowLocalHttp = false): string {
  try {
    const url = new URL(input.trim());
    const local = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new CCDriverError({ code: "address", status: 0 });
    return url.origin;
  } catch {
    throw new CCDriverError({ code: "address", status: 0 });
  }
}

export type CCDriverFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: "error";
    credentials: "omit";
    body?: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  json(): Promise<unknown>;
}>;

export class CCDriverClient {
  readonly origin: string;
  private verified = false;
  private readonly fetcher: CCDriverFetch;
  private readonly connection: CCDriverConnection | null;

  constructor(
    origin: string,
    fetcher: CCDriverFetch,
    connection: CCDriverConnection | null = null,
    allowLocalHttp = false,
  ) {
    this.fetcher = fetcher;
    this.connection = connection;
    this.origin = normalizeCCDriverOrigin(origin, allowLocalHttp);
    if (connection && normalizeCCDriverOrigin(connection.origin, allowLocalHttp) !== this.origin) {
      throw new CCDriverError({ code: "identity", status: 0 });
    }
  }

  private async request<T>(
    method: string,
    path: string,
    decode: (raw: unknown) => T,
    signal: AbortSignal,
    body?: object,
    authenticated = true,
  ): Promise<T> {
    if (authenticated && (!this.connection || !this.verified)) {
      throw new CCDriverError({ code: "identity", status: 0 });
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (authenticated && this.connection) {
      headers.Authorization = `Bearer ${this.connection.token}`;
      headers["X-CCDriver-Project-ID"] = this.connection.session.project_id;
    }
    let response: Awaited<ReturnType<CCDriverFetch>>;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method,
        headers,
        signal,
        redirect: "error",
        credentials: "omit",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CCDriverError({ code: "network", status: 0 });
    }
    if (response.url && new URL(response.url).origin !== this.origin) {
      throw new CCDriverError({ code: "identity", status: 0 });
    }
    if (!response.ok) throw new CCDriverError({ code: "http", status: response.status });
    try {
      return decode(response.status === 204 ? null : await response.json());
    } catch {
      throw new CCDriverError({ code: "protocol", status: 0 });
    }
  }

  async verify(signal: AbortSignal) {
    this.verified = false;
    const descriptor = await this.request(
      "GET",
      "/api/client/descriptor",
      decodeDescriptor,
      signal,
      undefined,
      false,
    );
    if (
      !descriptor.capabilities.device_sessions ||
      (this.connection && this.connection.server_id !== descriptor.server_id)
    ) {
      throw new CCDriverError({ code: "identity", status: 0 });
    }
    this.verified = true;
    return descriptor;
  }

  async pair(token: string, deviceName: string, signal: AbortSignal): Promise<CCDriverConnection> {
    const descriptor = await this.verify(signal);
    const secret = await this.request(
      "POST",
      "/api/client/pairings/exchange",
      decodeSessionSecret,
      signal,
      { token: token.trim(), server_id: descriptor.server_id, device_name: deviceName.trim() },
      false,
    );
    return { origin: this.origin, server_id: descriptor.server_id, ...secret };
  }

  workspace(signal: AbortSignal) {
    return this.request("GET", "/api/assistant", decodeWorkspace, signal);
  }

  messages(cursor: string, signal: AbortSignal) {
    return this.request(
      "GET",
      `/api/assistant/messages?limit=100&cursor=${encodeURIComponent(cursor)}`,
      decodeMessagePage,
      signal,
    );
  }

  tasks(signal: AbortSignal) {
    return this.request("GET", "/api/assistant/tasks", decodeTasks, signal);
  }

  send(content: string, key: string, signal: AbortSignal) {
    return this.request("POST", "/api/assistant/messages", decodeMessage, signal, {
      content,
      idempotency_key: key,
    });
  }

  stop(taskID: string, signal: AbortSignal) {
    return this.request(
      "POST",
      `/api/assistant/tasks/${encodeURIComponent(taskID)}/stop`,
      () => undefined,
      signal,
      {},
    );
  }

  revoke(signal: AbortSignal) {
    return this.request("DELETE", "/api/client/session", () => undefined, signal);
  }
  requests(signal: AbortSignal) {
    return this.request("GET", "/api/assistant/requests", decodeRequests, signal);
  }
  nativeSession(task: string, signal: AbortSignal) {
    return this.request(
      "GET",
      `/api/tasks/${encodeURIComponent(task)}/native-session`,
      decodeNativeSession,
      signal,
    );
  }
  controlHistory(task: string, signal: AbortSignal) {
    return this.request(
      "GET",
      `/api/tasks/${encodeURIComponent(task)}/native-session?history=1`,
      decodeControlHistory,
      signal,
    );
  }
  respond(marker: CCDriverControlMarker, answer: CCDriverAnswer, signal: AbortSignal) {
    return this.request(
      "POST",
      `/api/tasks/${encodeURIComponent(marker.task_id)}/native-session`,
      decodeControlReply,
      signal,
      {
        connection_id: marker.connection_id,
        thread_id: marker.thread_id,
        turn_id: marker.turn_id,
        request_id: marker.request_id,
        idempotency_key: marker.idempotency_key,
        operation: "respond",
        ...(answer.choice_id ? { choice_id: answer.choice_id } : { answers: answer.answers }),
      },
    );
  }
}
