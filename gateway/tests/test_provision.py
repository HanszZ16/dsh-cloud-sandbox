"""The sandbox image's provisioner: image-shipped (link:) plugins and their shared caches."""

import importlib.util
import json
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "sandbox-image" / "base" / "provision.py"


@pytest.fixture
def provision(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("provision", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "HOME", tmp_path / "home")
    monkeypatch.setattr(module, "PROFILE", tmp_path / "home" / ".dsh" / "profiles" / "web")
    return module


def image_plugin(root: Path, caches: dict[str, str]) -> str:
    package = root / "plugins" / "kb"
    package.mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({"name": "@x/kb", "version": "1.0.0", "dsh": {"bundle": {}}}))
    (package / "dsh-cloud.json").write_text(json.dumps({"sharedCaches": caches}))
    return f"link:{package}"


def test_shared_caches_link_to_the_image_and_replace_downloaded_copies(provision, tmp_path):
    model = tmp_path / "models" / "m"
    model.mkdir(parents=True)
    spec = image_plugin(tmp_path, {".cache/m": str(model), ".cache/n": str(tmp_path / "models" / "n")})
    downloaded = provision.HOME / ".cache" / "m"
    downloaded.mkdir(parents=True)
    (downloaded / "model.onnx").write_text("copy")

    provision.link_shared_caches(spec)
    provision.link_shared_caches(spec)

    assert downloaded.is_symlink() and downloaded.resolve() == model.resolve()
    assert (provision.HOME / ".cache" / "n").is_symlink()


def test_a_link_bundle_counts_as_installed_only_when_the_profile_links_its_directory(provision, tmp_path):
    spec = image_plugin(tmp_path, {})
    assert not provision.is_linked(spec)

    modules = provision.PROFILE / "node_modules" / "@x"
    modules.mkdir(parents=True)
    (provision.PROFILE / "package.json").write_text(json.dumps({"dependencies": {"@x/kb": "0.3.1"}}))
    (modules / "kb").mkdir()
    assert not provision.is_linked(spec)  # a registry copy of the same package

    (modules / "kb").rmdir()
    (modules / "kb").symlink_to(spec[len("link:"):])
    assert provision.is_linked(spec)


def test_a_renamed_link_bundle_replaces_the_old_name_and_is_rechecked(provision, tmp_path, monkeypatch):
    spec = image_plugin(tmp_path, {})
    source = Path(spec[len("link:"):])
    modules = provision.PROFILE / "node_modules" / "@old"
    modules.mkdir(parents=True)
    (modules / "kb").symlink_to(source)
    (provision.PROFILE / "package.json").write_text(json.dumps({"dependencies": {"@old/kb": f"link:{source}"}}))
    commands = []
    monkeypatch.setattr(provision, "run", lambda command, spec, timeout: commands.append(command) or True)

    assert provision.unlink_renamed(spec)
    assert commands == [["dsh", "plugin", "--profile", "web", "remove", "@old/kb"]]

    before = provision.revision(spec)
    manifest = json.loads((source / "package.json").read_text())
    (source / "package.json").write_text(json.dumps({**manifest, "version": "2.0.0"}))
    assert provision.revision(spec) != before
