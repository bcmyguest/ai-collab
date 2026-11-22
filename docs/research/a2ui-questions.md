# A2UI for agent questions, approvals, and choice cards over AG-UI

Research date: 2026-11-21. Sources are primary (spec, repo, npm registry, AG-UI docs). Items marked **UNCONFIRMED** were not verified in a primary source.

## Summary

1. A2UI is Apache-2.0, current spec is v0.9.1 on a2ui.org (the spec site also lists v1.0; the React README recommends v0.9). Version naming is inconsistent across sources.
2. AG-UI does not define A2UI transport. The carriage convention (`ACTIVITY_SNAPSHOT` with `activityType: "a2ui-surface"`) comes from `@ag-ui/a2ui-middleware` and assistant-ui docs, not the AG-UI spec.
3. `@a2ui/react` 0.15.0 is the official React renderer (Apache-2.0, peer React 18 or 19). It is pre-1.0 with breaking changes in minor releases. Next.js 16 compatibility is UNCONFIRMED.
4. The basic catalog has `ChoicePicker` (no `MultipleChoice`), `Button`, `TextField`, `Card`, `Row`, `Column`, `Text`. `ChoicePicker` has no per-option description slot, so option descriptions need a separate `Text`.
5. A user click returns as a client-to-server `action` message (v0.9.1), which the AG-UI integration forwards as `forwardedProps.a2uiAction.userAction` on a new run.

## Facts

| Item | Value | Source |
|---|---|---|
| Spec license | Not stated on spec page. Repo `a2ui-project/a2ui` is Apache-2.0. | https://github.com/a2ui-project/a2ui |
| Spec version | v0.9.1 (`"version": "v0.9.1"` in envelope). Site header shows v1.0. | https://a2ui.org/specification/v0.9.1-a2ui/ ; https://a2ui.org/specification/v1.0-a2ui/ |
| Repo spec path | `specification/v0_9/docs/a2ui_protocol.md` (also `a2ui_custom_functions.md`, `evolution_guide.md`) | https://github.com/google/A2UI/tree/main/specification/v0_9 (redirects to a2ui-project org) |
| Older spec | v0.8 used `surfaceUpdate`, `dataModelUpdate`, `beginRendering`, `userAction`. | https://raw.githubusercontent.com/google/A2UI/main/specification/v0_8/docs/a2ui_protocol.md |
| Message types (v0.9.1, server to client) | `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface`. Each message holds one of these keys. | https://a2ui.org/specification/v0.9.1-a2ui/ "Message types" |
| `createSurface` fields | `surfaceId`, `catalogId`, `theme` (opt), `sendDataModel` (opt) | same |
| `updateComponents` fields | `surfaceId`, `components` (flat array of `{id, component}`) | same; v0.8 shape at raw URL above |
| `updateDataModel` fields | `surfaceId`, `path` (opt, default `/`), `value` (opt) | same |
| Client to server | `action`: `name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context` | https://a2ui.org/specification/v0.9.1-a2ui/ "Client-to-server message" |
| v0.8 user event | `userAction` (with `name`, `surfaceId`, `sourceComponentId`, `timestamp`, `context`) | v0.8 raw URL above |
| Catalog: Text | `text`, `variant`. Supports simple Markdown. | v0.9.1 page, "Basic Catalog components" |
| Catalog: Button | `child`, `variant` (`primary`, `borderless`), `action` (`event` or `functionCall`), `checks` | same |
| Catalog: ChoicePicker | `options` (`label`/`value` pairs), `value` (data binding), `variant` (example `mutuallyExclusive`). No `maxAllowedSelections`. | same |
| Catalog: TextField | `label`, `value`, `variant` (example `shortText`), `checks` | same |
| Catalog: Card | `child` | same |
| Catalog: Row / Column | `children`, `justify`, `align`; Column adds `weight` | same |
| Catalog: MultipleChoice | Not in the spec. Use `ChoicePicker`. | v0.9.1 page |
| Catalog ID | v0.8: `https://a2ui.org/specification/v0_8/standard_catalog_definition.json`. v0.9 basic catalog URI: **UNCONFIRMED**. | v0.8 raw URL above |
| Basic catalog JSON file | Not found in directory listing. **UNCONFIRMED** path. | https://github.com/a2ui-project/a2ui/tree/main/specification/v0_9 |

Note: the page for v0.9.1 gives property names from examples only, not formal schemas. Treat the property lists as indicative.

## AG-UI carriage

| Item | Value | Source |
|---|---|---|
| A2UI in AG-UI | Listed as "Supported" under Generative UI in the integrations table. Spec doc calls A2UI "A declarative, LLM-friendly Generative UI spec. JSONL-based and streaming." | https://docs.ag-ui.com/concepts/generative-ui-specs.md |
| Event type | `ACTIVITY_SNAPSHOT` (creates or replaces one activity message) and `ACTIVITY_DELTA` (RFC 6902 patch on content). Draft spec. | https://docs.ag-ui.com/spec/draft/events/activity.md ; 1.0 page exists per index: https://docs.ag-ui.com/spec/1.0/events/index.md (1.0 activity page content not fetched) |
| Activity fields | `messageId`, `activityType` (open string), `content` (must be an object), `replace` (optional; absent means true) | https://docs.ag-ui.com/spec/draft/events/activity.md |
| A2UI `activityType` | `"a2ui-surface"`. Community convention, not in AG-UI spec. | https://www.assistant-ui.com/docs/tools/a2ui.md ; https://docs.ag-ui.com/spec/draft/events/activity.md states the set is the producer's |
| A2UI ops location | `content.a2ui_operations`, an array of `{version, createSurface|updateComponents|...}` | https://www.assistant-ui.com/docs/tools/a2ui.md (uses `"v0.9"` in its example) |
| Middleware | `@ag-ui/a2ui-middleware` 0.0.16, MIT, peers `@ag-ui/client >=1.0.0`, `rxjs 7.8.1`. Emits A2UI snapshots. | npm registry, `https://registry.npmjs.org/@ag-ui/a2ui-middleware` |
| Return path | Button click dispatches `a2ui:action`. Sending it triggers a run with no new user message. Agent reads `forwardedProps.a2uiAction.userAction`. `functionCall` actions stay client-side (`a2ui:functionCall`). | https://www.assistant-ui.com/docs/tools/a2ui.md |
| Client packages | `@assistant-ui/react-ag-ui` (`useAgUiRuntime`, `useAgUiSendA2uiAction`), `@assistant-ui/generative-ui`. Versions not shown. | same |
| AG-UI core | `@ag-ui/client` 1.0.5 and `@ag-ui/core` 1.0.5, both MIT, published 2026-11-17. | npm registry |

Note: the `a2uiAction` return path is an assistant-ui implementation detail. No AG-UI or A2UI primary spec page defined it (search found none; AG-UI generative-UI page is silent on it).

## React renderer

| Item | Value | Source |
|---|---|---|
| Package | `@a2ui/react` | https://www.npmjs.com/package/@a2ui/react (403 to fetch; registry read instead) |
| Latest | 0.15.0, published 2026-11-02, Apache-2.0 | `https://registry.npmjs.org/@a2ui/react` |
| Stable releases | 12 non-prerelease versions, from 0.10.x upward; 0.9.x alphas exist | same registry document |
| Peers | `react` and `react-dom` `^18.0.0 \|\| ^19.0.0`, `zod ^3.25.76` | same |
| Deps | `@a2ui/web_core ^0.15.0`, `@a2ui/markdown-it ^0.2.2`, `clsx`, `markdown-it` | same |
| Engines | node >=18 | package.json in tarball |
| Source | `typescript/renderers/react` in `a2ui-project/a2ui` | https://github.com/a2ui-project/a2ui |
| Entry points | root (version-agnostic runtime: `A2uiSurface`, `createComponentImplementation`), `@a2ui/react/v0_9`, `@a2ui/react/v0_8` | https://github.com/a2ui-project/a2ui/blob/main/typescript/renderers/react/CHANGELOG.md (0.13.0 entry); package README |
| Maturity | Pre-1.0. 0.15.0 has BREAKING CHANGEs (placeholders removed, `allowedParents` enforced). | CHANGELOG.md, 0.15.0 section |
| Next.js 16 / React 19 | React 19 is in peer range. The JS files carry no `"use client"` directive (only `.map` files in `v0_8` do). An App Router consumer must wrap `A2uiSurface` in a client component. Runtime with Next 16: **UNCONFIRMED**, not tested. | tarball inspection, `npm pack` of 0.15.0 |
| Other renderers | `@copilotkit/a2ui-renderer` 1.90.0, MIT, peers React 18 or 19. Not checked against A2UI version. | npm registry |

Official TypeScript packages also include `@a2ui/web_core` 0.15.0 and `@a2ui/agent` 0.1.0 (both Apache-2.0).

## Example: AskUserQuestion as A2UI

Source shape: `{questions:[{question, header, multiSelect, options:[{label, description}]}]}`.

Mapping: one surface per question. `header` becomes a `Text`, `question` becomes a `Text`, options become `ChoicePicker` options, `multiSelect` maps to the picker variant, and `description` has no `ChoicePicker` slot.

AG-UI envelope (assistant-ui convention):

```json
{"type":"ACTIVITY_SNAPSHOT","messageId":"q-1","activityType":"a2ui-surface","replace":true,
 "content":{"a2ui_operations":[ ...operations below... ]}}
```

Operations (v0.9.1 envelope, field names from the spec; `catalogId` value UNCONFIRMED):

```json
{"version":"v0.9.1","createSurface":{"surfaceId":"q-1","catalogId":"<basic catalog URI, UNCONFIRMED>"}}
{"version":"v0.9.1","updateDataModel":{"surfaceId":"q-1","path":"/answer","value":[]}}
{"version":"v0.9.1","updateComponents":{"surfaceId":"q-1","components":[
  {"id":"root","component":{"Card":{"child":"col"}}},
  {"id":"col","component":{"Column":{"children":["header","question","picker","submit"]}}},
  {"id":"header","component":{"Text":{"text":"Deploy target"}}},
  {"id":"question","component":{"Text":{"text":"Which environment should the deploy use?"}}},
  {"id":"picker","component":{"ChoicePicker":{"value":{"path":"/answer"},"variant":"mutuallyExclusive",
     "options":[{"label":"staging","value":"staging"},{"label":"production","value":"production"}]}}},
  {"id":"submit","component":{"Button":{"child":"submit-label","variant":"primary",
     "action":{"event":{"name":"answer_question","context":{"questionId":"q-1","answer":{"path":"/answer"}}}}}}},
  {"id":"submit-label","component":{"Text":{"text":"Submit"}}}
]}}
```

Notes on the example:
- `multiSelect: true` needs the other picker variant. The spec page names only `mutuallyExclusive`. The multi-select variant name is UNCONFIRMED.
- `description` for each option has no field. Render it as a `Text` beside each option, or put it in a `Row` with the option.
- The `Button.action.event` shape is partly confirmed (the spec lists `event` or `functionCall`). The inner `name`/`context` shape is inferred from the client `action` message.
- `Column.children` as an array of IDs is inferred from the examples. UNCONFIRMED for exact form.

User answer returns as a client-to-server `action` (v0.9.1):

```json
{"name":"answer_question","surfaceId":"q-1","sourceComponentId":"submit",
 "timestamp":"2026-11-21T10:00:00Z","context":{"questionId":"q-1","answer":["staging"]}}
```

Over AG-UI (assistant-ui convention), this object arrives as `forwardedProps.a2uiAction.userAction` on a new run. Under v0.8 the same object was called `userAction` at the top level.

## Unconfirmed

- Exact basic catalog URI for v0.9 and v0.9.1.
- Multi-select `ChoicePicker` variant name.
- Exact `children` form for `Column` and `Button.action` inner shape.
- Spec license text for `specification/`.
- `@a2ui/react` runtime behavior under Next.js 16 and React 19 (only peer ranges checked).
- AG-UI 1.0 activity page content (only draft fetched).
- Whether `@assistant-ui/react-ag-ui` and `@ag-ui/a2ui-middleware` versions are compatible with `@a2ui/react` 0.15.0 (not checked).
- The `npmjs.com` page was blocked (403); version data came from the npm registry JSON.

## Open decision for AI Collab

- Target spec version (v0.8, v0.9.1, or v1.0). Renderer 0.15.0 targets v0.9 per its README. Confirm before building.
- Whether to use the `@ag-ui/a2ui-middleware` convention or a private `activityType`. The AG-UI spec allows any `activityType`, so a private name works but drops interop.
