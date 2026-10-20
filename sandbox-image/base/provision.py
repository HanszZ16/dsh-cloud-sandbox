"""Install gateway-assigned packages into the user's persisted home.

Reads /etc/dsh-cloud/policy.json, written by the gateway before the sandbox
starts. Every entry is applied once per user: applied keys are recorded in
~/.dsh-cloud/provisioned.json, which lives in the persisted home, so a user who
later removes a default plugin keeps it removed. A failed or interrupted
install is reported and retried on the next start; it never blocks dsh.

  provision.py npm               before dsh starts: `npm install -g` the MCP
                                 server packages (into ~/.local) so their
                                 commands exist when dsh connects to them
  provision.py bundles HOST PORT after dsh listens: `dsh plugin add` and select
                                 each bundle; the web profile's live reload
                                 picks it up, and dsh's package-operation lock
                                 serializes it with installs the user starts
"""

from __future__ import annotations

import json
import os
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


def install_bundle(key: str, spec: str) -> bool:
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


def wait_for_dsh(host: str, port: int) -> bool:
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            socket.create_connection((host, port), timeout=1).close()
            return True
        except OSError:
            time.sleep(1)
    return False


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    policy = read_json(POLICY, {})
    record = read_json(RECORD, {"done": {}})
    if mode == "npm":
        entries, prefix, installer = policy.get("npm", []), "npm:", install_npm
    elif mode == "bundles" and len(sys.argv) == 4:
        entries, prefix, installer = policy.get("bundles", []), "", install_bundle
    else:
        log("usage: provision.py npm | provision.py bundles HOST PORT")
        return 2
    pending = [e for e in entries if record["done"].get(prefix + e["key"]) != e["spec"]]
    if not pending:
        return 0
    if mode == "bundles" and not wait_for_dsh(sys.argv[2], int(sys.argv[3])):
        log("dsh did not start listening; skipping plugin installs until the next start")
        return 1
    for entry in pending:
        if installer(entry["key"], entry["spec"]):
            record["done"][prefix + entry["key"]] = entry["spec"]
            write_json(RECORD, record)
    return 0


if __name__ == "__main__":
    sys.exit(main())
