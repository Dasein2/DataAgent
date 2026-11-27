import { z } from "zod";

export const BusinessContextId = z.string().regex(/^ctx_[a-f0-9]{20}$/);
export const BusinessContextIds = z.array(BusinessContextId).max(100).transform((ids) => [...new Set(ids)]);
export const BusinessContextDraft = z.object({
  name: z.string().trim().min(1).max(100),
  // Wire ceiling only: the configured character and token budgets live in the store, so the console
  // and the API give the same policy error instead of a raw schema message.
  content: z.string().max(200_000).refine((text) => text.trim().length > 0, "Markdown must not be empty"),
});
export type BusinessContextDraft = z.infer<typeof BusinessContextDraft>;

/**
 * Uploaded Markdown files. Loose on purpose: each document is validated as a draft on its own so one
 * bad file does not fail the whole batch.
 */
export const BusinessContextImport = z.object({
  documents: z.array(z.object({
    name: z.string().max(400),
    content: z.string().max(64_000),
  })).min(1).max(20),
});
export type BusinessContextImport = z.infer<typeof BusinessContextImport>;

export interface BusinessContextFile extends BusinessContextDraft {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
}
