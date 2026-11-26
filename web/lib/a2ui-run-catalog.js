// The Script component of the run-in-terminal card: exact text, and with sha256 the browser's digest of it written to `shown`.
import { DynamicStringSchema } from "@a2ui/web_core/v0_9";
// zod 3 matches the copy @a2ui/web_core validates with; the root zod 4 cannot read its schemas.
import { z } from "zod-v3";

export const ScriptApi = {
  name: "Script",
  schema: z.object({
    text: DynamicStringSchema,
    label: z.string().optional(),
    sha256: z.string().optional(),
    shown: DynamicStringSchema.optional(),
  }),
};
