# Service Portal update and restart integration runbook

This document is the integration contract for making a Docker Compose project display an
**Update and restart** control in Service Portal. It is also written as a prompt that can be
given directly to an AI coding agent working in another repository.

The portal deliberately does not search repositories for scripts. A project opts in through
trusted Docker Compose labels, and those labels tell the portal which repository-relative
script and existing local runner image to use. This avoids executing a file merely because it
has a familiar name.

## Copy/paste prompt for another repository

```text
Integrate this Docker Compose repository with Service Portal's opt-in Update and restart
control. Inspect the repository, its Compose configuration, existing deployment/update
scripts, image definitions, and tests before making changes. Reuse and harden a suitable
existing update script when one is present; otherwise create one at
scripts/update-and-restart.sh. Keep the solution noninteractive and safe for unattended use.

Service Portal discovers the capability from labels on a running Compose service. Add the
following labels to exactly one suitable long-lived service in this Compose project, replacing
the example image and user variables with values that are valid for this repository:

labels:
  io.service-portal.update.enabled: "true"
  io.service-portal.update.script: "scripts/update-and-restart.sh"
  io.service-portal.update.image: "${PROJECT_RUNNER_IMAGE:-your-local-runner-image:latest}"
  io.service-portal.update.user: "${HOST_UID:-1000}:${HOST_GID:-1000}"

Requirements for the labels:

- The script value is a relative path beneath the Compose project working directory. Do not
  use an absolute path, backslashes, or a path that escapes the repository.
- The script must exist in source control, have an appropriate shebang, and be executable.
- The image must already exist on the Docker host when the button is pressed. It must contain
  the script's required tools, normally a POSIX shell, Git, Docker CLI, and the Docker Compose
  plugin. Do not assume Service Portal will pull or build this runner image first.
- The user must be a numeric UID:GID pair and should match the owner of the host checkout so
  Git operations do not create root-owned files. Document the environment variables in the
  repository's example environment file.
- Prefer labeling only one service. If more than one service in the project opts in, all four
  effective settings must be identical or Service Portal will suppress the capability as a
  configuration conflict.

When a user confirms the control, Service Portal creates a detached maintenance container. It
uses the configured image and numeric user, mounts the Compose project working directory at the
same absolute path, sets that directory as the working directory, mounts the Docker socket,
adds the socket's numeric GID as a supplementary group, and executes the configured script as
the container entrypoint. It supplies these environment variables:

  HOME=/tmp
  SERVICE_PORTAL_UPDATE_DELEGATED=1
  SERVICE_PORTAL_UPDATE_JOB_ID=<job UUID>
  DSH_UPDATE_DELEGATED=1
  DSH_UPDATE_CONTAINER_NAME=<maintenance container name>

The two DSH variables are compatibility inputs for repositories that already support the DSH
maintenance-runner convention. Do not require secrets from Service Portal. If this is a private
repository, arrange noninteractive, least-privilege Git credentials inside the project-specific
runner without exposing them to the browser or committing them to source.

The update script must fail closed and log useful progress and errors. Implement or verify all
of the following behavior:

1. Resolve and enter the repository root from the script's own location.
2. Acquire an atomic per-checkout lock and always clean it up on exit.
3. Verify required tools, repository files, Docker access, and Compose availability before
   making changes.
4. Verify the expected branch, upstream, and remote. Reject a detached HEAD or an unexpected
   source repository.
5. Refuse a dirty working tree. Never reset, stash, discard, or overwrite local work.
6. Fetch the expected upstream branch and allow fast-forward updates only. Reject divergent or
   rewritten history.
7. Validate the updated Compose configuration before disrupting any running service.
8. Pull required external images and/or build replacement images while the current application
   remains available whenever the repository's architecture permits it.
9. Reconcile the complete Compose application, including required profiles or overlay files;
   do not update only one container if that would leave the project inconsistent.
10. Use `docker compose up -d --wait` with a bounded wait timeout to recreate and health-check
    the application. Avoid `docker compose down`, because it creates unnecessary downtime and
    may disrupt project networks or dependencies.
11. Preserve named volumes, bind-mounted configuration, and user data. Do not run global image,
    container, network, or volume prune commands.
12. Return exit code 0 only after the updated application is healthy. On failure, return a
    nonzero exit code and print a concise line containing a term such as Error, Fatal, Failed,
    or Refusing so Service Portal can surface the cause.

Account for this repository's actual topology. If it uses multiple Compose files, profiles,
generated configuration, helper containers, or a pre-existing delegated update mode, preserve
those mechanics and make the portal entrypoint select the correct path without recursively
launching another updater. Treat SERVICE_PORTAL_UPDATE_DELEGATED=1 as confirmation that the
script is already running in the detached maintenance container.

Add automated tests for the integration. At minimum, use fake Git and Docker commands or an
equivalent isolated harness to prove that the script:

- rejects a dirty checkout before fetch, build, pull, stop, or recreate operations;
- rejects the wrong branch, upstream, remote, and non-fast-forward history;
- validates and prepares the replacement before recreation;
- uses the expected Compose files/profiles and bounded health wait;
- propagates failures with a nonzero exit code; and
- preserves command ordering without changing real containers during the unit tests.

Also run the repository's existing test suite, a shell syntax check, `docker compose config`,
and a check that the selected runner image contains every required executable. Do not perform a
real update/restart smoke test unless explicitly authorized, since it changes running services.

Finish by reporting:

- the service and Compose file where the labels were added;
- the exact effective script path, runner image, and numeric UID:GID;
- the safety checks and deployment sequence in the script;
- the tests and validation commands run, with results; and
- any operator setup still required, especially environment variables or private-repository
  credentials.
```

## Portal-side acceptance checklist

The control will appear only when all of these conditions are true:

- The container belongs to a Docker Compose project with valid standard labels for
  `com.docker.compose.project` and an absolute
  `com.docker.compose.project.working_dir` other than `/`.
- `io.service-portal.update.enabled` is exactly the string `true`.
- `io.service-portal.update.script` is a valid repository-relative path.
- `io.service-portal.update.image`, when supplied, is a valid Docker image reference. If it is
  omitted, the opted-in service's own image is used.
- `io.service-portal.update.user`, when supplied, is an explicit numeric `UID:GID`. If omitted,
  the service's numeric configured user is used when possible, otherwise the runner falls back
  to `0:0`.
- Every opted-in container in the same Compose project has identical effective project
  directory, script, image, and user settings.

The button is project-scoped even though it is rendered beside service rows. Service Portal
allows only one active maintenance job per Compose project, hides its own maintenance helper
containers from the service list, captures bounded logs, persists job status, and removes the
helper after completion. A successful script exit marks the job successful; any nonzero exit
marks it failed and exposes its most useful error line in the portal.

## Example Compose fragment

```yaml
services:
  app:
    image: "${PROJECT_RUNNER_IMAGE:-local/example-app:latest}"
    user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
    labels:
      io.service-portal.update.enabled: "true"
      io.service-portal.update.script: "scripts/update-and-restart.sh"
      io.service-portal.update.image: "${PROJECT_RUNNER_IMAGE:-local/example-app:latest}"
      io.service-portal.update.user: "${HOST_UID:-1000}:${HOST_GID:-1000}"
```

Example environment documentation:

```dotenv
# Numeric owner of this host checkout. Obtain with: id -u; id -g
HOST_UID=1000
HOST_GID=1000

# Existing local image containing Git, Docker CLI, Compose, and the update script's shell.
PROJECT_RUNNER_IMAGE=local/example-app:latest
```

After changing labels, recreate the labeled service so Docker places the new labels on the
running container. Service Portal reads live Docker metadata, so no portal rebuild is required.
