// The AI Collab A2UI catalog: the basic catalog plus OptionPicker, which ChoicePicker cannot express (per-option descriptions, Other, read-only).
import { Catalog, DynamicStringListSchema, DynamicStringSchema } from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
// zod 3 matches the copy @a2ui/web_core validates with; the root zod 4 cannot read its schemas.
import { z } from "zod-v3";
import { A2UI_CATALOG_ID } from "./a2ui.js";

export const OptionPickerApi = {
  name: "OptionPicker",
  schema: z.object({
    options: z.array(z.object({
      label: z.string(),
      value: z.string(),
      description: z.string().optional(),
      preview: z.string().optional(),
    })),
    multiSelect: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    value: DynamicStringListSchema,
    other: DynamicStringSchema.optional(),
  }),
};

/** A catalog of the basic components and the given custom ones (API objects or React implementations). */
export function aiCollabCatalog(custom = []) {
  return new Catalog(A2UI_CATALOG_ID, "0.9", [...basicCatalog.components.values(), ...custom], [...basicCatalog.functions.values()]);
}
