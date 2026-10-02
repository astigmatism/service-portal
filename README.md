# Service Portal

A lightweight Docker container that acts as a **gateway/portal to every container
on the host**. Open the portal in a browser (plain port 80) to see a live table of all
containers; click a service row or one of its port chips to open that service in a new browser
tab via its published port.

New containers appear automatically unless explicitly hidden — the portal re-queries Docker
on every request. No reconfiguration, no restart for discovery.

## How it works

- One Node.js HTTP server on `node:20-alpine`, with Sharp for small wallpaper previews.
  Running outside Docker requires Node.js 20.9 or newer and `npm ci`.
- The container mounts the **host Docker socket** read-write and calls the Docker Engine REST
  API (`GET /containers/json?all=1`) over the Unix socket on every `/api/services` request,
  so the UI is always a live view of the host.
- Single-page UI (vanilla HTML/CSS/JS, dark theme): sortable table (Service / Image / Ports /
  Status), status dots from Docker state + health, clickable port chips (https is auto-used
  for host ports 443/8443/3443/9443), a "Hide services without links" filter persisted in
  localStorage, a Table/Sidebar layout switch also persisted in localStorage (the Sidebar
  layout is a narrow single-column list on the left third of the screen — status dot, name
  link, a per-row start/stop toggle, and an opt-in update/restart control — leaving the rest of the viewport for the
  wallpaper — whose right edge carries a drag handle for pulling the list wider toward the
  centre or back to the left. The handle stays invisible until the pointer comes within ~36px
  of that edge, so the list reads clean by default (clamped between 280px and the row minus a
  240px wallpaper strip, the finalized width remembered per browser in localStorage so a
  return visit lands where you left it, double-click or Enter for the default third),
  and 20-second auto-refresh.
- Project update, start, and stop actions run in detached maintenance containers, so an action
  survives replacing a target container or the portal itself. Job status and bounded logs persist in `/data`.
- **Update checks**: projects that opt in are checked for a pending update every 15 minutes, when the
  page opens or its tab becomes visible again, and right after any project action. The Update control
  stays disabled while the deployment is current; when an update is ready it is enabled, badged with
  the number of commits the deployment is behind, and its tooltip lists the pending commits (see
  [Update checks](#update-checks)).
- An **Activity** panel (header toggle, next to Appearance) keeps a durable, newest-first feed of
  portal actions: project jobs (from the persisted maintenance records, with full runner logs
  expandable per event) and container start/stop actions (appended to `/data/activity.jsonl`,
  rotated past 256 KB). The toggle shows an unread badge for events newer than the last time that
  browser viewed the panel (localStorage), so nothing is silently missed. Toasts remain as
  ephemeral pings: they stack bottom-left, failures stay until dismissed, everything else fades
  after 6 s — a faded toast loses nothing because the panel holds the record.

## Routes

| Path | Response |
|---|---|
| `/`, `/index.html` | The portal UI (`text/html`, `Cache-Control: no-store`) |
| `/api/services` | JSON: `{generatedAt, services: [...]}` — one entry per visible container with `name, label, description, id, image, state, health, statusLine, ports[], self, project, update, lifecycle` (`no-store`). `update.check` is `null` unless the project opted into [update checks](#update-checks); otherwise `{status: "unknown"\|"current"\|"available"\|"error", checking, checkedAt, behind, deployed, target, commits: [{revision, committedAt, subject}], note, error, intervalMinutes}` |
| `POST /api/services/<id>/start` / `POST /api/services/<id>/stop` | Docker start/stop for an individual container: `200` `{ok, action}` on success, `409` for members of opted-in lifecycle projects, `502` when Docker refuses (`no-store`) |
| `POST /api/projects/<project>/update` | Starts an opted-in detached update/restart job; requires `X-Service-Portal-Action: update`, returns `202` + job metadata, `409` if already active |
| `POST /api/projects/<project>/start` / `POST /api/projects/<project>/stop` | Starts an opted-in detached project action; requires the matching `X-Service-Portal-Action: start` or `stop` header; serialized with updates |
| `POST /api/update-checks` | Queues an update check for every opted-in project whose last check started more than a minute ago and that has no active action; requires `X-Service-Portal-Action: check`; returns `202 {ok, queued: [...]}` (`403` without the header, `405` for other methods) |
| `GET /api/maintenance/<job-id>` | Persisted action, state, exit code, error, and bounded runner logs (`no-store`) |
| `GET /api/activity` | JSON: `{generatedAt, events: [...]}` — newest-first feed merging project-job events and container start/stop events, capped at 200 (`no-store`) |
| `/api/appearance` | `GET` → `{settings: {...}}` including the wallpaper slots (`{id, name, wallpapers}` each) and the active-slot pointer; `PUT` → updates the global styling settings (position, opacity, blur, scrim, glass) and the active-slot pointer (sanitized and clamped server-side; the slots themselves can only change through the slot/wallpaper endpoints) (`no-store`) |
| `/api/appearance/slots` | `POST` → append an empty, unnamed slot and make it active · `DELETE` → remove every slot and all its wallpapers (`no-store`) |
| `/api/appearance/slots/<id>` | `PUT` → rename the slot — body `{"name": "..."}`; the name is trimmed, whitespace runs collapse, control/bidi characters are dropped and it is capped at 60 characters; `""` clears it (unnamed slots display as "Slot N"); the active pointer and order are untouched → `{ok, slot, settings}` (404 unknown slot, 400 bad JSON or a non-string `name`) · `DELETE` → remove one slot and every wallpaper in it (404 if unknown) — if it was the active slot, the pointer moves to the previous slot (`no-store`) |
| `POST /api/appearance/slots/<id>/move` | Move the slot one position in the navigation order — body `{"delta": -1 \| 1}`; the active-slot pointer rides along by id (404 unknown slot, 400 bad delta, 422 already at the end it wants to move toward) (`no-store`) |
| `/api/appearance/slots/<id>/wallpapers` | `POST` → upload a wallpaper into that slot (image/* bodies up to 1 GB; optional `x-sp-image-dark: 1` and `x-sp-accent: #rrggbb` headers) and make the slot active; 404 for an unknown slot (`no-store`) |
| `/api/appearance/wallpapers` | Flat view over the slots: `GET` → the slots, the active-slot pointer, plus a derived flat wallpaper list for pre-slot clients · `POST` → (legacy) append a wallpaper to the active slot, creating a slot when there is none · `DELETE` → remove every wallpaper (`no-store`) |
| `/api/appearance/wallpapers/<id>` | One wallpaper: `GET` → stream its original stored bytes (404 if unknown; private cache with ETag revalidation); `GET ?download=1` → the same bytes as an attachment (`Content-Disposition: attachment`) named `<slot name or "Slot N"> NN.<ext>` — NN is its position in the slot, the extension follows its stored type · `PUT` → update its meta (`imageDark`, `accent`, `accentTouched`) · `DELETE` → remove it from its slot — a drained slot is removed too and the active pointer moves to the previous slot (mutations: `no-store`) |
| `/api/appearance/wallpapers/<id>/thumbnail` | `GET` → WebP preview within 640 × 640 pixels, generated on demand and cached on disk; private cache with ETag revalidation; 404 for unknown images, 422 if a preview cannot be decoded |
| `/api/appearance/background` | Legacy single-wallpaper endpoint, kept working: it always addresses the *first wallpaper of the active slot* — `GET` → stream its bytes (404 if none; private cache with ETag revalidation) · `POST` → replace it in place, or create it · `DELETE` → remove it (mutations: `no-store`) |
| `/healthz` | Plain-text `ok` |
| `/favicon.ico` | The deployment's configured favicon (the star by default) — served to both the browser-tab icon and the header logo next to the portal title |
| `/star.svg` | The built-in star icon (`image/svg+xml`); the page no longer references it, kept for compatibility |
| anything else | `404 not found` |

## Quick start (Docker Compose)

From this directory:

```sh
cp .env.example .env                 # first deployment only; then edit .env
docker compose up --build -d
docker compose ps
```

Open **http://localhost:8080/**. The Compose deployment:

- builds the image from the checked-out source;
- publishes the portal on host port `8080` (container port `80`);
- reports container health through `/healthz`;
- restarts automatically unless explicitly stopped; and
- keeps appearance settings and wallpaper data in the named volume
`service-portal_portal-data`.

Runtime-specific settings live in `.env`, which is intentionally ignored by
Git. The available settings are:

| Setting | Default | Purpose |
|---|---|---|
| `PORTAL_TITLE` | `Service Portal` | Browser and page-header title for this deployment |
| `PORTAL_FAVICON_PATH` | `./star.svg` | Host path to this deployment's favicon image |
| `SERVICE_PORT` | `8080` | Host port published by Docker Compose |
| `PORTAL_UPDATE_USER` | `1000:1000` in `.env.example` | Numeric host UID:GID used by the updater when it writes to this checkout; use the output of `id -u` and `id -g` |
| `UPDATE_CHECK_INTERVAL_MINUTES` | `15` | Minutes between [update checks](#update-checks) (1–1440); `0` keeps only the checks on page open and after project actions |

Two more environment variables tune update checks when the portal runs outside Compose or with an
override: `UPDATE_CHECK_MIN_GAP_SECONDS` (default `60`, the throttle for page-triggered checks) and
`UPDATE_CHECK_TIMEOUT_SECONDS` (default `120`, after which a check runner is stopped).

Use the committed `.env.example` as the template for each machine. Changing
any of these settings only requires `docker compose up -d` to recreate the container;
the image does not need to be rebuilt.

To choose another host port, set `SERVICE_PORT` when starting it:

```sh
SERVICE_PORT=9090 docker compose up --build -d
```

Then open `http://localhost:9090/`. On another machine, replace `localhost`
with that machine's hostname or IP address and ensure the selected host port is
allowed through its firewall.

Useful lifecycle commands:

```sh
docker compose logs -f
docker compose restart
docker compose down                 # removes the container, keeps portal data
docker compose down --volumes       # also removes saved appearance data
```

> **Docker socket access:** this application intentionally mounts
> `/var/run/docker.sock` so it can discover, start/stop, and update opted-in projects. That is a
> powerful host-level capability; expose this unauthenticated portal only on a
> network you trust.

## Build manually

Requires Docker Engine and a free host port 80.

```sh
docker build -t service-portal:latest .
```

## Run manually

```sh
docker rm -f service-portal 2>/dev/null
docker run -d --name service-portal \
  --restart unless-stopped \
  -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/service-portal:/data \
  -e PORTAL_TITLE="Service Portal" \
  -e SELF_NAME=service-portal \
  service-portal:latest
```

Then open `http://<machine-ip>/`.

For a copy/paste prompt that guides an AI coding agent through a safe, machine-agnostic Ubuntu
deployment, see [`docs/setup-on-another-ubuntu-server.md`](docs/setup-on-another-ubuntu-server.md).

- `--restart unless-stopped` — survives reboots, honors explicit `docker stop`.
- The socket mount lets the container talk to the Docker Engine. The app issues read-only
  `GET /containers/json?all=1` plus `POST /containers/<id>/start|stop` for the sidebar layout's
  per-row start/stop toggles, but the mount itself is a powerful capability —
  that is the inherent trade-off of live container discovery.
- If port 80 is unavailable, publish a different **host** port but keep the internal port 80:
  `-p <newport>:80` (do not renumber the internal port).
- The `/data` volume holds the shared wallpaper slots and appearance
  settings (`wallpapers/<id>` image files plus `appearance.json`) — the
  Appearance panel is network-wide, not per-browser. It survives container
  recreation; removing the host directory resets the appearance to defaults.
  A pre-slot `background.bin`/`background.json` or a flat pre-slot wallpaper
  array is migrated into slots automatically on first boot (each legacy
  wallpaper becomes its own slot).
- `/data/wallpaper-thumbnails/` is a disposable preview cache. Previews are created
  on first request, including for existing uploads, and reused after a restart.
  Replacing or deleting a wallpaper removes its previews. No re-upload or data
  migration is needed; previews never overwrite the stored wallpaper.
- The `/data` volume also holds `maintenance/<job-id>.json` (update job records),
  `activity.jsonl` (container start/stop and update-available events for the Activity
  panel), and `update-checks.json` (the latest update-check result per project), so
  the activity history and check results survive container recreation too.

## Security note

The portal container sees the host Docker socket. Anyone with control of the container can
control all containers on the host. Run it only on networks you trust; it exposes no
authentication of its own.

## Update and restart integration

Updates are disabled unless a Compose service explicitly opts its project in with labels:

```yaml
labels:
  io.service-portal.update.enabled: "true"
  io.service-portal.update.script: "scripts/update-and-restart.sh"
  io.service-portal.update.image: "my-project-updater:latest"
  io.service-portal.update.user: "1000:1000"
  io.service-portal.update.host-home: "/home/operator" # optional
```

The script must be an executable relative path inside the Compose project working directory.
The runner image must already exist locally and contain everything the project script needs,
normally Git, Docker CLI, and the Compose plugin. The portal derives the absolute project
directory from Docker's `com.docker.compose.project.working_dir` label, mounts that directory
and the Docker socket into a new detached runner, and never accepts a command or path from the
browser. Every container in the same Compose project shares the same job and lock.

Projects whose update also manages files in the deploying user's home can set the optional
`io.service-portal.update.host-home` label to an absolute, non-root POSIX path. The portal
validates the path and exposes it to the runner as `SERVICE_PORTAL_UPDATE_HOST_HOME`. Only the
home's `.config/systemd/user` directory is bound at the same path using Docker's
missing-source-safe mount form; the home itself is not mounted. Invalid paths disable the
project's update action instead of creating or mounting an unintended directory, and a missing
user-unit directory makes runner creation fail closed.

The portal's own Compose service is opted in. Its `update and restart` script refuses dirty,
detached, non-`main`, unexpected-origin, and divergent or rewritten Git states; accepts clean
local commits ahead of `origin/main`; validates Compose; builds while the current portal remains
available; and then recreates the portal with `docker compose up --wait`. A dirty development
checkout therefore produces a safe failed job without interrupting the running portal.

For private repositories, the project-specific runner must provide noninteractive Git
credentials without exposing them to the browser. The portal repository is public, so its
script rewrites its SSH remote to HTTPS for the fetch only.

### Update checks

A project can additionally opt into periodic update checks by adding one more label to the
same service that carries its update labels:

```yaml
labels:
  io.service-portal.update.check: "true"
```

The label is a hard opt-in: a check invokes the project's update script with the single argument
`check`, and a script that ignores its arguments would perform a full update instead. Only add the
label once the script implements the check contract below.

The portal runs the check in the same kind of detached runner as an update — same validated image,
numeric user, checkout mount, Docker socket, and optional user-unit mount — with `Cmd: ["check"]`
and one extra variable, `SERVICE_PORTAL_DEPLOYED_REVISION`. That is the running service's
`org.opencontainers.image.revision` label (a 7–40 character commit hash), or empty when the image
does not record one. Comparing what actually runs with what an update would deploy is what makes a
pushed-but-not-yet-deployed change, or a deployment whose last update failed, show up as pending.
Record the revision at build time, for example with a Compose build label
`org.opencontainers.image.revision: "${SOURCE_REVISION:-}"` set by the update script.

A check must not change the working tree, build or pull images, or start, stop, or recreate
anything. It may fetch upstream refs. It should take the project's update lock without waiting and
fail with an `Error:` line when the lock is held. It reports on stdout; the last summary line wins:

```text
service-portal-check: status=<current|available> behind=<n|unknown> deployed=<sha|unknown> target=<sha|unknown>
service-portal-check-commit: <sha> <ISO-8601 committer date> <subject>   # 0–10 lines, newest first
service-portal-check-note: <text>                                         # optional
```

`current` means an update would change nothing; `available` means it would deploy `target` over
`deployed`, `behind` commits ahead of it. Exit 0 after printing the summary. A nonzero exit, a
missing or malformed summary, or a run longer than the timeout counts as a failed check, with the
first `Error`/`Fatal`/`Failed`/`Refusing` line as its message. Commit subjects and notes are
treated as untrusted display text (control characters stripped, length capped).

In the browser:

- **Current** — the Update control is disabled; its tooltip names the deployed revision and when it
  was checked.
- **Available** — the control is enabled with an accent ring and a badge showing how many commits
  the deployment is behind (`99+` above 99, `!` when the distance is unknown). The tooltip shows the
  distance, how old the newest pending commit is, up to five commit subjects, and the revision
  range. The confirmation names the number of commits that will be deployed.
- **Unknown or failed** (not checked yet, a check in progress, a deployment that changed since the
  last check, or a check that failed) — the control stays enabled, exactly as without checks, and
  the tooltip says why. A check that cannot tell never blocks an update.

The first time a project reports a new available target, the portal appends an "Update available
for …" event to the Activity feed, so the header's unread badge tells you even when you are not
looking at the list. Checks themselves are not maintenance jobs and have no Activity entries or job
records of their own, but they never overlap one: an action waits for a running check of its
project to finish, and no check starts while an action is active. One check runs at a time across
the portal.

Disabling the control only affects the browser. `POST /api/projects/<project>/update` still accepts
an update of a current project, so a project-side wrapper or `curl` can force a redeploy.

The portal's own Compose service opts in. Its `update and restart` script accepts `check`, keeps
its lock, branch, origin, clean-tree, and fast-forward rules, and records the deployed commit in the
image through `SERVICE_PORTAL_SOURCE_REVISION`.

### Project start and stop

A project with a valid update capability can opt into project-wide lifecycle actions by adding
`io.service-portal.lifecycle.services: "reports,runner"` to one visible Compose service. List
the Compose service names that its script starts and stops, including hidden members. That
service becomes the project's visible entry; other listed members are represented in its
`lifecycle.members` state instead of separate portal rows. The portal reports `running` when
all members run and pass any health checks, `stopped` when all members are present and none
run, and `partial` otherwise.
Partial projects offer both Start and Stop. Other projects retain their per-container controls.

The same update script receives `start` or `stop` as its first argument in a detached runner;
an update receives no argument. The portal uses the validated updater image, user, checkout,
Docker socket, and optional user-unit mount. It also passes
`SERVICE_PORTAL_ACTION_REQUESTED_AT` as a UTC ISO 8601 timestamp captured when the action
request arrives, so a script can account for work that finishes while the runner launches.
Update, Start, and Stop share a project job lock, status endpoint, logs, and activity history.
The project script owns service ordering, health checks, and application-specific cleanup.

For a copy/paste prompt and complete integration checklist for other repositories, see
[`docs/update-and-restart-integration-runbook.md`](docs/update-and-restart-integration-runbook.md).

## Tests

The project uses Node's built-in test runner and has no test-framework dependency:

```sh
npm ci
npm test
```

The suite covers appearance behavior, container start/stop forwarding, project lifecycle
discovery and controls, stopped-container discovery,
update capability and path validation, runner construction, duplicate-job prevention,
success/failure monitoring, log capture and persistence, the activity feed (container
events, persisted update-job events, ordering, log lookup, method guard), sidebar
confirmation/polling, the update script's fail-closed command ordering, and update checks
(runner construction, result parsing and sanitizing, timeouts, throttling, scheduling,
persistence, leftover-runner cleanup, mutual exclusion with actions, the Activity
announcement, the script's `check` mode, and the control's disabled/badged states).

## Customization

- **Friendly names/descriptions**: edit `labels.json` — one entry per exact container name:
  ```json
  { "<container-name>": { "label": "Display name", "description": "One-line description" } }
  ```
  Containers without an entry fall back to their raw Docker name. Rebuild + redeploy after
  editing.
- **Runtime label override (no rebuild)**: pass `-e SERVICE_LABELS='{"name": {"label": "...",
  "description": "..."}}'` (JSON string) to `docker run`; it takes precedence over
  the entire `labels.json` mapping. Recreate the portal to apply it.
- **Hide internal services**: a published port does not establish that a container is a
  browser application. Exclude an internal backend from both portal layouts and
  `/api/services` with an exact-name entry in `labels.json`:
  ```json
  { "my-internal-api": { "hidden": true } }
  ```
  Rebuild and redeploy only the portal; the backend needs no restart. The supplied mapping
  hides `qwen38-daytime` and `qwen38-nighttime`, whose inference endpoints serve the router.
  This field also works in `SERVICE_LABELS`; include any existing entries when overriding
  the mapping. Alternatively, the backend's Compose configuration can declare:
  ```yaml
  labels:
    io.service-portal.hidden: "true"
  ```
  Apply that label through the backend's normal deployment process; Docker labels are
  read on each discovery request. Either JSON boolean `hidden: true` or Docker label
  `io.service-portal.hidden: "true"` hides the service, even if the other setting is false.
  Missing or false settings keep normal discovery. This applies to running and stopped
  containers regardless of ports. The browser's "Hide services without links" checkbox
  cannot reveal explicitly hidden services.

  Hiding is a listing preference, not access control: it does not alter ports, networks,
  inference traffic, Docker management, activity history, or project update capabilities.
- **Wallpapers & appearance**: the gear button opens the Appearance panel — upload
  background images and tune wallpaper opacity, wallpaper blur, scrim, list-background
  opacity (for both table and sidebar layouts), and glass blur. Wallpapers live in
  **slots** on the server in the `/data` volume, shared by every machine on the
  network. A slot can hold several wallpapers, and each browser rolls its *own* random
  wallpaper from the active slot — re-rolled on every refresh and on every slot switch —
  while the slot membership itself stays shared. The panel has two columns. The
  left one holds the controls, grouped by scope, top to bottom: **Position** (how the wallpaper on screen is framed — a 3×3
  anchor grid plus Horizontal / Vertical sliders, remembered per wallpaper in this
  browser only; **Apply to all in slot** copies the current position to every
  wallpaper in the active slot, **Reset slot** returns them all to center, and both
  ask first when they would overwrite another wallpaper's own position), **This wallpaper** (remove the wallpaper on screen, reset
  its derived colors), **Slots**
  (a **Name** field, Add / Remove, Move up / Move down, and the prev/next "N of M"
  stepper beneath them), and **Effects** (the sliders above). The right one is the
  **Wallpapers in this slot** gallery: a count and one large tile per wallpaper of
  the active slot — click a tile to show it, **×** removes it, and the download
  button saves its original stored image (not the preview), named after its slot
  (e.g. `Nature 07.jpg`, or `Slot 1 07.jpg` when unnamed). The two columns scroll
  independently, so a full slot never pushes the controls out of reach; on narrow
  windows the panel falls back to one column with the gallery last. **Name** gives the
  active slot a name, shared by every machine — it saves when you press Enter or
  leave the field, Esc reverts, and an empty name falls back to "Slot N" (its
  position). **Add** appends an empty
  slot and jumps to it; **Remove** deletes the active slot with all its
  wallpapers (and a slot whose last wallpaper is removed is removed too, with the
  pointer moving to the previous slot). **Move up** / **Move down** move the
  active slot one position in the navigation order — its wallpapers, and each
  browser's current pick, travel with it (moving, unlike prev/next, does not
  switch to a different slot). Prev/next move between slots — previous is
  disabled on the first, next on the last (both stay visible, dimmed like the
  move buttons), with an "N of M" counter. In the header, the **slot menu**
  button names the active slot; open it to see every slot (a thumbnail, its name
  and wallpaper count, the active one checked) and pick any of them to jump
  straight there with a fresh random wallpaper — no stepping through the slots in
  between. It works from the keyboard too (↑/↓, Home/End, Enter, Esc), and its
  last entry, **Name & manage slots…**, opens this panel on the Name field. The
  shuffle button next to it picks a different random
  wallpaper from the current slot, without switching slots; it dims when the
  slot has fewer than two wallpapers. An upload appends its wallpapers to the
  active slot, multi-file selections in order. A **.zip** picked or dropped there is
  unpacked in the browser (the server never sees the archive): each supported image
  inside it (jpeg/png/webp/gif/avif; folders walked in natural path order, hidden
  files, `__MACOSX` metadata and nested archives skipped) becomes its own wallpaper
  with its own sampled colors. Archives are capped at 1 GB; Zip64 and encrypted
  entries are not supported. A file that fails does not stop the rest of the batch —
  the status line lists what failed. **Remove wallpaper** deletes the
  currently displayed wallpaper. Both this button and the thumbnail × ask for
  confirmation; cancelling keeps the wallpaper. The confirmation also notes when
  removing the last wallpaper will remove its slot. The active slot is persisted server-side, so the
  portal always comes back to the slot you left on (showing a fresh roll of it);
  **Reset appearance**, alone at the bottom of the panel, deletes every slot and
  restores the default settings. Browsers that still
  hold a wallpaper from the old browser-only storage get it migrated to the server
  automatically on first load, then their local copies are cleared.
- **Wallpaper performance**: the panel loads small previews only when opened,
  with offscreen thumbnails loaded lazily — the larger gallery tiles still use the
  same 640 px previews, never the originals. Preview images preserve transparency
  and orientation; animated wallpapers use a still first frame in the panel.
  A failed preview shows a placeholder and remains selectable. The background
  uses the original stored image, with the existing upload resizing rules
  unchanged — so a download returns that stored file, which for an image whose
  longest edge exceeded 4096 px is the copy resized at upload. Slider drags update effects once per frame without rebuilding
  thumbnails, and saves are debounced with a final save when the control is released.
- **Auto color scheme**: when a wallpaper is uploaded, the browser samples its dominant
  hue (32×32 grid, 12 hue buckets, saturation-weighted; the accent is re-normalized to a
  fixed lightness/saturation so it always reads as an accent) and derives a coordinated
  dark palette around it — background, panels, inputs, borders, header, table head, hover
  rows and pills all take on the wallpaper's hue. The sampled accent is stored per
  wallpaper, so each wallpaper keeps its own theme (and its own deliberate "reset
  colors") and switching wallpaper switches the palette. Hueless (gray) images leave
  the stock palette in place; deleting the last wallpaper restores it. Text and the
  status colors (ok/warn/bad) never change.
- **Rename the portal**: set `PORTAL_TITLE` in `.env` when using Compose, or pass
  `-e PORTAL_TITLE="My System Services"` to `docker run`. No rebuild is needed.
- **Change the favicon**: the configured icon drives both the browser-tab favicon and
  the header logo next to the portal title. Set `PORTAL_FAVICON_PATH` in `.env` to an
  SVG, PNG, ICO, GIF, JPEG, WebP, or AVIF file on the Docker host. Relative paths are
  resolved from the directory containing `compose.yaml`; run `docker compose up -d`
  after changing it. If you replace the image at the same path, run
  `docker compose restart portal` so the server reloads it (the new icon then appears
  on the next page load, no rebuild needed).
  For `docker run`, mount the file read-only and pass its container path as
  `PORTAL_FAVICON_FILE`, for example with
  `-v /host/prod.svg:/branding/favicon:ro` and
  `-e PORTAL_FAVICON_FILE=/branding/favicon`.
- **Browser address / HTTPS behind a proxy**: set `url` in the service's `labels.json`
  entry (or `SERVICE_LABELS` override), for example:
  ```json
  { "my-app": { "label": "My App", "url": "https://image-studio.lan:8443/" } }
  ```
  Or declare it in the application's Compose service:
  ```yaml
  labels:
    io.service-portal.url: "https://image-studio.lan:8443/"
  ```
  The Docker label takes precedence over the JSON default, so a deployment's
  hostname or port changes travel with the application. Only absolute HTTP(S)
  URLs without embedded credentials are accepted; invalid values are ignored.
  Both layouts open this address by default, including apps without published ports.
  The table also shows an explicit **Open HTTPS** button; numbered port buttons
  still open their individual endpoints for tooling. Without an explicit address,
  the portal prefers a published HTTPS port (443, 3443, 8443, or 9443 on either side
  of the mapping), then the first published port.

  The supplied ComfyUI Frontend entries use `https://image-studio.lan:8443/` and
  hide its separate TLS proxy entry. On each client, resolve `image-studio.lan` to
  the appliance and trust the appliance's local root CA. A portal link does not
  configure DNS or certificate trust. Rebuild and redeploy the portal to apply
  JSON changes; recreate the application to apply Docker labels.

## Operations

```sh
docker logs -f service-portal     # logs
docker restart service-portal     # restart
docker rm -f service-portal       # remove container (image stays)

# after editing files (from this directory):
docker build -t service-portal:latest .
docker rm -f service-portal && docker run -d --name service-portal \
  --restart unless-stopped -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/service-portal:/data \
  -e PORTAL_TITLE="Service Portal" \
  -e SELF_NAME=service-portal service-portal:latest
```

## Verify after deploy

```sh
docker ps --filter name=service-portal --format '{{.Names}} {{.Status}} {{.Ports}}'
curl -s http://127.0.0.1/healthz                      # → ok
curl -s http://127.0.0.1/api/services | head -c 400   # → JSON with services[]
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1/
# → 200 text/html; charset=utf-8
docker logs service-portal                            # → "service-portal listening on :80"
```

## Project layout

```
service-portal/
├── package.json
├── package-lock.json
├── Dockerfile
├── server.js
├── wallpaper-images.js
├── index.html
├── labels.json
├── update and restart
├── docs/
├── test/
└── star.svg
```

MIT licensed.
