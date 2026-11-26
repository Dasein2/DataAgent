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

/** The console supplies a free-text action; these placeholders are not answers. */
export function isFreeTextOption(option: { id: string; label: string }): boolean {
  const label = option.label.trim();
  return /^(?:other|others|custom|free[_-]?text|user[_-]?input)$/i.test(option.id) ||
    /^(?:其他|其它|自定义|自由输入|自行输入|手动输入)(?:[／/、 ]*(?:选项|口径|补充|输入|填写|说明))?$/u.test(label) ||
    /^(?:其他|其它|另有|自定义|自由输入|自行输入|手动输入).*?(?:请说明|请填写|请输入|请补充|自行填写|自行输入|手动输入)/u.test(label) ||
    /^(?:other|something else|custom|free[ -]text)(?:$|.*\b(?:please specify|please enter|type your own)\b)/i.test(label);
}

export const ClarificationAnswer = z.union([
  z.strictObject({ question_id: z.string().uuid(), option_id: optionId }),
  z.strictObject({ question_id: z.string().uuid(), text: z.string().trim().min(1).max(2_000) }),
]);
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export type TaskClarification = z.infer<typeof ClarificationQuestion> & {
  /** intent_confirmation is retained for historical tasks; new questions use follow_up. */
  kind?: "intent_confirmation" | "follow_up";
  id: string;
  asked_at: string;
  expires_at: string;
  answer?: { text: string; option_id?: string; answered_at: string };
};

export function clarificationPrompt(goal: string, clarifications: readonly TaskClarification[]): string {
  // Restate the goal and the confirmed decisions in case Pi has compacted earlier turns.
  return "Continue the same analysis using the user's clarification below. Keep other requirements unchanged. " +
    "Apply the user's latest corrections over earlier assumptions. Reuse the database context and evidence already gathered; a clarification does not restart discovery. A general confirmation does not settle any unresolved business choice, and model narration is not database evidence. Use the chosen scope when planning SQL and disclose the actual scope in the answer. Compute only the chosen population; do not add totals for rejected alternatives just to explain them. For a month, use exact half-open boundaries (for January: >= January 1 and < February 1), and describe these dates accurately. Do not repeat resolved questions or ask for permission to start. Ask another focused question only if continued exploration uncovers a new material decision that cannot be resolved from evidence. Carry forward decisions that are already clear and still apply.\n\n" +
    JSON.stringify({ goal, clarifications: clarifications.map(({ question, answer }) => ({ question, answer: answer?.text })) });
}
