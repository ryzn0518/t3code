import { useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, View } from "react-native";
import type { CCDriverController } from "@t3tools/client-runtime/ccdriver/controller";
import {
  nativeQuestions,
  transientApprovalLabels,
  type CCDriverAnswer,
} from "@t3tools/client-runtime/ccdriver/requests";
import type { CCDriverNativeRequest, CCDriverPendingItem } from "@t3tools/contracts/ccdriver";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";

type RunAction = (action: (signal: AbortSignal) => Promise<unknown>) => Promise<void>;

function RequestCard({
  item,
  request,
  disabled,
  onRespond,
}: {
  item: CCDriverPendingItem;
  request: CCDriverNativeRequest;
  disabled: boolean;
  onRespond: (answer: CCDriverAnswer) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = nativeQuestions(request);
  const input = request.method === "item/tool/requestUserInput";
  const choices = request.choices?.filter((choice) => transientApprovalLabels[choice.kind]) ?? [];
  return (
    <View className="gap-4 rounded-2xl bg-subtle p-4">
      <Text className="font-t3-bold">
        {item.agent_name} · {input ? "需要你补充信息" : "等待你处理请求"}
      </Text>
      {input ? (
        <>
          {!questions.length ? (
            <Text className="text-sm text-foreground-muted">当前问题结构需要在网页中处理。</Text>
          ) : null}
          {questions.map((question) => (
            <View key={question.id} className="gap-3">
              <Text className="text-base">{question.question}</Text>
              {question.options?.map((option) => (
                <Pressable
                  key={option.label}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: answers[question.id] === option.label, disabled }}
                  disabled={disabled}
                  onPress={() => setAnswers((prior) => ({ ...prior, [question.id]: option.label }))}
                  className={
                    answers[question.id] === option.label
                      ? "min-h-12 rounded-xl bg-secondary p-3"
                      : "min-h-12 rounded-xl bg-screen p-3"
                  }
                >
                  <Text className="font-t3-medium">{option.label}</Text>
                  {option.description ? (
                    <Text className="mt-1 text-sm text-foreground-muted">{option.description}</Text>
                  ) : null}
                </Pressable>
              ))}
              {!question.options?.length || question.isOther ? (
                <AppTextInput
                  accessibilityLabel={question.question}
                  placeholder={question.options?.length ? "也可以填写自己的回答" : "填写回答"}
                  value={answers[question.id] ?? ""}
                  onChangeText={(value) =>
                    setAnswers((prior) => ({ ...prior, [question.id]: value }))
                  }
                  secureTextEntry={question.isSecret}
                  autoCorrect={!question.isSecret}
                  autoCapitalize="none"
                  editable={!disabled}
                  maxLength={12000}
                />
              ) : null}
            </View>
          ))}
          <Button
            label="提交回答"
            tone="primary"
            disabled={
              disabled ||
              !questions.length ||
              questions.some((question) => !answers[question.id]?.trim())
            }
            onPress={() =>
              onRespond({
                answers: Object.fromEntries(
                  questions.map((question) => [question.id, [answers[question.id] ?? ""]]),
                ),
              })
            }
          />
        </>
      ) : (
        <>
          <Text selectable className="text-sm leading-6">
            {JSON.stringify(request.params, null, 2)}
          </Text>
          {request.files?.map((file) => (
            <View key={file.path} className="gap-2">
              <Text className="font-t3-medium">{file.path}</Text>
              <Text selectable className="text-sm">
                {file.diff}
              </Text>
            </View>
          ))}
          {choices.map((choice) => (
            <Button
              key={choice.id}
              label={transientApprovalLabels[choice.kind] ?? "处理请求"}
              tone={
                choice.kind === "accept" || choice.kind === "grantForTurn" ? "primary" : "secondary"
              }
              disabled={disabled}
              onPress={() =>
                Dialog.alert(
                  transientApprovalLabels[choice.kind] ?? "处理请求",
                  choice.kind === "accept"
                    ? "只批准上面列出的这项操作，不批准后续请求。"
                    : choice.kind === "grantForTurn"
                      ? "仅授予上面列出的当前轮次权限。"
                      : "处理当前这一项请求。",
                  [
                    { text: "返回检查", style: "cancel" },
                    { text: "确认提交", onPress: () => onRespond({ choice_id: choice.id }) },
                  ],
                )
              }
            />
          ))}
          {!choices.length ? (
            <Text className="text-sm text-foreground-muted">
              此请求需要在网页中处理，App 不会自动批准。
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

export function CCDriverRequests({
  controller,
  busy,
  run,
}: {
  controller: CCDriverController;
  busy: boolean;
  run: RunAction;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const rows =
    state.requests?.items.flatMap((item) =>
      item.session.requests.map((request) => ({ item, request })),
    ) ?? [];
  return (
    <FlatList
      data={rows}
      className="flex-1"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 40 }}
      keyExtractor={({ item, request }) =>
        `${item.task_id}:${item.session.connection_id}:${item.session.turn_id}:${request.id}`
      }
      ListHeaderComponent={
        <View className="gap-3">
          <Text className="text-lg font-t3-bold">
            {state.requests ? `待处理 · ${rows.length}` : "待处理"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            可在此处理服务端开放的问题与单次审批；未开放的能力请在网页处理。
          </Text>
          {state.requestsError ? (
            <Text accessibilityRole="alert" className="text-sm">
              {state.requestsError}
            </Text>
          ) : null}
          {state.requests?.unavailable_task_ids.length || state.requests?.truncated ? (
            <Text className="text-sm text-foreground-muted">
              部分执行会话暂不可用或列表未完整加载，请刷新核对。
            </Text>
          ) : null}
          {state.requestNotice ? (
            <Text accessibilityLiveRegion="polite" className="text-sm">
              {state.requestNotice}
            </Text>
          ) : null}
          <Button
            label="刷新待处理状态"
            disabled={busy}
            onPress={() => void run((signal) => controller.sync(signal))}
          />
          {state.controlPending ? (
            <View className="gap-3 rounded-2xl bg-subtle p-4">
              <Text className="font-t3-bold">有一项操作正在等待回执确认</Text>
              <Text className="text-sm text-foreground-muted">
                不会自动重新发送批准或回答。请先刷新回执，或在网页核对执行详情。
              </Text>
              <Button
                label="刷新操作回执"
                disabled={busy}
                onPress={() => void run((signal) => controller.reconcileControl(signal))}
              />
              <Button
                label="已在网页核对，结束回执跟进"
                tone="text"
                disabled={busy}
                onPress={() =>
                  Dialog.alert(
                    "结束本机回执跟进？",
                    "这不会撤回已发送的操作，也不会再次提交。请先在网页确认实际执行结果。",
                    [
                      { text: "继续核对", style: "cancel" },
                      {
                        text: "已核对",
                        onPress: () => void run(() => controller.acknowledgeControl()),
                      },
                    ],
                  )
                }
              />
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Text className="py-8 text-foreground-muted">
          {state.requestsError ||
          state.requests?.unavailable_task_ids.length ||
          state.requests?.truncated
            ? "待处理状态尚不完整，请刷新或在网页核对。"
            : state.requests
              ? "当前列表没有待处理请求。"
              : "正在读取待处理状态…"}
        </Text>
      }
      renderItem={({ item: { item, request } }) => (
        <RequestCard
          item={item}
          request={request}
          disabled={busy || Boolean(state.controlPending) || Boolean(state.requestsError)}
          onRespond={(answer) =>
            void run(async (signal) => {
              await controller.respond(item, request, answer, signal);
              await controller.sync(signal);
            })
          }
        />
      )}
    />
  );
}
