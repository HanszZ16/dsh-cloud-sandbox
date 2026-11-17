import subprocess
from types import SimpleNamespace

import pytest

from dsh_gateway.backends.opensandbox_backend import _read_launch_url, memory_quantity, policy_files


@pytest.mark.parametrize(
    ("docker", "quantity"),
    [("2g", "2Gi"), ("512m", "512Mi"), ("1024K", "1024Ki"), ("4gb", "4Gi"), ("1073741824", "1073741824"), ("2Gi", "2Gi")],
)
def test_group_memory_keeps_its_binary_meaning_on_opensandbox(docker, quantity):
    assert memory_quantity(docker) == quantity


def test_policy_files_are_placed_relative_to_the_mounted_directory():
    files = {"/etc/dsh-cloud/policy.json": b"{}", "/etc/dsh-cloud/admin.cordis.yml": b"[]"}
    assert policy_files(files) == {"policy.json": b"{}", "admin.cordis.yml": b"[]"}


def test_a_file_outside_the_policy_directory_is_refused():
    with pytest.raises(ValueError, match="/etc/passwd"):
        policy_files({"/etc/passwd": b""})
    with pytest.raises(ValueError):
        policy_files({"/etc/dsh-cloud-other/x": b""})


async def test_launch_token_ends_before_the_next_log_line_even_when_execd_strips_newlines(tmp_path):
    url = "http://localhost:8000/u/admin/?token=test-token"
    log = tmp_path / "web log.txt"
    log.write_text(f"dsh web: http://localhost:8000/u/admin/?token=old\nstartup chatter\ndsh web: {url}\ndsh-cloud: ready\n")

    async def run(command):
        stdout = subprocess.check_output(["sh", "-c", command], text=True)
        lines = [SimpleNamespace(text=line) for line in stdout.splitlines()]
        return SimpleNamespace(error=None, exit_code=0, logs=SimpleNamespace(stdout=lines))

    sandbox = SimpleNamespace(commands=SimpleNamespace(run=run))
    assert await _read_launch_url(sandbox, str(log)) == url
    assert await _read_launch_url(sandbox, str(tmp_path / "not-started")) == ""
