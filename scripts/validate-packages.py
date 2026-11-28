"""Check each release ZIP against its unpacked build and target-specific manifest."""
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]


def validate(target, version):
    directory = ROOT / "dist" / target
    package = directory.parent / f"aethvyr-{target}-{version}.zip"
    files = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    with ZipFile(package) as archive:
        entries = [item.filename for item in archive.infolist() if not item.is_dir()]
        if len(entries) != len(files) or set(entries) != files:
            raise ValueError(f"{target} ZIP has missing, duplicate or unexpected files")
        for name in entries:
            if archive.read(name) != (directory / name).read_bytes():
                raise ValueError(f"{target} ZIP differs from build at {name}")
        manifest = json.loads(archive.read("manifest.json"))
        background = manifest["background"]
        if target == "firefox":
            correct_target = background.get("scripts") == ["background/engine.js"] and (
                manifest["browser_specific_settings"]["gecko"]["id"] ==
                "velostream@srikarthickeyanganapathy.github.io")
        else:
            correct_target = background.get("service_worker") == "background/engine.js"
        if not correct_target or background.get("type") != "module" or manifest["version"] != version:
            raise ValueError(f"{target} manifest has incorrect version or background entry")
        for name in ["lib/SHAKA-LICENSE.txt", "player/ANIME4K-LICENSE.txt", "lib/shaka-player.compiled.js"]:
            if not archive.getinfo(name).file_size:
                raise ValueError(f"{name} is empty")
    print(f"Validated {package.name} ({len(files)} files)")


if __name__ == "__main__":
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    for target in ("chrome", "firefox"):
        validate(target, version)
