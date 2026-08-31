# Rosalina System Services — service-portal

A zero-dependency Docker container that acts as a **gateway/portal to every container running
on the host**. Open the portal in a browser (plain port 80) to see a live table of all running
containers; click a service row or one of its port chips to open that service in a new browser
tab via its published port.

New containers appear automatically — the portal re-queries Docker on every request. No
reconfiguration, no restart.

## How it works

- One Node.js HTTP server on `node:20-alpine`. No package.json, no npm, no node_modules.
- The container mounts the **host Docker socket** read-write and calls the Docker Engine REST
  API (`GET /containers/json`) over the Unix socket on every `/api/services` request,
  so the UI is always a live view of the host.
- Single-page UI (vanilla HTML/CSS/JS, dark theme): sortable table (Service / Image / Ports /
  Status), status dots from Docker state + health, clickable port chips (https is auto-used
  for host ports 443/8443/3443/9443), a "Hide services without links" filter persisted in
  localStorage, a Table/Sidebar layout switch also persisted in localStorage (the Sidebar
  layout is a narrow single-column list on the left third of the screen — status dot, name
  link, and a per-row start/stop toggle — leaving the rest of the viewport for the
  wallpaper), and 20-second auto-refresh.

## Routes

| Path | Response |
|---|---|
| `/`, `/index.html` | The portal UI (`text/html`, `Cache-Control: no-store`) |
| `/api/services` | JSON: `{generatedAt, services: [...]}` — one entry per running container with `name, label, description, id, image, state, health, statusLine, ports[], self` (`no-store`) |
| `POST /api/services/<id>/start` / `POST /api/services/<id>/stop` | Docker start/stop for that container: `200` `{ok, action}` on success, `502` + `error` when Docker refuses (`no-store`) |
| `/api/appearance` | `GET` → `{settings: {...}}`; `PUT` → replaces the styling settings (opacity, blur, scrim, glass, dark flag, sampled accent; sanitized and clamped server-side) (`no-store`) |
| `/api/appearance/background` | The shared wallpaper: `GET` → stored image bytes (404 if none) · `POST` → replace it (image/* bodies up to 200 MB) · `DELETE` → remove it (`no-store`) |
| `/healthz` | Plain-text `ok` |
| `/favicon.ico`, `/star.svg` | The star icon (`image/svg+xml`) |
| anything else | `404 not found` |

## Build

Requires Docker Engine and a free host port 80.

```sh
docker build -t service-portal:latest .
```

## Run

```sh
docker rm -f service-portal 2>/dev/null
docker run -d --name service-portal \
  --restart unless-stopped \
  -p 80:80 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/service-portal:/data \
  -e SELF_NAME=service-portal \
  service-portal:latest
```

Then open `http://<machine-ip>/`.

- `--restart unless-stopped` — survives reboots, honors explicit `docker stop`.
- The socket mount lets the container talk to the Docker Engine. The app issues read-only
  `GET /containers/json` plus `POST /containers/<id>/start|stop` for the sidebar layout's
  per-row start/stop toggles, but the mount itself is a powerful capability —
  that is the inherent trade-off of live container discovery.
- If port 80 is unavailable, publish a different **host** port but keep the internal port 80:
  `-p <newport>:80` (do not renumber the internal port).
- The `/data` volume holds the shared wallpaper and appearance settings
  (`background.bin`, `background.json`, `appearance.json`) — the Appearance
  panel is network-wide, not per-browser. It survives container recreation;
  removing the host directory resets the appearance to defaults.

## Security note

The portal container sees the host Docker socket. Anyone with control of the container can
control all containers on the host. Run it only on networks you trust; it exposes no
authentication of its own.

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
- **Wallpaper & appearance**: the gear button opens the Appearance panel — upload a
  background image and tune opacity, wallpaper blur, scrim, and glass blur. The wallpaper
  and settings are stored on the server in the `/data` volume, so every machine on the
  network sees the same appearance. Browsers that still hold a wallpaper from the old
  browser-only storage get it migrated to the server automatically on first load, then
  their local copies are cleared.
- **Auto color scheme**: when a background is uploaded, the browser samples its dominant
  hue (32×32 grid, 12 hue buckets, saturation-weighted; the accent is re-normalized to a
  fixed lightness/saturation so it always reads as an accent) and derives a coordinated
  dark palette around it — background, panels, inputs, borders, header, table head, hover
  rows and pills all take on the wallpaper's hue. The sampled accent is stored in the
  shared settings (field `accent`), so every client on the network gets the same theme.
  Hueless (gray) images leave the stock palette in place; removing or resetting the
  background restores the stock palette. Text and the status colors (ok/warn/bad) never
  change.
- **Rename the portal**: change "Rosalina System Services" in the two places in
  `index.html` (the `<title>` tag and the header `<div class="title" id="title">`), rebuild.
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
├── Dockerfile
├── server.js
├── index.html
├── labels.json
└── star.svg
```

MIT licensed.
