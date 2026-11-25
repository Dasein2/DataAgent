import { z } from "zod";

export const ASK_USER = "ask_user";
export const MAX_CLARIFICATIONS = 8;
export const CLARIFICATION_WAIT_MS = 15 * 60_000;

const optionId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
export const ClarificationQuestion = z.strictObject({
  question: z.string().trim().min(1).max(500),
  impact: z.string().trim().min(1).max(500),
  options: z.array(z.strictObject({ id: optionId, label: z.string().trim().min(1).max(160) })).min(2).max(4).optional(),
}).refine(value => !value.options || new Set(value.options.map(option => option.id)).size === value.options.length, "Option IDs must be unique");

export const ClarificationAnswer = z.union([
  z.strictObject({ question_id: z.string().uuid(), option_id: optionId }),
  z.strictObject({ question_id: z.string().uuid(), text: z.string().trim().min(1).max(2_000) }),
]);
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export type TaskClarification = z.infer<typeof ClarificationQuestion> & {
  id: string;
  asked_at: string;
  expires_at: string;
  answer?: { text: string; option_id?: string; answered_at: string };
};

export function clarificationPrompt(goal: string, clarifications: readonly TaskClarification[]): string {
  // Restate the goal and the confirmed decisions in case Pi has compacted earlier turns.
  return "Continue the same analysis using the user's clarification below. Keep other requirements unchanged. " +
    "Use confirmed choices when planning SQL and disclose the actual scope in the answer. Ask another focused question if continued exploration uncovers a material decision that cannot be resolved from evidence. Carry forward decisions that are already clear and still apply.\n\n" +
    JSON.stringify({ goal, clarifications: clarifications.map(({ question, answer }) => ({ question, answer: answer?.text })) });
}
