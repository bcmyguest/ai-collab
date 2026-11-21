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

Routing stays `from: "operator"`. Messages gain an envelope field `by` (the login), and hooks render the sender as `from=operator (octocat)`. Question answers and approvals stay the plain `reply <id> <answer>` text, with the login in the ntfy title (`Reply from operator (octocat)`), which the UI shows next to the answer. AFK mode envelopes carry `by` too.
