# GitHub sign-in

Optional. With `~/.config/ai-collab/github.json` (`$XDG_CONFIG_HOME/ai-collab/github.json`) present, the UI asks each visitor to sign in with GitHub, and every message, question answer, approval and AFK change sent from the UI carries the sender's GitHub login. Without the file, the UI has no sign-in, and every message is from `operator`.

## Set up

1. Register an OAuth app at <https://github.com/settings/applications/new> ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)):

   | Field | Value |
   |---|---|
   | Application name | `AI Collab` (any) |
   | Homepage URL | `AI_COLLAB_UI_ORIGIN`, e.g. `https://ai-collab-ui.<tailnet>.ts.net` |
   | Authorization callback URL | `AI_COLLAB_UI_ORIGIN` + `/api/auth/callback`, e.g. `https://ai-collab-ui.<tailnet>.ts.net/api/auth/callback` |
   | Enable Device Flow | off |

2. Generate a client secret and save it in a file only you can read, e.g. `install -m 600 /dev/null ~/.config/ai-collab/github-client-secret`, then paste the secret into it.
3. Write `~/.config/ai-collab/github.json`; `users` lists the GitHub logins allowed in (case-insensitive):

   ```json
   {
     "clientId": "Ov23liEXAMPLE",
     "clientSecretFile": "/home/you/.config/ai-collab/github-client-secret",
     "users": ["octocat", "hubot"]
   }
   ```

4. Restart the UI service. Sign-in needs `AI_COLLAB_UI_ORIGIN`; the UI refuses to start with `github.json` and no origin.

## How it works

The UI follows GitHub's [web application flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow):

- **Sign in with GitHub** opens `/api/auth/login`, which redirects to GitHub with a random `state` held in a 10-minute HttpOnly cookie and an empty scope (public profile only).
- `/api/auth/callback` checks `state`, exchanges the code for a token, reads `GET https://api.github.com/user`, checks the login against `users`, and drops the token. The client secret file is read at each callback and never logged.
- The session cookie (`__Host-ai-collab-session`: HttpOnly, Secure, SameSite=Lax, 30 days) holds `{login, name, exp}` signed with HMAC-SHA256. The key is 32 random bytes at `$AI_COLLAB_STATE_DIR/auth/secret` (mode 0600), created on first start. Delete it to sign everyone out.
- Every `/api` route except `/api/auth/*` and `/api/version` answers 401 without a valid session. A login removed from `users` is refused at the next request after the UI restarts.
- The header shows **signed in as \<login\> · sign out**. Each person on the allowlist signs in with their own account; the UI labels their messages with their login, and the viewer's own as **You**.

## What agents see

Routing stays `from: "operator"`. Messages gain an envelope field `by` (the login), and hooks render the sender as `from=operator (octocat)`. Question answers and approvals stay the plain `reply <id> <answer>` text, with the login in the message title (`Reply from operator (octocat)`), which the UI shows next to the answer. AFK mode envelopes carry `by` too.

## Hosted project isolation

Set `"hosted": true` in `github.json` to scope the UI to each signed-in GitHub login. For every project on the UI host, add an explicit `projects.json` entry with its GitHub `owner` and the absolute path to its bus `tokenFile`. Keep project names unique. The UI uses the first project assigned to each login as that user's default and shows the configured owner on agent cards. Ownership comes from the host's configuration.

Give each owner a dedicated credential before enabling hosted mode. The local bus accepts one token and has no per-topic ACLs, so two owners cannot share it: the UI rejects a token reused across owners. Point hosted projects at a broker with per-account credentials, such as an operator-run ntfy server (threads then stay unavailable). On a shared broker, use deny-by-default ACLs and grant each account access to only its own project topics. Use a separate private broker per owner if tenants can reach the broker's file endpoint, since attachments use bearer URLs. Give agent machines the corresponding restricted credentials. Keep setup's admin credentials on the broker host. The UI rejects missing owners or credentials and rejects a token reused across owners. The broker administrator configures and verifies the underlying ACLs.

Use fresh project topic names when assigning existing projects to new owners. A broker replays its retained messages on a reused topic (the bus keeps 7 days). Restart the UI when changing owners or removing a login, and revoke the corresponding broker credentials separately. The hosted UI keeps its history and attachment caches under `$AI_COLLAB_STATE_DIR/hosted/<login>`.

Hosted mode supports chat, questions, approvals, activity, history, and per-owner AFK. Run agents on their owners' machines. Local starts and session controls, schedules, push notifications, and team or task management are unavailable in hosted mode.

Cross-user delivery stays closed in this phase. Cross-user collaboration requires separately provisioned agent identities, verified message origin, and an explicit delivery policy. An agent's self-reported sender name cannot establish cross-user ownership.
