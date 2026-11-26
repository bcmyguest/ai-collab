/** Import path for the pattern catalog (about 35 importers); the code lives in lib/catalog/. */
export {
  allPatternNames, BUILT_IN_PATTERNS, checkTeamText, copyPattern, createPattern, deletePattern, getPattern, listPatterns, removableNames, removePattern,
  savePattern, saveTeamText, teamTemplates, teamTextOf, validatePatternModels,
} from "./catalog/patterns.ts";
export { DONE, legacyPattern, requiredHandoffs, validatePattern } from "./catalog/pattern-model.ts";
