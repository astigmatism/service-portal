# Set up Service Portal on another Ubuntu server

This is a copy/paste prompt for the AI coding agent responsible for the target server. It
deliberately leaves checkout location, host port, host identity, firewall tooling, and network
address to that agent because those details are machine-specific.

## Copy/paste prompt

```text
Set up and verify the Service Portal container on this Ubuntu server from the public repository
https://github.com/astigmatism/service-portal.git.

Own the deployment from discovery through verification. Inspect the server before changing it,
reuse a healthy existing Docker installation, and follow the server's established administration,
ownership, checkout-location, firewall, and service-management conventions. Do not assume or
prescribe a fixed filesystem location for the checkout, Docker data, or user home. Do not delete,
overwrite, or repurpose an existing checkout, container, port assignment, firewall rule, or volume
without explicit approval.

The expected deployment boundary is:

- a supported Ubuntu release and CPU architecture;
- Git plus a current Docker Engine and Docker Compose v2 plugin;
- a Docker daemon compatible with the socket mount in the committed Compose configuration;
- permission for the deployment operator to build images and manage containers; and
- a trusted home-network client path to one available TCP port on the server.

This portal has no authentication and intentionally receives powerful access to the host Docker
Engine so it can discover, start, stop, and update containers. It must not be exposed to the public
Internet or an untrusted network.

Perform the following work:

1. Discover and record the Ubuntu release, CPU architecture, active Docker context/daemon, Docker
   Engine version, Compose version, current operator, checkout ownership policy, active containers,
   occupied listening ports, firewall policy, and the server's LAN-reachable hostname or address.
   Check specifically for an existing container or Compose project named service-portal and for an
   existing checkout of this repository. Treat anything pre-existing as user data.

2. Confirm that Docker Engine is running and that `docker compose` supports `up --wait` and
   `--wait-timeout`. If Git, Docker Engine, or the Compose v2 plugin is missing or obsolete, install
   it using the current official instructions appropriate to the detected Ubuntu release and CPU
   architecture. Do not replace a working installation merely to standardize it. If the active
   engine is rootless or uses a nonstandard endpoint that is incompatible with the committed socket
   mount, stop and report the mismatch instead of silently editing tracked project files.

3. Choose a checkout location according to this server's existing conventions. If no checkout
   exists, clone the repository there over HTTPS and enter it. If one does exist, verify that it is
   the expected repository and preserve it. The deployable checkout must be on branch `main`, track
   `origin/main`, be fast-forwarded to the current remote commit, and have no tracked or untracked
   changes. Never reset, stash, discard, or overwrite local work to make it clean. Confirm that the
   committed `update and restart` file is executable.

4. Create `.env` from `.env.example`; `.env` is intentionally ignored by Git. Set:

   - `PORTAL_TITLE` to a clear title identifying this server;
   - `PORTAL_FAVICON_PATH` to an image identifying this server, or leave the default star;
   - `SERVICE_PORT` to an unused TCP port appropriate for this host, retaining 8080 if it is free;
     and
   - `PORTAL_UPDATE_USER` to the numeric UID:GID that owns the checkout, determined from the actual
     checkout rather than assumed from another machine.

   Keep the container's internal port unchanged. Do not add secrets to `.env` or commit it.

5. From the repository root, validate before deployment:

   - `git status --short --branch`
   - `git remote get-url origin`
   - `sh -n './update and restart'`
   - `docker compose config --quiet`
   - run the Node test suite in an ephemeral Node 20 container with the checkout mounted as its
     working directory, so no host Node installation is required
   - `docker compose build --pull`

   Stop on any failure and diagnose it. Do not work around a failing check by removing data or
   weakening the project configuration.

6. Deploy with:

   `docker compose up -d --wait --wait-timeout 120`

   Do not run `docker compose down --volumes`, and do not run any global Docker prune command. The
   Compose named volume stores shared appearance settings, wallpaper data, and maintenance job
   state and must survive container recreation.

7. Verify all of the following:

   - `docker compose ps` reports the portal running and healthy;
   - the published host port is the one selected in `.env`;
   - an HTTP request to `/healthz` through the loopback interface returns exactly `ok`;
   - `/` returns HTTP 200 with an HTML content type;
   - `/api/services` returns JSON with a `services` array and can see the host's containers;
   - container logs show no startup or Docker-socket errors;
   - the checkout remains clean after deployment; and
   - the portal is reachable through the server's LAN hostname or address from the intended trusted
     network, subject to the host's firewall policy.

   If a firewall change is required, follow the host's existing firewall tooling and restrict
   access to the trusted home-network scope. Do not create public exposure, port forwarding, a
   tunnel, or a broad allow rule.

8. Do not press the portal's Update and restart control as part of setup. Confirm only that the
   running portal exposes the capability for its Compose project. A future use of that control
   requires the checkout to remain clean on `main`, tracking the expected origin; it fetches only a
   fast-forward, rebuilds while the current portal remains available, and recreates the service with
   a bounded health wait.

9. Finish with a concise report containing:

   - Ubuntu release and architecture;
   - Docker Engine and Compose versions;
   - deployed Git commit;
   - the chosen portal title and host port (but no secrets);
   - container and health-check status;
   - the LAN URL for the trusted network;
   - whether firewall configuration changed;
   - confirmation that persistent data uses the Compose named volume;
   - confirmation that the checkout is clean and the self-update capability is visible; and
   - any unresolved compatibility or security concern.

If any step needs a destructive action, a change to tracked project files, replacement of an
existing deployment, or a security-policy decision, pause and ask for approval with the exact
finding and proposed change.
```
