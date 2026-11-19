"""Install gateway-assigned packages into the user's persisted home.

Reads /etc/dsh-cloud/policy.json, written by the gateway before the sandbox
starts. Every entry is applied once per user: applied keys are recorded in
~/.dsh-cloud/provisioned.json, which lives in the persisted home, so a user who
later removes a default plugin keeps it removed (a package shipped in the
image as file:… is installed again when the image carries a new version; one
shipped as link:… is a symlink into the image and follows it by itself). A failed or interrupted
install is reported and retried on the next start; it never blocks dsh.

  provision.py npm               before dsh starts: `npm install -g` the MCP
                                 server packages (into ~/.local) so their
                                 commands exist when dsh connects to them, and
                                 install, update, or reinstall bundles shipped
                                 in the image (file:, link:), which needs no
                                 network, and link the caches they share:
                                 dsh then boots with their rows and code (a
                                 dependency-only change triggers no live reload)
  provision.py bundles HOST PORT after dsh listens: `dsh plugin add` and select
                                 each registry bundle; the web profile's live
                                 reload picks up the new selection, and dsh's
                                 package-operation lock serializes it with
                                 installs the user starts
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

POLICY = Path("/etc/dsh-cloud/policy.json")
HOME = Path.home()
PROFILE = Path(os.environ.get("DSH_HOME", HOME / ".dsh")) / "profiles" / "web"
RECORD = HOME / ".dsh-cloud" / "provisioned.json"
INSTALL_TIMEOUT_S = int(os.environ.get("DSH_CLOUD_INSTALL_TIMEOUT_S", "1800"))
NPM_TIMEOUT_S = int(os.environ.get("DSH_CLOUD_NPM_TIMEOUT_S", "180"))
READY_TIMEOUT_S = 300


def log(message: str) -> None:
    print(f"dsh-cloud provision: {message}", flush=True)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".partial")
    partial.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(partial, path)


def dependencies() -> dict[str, str]:
    return read_json(PROFILE / "package.json", {}).get("dependencies", {})


def is_bundle(package: str) -> bool:
    manifest = read_json(PROFILE / "node_modules" / package / "package.json", {})
    return isinstance(manifest.get("dsh"), dict) and "bundle" in manifest["dsh"]


def select_bundle(package: str) -> None:
    manifest_path = PROFILE / "package.json"
    manifest = read_json(manifest_path, {})
    bundles = manifest.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
    if package not in bundles:
        bundles.append(package)
        write_json(manifest_path, manifest)


def run(command: list[str], spec: str, timeout_s: int) -> bool:
    # A session of its own, so a timeout ends the whole tree (pnpm, npm), not only the launcher.
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        log(f"installing {spec} timed out after {timeout_s}s; retrying on next start")
        return False
    if process.returncode != 0:
        log(f"installing {spec} failed (exit {process.returncode}); retrying on next start\n{output[-2000:]}")
        return False
    return True


def install_npm(key: str, spec: str) -> bool:
    log(f"installing MCP server package {spec} ({key})")
    return run(["npm", "install", "--global", "--no-fund", "--no-audit", spec], spec, NPM_TIMEOUT_S)


def refresh_local(spec: str) -> bool | None:
    """Bring an installed copy of an image-shipped `file:` package up to the image's version.

    Returns None when the package is not installed yet (a normal install follows),
    True once the copy matches the image, and False when that failed.
    """
    source = Path(spec[len("file:"):])
    manifest = read_json(source / "package.json", {})
    name = manifest.get("name")
    installed = PROFILE / "node_modules" / str(name)
    if not name or name not in dependencies() or not installed.exists():
        return None
    current = read_json(installed / "package.json", {})
    if current.get("dependencies") != manifest.get("dependencies"):
        # New dependencies need pnpm: reinstall from scratch.
        log(f"dependencies of {name} changed; reinstalling")
        if not run(["dsh", "plugin", "--profile", "web", "remove", name], spec, INSTALL_TIMEOUT_S):
            return False
        return None
    target = installed.resolve()
    for path in source.rglob("*"):
        if path.is_dir() or "node_modules" in path.parts:
            continue
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Replace rather than write in place: installed files are hard links into the pnpm store.
        partial = destination.with_name(destination.name + ".partial")
        shutil.copyfile(path, partial)
        os.replace(partial, destination)
    log(f"updated {name} to {manifest.get('version')}")
    return True


def link_shared_caches(spec: str) -> None:
    """Point the caches an image-shipped package declares at the image's copies.

    The package directory's dsh-cloud.json maps paths under the home (where the
    plugin looks) to directories in the image. A copy the user downloaded
    earlier is replaced: it holds the same files the image provides.
    """
    manifest = read_json(Path(spec.split(":", 1)[1]) / "dsh-cloud.json", {})
    for relative, target in manifest.get("sharedCaches", {}).items():
        path = HOME / relative
        if path.is_symlink():
            if os.readlink(path) == target:
                continue
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(target)
        log(f"linked {path} to {target}")


def is_linked(spec: str) -> bool:
    """Whether the profile already loads the package at this link: spec's directory."""
    source = Path(spec[len("link:"):])
    name = read_json(source / "package.json", {}).get("name")
    installed = PROFILE / "node_modules" / str(name)
    return bool(name) and name in dependencies() and installed.is_symlink() and installed.resolve() == source.resolve()


def unlink_renamed(spec: str) -> bool:
    """Remove profile packages that link this link: spec's directory under another name.

    Left in place, such a package would load the directory's code a second time
    under its old name. Returns False when a removal failed.
    """
    source = Path(spec[len("link:"):]).resolve()
    name = read_json(source / "package.json", {}).get("name")
    for package in dependencies():
        installed = PROFILE / "node_modules" / package
        if package != name and installed.is_symlink() and installed.resolve() == source:
            log(f"{package} was renamed to {name}; removing it")
            if not run(["dsh", "plugin", "--profile", "web", "remove", package], spec, INSTALL_TIMEOUT_S):
                return False
    return True


def install_bundle(key: str, spec: str) -> bool:
    if spec.startswith("file:"):
        refreshed = refresh_local(spec)
        if refreshed is not None:
            return refreshed
    if spec.startswith("link:"):
        # A gateway can be newer than a group's image. Leave the existing
        # profile intact and retry when the bundle is present on the next boot.
        if not (Path(spec[len("link:"):]) / "package.json").is_file():
            log(f"{spec} is not in this image; skipping {key}")
            return False
        if not unlink_renamed(spec):
            return False
        if is_linked(spec):
            name = read_json(Path(spec[len("link:"):]) / "package.json", {}).get("name")
            if name and is_bundle(str(name)):
                select_bundle(str(name))
            return True
    before = dependencies()
    log(f"installing {spec} ({key})")
    if not run(["dsh", "plugin", "--profile", "web", "add", spec], spec, INSTALL_TIMEOUT_S):
        return False
    added = [name for name in dependencies() if name not in before]
    if not added:
        log(f"{spec} was already a profile dependency")
        added = [name for name in dependencies() if spec == name or spec.startswith(name + "@")]
    for package in added:
        if is_bundle(package):
            select_bundle(package)
            log(f"selected bundle {package}")
        else:
            # A plain plugin package: an admin config patch mounts its rows.
            log(f"installed plugin package {package}")
    return True


def revision(spec: str) -> str:
    """What the provisioning record stores for `spec`.

    A local `file:` package (shipped in the image) also records its version,
    so a newer image's copy is installed over the old one at the next start; a
    `link:` package records its name and version, so a rename or upgrade is
    checked once.
    """
    if spec.startswith("file:"):
        version = read_json(Path(spec[len("file:"):]) / "package.json", {}).get("version")
        if version:
            return f"{spec}#{version}"
    if spec.startswith("link:"):
        manifest = read_json(Path(spec[len("link:"):]) / "package.json", {})
        if manifest.get("name") and manifest.get("version"):
            return f"{spec}#{manifest['name']}@{manifest['version']}"
    return spec


def wait_for_dsh(host: str, port: int) -> bool:
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            socket.create_connection((host, port), timeout=1).close()
            return True
        except OSError:
            time.sleep(1)
    return False


def clean_legacy_profile() -> None:
    """Remove obsolete or missing image-linked plugins and repair stale DSH runtime pins on existing volumes."""
    manifest_path = PROFILE / "package.json"
    if not manifest_path.is_file():
        return
    manifest = read_json(manifest_path, {})
    changed = False
    deps = manifest.get("dependencies")
    bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles")
    to_remove = ["dsh-cloud-workspace-rooms"]
    if isinstance(deps, dict):
        for pkg, spec in list(deps.items()):
            if isinstance(spec, str) and spec.startswith("link:"):
                target = Path(spec[len("link:"):])
                if not (target / "package.json").is_file() and pkg not in to_remove:
                    to_remove.append(pkg)
    for pkg in to_remove:
        if isinstance(deps, dict) and pkg in deps:
            del deps[pkg]
            changed = True
        if isinstance(bundles, list) and pkg in bundles:
            bundles.remove(pkg)
            changed = True
        old_link = PROFILE / "node_modules" / pkg
        if old_link.is_symlink() or old_link.is_file():
            old_link.unlink()
        elif old_link.is_dir():
            shutil.rmtree(old_link)
    if changed:
        write_json(manifest_path, manifest)
    doctor = Path("/usr/local/lib/dsh-cloud/plugins/ds-bot/bin/ds-bot-doctor.mjs")
    if doctor.is_file():
        run(["node", str(doctor), "doctor", "--fix"], "ds-bot-doctor", INSTALL_TIMEOUT_S)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    policy = read_json(POLICY, {})
    record = read_json(RECORD, {"done": {}})
    bundles = [
        {"key": "ds-bot", "spec": "link:/usr/local/lib/dsh-cloud/plugins/ds-bot"}
        if b.get("key") == "workspace-rooms" else b
        for b in policy.get("bundles", [])
    ]
    builtin_ds_bot = {"key": "ds-bot", "spec": "link:/usr/local/lib/dsh-cloud/plugins/ds-bot"}
    if not any(b.get("key") == "ds-bot" for b in bundles):
        bundles.append(builtin_ds_bot)
    local = [b for b in bundles if b["spec"].startswith(("file:", "link:"))]
    if mode == "npm":
        clean_legacy_profile()
        for bundle in local:
            if bundle["spec"].startswith("link:"):
                link_shared_caches(bundle["spec"])
        for bundle in local:
            needs_install = record["done"].get(bundle["key"]) != revision(bundle["spec"]) or bundle["spec"].startswith("link:")
            if needs_install and install_bundle(bundle["key"], bundle["spec"]):
                record["done"][bundle["key"]] = revision(bundle["spec"])
                write_json(RECORD, record)
        entries, prefix, installer = policy.get("npm", []), "npm:", install_npm
    elif mode == "bundles" and len(sys.argv) == 4:
        entries, prefix, installer = [b for b in bundles if b not in local], "", install_bundle
    else:
        log("usage: provision.py npm | provision.py bundles HOST PORT")
        return 2
    pending = [e for e in entries if record["done"].get(prefix + e["key"]) != revision(e["spec"])]
    if not pending:
        return 0
    if mode == "bundles" and not wait_for_dsh(sys.argv[2], int(sys.argv[3])):
        log("dsh did not start listening; skipping plugin installs until the next start")
        return 1
    for entry in pending:
        if installer(entry["key"], entry["spec"]):
            record["done"][prefix + entry["key"]] = revision(entry["spec"])
            write_json(RECORD, record)
    return 0


if __name__ == "__main__":
    sys.exit(main())
