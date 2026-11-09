import * as Schema from "effect/Schema";
import {
  CCDriverControlMarker,
  type CCDriverRequests,
  type CCDriverPendingItem,
  type CCDriverNativeRequest,
  CCDriverConnection,
  CCDriverConversationCache,
  CCDriverPendingMessage,
  type CCDriverMessage,
  type CCDriverTask,
  type CCDriverWorkspace,
} from "@t3tools/contracts/ccdriver";
import { CCDriverClient, CCDriverError, type CCDriverFetch } from "./client.ts";

import { validNativeAnswer, type CCDriverAnswer } from "./requests.ts";

export interface CCDriverStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CCDriverSnapshot {
  readonly requests: CCDriverRequests | null;
  readonly requestsError: string | null;
  readonly controlPending: CCDriverControlMarker | null;
  readonly requestNotice: string | null;
  readonly connection: CCDriverConnection | null;
  readonly workspace: CCDriverWorkspace | null;
  readonly messages: readonly CCDriverMessage[];
  readonly tasks: readonly CCDriverTask[];
  readonly pending: CCDriverPendingMessage | null;
  readonly phase: "loading" | "unpaired" | "syncing" | "ready" | "offline" | "expired";
  readonly error: string | null;
}

const isCCDriverError = Schema.is(CCDriverError);
const decodeCache = Schema.decodeUnknownSync(CCDriverConversationCache);
const decodePending = Schema.decodeUnknownSync(CCDriverPendingMessage);
const decodeConnection = Schema.decodeUnknownSync(CCDriverConnection);

const decodeControlMarker = Schema.decodeUnknownSync(CCDriverControlMarker);

const CONNECTION_KEY = "ccdriver.connection.v1";
const NATIVE_REQUESTS_UNSUPPORTED = "当前服务端未开放手机审批，请在网页处理。";

function errorText(error: unknown): string {
  if (!isCCDriverError(error)) return "无法保存本机数据，请检查设备存储后重试。";
  if (error.status === 401) return "设备授权已过期或被撤销，请重新配对。";
  if (error.status === 403) return "当前用户没有执行此操作的权限。";
  if (error.code === "identity") return "服务器身份或接入能力不匹配，请核对地址。";
  if (error.code === "address") return "请输入完整的 HTTPS 服务器地址，不包含路径或配对码。";
  if (error.code === "protocol") return "服务器返回的数据不兼容，请检查服务版本。";
  return "暂时无法连接服务器，请检查私网连接后重试。";
}

interface CCDriverPorts {
  fetch: CCDriverFetch;
  secrets: CCDriverStorage;
  data: CCDriverStorage;
  newID: () => string;
  allowLocalHttp?: boolean;
}

export class CCDriverController {
  private state: CCDriverSnapshot = {
    requests: null,
    requestsError: null,
    controlPending: null,
    requestNotice: null,
    connection: null,
    workspace: null,
    messages: [],
    tasks: [],
    pending: null,
    phase: "loading",
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private cache: CCDriverConversationCache | null = null;
  private generation = 0;
  private syncing = false;
  private mutating = false;

  private readonly ports: CCDriverPorts;
  constructor(ports: CCDriverPorts) {
    this.ports = ports;
  }

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<CCDriverSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private fail(error: unknown) {
    this.update({
      phase: isCCDriverError(error) && error.status === 401 ? "expired" : "offline",
      error: errorText(error),
    });
  }

  private scope(connection: CCDriverConnection) {
    return `ccdriver.v1.${connection.server_id}.${connection.session.human_id}.${connection.session.project_id}`;
  }

  private client(connection: CCDriverConnection) {
    return new CCDriverClient(
      connection.origin,
      this.ports.fetch,
      connection,
      this.ports.allowLocalHttp,
    );
  }

  private async restore(connection: CCDriverConnection, generation: number) {
    const key = this.scope(connection);
    const [rawCache, rawPending, rawControl] = await Promise.all([
      this.ports.data.read(`${key}.cache`),
      this.ports.data.read(`${key}.pending`),
      this.ports.data.read(`${key}.control`),
    ]);
    let cache: CCDriverConversationCache | null = null;
    let pending: CCDriverPendingMessage | null = null;
    if (rawCache) {
      try {
        cache = decodeCache(JSON.parse(rawCache));
      } catch {
        /* A corrupt cache is refetched; pending requests are preserved separately. */
      }
    }
    if (rawPending) pending = decodePending(JSON.parse(rawPending));
    if (generation !== this.generation) return;
    const matches = (value: { server_id: string; human_id: string; project_id: string }) =>
      value.server_id === connection.server_id &&
      value.human_id === connection.session.human_id &&
      value.project_id === connection.session.project_id;
    if ((cache && !matches(cache)) || (pending && !matches(pending)))
      throw new CCDriverError({ code: "identity", status: 0 });
    this.cache = cache;
    this.update({
      connection,
      requests: null,
      requestsError: null,
      requestNotice: null,
      controlPending: rawControl ? decodeControlMarker(JSON.parse(rawControl)) : null,
      workspace: null,
      tasks: [],
      messages: cache?.messages ?? [],
      pending,
      phase: "offline",
      error: null,
    });
  }

  async load() {
    const generation = ++this.generation;
    try {
      const raw = await this.ports.secrets.read(CONNECTION_KEY);
      if (generation !== this.generation) return;
      if (!raw) {
        this.update({ phase: "unpaired" });
        return;
      }
      const connection = decodeConnection(JSON.parse(raw));
      this.client(connection);
      await this.restore(connection, generation);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  async pair(origin: string, token: string, deviceName: string, signal: AbortSignal) {
    if (this.mutating) return;
    this.mutating = true;
    const generation = ++this.generation;
    try {
      const connection = await new CCDriverClient(
        origin,
        this.ports.fetch,
        null,
        this.ports.allowLocalHttp,
      ).pair(token, deviceName, signal);
      await this.ports.secrets.write(CONNECTION_KEY, JSON.stringify(connection));
      await this.restore(connection, generation);
    } catch (error) {
      if (generation === this.generation && !signal.aborted) this.fail(error);
    } finally {
      this.mutating = false;
    }
  }

  async sync(signal: AbortSignal) {
    const connection = this.state.connection;
    if (!connection || this.syncing || this.mutating || signal.aborted) return;
    this.syncing = true;
    const generation = this.generation;
    const current = () => generation === this.generation && !signal.aborted;
    try {
      const client = this.client(connection);
      const descriptor = await client.verify(signal);
      const nativeRequests = descriptor.capabilities.native_requests !== false;
      const workspace = await client.workspace(signal);
      if (!current()) return;
      this.update({ workspace, phase: "syncing", error: null });
      if (!workspace.channel) {
        this.cache = null;
        this.update({ messages: [], tasks: [], phase: "ready" });
        return;
      }
      if (this.cache && this.cache.workspace_id !== workspace.channel.id) {
        this.cache = null;
        this.update({ messages: [], tasks: [] });
      }
      let cache =
        this.cache?.workspace_id === workspace.channel.id
          ? this.cache
          : {
              server_id: connection.server_id,
              human_id: connection.session.human_id,
              project_id: connection.session.project_id,
              workspace_id: workspace.channel.id,
              messages: [],
              cursor: "",
            };
      let more = true;
      for (let pageNumber = 0; pageNumber < 10 && more; pageNumber++) {
        let page;
        try {
          page = await client.messages(cache.cursor, signal);
        } catch (error) {
          if (isCCDriverError(error) && error.status === 400 && cache.cursor !== "") {
            cache = Object.assign({}, cache, { cursor: "", messages: [] });
            page = await client.messages("", signal);
          } else throw error;
        }
        if (!current()) return;
        if (
          page.workspace_id !== workspace.channel.id ||
          page.messages.some((message) => message.channel_id !== page.workspace_id) ||
          (page.has_more && page.next_cursor === cache.cursor)
        )
          throw new CCDriverError({ code: "protocol", status: 0 });
        const byID = new Map(
          [...cache.messages, ...page.messages].map((message) => [message.id, message]),
        );
        cache = Object.assign({}, cache, {
          cursor: page.next_cursor,
          messages: [...byID.values()].sort((a, b) => a.channel_seq - b.channel_seq).slice(-500),
        });
        await this.ports.data.write(`${this.scope(connection)}.cache`, JSON.stringify(cache));
        if (!current()) return;
        this.cache = cache;
        this.update({ messages: cache.messages });
        more = page.has_more;
      }
      const tasks = await client.tasks(signal);
      if (current()) this.update({ tasks, phase: more ? "syncing" : "ready", error: null });
      if (nativeRequests) {
        try {
          const requests = await client.requests(signal);
          if (current()) this.update({ requests, requestsError: null });
        } catch {
          if (current()) this.update({ requestsError: "待处理状态暂不可用，请刷新或在网页核对。" });
        }
        if (current() && this.state.controlPending) await this.reconcileControl(signal);
      } else if (current()) {
        this.update({ requests: null, requestsError: NATIVE_REQUESTS_UNSUPPORTED });
      }
    } catch (error) {
      if (current()) this.fail(error);
    } finally {
      this.syncing = false;
    }
  }

  async send(content: string, signal: AbortSignal) {
    const { connection, workspace } = this.state;
    if (!connection || !workspace?.channel || this.mutating || signal.aborted) return false;
    const generation = this.generation;
    this.mutating = true;
    try {
      const pending = this.state.pending ?? {
        server_id: connection.server_id,
        human_id: connection.session.human_id,
        project_id: connection.session.project_id,
        workspace_id: workspace.channel.id,
        content: content.trim(),
        idempotency_key: `mobile:${this.ports.newID()}`,
      };
      if (!pending.content || pending.workspace_id !== workspace.channel.id)
        throw new CCDriverError({ code: "identity", status: 0 });
      await this.ports.data.write(`${this.scope(connection)}.pending`, JSON.stringify(pending));
      if (generation !== this.generation) return false;
      this.update({ pending, error: null });
      const client = this.client(connection);
      await client.verify(signal);
      await client.send(pending.content, pending.idempotency_key, signal);
      await this.ports.data.remove(`${this.scope(connection)}.pending`);
      if (generation !== this.generation) return false;
      this.update({ pending: null });
      return true;
    } catch (error) {
      if (generation === this.generation && !signal.aborted) this.fail(error);
      return false;
    } finally {
      this.mutating = false;
    }
  }

  async stop(taskID: string, signal: AbortSignal) {
    const connection = this.state.connection;
    if (!connection || this.mutating) return;
    this.mutating = true;
    try {
      const client = this.client(connection);
      await client.verify(signal);
      await client.stop(taskID, signal);
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    } finally {
      this.mutating = false;
    }
  }

  async disconnect(signal: AbortSignal, localOnly = false) {
    if (this.mutating) return;
    this.mutating = true;
    try {
      const connection = this.state.connection;
      if (connection && !localOnly) {
        const client = this.client(connection);
        try {
          await client.verify(signal);
          await client.revoke(signal);
        } catch (error) {
          if (!(isCCDriverError(error) && error.status === 401)) throw error;
        }
      }
      ++this.generation;
      await this.ports.secrets.remove(CONNECTION_KEY);
      this.cache = null;
      this.update({
        connection: null,
        requests: null,
        requestsError: null,
        controlPending: null,
        requestNotice: null,
        workspace: null,
        messages: [],
        tasks: [],
        pending: null,
        phase: "unpaired",
        error: null,
      });
    } catch (error) {
      if (!signal.aborted) this.fail(error);
    } finally {
      this.mutating = false;
    }
  }
  private withoutControlRequest(marker: CCDriverControlMarker): CCDriverRequests | null {
    const snapshot = this.state.requests;
    if (!snapshot) return null;
    return {
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.task_id === marker.task_id &&
        item.session.connection_id === marker.connection_id &&
        item.session.thread_id === marker.thread_id &&
        item.session.turn_id === marker.turn_id
          ? {
              ...item,
              session: {
                ...item.session,
                requests: item.session.requests.filter(
                  (request) => request.id !== marker.request_id,
                ),
              },
            }
          : item,
      ),
    };
  }

  async reconcileControl(signal: AbortSignal) {
    const connection = this.state.connection;
    const marker = this.state.controlPending;
    if (!connection || !marker || this.mutating) return;
    this.mutating = true;
    const generation = this.generation;
    try {
      const client = this.client(connection);
      const descriptor = await client.verify(signal);
      if (descriptor.capabilities.native_requests === false) {
        if (generation === this.generation && !signal.aborted)
          this.update({
            requests: null,
            requestsError: NATIVE_REQUESTS_UNSUPPORTED,
            requestNotice: "当前服务端未开放手机审批回执。请在网页核对，操作不会自动重发。",
          });
        return;
      }
      const history = await client.controlHistory(marker.task_id, signal);
      const receipt = history.find(
        (value) =>
          value.id === marker.idempotency_key &&
          value.connection_id === marker.connection_id &&
          value.thread_id === marker.thread_id &&
          value.turn_id === marker.turn_id &&
          value.request_id === marker.request_id,
      );
      if (
        generation !== this.generation ||
        signal.aborted ||
        this.state.controlPending?.idempotency_key !== marker.idempotency_key
      )
        return;
      if (receipt && (receipt.state === "accepted" || receipt.provider_resolved)) {
        await this.ports.data.remove(`${this.scope(connection)}.control`);
        if (generation === this.generation)
          this.update({
            controlPending: null,
            requestsError: null,
            requests: this.withoutControlRequest(marker),
            requestNotice:
              receipt.state === "accepted"
                ? "操作已确认接收。"
                : "原请求已由运行时处理，请查看最新结果。",
          });
      } else
        this.update({ requestNotice: "尚未取得确认回执。不会自动重发，请核对网页中的执行详情。" });
    } catch {
      if (generation === this.generation && !signal.aborted)
        this.update({ requestNotice: "回执暂时不可用。不会自动重发此操作。" });
    } finally {
      this.mutating = false;
    }
  }

  async acknowledgeControl() {
    const connection = this.state.connection;
    if (!connection || this.mutating) return;
    this.mutating = true;
    try {
      await this.ports.data.remove(`${this.scope(connection)}.control`);
      this.update({
        controlPending: null,
        requestNotice: "已结束本机回执跟进；没有撤回或重新发送操作。",
      });
    } catch {
      this.update({ requestNotice: "无法保存本机状态，请重试。" });
    } finally {
      this.mutating = false;
    }
  }

  async respond(
    item: CCDriverPendingItem,
    request: CCDriverNativeRequest,
    answer: CCDriverAnswer,
    signal: AbortSignal,
  ): Promise<boolean> {
    const connection = this.state.connection;
    if (!connection || this.mutating || this.state.controlPending || signal.aborted) return false;
    const displayed = this.state.requests?.items.find(
      (candidate) => candidate.task_id === item.task_id,
    );
    if (
      !displayed ||
      !displayed.session.requests.some(
        (value) => JSON.stringify(value) === JSON.stringify(request),
      ) ||
      JSON.stringify(displayed.session) !== JSON.stringify(item.session) ||
      !validNativeAnswer(request, answer)
    ) {
      this.update({ requestsError: "请求或回答已变化，请刷新后重新选择。" });
      return false;
    }
    const generation = this.generation;
    this.mutating = true;
    try {
      const client = this.client(connection);
      const descriptor = await client.verify(signal);
      if (descriptor.capabilities.native_requests === false) {
        if (generation === this.generation && !signal.aborted)
          this.update({ requests: null, requestsError: NATIVE_REQUESTS_UNSUPPORTED });
        return false;
      }
      const latest = await client.nativeSession(item.task_id, signal);
      const live = latest?.requests.find((value) => value.id === request.id);
      if (
        !latest ||
        latest.connection_id !== item.session.connection_id ||
        latest.thread_id !== item.session.thread_id ||
        latest.turn_id !== item.session.turn_id ||
        !live ||
        JSON.stringify(live) !== JSON.stringify(request)
      ) {
        this.update({ requestsError: "原请求已消失或轮次已改变，请刷新后核对。" });
        return false;
      }
      const marker = {
        task_id: item.task_id,
        idempotency_key: `mobile-control:${this.ports.newID()}`,
        connection_id: latest.connection_id,
        thread_id: latest.thread_id,
        turn_id: latest.turn_id,
        request_id: request.id,
      };
      const body = { ...marker, ...answer, operation: "respond" as const };
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 60 * 1024) {
        this.update({ requestsError: "回答过长，请缩短后提交。" });
        return false;
      }
      // Persist identity only: secret answers and authorization payloads never enter the outbox.
      await this.ports.data.write(`${this.scope(connection)}.control`, JSON.stringify(marker));
      if (generation !== this.generation || signal.aborted) return false;
      this.update({ controlPending: marker, requestNotice: null });
      const reply = await client.respond(marker, answer, signal);
      if (
        !reply.delivered ||
        reply.receipt.id !== marker.idempotency_key ||
        reply.receipt.state !== "accepted" ||
        reply.receipt.connection_id !== marker.connection_id ||
        reply.receipt.thread_id !== marker.thread_id ||
        reply.receipt.turn_id !== marker.turn_id ||
        reply.receipt.request_id !== marker.request_id
      )
        throw new CCDriverError({ code: "protocol", status: 0 });
      await this.ports.data.remove(`${this.scope(connection)}.control`);
      if (generation !== this.generation) return false;
      this.update({
        controlPending: null,
        requestNotice: "操作已确认接收。",
        requestsError: null,
        requests: this.withoutControlRequest(marker),
      });
      return true;
    } catch {
      if (generation === this.generation && !signal.aborted)
        this.update({
          requestsError: this.state.controlPending
            ? "操作结果尚未确认。请刷新回执，不要重复批准或发送回答。"
            : "未能提交操作，请刷新状态后重试。",
        });
      return false;
    } finally {
      this.mutating = false;
    }
  }
}
