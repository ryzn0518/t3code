import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Network from "expo-network";
import type { CCDriverMessage } from "@t3tools/contracts/ccdriver";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import * as Dialog from "../../components/ui/Dialog";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { CCDriverRequests } from "./CCDriverRequests";
import { makeCCDriverController } from "./runtime";

const phaseLabels = {
  loading: "正在读取本机连接",
  unpaired: "连接你的服务器",
  syncing: "正在同步",
  ready: "已同步",
  offline: "离线 · 保留本机记录",
  expired: "需要重新配对",
} as const;
const taskLabels: Record<string, string> = {
  pending: "等待执行",
  running: "执行中",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

export function CCDriverRouteScreen() {
  const [controller] = useState(makeCCDriverController);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [tab, setTab] = useState<"chat" | "work" | "requests" | "connection">("chat");
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("我的手机");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const messagesList = useRef<FlatList<CCDriverMessage>>(null);
  const followMessages = useRef(true);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hydrate this screen's persisted credentials and conversation cache
  useEffect(() => {
    void controller.load();
  }, [controller]);

  const sessionID = state.connection?.session.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- native foreground and network changes resume bounded server synchronization
  useEffect(() => {
    if (!focused || !sessionID) return;
    let disposed = false;
    let loop = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const pause = () => {
      loop += 1;
      if (timer) clearTimeout(timer);
      request?.abort();
    };
    const tick = async (currentLoop: number) => {
      if (disposed || currentLoop !== loop || AppState.currentState !== "active") return;
      request = new AbortController();
      await controller.sync(request.signal);
      if (
        !disposed &&
        currentLoop === loop &&
        AppState.currentState === "active" &&
        controller.getSnapshot().phase !== "expired"
      ) {
        timer = setTimeout(
          () => void tick(currentLoop),
          controller.getSnapshot().phase === "offline" ? 20_000 : 5_000,
        );
      }
    };
    const wake = () => {
      pause();
      void tick(loop);
    };
    const appState = AppState.addEventListener("change", (value) => {
      if (value === "active") wake();
      else pause();
    });
    const network = Network.addNetworkStateListener(() => {
      if (AppState.currentState === "active") wake();
    });
    void tick(loop);
    return () => {
      disposed = true;
      pause();
      appState.remove();
      network.remove();
    };
  }, [controller, focused, sessionID]);

  const run = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action(new AbortController().signal);
    } catch {
      setActionError("操作结果尚未确认，请先同步状态后再试。");
    }
    setBusy(false);
  };

  const unpaired = !state.connection || state.phase === "expired";
  const canSend = Boolean(
    state.workspace?.channel &&
    (state.phase === "ready" || state.phase === "syncing") &&
    !state.pending &&
    draft.trim() &&
    !busy,
  );

  const confirmDisconnect = (localOnly: boolean) =>
    Dialog.alert(
      localOnly ? "移除本机连接？" : "解除设备授权？",
      localOnly
        ? "这只移除本机保存的凭据。服务器上的授权仍需由所有者撤销。"
        : "此设备将无法继续访问服务器；后台任务会继续运行。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "确认",
          style: "destructive",
          onPress: () => void run((signal) => controller.disconnect(signal, localOnly)),
        },
      ],
    );

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="px-5 pb-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
        <Text className="text-2xl font-t3-bold">
          {state.workspace?.main_agent?.name ?? "个人助手"}
        </Text>
        <Text accessibilityLiveRegion="polite" className="mt-1 text-sm text-foreground-muted">
          {phaseLabels[state.phase]}
        </Text>
        <View className="mt-4 flex-row gap-2">
          {(
            [
              ["chat", "对话"],
              ["work", "工作"],
              ["requests", "待处理"],
              ["connection", "连接"],
            ] as const
          ).map(([id, label]) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: tab === id }}
              onPress={() => setTab(id)}
              className={
                tab === id
                  ? "min-h-11 justify-center rounded-full bg-secondary px-3"
                  : "min-h-11 justify-center px-3"
              }
            >
              <Text
                className={tab === id ? "font-t3-bold text-foreground" : "text-foreground-muted"}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {actionError || state.error ? (
        <View className="mx-5 mb-3 rounded-2xl bg-subtle p-4">
          <Text accessibilityRole="alert" className="text-sm">
            {actionError || state.error}
          </Text>
        </View>
      ) : null}

      {unpaired || tab === "connection" ? (
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 20, gap: 20 }}
        >
          {state.connection ? (
            <View className="gap-2">
              <Text className="font-t3-bold">{state.connection.session.device_name}</Text>
              <Text selectable className="text-sm text-foreground-muted">
                {state.connection.origin}
              </Text>
              <Text className="text-sm text-foreground-muted">
                授权有效期至 {new Date(state.connection.session.expires_at).toLocaleDateString()}
              </Text>
            </View>
          ) : null}
          {unpaired ? (
            <>
              <Text className="text-sm text-foreground-muted">
                先连接私网，再填写服务器地址和由所有者生成的一次性配对码。
              </Text>
              <ConnectionFormField
                label="服务器地址"
                value={origin}
                onChangeText={setOrigin}
                placeholder="https://agent.example.com"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <ConnectionFormField
                label="一次性配对码"
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <ConnectionFormField
                label="设备名称"
                value={deviceName}
                onChangeText={setDeviceName}
                maxLength={40}
              />
              <Button
                label="配对并连接"
                tone="primary"
                loading={busy}
                disabled={!origin.trim() || !token.trim() || !deviceName.trim()}
                onPress={() =>
                  void run(async (signal) => {
                    await controller.pair(origin, token, deviceName, signal);
                    if (controller.getSnapshot().connection?.session.id !== sessionID) {
                      setToken("");
                      setTab("chat");
                      await controller.sync(signal);
                    }
                  })
                }
              />
            </>
          ) : (
            <>
              <Button
                label="立即同步"
                loading={busy}
                onPress={() => void run((signal) => controller.sync(signal))}
              />
              <Button
                label="解除设备授权"
                tone="danger"
                disabled={busy}
                onPress={() => confirmDisconnect(false)}
              />
            </>
          )}
          {state.connection ? (
            <Button
              label="仅移除本机连接"
              tone="text"
              disabled={busy}
              onPress={() => confirmDisconnect(true)}
            />
          ) : null}
        </ScreenScrollView>
      ) : tab === "requests" ? (
        <CCDriverRequests controller={controller} busy={busy} run={run} />
      ) : tab === "chat" ? (
        <>
          <FlatList
            ref={messagesList}
            data={state.messages}
            keyExtractor={(message) => message.id}
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 12, gap: 20 }}
            keyboardShouldPersistTaps="handled"
            onScroll={({ nativeEvent }) => {
              followMessages.current =
                nativeEvent.contentSize.height -
                  nativeEvent.contentOffset.y -
                  nativeEvent.layoutMeasurement.height <
                96;
            }}
            onContentSizeChange={() => {
              if (followMessages.current) messagesList.current?.scrollToEnd({ animated: false });
            }}
            ListEmptyComponent={
              <Text className="py-8 text-foreground-muted">
                {state.workspace && !state.workspace.channel
                  ? "请先在网页中设置主 Agent，再回来同步。"
                  : "对话会在连接后同步到这里。"}
              </Text>
            }
            renderItem={({ item }) => (
              <View className="gap-2">
                <Text className="text-xs font-t3-bold text-foreground-muted">
                  {item.author_type === "human"
                    ? "我"
                    : item.author_type === "agent"
                      ? "助手"
                      : "系统"}
                </Text>
                <Text selectable className="text-base leading-7">
                  {item.content_markdown}
                </Text>
              </View>
            )}
          />
          {state.pending ? (
            <View className="mx-5 my-2 gap-3 rounded-2xl bg-subtle p-4">
              <Text className="text-sm font-t3-bold">有一条消息等待确认送达</Text>
              <Text numberOfLines={3} className="text-sm text-foreground-muted">
                {state.pending.content}
              </Text>
              <Button
                label="用原请求重试"
                size="compact"
                loading={busy}
                onPress={() =>
                  void run(async (signal) => {
                    await controller.send("", signal);
                    await controller.sync(signal);
                  })
                }
              />
            </View>
          ) : null}
          <View
            className="gap-3 border-t border-subtle px-5 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <AppTextInput
              accessibilityLabel="给主 Agent 的消息"
              placeholder="说说你需要做什么…"
              multiline
              maxLength={16000}
              value={draft}
              onChangeText={setDraft}
              className="max-h-40"
            />
            <Button
              label="发送"
              icon="arrow.up"
              tone="primary"
              disabled={!canSend}
              loading={busy}
              onPress={() =>
                void run(async (signal) => {
                  const submitted = draft;
                  if (await controller.send(submitted, signal))
                    setDraft((current) => (current === submitted ? "" : current));
                  await controller.sync(signal);
                })
              }
            />
          </View>
        </>
      ) : (
        <FlatList
          data={state.tasks}
          keyExtractor={(task) => task.id}
          className="flex-1"
          contentContainerStyle={{
            padding: 20,
            gap: 24,
            paddingBottom: Math.max(insets.bottom, 20),
          }}
          ListEmptyComponent={
            <Text className="py-8 text-foreground-muted">
              暂时没有 worker 任务。你可以在主对话中提出需求。
            </Text>
          }
          renderItem={({ item }) => (
            <View className="gap-3">
              <View className="flex-row items-start justify-between gap-4">
                <Text className="flex-1 font-t3-bold">{item.worker?.name ?? "Worker"}</Text>
                <Text className="text-sm text-foreground-muted">
                  {taskLabels[item.status] ?? item.status}
                </Text>
              </View>
              <Text numberOfLines={4} className="text-sm">
                {item.prompt}
              </Text>
              {item.result || item.error ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {item.result || item.error}
                </Text>
              ) : null}
              {item.status === "running" || item.status === "pending" ? (
                <Button
                  label="停止任务"
                  tone="danger"
                  size="compact"
                  disabled={busy}
                  onPress={() =>
                    Dialog.alert("停止这个任务？", "已完成的步骤会保留。", [
                      { text: "继续执行", style: "cancel" },
                      {
                        text: "停止",
                        style: "destructive",
                        onPress: () =>
                          void run(async (signal) => {
                            await controller.stop(item.id, signal);
                            await controller.sync(signal);
                          }),
                      },
                    ])
                  }
                />
              ) : null}
            </View>
          )}
        />
      )}
    </KeyboardAvoidingView>
  );
}
