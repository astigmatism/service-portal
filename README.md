# Service Portal

A zero-dependency Docker container that acts as a **gateway/portal to every container
on the host**. Open the portal in a browser (plain port 80) to see a live table of all
containers; click a service row or one of its port chips to open that service in a new browser
tab via its published port.

New containers appear automatically — the portal re-queries Docker on every request. No
reconfiguration, no restart.

## How it works

- One Node.js HTTP server on `node:20-alpine`. There are no runtime npm dependencies.
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
- Project updates run in detached maintenance containers, so an updater survives replacing
  the target container or the portal itself. Job status and bounded logs persist in `/data`.
- An **Activity** panel (header toggle, next to Appearance) keeps a durable, newest-first feed of
  portal actions: update jobs (from the persisted maintenance records, with full runner logs
  expandable per event) and container start/stop actions (appended to `/data/activity.jsonl`,
  rotated past 256 KB). The toggle shows an unread badge for events newer than the last time that
  browser viewed the panel (localStorage), so nothing is silently missed. Toasts remain as
  ephemeral pings: they stack bottom-left, failures stay until dismissed, everything else fades
  after 6 s — a faded toast loses nothing because the panel holds the record.

## Routes

| Path | Response |
|---|---|
| `/`, `/index.html` | The portal UI (`text/html`, `Cache-Control: no-store`) |
| `/api/services` | JSON: `{generatedAt, services: [...]}` — one entry per container with `name, label, description, id, image, state, health, statusLine, ports[], self, project, update` (`no-store`) |
| `POST /api/services/<id>/start` / `POST /api/services/<id>/stop` | Docker start/stop for that container: `200` `{ok, action}` on success, `502` + `error` when Docker refuses (`no-store`) |
| `POST /api/projects/<project>/update` | Starts an opted-in detached update/restart job; requires `X-Service-Portal-Action: update`, returns `202` + job metadata, `409` if already active |
| `GET /api/maintenance/<job-id>` | Persisted update state, exit code, error, and bounded runner logs (`no-store`) |
| `GET /api/activity` | JSON: `{generatedAt, events: [...]}` — newest-first feed merging update-job events and container start/stop events, capped at 200 (`no-store`) |
| `/api/appearance` | `GET` → `{settings: {...}}` including the wallpaper slots and the active-slot pointer; `PUT` → updates the global styling settings (position, opacity, blur, scrim, glass) and the active-slot pointer (sanitized and clamped server-side; the slots themselves can only change through the slot/wallpaper endpoints) (`no-store`) |
| `/api/appearance/slots` | `POST` → append an empty slot and make it active · `DELETE` → remove every slot and all its wallpapers (`no-store`) |
| `/api/appearance/slots/<id>` | `DELETE` → remove one slot and every wallpaper in it (404 if unknown) — if it was the active slot, the pointer moves to the previous slot (`no-store`) |
| `POST /api/appearance/slots/<id>/move` | Move the slot one position in the navigation order — body `{"delta": -1 \| 1}`; the active-slot pointer rides along by id (404 unknown slot, 400 bad delta, 422 already at the end it wants to move toward) (`no-store`) |
| `/api/appearance/slots/<id>/wallpapers` | `POST` → upload a wallpaper into that slot (image/* bodies up to 200 MB; optional `x-sp-image-dark: 1` and `x-sp-accent: #rrggbb` headers) and make the slot active; 404 for an unknown slot (`no-store`) |
| `/api/appearance/wallpapers` | Flat view over the slots: `GET` → the slots, the active-slot pointer, plus a derived flat wallpaper list for pre-slot clients · `POST` → (legacy) append a wallpaper to the active slot, creating a slot when there is none · `DELETE` → remove every wallpaper (`no-store`) |
| `/api/appearance/wallpapers/<id>` | One wallpaper: `GET` → its bytes (404 if unknown) · `PUT` → update its meta (`imageDark`, `accent`, `accentTouched`) · `DELETE` → remove it from its slot — a drained slot is removed too and the active pointer moves to the previous slot (`no-store`) |
| `/api/appearance/background` | Legacy single-wallpaper endpoint, kept working: it always addresses the *first wallpaper of the active slot* — `GET` → its bytes (404 if none) · `POST` → replace it in place, or create it · `DELETE` → remove it (`no-store`) |
| `/healthz` | Plain-text `ok` |
| `/favicon.ico` | The deployment's configured favicon (the star by default) |
| `/star.svg` | The built-in star icon (`image/svg+xml`) |
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
- The `/data` volume also holds `maintenance/<job-id>.json` (update job records)
  and `activity.jsonl` (container start/stop events for the Activity panel), so
  the activity history survives container recreation too.

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

For a copy/paste prompt and complete integration checklist for other repositories, see
[`docs/update-and-restart-integration-runbook.md`](docs/update-and-restart-integration-runbook.md).

## Tests

The project uses Node's built-in test runner and has no test-framework dependency:

```sh
npm test
```

The suite covers appearance behavior, start/stop forwarding, stopped-container discovery,
update capability and path validation, runner construction, duplicate-job prevention,
success/failure monitoring, log capture and persistence, the activity feed (container
events, persisted update-job events, ordering, log lookup, method guard), sidebar
confirmation/polling, and the update script's fail-closed command ordering.

## Customization

- **Friendly names/descriptions**: edit `labels.json` — one entry per exact container name:
  ```json
  { "<container-name>": { "label": "Display name", "description": "One-line description" } }
  ```
  Containers without an entry fall back to their raw Docker name. Rebuild + redeploy after
  editing.
- **Runtime label override (no rebuild)**: pass `-e SERVICE_LABELS='{"name": {"label": "...",
  "description": "..."}}'` (JSON string) to `docker run`; it takes precedence over
  `labels.json`.
- **Wallpapers & appearance**: the gear button opens the Appearance panel — upload
  background images and tune wallpaper opacity, wallpaper blur, scrim, list-background
  opacity (for both table and sidebar layouts), and glass blur. Wallpapers live in
  **slots** on the server in the `/data` volume, shared by every machine on the
  network. A slot can hold several wallpapers, and each browser rolls its *own* random
  wallpaper from the active slot — re-rolled on every refresh and on every slot switch —
  while the slot membership itself stays shared. The panel groups its controls by
  scope, top to bottom: **This wallpaper** (remove the wallpaper on screen, reset
  its derived colors), **Wallpapers in this slot** (the thumbnail strip), **Slots**
  (Add / Remove, Move up / Move down, and the prev/next "N of M" stepper
  beneath them), and **Effects** (the sliders above). **Add** appends an empty
  slot and jumps to it; **Remove** deletes the active slot with all its
  wallpapers (and a slot whose last wallpaper is removed is removed too, with the
  pointer moving to the previous slot). **Move up** / **Move down** move the
  active slot one position in the navigation order — its wallpapers, and each
  browser's current pick, travel with it (moving, unlike prev/next, does not
  switch to a different slot). Prev/next (and the
  header arrows) move between slots — previous is disabled on the first, next on
  the last (both stay visible, dimmed like the move buttons), with an "N of M"
  counter — and an upload appends its wallpapers to the
  active slot, multi-file selections in order. **Remove wallpaper** deletes the
  currently displayed wallpaper. The active slot is persisted server-side, so the
  portal always comes back to the slot you left on (showing a fresh roll of it);
  **Reset appearance**, alone at the bottom of the panel, deletes every slot and
  restores the default settings. Browsers that still
  hold a wallpaper from the old browser-only storage get it migrated to the server
  automatically on first load, then their local copies are cleared.
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
- **Change the favicon**: set `PORTAL_FAVICON_PATH` in `.env` to an SVG, PNG, ICO,
  GIF, JPEG, WebP, or AVIF file on the Docker host. Relative paths are resolved from
  the directory containing `compose.yaml`; run `docker compose up -d` after changing it.
  If you replace the image at the same path, run `docker compose restart portal` so the
  server reloads it.
  For `docker run`, mount the file read-only and pass its container path as
  `PORTAL_FAVICON_FILE`, for example with
  `-v /host/prod.svg:/branding/favicon:ro` and
  `-e PORTAL_FAVICON_FILE=/branding/favicon`.
- **Non-standard HTTPS ports**: edit the `schemeFor()` function in `index.html` to add host
  ports that should produce `https:` links.

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
├── Dockerfile
├── server.js
├── index.html
├── labels.json
├── update and restart
├── docs/
├── test/
└── star.svg
```

MIT licensed.
