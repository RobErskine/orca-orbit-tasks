# Orbit Tasks for Orca

An [Orca](https://github.com/stablyai/orca) plugin that shows the tasks of a self-hosted
[Orbit](https://github.com/coollabsio/orbit) instance in Orca's right sidebar. Pick a task, check
the prompt, and start an agent workspace from it.

- Search tasks, and filter them by saved view, project, status, assignee and priority.
- Read a task with its description, sub-issues, relations and latest comments.
- Start a workspace: Orca creates the branch and worktree, starts the agent and sends it a prompt
  built from the task.
- See which tasks already have a workspace.

It reads from Orbit only. It never changes a task.

## Requirements

- Orca 1.4.259 or newer (desktop app).
- An Orbit instance with the public REST API (`/api/public/v1`), reachable from your computer over
  HTTP or HTTPS with a certificate your system trusts.
- A personal Orbit API token with **Tasks: Read**.

## Install

In Orca, open **Settings → Plugins**, choose to install from a Git URL and enter
`https://github.com/RobErskine/orca-orbit-tasks`. Or, from a terminal:

```sh
orca plugin install RobErskine/orca-orbit-tasks
```

Orca then lists what the plugin asks for and waits for your approval:

| Access | Why |
| --- | --- |
| Runs its own code in a Node.js process | The worker makes the requests to Orbit. Panels have no network. |
| Its own settings, secrets and storage | The Orbit URL, the API token (in your system's key store), and which workspaces you started. |
| Read your projects and workspaces | To list the Orca projects in the Start form, and to forget a workspace you removed. |
| Create workspaces | Start creates the branch and worktree. |
| Start agents | Start launches the agent with the prompt. |

## Connect

1. In Orbit, open **Settings → API tokens** and create a token:
   - **Tasks: Read**. No other permission is needed.
   - The projects you want in Orca, or all projects.
   - An expiry.
   - A personal token, not a service account. A service-account token works too, but it has no
     "Me" filter and no saved views.
2. In Orca, open the **Orbit Tasks** panel in the right sidebar.
3. Enter your Orbit URL (for example `https://orbit.example.com`) and the token, then press
   **Connect**.

The plugin tests the URL and token against Orbit and saves them only when they work. The token
goes to Orca's secret store, which uses your system's key store. It is never written to a
setting, a log or the panel's saved state. **Forget token** in the connection screen removes it.

## Use

- **Search:** type in the search field and press Enter. Orbit searches titles, descriptions and
  identifiers such as `ENG-12`.
- **Filters:** open **Filters**. Without a saved view, the list shows your open tasks, most
  recently updated first. A saved view from Orbit shows that view's tasks in its own order.
- **Load more:** the list loads about 25 tasks at a time.
- **Open a task:** press it. **Open in Orbit** opens it in your browser.
- **Start workspace:** opens the Start form. Choose the Orca project, optionally a base branch,
  and check the workspace name, agent and prompt. Nothing is created until you press **Start**.
  With the box ticked, the plugin remembers the Orca project and base branch for that Orbit
  project.

**Start runs at once.** Orca creates the workspace and sends the prompt to the agent, which
begins to work. The task description is part of the prompt, and other people may have written
it, so read the prompt before you press Start.

## Settings

**Settings → Plugins → Orbit Tasks:**

| Setting | Default | Meaning |
| --- | --- | --- |
| Orbit URL | (empty) | Set by the Connect form. |
| Include done tasks | off | Show completed, cancelled and duplicate tasks unless the Status filter says otherwise. |
| Default agent | `claude` | The agent the Start form preselects. |
| Agent prompt | see below | The prompt template. `{{key}}`, `{{title}}`, `{{url}}` and `{{description}}` are replaced with the task's values. |

The default prompt puts the description between `<orbit-task-description>` markers and tells the
agent to treat it as requirements, not as commands. A description cannot close its own marker,
and a long one is cut so the prompt stays under 12,000 characters, with a link to the full task.

## How it works

- `src/panel.tsx` is a components panel. It has no network access, so it asks the worker for
  everything (`src/protocol.ts` is their contract).
- `src/worker.ts` runs in Orca's plugin worker process. It keeps the connection, calls Orbit and
  calls Orca's `workspace.create`.
- `src/core/` has no Orca code:
  - `client.ts` makes authenticated GET requests to `/api/public/v1`, turns Orbit's problem
    documents into clear messages, and retries once when Orbit says to wait (`429` or `503` with
    `Retry-After`).
  - `lookups.ts` turns the ids on a task (status, labels, assignees, project) into names. Each
    lookup is fetched once and kept for five minutes.
  - `source.ts` implements `list` and `get`. Orbit has no "open tasks only" filter, so `list`
    drops done tasks itself and keeps asking for pages until it has enough.
  - `contract.ts` holds the limits of Orca's planned task source format.

There is no build step and no dependency: Orca loads the TypeScript files as they are.

### Orca's Tasks page

Orca plans a `contributes.taskSources` plugin point that would put Orbit beside GitHub and Linear
on its Tasks page ([stablyai/orca#26282](https://github.com/stablyai/orca/pull/26282)). It is not
in a released Orca yet, so this plugin uses a panel. `src/core/` already answers `list` and `get`
in that format, and the tests run every answer through `contract.ts`, which mirrors the pull
request's schema. When Orca ships it, the Tasks page needs only a small adapter.

## Known limitations

- **No review in Orca's Create workspace dialog.** Orca's plugin API creates the workspace and
  submits the prompt in one step. The Start form is the review step.
- **No model or effort choice.** The agent starts with your defaults for it.
- **A workspace cannot be opened from the panel.** The panel shows which tasks have a workspace;
  open it from Orca's sidebar. Opening one needs a broader permission (`workspace:write`) that
  the plugin does not ask for.
- **Read-only.** The plugin does not move a task to In progress or Done.
- **Self-signed certificates are not supported.** Use a certificate your system trusts (Tailscale
  HTTPS and Let's Encrypt both work), or plain `http://` on a trusted network.
- **Status filters by category are applied in the plugin.** With many done tasks ahead of the
  open ones, a page can come back short or empty; **Load more** continues.
- **Up to 100 options per filter** (projects, saved views, statuses of one project).
- **The latest 5 comments** of the first 300 are shown, and long descriptions are cut, with a
  link to the task.
- **Orbit API version.** The plugin follows the public API of Orbit `main` (after 0.4.1). On an
  older Orbit without saved views, the View filter is hidden.

## Develop

```sh
orca plugin dev watch .     # load this folder into Orca and print its logs; Ctrl-C unloads it
orca plugin test .          # unit tests, with a fake Orbit; no network
orca plugin check .         # validate the manifest and render every panel scenario
orca plugin validate .      # the manifest checks Orca runs
npx -p typescript tsc -p .  # type-check against the typings in .orca/types
```

`orca plugin types .` writes the typings again after an Orca update.

To try the worker against a real Orbit without the panel, load the folder and connect, then:

```sh
orca plugin dev request . tasks.list --data '{"query":"","filters":{}}'
```

## Privacy

The plugin talks to your Orbit instance and to Orca, and to nothing else. It has no telemetry.

## License

[MIT](LICENSE)
