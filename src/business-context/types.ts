import { z } from "zod";

export const BusinessContextId = z.string().regex(/^ctx_[a-f0-9]{20}$/);
export const BusinessContextIds = z.array(BusinessContextId).max(100).transform((ids) => [...new Set(ids)]);
export const BusinessContextDraft = z.object({
  name: z.string().trim().min(1).max(100),
  content: z.string().max(16_000).refine((text) => text.trim().length > 0, "Markdown must not be empty"),
});
export type BusinessContextDraft = z.infer<typeof BusinessContextDraft>;

export interface BusinessContextFile extends BusinessContextDraft {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
}
