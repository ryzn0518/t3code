import { validNativeAnswer } from "./requests.ts";
import * as Schema from "effect/Schema";
import { CCDriverWorkspace, CCDriverMessagePage, CCDriverTask } from "@t3tools/contracts/ccdriver";
import wire from "./wire.fixture.json" with { type: "json" };
import { describe, expect, it } from "vite-plus/test";
import {
  CCDriverClient,
  CCDriverError,
  normalizeCCDriverOrigin,
  type CCDriverFetch,
} from "./client.ts";
import { CCDriverController, type CCDriverStorage } from "./controller.ts";
import type { CCDriverConnection, CCDriverMessage } from "@t3tools/contracts/ccdriver";

const decodeWireWorkspace = Schema.decodeSync(CCDriverWorkspace);
const decodeWireMessages = Schema.decodeSync(CCDriverMessagePage);
const decodeWireTasks = Schema.decodeSync(Schema.Array(CCDriverTask));

const origin = "https://agent.example.test";
const connection: CCDriverConnection = {
  origin,
  server_id: "server-one",
  token: "test-device-credential",
  session: {
    id: "device-one",
    human_id: "person-one",
    organization_id: "org-one",
    project_id: "project-one",
    device_name: "Phone",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2030-01-01T00:00:00Z",
  },
};
const descriptor = {
  server_id: "server-one",
  protocol: "ccdriver-client-v1",
  capabilities: { device_sessions: true, session_refresh: false, websocket_tickets: false },
};
const workspace = {
  channel: { id: "workspace-one", name: "Personal" },
  main_agent: { id: "agent-one", name: "Main" },
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const signal = () => new AbortController().signal;

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  } satisfies CCDriverStorage & { values: Map<string, string> };
}

function fixture() {
  const secrets = memoryStore();
  secrets.values.set("ccdriver.connection.v1", JSON.stringify(connection));
  const data = memoryStore();
  const ledger = new Map<string, CCDriverMessage>();
  const requests: { path: string; method: string; authorization: string | null }[] = [];
  const config = {
    loseFirstReceipt: false,
    serverID: "server-one",
    workspaceID: "workspace-one",
    unauthorized: false,
    nativeRequests: undefined as boolean | undefined,
  };
  let receiptsLost = 0;
  let generated = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("Authorization");
    requests.push({ path: url.pathname, method, authorization });
    if (url.pathname === "/api/client/descriptor")
      return response({
        ...descriptor,
        server_id: config.serverID,
        capabilities: {
          ...descriptor.capabilities,
          ...(config.nativeRequests === undefined
            ? {}
            : { native_requests: config.nativeRequests }),
        },
      });
    if (config.unauthorized) return response({ error: "raw secret from an untrusted server" }, 401);
    if (url.pathname === "/api/assistant")
      return response({ ...workspace, channel: { ...workspace.channel, id: config.workspaceID } });
    if (url.pathname === "/api/assistant/tasks") return response([]);
    if (url.pathname === "/api/assistant/requests")
      return response({ items: [], unavailable_task_ids: [], truncated: false });
    if (url.pathname === "/api/assistant/messages" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { content: string; idempotency_key: string };
      const persisted = [...data.values.entries()].find(([key]) => key.endsWith(".pending"));
      expect(persisted && JSON.parse(persisted[1]).idempotency_key).toBe(body.idempotency_key);
      const message = ledger.get(body.idempotency_key) ?? {
        id: `message-${ledger.size + 1}`,
        channel_id: config.workspaceID,
        channel_seq: ledger.size + 1,
        author_type: "human",
        content_markdown: body.content,
        created_at: "2026-01-01T00:00:00Z",
      };
      ledger.set(body.idempotency_key, message);
      if (config.loseFirstReceipt && receiptsLost++ === 0)
        throw new TypeError("network failure with sensitive transport detail");
      return response(message, 201);
    }
    if (url.pathname === "/api/assistant/messages") {
      const cursor = url.searchParams.get("cursor") ?? "";
      const messages = [...ledger.values()].filter(
        (message) => message.channel_seq > Number(cursor || 0),
      );
      return response({
        workspace_id: config.workspaceID,
        messages,
        next_cursor: String(ledger.size),
        has_more: false,
      });
    }
    if (url.pathname === "/api/client/session" && method === "DELETE")
      return new Response(null, { status: 204 });
    throw new Error("unexpected fixture request");
  };
  const ports = { fetch: fetcher, secrets, data, newID: () => `id-${++generated}` };
  return { ports, data, secrets, ledger, requests, config };
}

describe("ccdriver transport", () => {
  it.each([
    "http://agent.example.test",
    "https://user:secret@agent.example.test",
    "https://agent.example.test/api",
    "https://agent.example.test/?token=secret",
    "https://agent.example.test/#secret",
    "file:///tmp/test",
  ])("rejects unsafe address %s", (address) => {
    expect(() => normalizeCCDriverOrigin(address)).toThrow(CCDriverError);
  });

  it("requires an explicit development allowance for local HTTP", () => {
    expect(() => normalizeCCDriverOrigin("http://localhost:1234")).toThrow(CCDriverError);
    expect(normalizeCCDriverOrigin("http://localhost:1234", true)).toBe("http://localhost:1234");
    expect(() => normalizeCCDriverOrigin("http://agent.example.test", true)).toThrow(CCDriverError);
  });

  it("checks server identity anonymously before releasing a credential", async () => {
    const test = fixture();
    test.config.serverID = "different-server";
    const client = new CCDriverClient(origin, test.ports.fetch, connection);
    await expect(client.workspace(signal())).rejects.toMatchObject({ code: "identity" });
    await expect(client.verify(signal())).rejects.toMatchObject({ code: "identity" });
    expect(test.requests).toEqual([
      { path: "/api/client/descriptor", method: "GET", authorization: null },
    ]);
  });

  it("rejects a connection credential bound to another origin", () => {
    expect(
      () => new CCDriverClient("https://other.example.test", fixture().ports.fetch, connection),
    ).toThrow(CCDriverError);
  });
});

describe("ccdriver persisted conversation", () => {
  it("keeps chat available without polling a server-disabled native approval API", async () => {
    const test = fixture();
    test.config.nativeRequests = false;
    const controller = new CCDriverController(test.ports);
    await controller.load();
    await controller.sync(signal());
    expect(controller.getSnapshot().phase).toBe("ready");
    expect(controller.getSnapshot().requests).toBeNull();
    expect(controller.getSnapshot().requestsError).toContain("网页");
    expect(await controller.send("Continue normal conversation", signal())).toBe(true);
    await controller.sync(signal());
    expect(
      test.requests.filter((request) => request.path === "/api/assistant/requests"),
    ).toHaveLength(0);
    expect(test.ledger.size).toBe(1);
  });

  it("reuses one durable request after the server accepts a message but its receipt is lost", async () => {
    const test = fixture();
    test.config.loseFirstReceipt = true;
    const first = new CCDriverController(test.ports);
    await first.load();
    await first.sync(signal());
    expect(await first.send("请继续这项工作", signal())).toBe(false);
    const key = first.getSnapshot().pending?.idempotency_key;
    expect(key).toBeTruthy();
    expect(first.getSnapshot().error).not.toContain("sensitive transport");
    const restarted = new CCDriverController(test.ports);
    await restarted.load();
    await restarted.sync(signal());
    expect(restarted.getSnapshot().pending?.idempotency_key).toBe(key);
    expect(await restarted.send("", signal())).toBe(true);
    await restarted.sync(signal());
    expect(test.ledger.size).toBe(1);
    expect(restarted.getSnapshot().messages).toHaveLength(1);
    expect(restarted.getSnapshot().pending).toBeNull();
    expect([...test.data.values.keys()].some((value) => value.endsWith(".pending"))).toBe(false);
  });

  it("never transmits when durable outbox persistence fails", async () => {
    const test = fixture();
    const controller = new CCDriverController({
      ...test.ports,
      data: {
        ...test.data,
        write: async (key, value) => {
          if (key.endsWith(".pending")) throw new Error("disk full");
          await test.data.write(key, value);
        },
      },
    });
    await controller.load();
    await controller.sync(signal());
    expect(await controller.send("work", signal())).toBe(false);
    expect(test.ledger.size).toBe(0);
    expect(test.requests.some((value) => value.method === "POST")).toBe(false);
  });

  it("keeps pending messages out of a replacement workspace", async () => {
    const test = fixture();
    test.config.loseFirstReceipt = true;
    const controller = new CCDriverController(test.ports);
    await controller.load();
    await controller.sync(signal());
    await controller.send("work", signal());
    const pending = controller.getSnapshot().pending;
    test.config.workspaceID = "workspace-two";
    await controller.sync(signal());
    expect(await controller.send("", signal())).toBe(false);
    expect(controller.getSnapshot().pending).toEqual(pending);
    expect(test.requests.filter((value) => value.method === "POST")).toHaveLength(1);
  });

  it("does not restore late responses after local disconnect", async () => {
    const test = fixture();
    const requested = Promise.withResolvers<void>();
    const result = Promise.withResolvers<Response>();
    const controller = new CCDriverController({
      ...test.ports,
      fetch: async (input, init) => {
        if (String(input).endsWith("/api/assistant")) {
          requested.resolve();
          return result.promise;
        }
        return test.ports.fetch(input, init);
      },
    });
    await controller.load();
    const sync = controller.sync(signal());
    await requested.promise;
    await controller.disconnect(signal(), true);
    result.resolve(response(workspace));
    await sync;
    expect(controller.getSnapshot()).toMatchObject({
      connection: null,
      workspace: null,
      messages: [],
      phase: "unpaired",
    });
  });

  it("retains the pending message when authorization is revoked", async () => {
    const test = fixture();
    const controller = new CCDriverController(test.ports);
    await controller.load();
    await controller.sync(signal());
    test.config.unauthorized = true;
    expect(await controller.send("work", signal())).toBe(false);
    expect(controller.getSnapshot().phase).toBe("expired");
    expect(controller.getSnapshot().pending?.content).toBe("work");
    expect(controller.getSnapshot().error).not.toContain("raw secret");
  });
});

// Synthetic responses encoded from ccdriver's Go API types, without application data.
it("decodes the server's workspace, message page and task result wire shapes", () => {
  expect(decodeWireWorkspace(wire.workspace).channel?.id).toBe("channel-fixture");
  expect(decodeWireMessages(wire.messages).messages[0]?.content_markdown).toBe("查看项目进展");
  expect(decodeWireTasks(wire.tasks)[0]?.result).toBe("已完成检查");
});

function controlFixture() {
  const test = fixture();
  const question = {
    id: "question",
    method: "item/tool/requestUserInput",
    choices: null,
    params: {
      questions: [{ id: "secret", header: "凭据", question: "输入临时凭据", isSecret: true }],
    },
  };
  const session = {
    connection_id: "native-connection",
    thread_id: "native-thread",
    turn_id: "native-turn",
    requests: [question],
  };
  const config = Object.assign(test.config, {
    loseReply: false,
    rejectBeforeAccept: false,
    turn: "native-turn",
    receiptVisible: true,
  });
  const receipts: {
    id: string;
    state: string;
    connection_id: string;
    thread_id: string;
    turn_id: string;
    request_id: string;
  }[] = [];
  let posted = 0;
  let nativeReads = 0;
  const fetcher: CCDriverFetch = async (url, init) => {
    if (url.endsWith("/api/assistant/requests"))
      return response({
        items: session.requests.length
          ? [
              {
                task_id: "native-task",
                agent_name: "Main",
                session: { ...session, turn_id: config.turn },
              },
            ]
          : [],
        unavailable_task_ids: [],
        truncated: false,
      });
    if (url.includes("/api/tasks/native-task/native-session")) {
      if (init.method === "GET") {
        nativeReads++;
        return response(
          url.includes("history=1")
            ? config.receiptVisible
              ? receipts
              : []
            : { ...session, turn_id: config.turn },
        );
      }
      posted++;
      if (config.rejectBeforeAccept) throw new Error("connection lost");
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      expect(body.task_id).toBeUndefined();
      expect(body.operation).toBe("respond");
      const persisted = [...test.data.values.entries()].find(([key]) => key.endsWith(".control"));
      expect(persisted).toBeDefined();
      expect(persisted?.[1]).not.toContain("private-answer");
      const receipt = {
        id: String(body.idempotency_key),
        state: "accepted",
        connection_id: String(body.connection_id),
        thread_id: String(body.thread_id),
        turn_id: String(body.turn_id),
        request_id: String(body.request_id),
      };
      receipts.push(receipt);
      session.requests = [];
      if (config.loseReply) throw new Error("receipt lost");
      return response({ delivered: true, receipt });
    }
    return test.ports.fetch(url, init);
  };
  return {
    ...test,
    config,
    ports: { ...test.ports, fetch: fetcher },
    posted: () => posted,
    nativeReads: () => nativeReads,
  };
}

it("recovers an accepted native operation by receipt after restart without resending its secret answer", async () => {
  const test = controlFixture();
  test.config.loseReply = true;
  const first = new CCDriverController(test.ports);
  await first.load();
  await first.sync(signal());
  const item = first.getSnapshot().requests!.items[0]!;
  expect(
    await first.respond(
      item,
      item.session.requests[0]!,
      { answers: { secret: ["private-answer"] } },
      signal(),
    ),
  ).toBe(false);
  expect(first.getSnapshot().controlPending).not.toBeNull();
  expect([...test.data.values.values()].join(" ")).not.toContain("private-answer");
  const restarted = new CCDriverController(test.ports);
  await restarted.load();
  expect(restarted.getSnapshot().controlPending).not.toBeNull();
  test.config.nativeRequests = false;
  const readsBefore = test.nativeReads();
  await restarted.sync(signal());
  await restarted.reconcileControl(signal());
  expect(restarted.getSnapshot().controlPending).not.toBeNull();
  expect(restarted.getSnapshot().requests).toBeNull();
  expect(restarted.getSnapshot().requestsError).toContain("网页");
  expect(test.nativeReads()).toBe(readsBefore);
  expect(test.posted()).toBe(1);
  test.config.nativeRequests = true;
  await restarted.sync(signal());
  expect(restarted.getSnapshot().controlPending).toBeNull();
  expect(test.posted()).toBe(1);
});

it("keeps an uncertain native operation blocked instead of replaying it on reconnect", async () => {
  const test = controlFixture();
  test.config.rejectBeforeAccept = true;
  const first = new CCDriverController(test.ports);
  await first.load();
  await first.sync(signal());
  const item = first.getSnapshot().requests!.items[0]!;
  await first.respond(
    item,
    item.session.requests[0]!,
    { answers: { secret: ["private-answer"] } },
    signal(),
  );
  const restarted = new CCDriverController(test.ports);
  await restarted.load();
  await restarted.sync(signal());
  expect(restarted.getSnapshot().controlPending).not.toBeNull();
  expect(
    await restarted.respond(
      item,
      item.session.requests[0]!,
      { answers: { secret: ["changed-answer"] } },
      signal(),
    ),
  ).toBe(false);
  expect(test.posted()).toBe(1);
  await restarted.acknowledgeControl();
  expect(restarted.getSnapshot().controlPending).toBeNull();
  expect(test.posted()).toBe(1);
});

it("refuses a stale native turn before persisting or submitting the operation", async () => {
  const test = controlFixture();
  const controller = new CCDriverController(test.ports);
  await controller.load();
  await controller.sync(signal());
  const item = controller.getSnapshot().requests!.items[0]!;
  test.config.turn = "replacement-turn";
  expect(
    await controller.respond(
      item,
      item.session.requests[0]!,
      { answers: { secret: ["private-answer"] } },
      signal(),
    ),
  ).toBe(false);
  expect(test.posted()).toBe(0);
  expect(controller.getSnapshot().controlPending).toBeNull();
  test.config.turn = "native-turn";
  test.config.nativeRequests = false;
  const readsBefore = test.nativeReads();
  expect(
    await controller.respond(
      item,
      item.session.requests[0]!,
      { answers: { secret: ["private-answer"] } },
      signal(),
    ),
  ).toBe(false);
  expect(test.nativeReads()).toBe(readsBefore);
  expect(test.posted()).toBe(0);
  expect(controller.getSnapshot().controlPending).toBeNull();
});

it("does not send an operation when its receipt identity cannot be saved", async () => {
  const test = controlFixture();
  const controller = new CCDriverController({
    ...test.ports,
    data: {
      ...test.data,
      write: async (key, value) => {
        if (key.endsWith(".control")) throw new Error("storage unavailable");
        await test.data.write(key, value);
      },
    },
  });
  await controller.load();
  await controller.sync(signal());
  const item = controller.getSnapshot().requests!.items[0]!;
  expect(
    await controller.respond(
      item,
      item.session.requests[0]!,
      { answers: { secret: ["private-answer"] } },
      signal(),
    ),
  ).toBe(false);
  expect(test.posted()).toBe(0);
});

it("requires offered question answers and never promotes a persistent policy choice to one-time approval", () => {
  const question = {
    id: "q",
    method: "item/tool/requestUserInput",
    choices: null,
    params: {
      questions: [
        {
          id: "choice",
          header: "选择",
          question: "选择一种",
          options: [{ label: "允许" }, { label: "拒绝" }],
        },
      ],
    },
  };
  expect(validNativeAnswer(question, { answers: { choice: ["未提供的选项"] } })).toBe(false);
  expect(validNativeAnswer(question, { answers: { choice: ["允许"], injected: ["extra"] } })).toBe(
    false,
  );
  expect(validNativeAnswer(question, { answers: { choice: ["允许"] } })).toBe(true);
  const request = {
    id: "approval",
    method: "item/commandExecution/requestApproval",
    params: {},
    choices: [
      { id: "persist", kind: "acceptForSession" },
      { id: "once", kind: "accept" },
    ],
  };
  expect(validNativeAnswer(request, { choice_id: "persist" })).toBe(false);
  expect(validNativeAnswer(request, { choice_id: "unoffered" })).toBe(false);
  expect(validNativeAnswer(request, { choice_id: "once" })).toBe(true);
});
