/** Record shapes for patterns and projects.json entries. */

export type PatternSource = "built-in" | "global" | "project" | "other" | "team";

export type Role = {
  id: string;
  responsibility: string;
  harness: string;
  model?: string;
  count?: number;
  skill?: string;
  fallback?: string;
  codeMode?: boolean;
};

export type Handoff = {
  from: string;
  to: string;
  on: string;
  required: boolean;
  cap?: number;
  kind?: string;
};

/** A pattern as listed or saved. `invalid` (with empty roles) marks an entry that failed to load. */
export type Pattern = {
  name: string;
  description?: string;
  roles: Role[];
  handoffs: Handoff[];
  maxVisits?: number;
  permission?: string;
  landing?: string;
  source?: PatternSource;
  file?: string;
  legacy?: boolean;
  invalid?: string;
};

/** The slice of loadConfig the catalog reads: the project, its peers and the state directory. */
export type CatalogConfig = { project: string; peers: string[]; stateDir: string };

/** One registered project in projects.json; teams map a name to member strings, patterns map a name to a pattern. */
export type ProjectEntry = {
  project: string;
  root?: string;
  url?: string;
  peers?: string;
  closed?: boolean;
  teams?: Record<string, string[]>;
  patterns?: Record<string, Pattern>;
  [key: string]: unknown;
};
