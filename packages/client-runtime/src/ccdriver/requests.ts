import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { CCDriverQuestion, type CCDriverNativeRequest } from "@t3tools/contracts/ccdriver";

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(CCDriverQuestion));
export function nativeQuestions(request: CCDriverNativeRequest): readonly CCDriverQuestion[] {
  if (request.method !== "item/tool/requestUserInput") return [];
  const decoded = decodeQuestions(request.params.questions);
  return Option.isSome(decoded) ? decoded.value : [];
}

export const transientApprovalLabels: Readonly<Record<string, string>> = {
  accept: "仅批准本次",
  grantForTurn: "批准当前轮次权限",
  decline: "拒绝",
  cancel: "取消本轮",
};

export interface CCDriverAnswer {
  readonly choice_id?: string;
  readonly answers?: Readonly<Record<string, readonly string[]>>;
}

export function validNativeAnswer(request: CCDriverNativeRequest, answer: CCDriverAnswer): boolean {
  const questions = nativeQuestions(request);
  if (request.method === "item/tool/requestUserInput") {
    if (
      !questions.length ||
      answer.choice_id ||
      !answer.answers ||
      Object.keys(answer.answers).length !== questions.length
    )
      return false;
    return questions.every((question) => {
      const values = answer.answers?.[question.id];
      if (values?.length !== 1 || !values[0]?.trim()) return false;
      return (
        !question.options?.length ||
        question.isOther === true ||
        question.options.some((option) => option.label === values[0])
      );
    });
  }
  if (
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(request.method) ||
    answer.answers
  )
    return false;
  return Boolean(
    request.choices?.some(
      (choice) => choice.id === answer.choice_id && transientApprovalLabels[choice.kind],
    ),
  );
}
