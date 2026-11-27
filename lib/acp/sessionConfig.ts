// Portions © 2026 T3 Tools Inc., MIT License, from pingdotgg/t3code@452d8f0 packages/provider-acp/src/server/sessionConfig.ts
// ACP session config options (session/new, load and resume responses) as option descriptors, plus the model option.

/** One select choice of an ACP SessionConfigOption. */
export interface AcpSelectOption { value: string; name: string; description?: string | null }
/** A named group of select choices. */
export interface AcpSelectGroup { group: string; name: string; options: AcpSelectOption[] }
/** An ACP SessionConfigOption as the agent sends it; only the fields read here. */
export type AcpConfigOption =
  | { id: string; name: string; description?: string | null; category?: string | null; type: "select"; currentValue: string; options: Array<AcpSelectOption | AcpSelectGroup> }
  | { id: string; name: string; description?: string | null; category?: string | null; type: "boolean"; currentValue: boolean };
/** The unstable ACP model state (`models` in a session response). */
export interface AcpModelState { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string; description?: string | null }> }
/** A session mode, as `modes.availableModes` lists it. */
export interface AcpSessionModeState { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string | null }> }

export interface OptionChoice { id: string; label: string; description?: string }
export type OptionDescriptor =
  | { id: string; label: string; description?: string; type: "boolean"; currentValue: boolean; role?: "mode" }
  | { id: string; label: string; description?: string; type: "select"; options: OptionChoice[]; currentValue?: string; role?: "mode" | "reasoning" };

export const ACP_SESSION_MODE_OPTION_ID = "_t3/session-mode";

/** Encodes a valid empty ACP choice as a non-empty ID; map back before applying. */
export const ACP_EMPTY_OPTION_VALUE = "_t3/empty";

const MAX_OPTION_DESCRIPTORS = 16;
const MAX_OPTION_CHOICES = 64;
const MAX_TEXT_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 1_024;

const boundedText = (value: string | null | undefined, maximumLength: number): string =>
  (value ?? "").trim().slice(0, maximumLength);

const boundedOpaqueValue = (value: string, maximumLength: number): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= maximumLength ? value : undefined;

const choiceId = (value: string): string | undefined =>
  value === "" ? ACP_EMPTY_OPTION_VALUE : boundedOpaqueValue(value, MAX_TEXT_LENGTH);

/** Mistral Vibe 3.1 sends its reasoning level under `thinking`, a category ACP reserves but never defined. */
export const isAcpThoughtLevelOption = (option: AcpConfigOption): boolean =>
  option.category === "thought_level" || (option.category === "thinking" && option.type === "select");

export function flattenSelectChoices(options: Array<AcpSelectOption | AcpSelectGroup>): AcpSelectOption[] {
  return options.flatMap((candidate) => ("value" in candidate ? [candidate] : candidate.options));
}

function selectChoices(candidates: Array<{ value: string; name: string; description?: string | null }>): OptionChoice[] {
  const seen = new Set<string>();
  const choices: OptionChoice[] = [];
  for (const candidate of candidates) {
    const id = choiceId(candidate.value);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const description = boundedText(candidate.description, MAX_DESCRIPTION_LENGTH);
    choices.push({ id, label: boundedText(candidate.name, MAX_TEXT_LENGTH) || id, ...(description ? { description } : {}) });
    if (choices.length === MAX_OPTION_CHOICES) break;
  }
  return choices;
}

/** The non-model config options and the session mode as bounded descriptors; model and collaboration_mode are left to the model control. */
export function acpOptionDescriptors(input: { configOptions: AcpConfigOption[] | null | undefined; modeState: AcpSessionModeState | undefined }): OptionDescriptor[] {
  const descriptors: OptionDescriptor[] = [];
  const seen = new Set<string>();
  const mirroredModeChoiceSets: Array<ReadonlySet<string>> = [];
  let hasModeCategory = false;

  for (const option of input.configOptions ?? []) {
    if (option.category === "model" || option.category === "collaboration_mode") continue;
    const id = boundedOpaqueValue(option.id, MAX_TEXT_LENGTH);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const description = boundedText(option.description, MAX_DESCRIPTION_LENGTH);
    const base = { id, label: boundedText(option.name, MAX_TEXT_LENGTH) || id, ...(description ? { description } : {}) };
    if (option.type === "boolean") {
      if (option.category === "mode") hasModeCategory = true;
      descriptors.push({ ...base, type: "boolean", currentValue: option.currentValue, ...(option.category === "mode" ? { role: "mode" as const } : {}) });
      if (descriptors.length === MAX_OPTION_DESCRIPTORS) return descriptors;
      continue;
    }
    const choices = selectChoices(flattenSelectChoices(option.options));
    if (choices.length === 0) {
      seen.delete(id);
      continue;
    }
    if (option.category === "mode") hasModeCategory = true;
    const isThoughtLevel = isAcpThoughtLevelOption(option);
    if (isThoughtLevel) mirroredModeChoiceSets.push(new Set(choices.map((choice) => choice.id)));
    const currentValue = choiceId(option.currentValue);
    descriptors.push({
      ...base,
      type: "select",
      options: choices,
      ...(currentValue && choices.some((choice) => choice.id === currentValue) ? { currentValue } : {}),
      ...(isThoughtLevel ? { role: "reasoning" as const } : option.category === "mode" ? { role: "mode" as const } : {}),
    });
    if (descriptors.length === MAX_OPTION_DESCRIPTORS) return descriptors;
  }

  const modeState = input.modeState;
  if (modeState !== undefined && !hasModeCategory) {
    const choices = selectChoices(modeState.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })));
    const currentValue = choiceId(modeState.currentModeId);
    // Some agents duplicate modes in config options; show each control once.
    const duplicatesKnownModeDescriptor = mirroredModeChoiceSets.some(
      (choiceIds) => choiceIds.size === choices.length && choices.every((choice) => choiceIds.has(choice.id)),
    );
    if (choices.length > 1 && !duplicatesKnownModeDescriptor && !seen.has(ACP_SESSION_MODE_OPTION_ID)) {
      descriptors.push({
        id: ACP_SESSION_MODE_OPTION_ID, label: "Mode", description: "Session mode advertised by the ACP agent.", type: "select", options: choices,
        ...(currentValue && choices.some((choice) => choice.id === currentValue) ? { currentValue } : {}),
        role: "mode",
      });
    }
  }

  return descriptors.slice(0, MAX_OPTION_DESCRIPTORS);
}

/** The select option that picks the model: category `model`, else the id `model` (Cursor's ACP_MODEL_CONFIG_ID). */
export function modelConfigOption(configOptions: AcpConfigOption[] | null | undefined): Extract<AcpConfigOption, { type: "select" }> | undefined {
  const selects = (configOptions ?? []).filter((o): o is Extract<AcpConfigOption, { type: "select" }> => o?.type === "select");
  return selects.find((o) => o.category === "model") ?? selects.find((o) => o.id === "model");
}

/** A session's selectable models and the current one. */
export interface SessionModels {
  current?: string;
  models: Array<{ id: string; label?: string }>;
}

/** The session's models as `{id, label}`: the model config option's choices, else the unstable `models` list. */
export function sessionModels(response: { configOptions?: AcpConfigOption[] | null; models?: AcpModelState | null } | null | undefined): SessionModels {
  const option = modelConfigOption(response?.configOptions);
  if (option) {
    const models = selectChoices(flattenSelectChoices(option.options)).map((c) => ({ id: c.id, label: c.label }));
    return { ...(option.currentValue ? { current: option.currentValue } : {}), models };
  }
  const state = response?.models;
  const models = (state?.availableModels ?? []).filter((m) => typeof m?.modelId === "string" && m.modelId)
    .map((m) => ({ id: m.modelId, ...(m.name ? { label: m.name } : {}) }));
  return { ...(state?.currentModelId ? { current: state.currentModelId } : {}), models };
}
