import { z } from "zod";

export const ASK_USER = "ask_user";
export const MAX_CLARIFICATIONS = 8;
export const CLARIFICATION_WAIT_MS = 15 * 60_000;

const optionId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
export const ClarificationQuestion = z.strictObject({
  question: z.string().trim().min(1).max(500),
  impact: z.string().trim().min(1).max(500),
  options: z.array(z.strictObject({ id: optionId, label: z.string().trim().min(1).max(160) })).min(1).max(4).optional(),
}).refine(value => !value.options || new Set(value.options.map(option => option.id)).size === value.options.length, "Option IDs must be unique");

export const ClarificationAnswer = z.union([
  z.strictObject({ question_id: z.string().uuid(), option_id: optionId }),
  z.strictObject({ question_id: z.string().uuid(), text: z.string().trim().min(1).max(2_000) }),
]);
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export type TaskClarification = z.infer<typeof ClarificationQuestion> & {
  kind?: "intent_confirmation" | "follow_up";
  id: string;
  asked_at: string;
  expires_at: string;
  answer?: { text: string; option_id?: string; answered_at: string };
};

export const INTENT_CONFIRMATION_GUIDANCE = [
  "The current task is awaiting its initial intent confirmation. Call ask_user by itself now, even if the request is already clear.",
  "In question, summarize your understanding in the user's language, including the requested outcome and any relevant scope already specified. Do not silently add unrequested defaults: label any proposed definition, period or filter as a proposal. In impact, explain what the user is confirming or what the choice affects.",
  "If the user needs to pick a business definition, give concrete, meaningful options. Otherwise omit options and the service will offer a confirm button. The user can always correct the request in their own words.",
  "Use only the conversation and supplied business context. Do not query metadata or data or produce analysis results until the user replies.",
].join(" ");

export function intentConfirmationOptions(options: TaskClarification["options"]): NonNullable<TaskClarification["options"]> {
  return options?.length ? options : [{ id: "confirm", label: "确认并开始分析" }];
}

export function clarificationPrompt(goal: string, clarifications: readonly TaskClarification[]): string {
  // Restate the goal and the confirmed decisions in case Pi has compacted earlier turns.
  return "Continue the same analysis using the user's clarification below. Keep other requirements unchanged. " +
    "Apply the user's latest corrections over earlier assumptions. A confirmation reply accepts the described scope; it does not answer unresolved choices. Any text produced before confirmation is not database evidence. Confirming the proposed scope authorizes starting the analysis, while any unresolved business choices can still be clarified. Use confirmed choices when planning SQL and disclose the actual scope in the answer. Ask another focused question if continued exploration uncovers a material decision that cannot be resolved from evidence. Carry forward decisions that are already clear and still apply.\n\n" +
    JSON.stringify({ goal, clarifications: clarifications.map(({ question, answer }) => ({ question, answer: answer?.text })) });
}
