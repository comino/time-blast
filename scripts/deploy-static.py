#!/usr/bin/env python3
"""Atomically install a built dist/ into a Caddy-readable directory.

Run pnpm build first, then sudo python3 scripts/deploy-static.py dist.
This does not change Caddy configuration or restart any service.
Hashed assets survive releases so tabs already open can still load workers.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import os
from pathlib import Path
import shutil
import uuid


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(source, destination):
    if destination.exists():
        if digest(source) != digest(destination):
            raise RuntimeError(f"Immutable asset collision: {destination.name}")
        return
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}")
    shutil.copyfile(source, temporary)
    temporary.chmod(0o644)
    os.replace(temporary, destination)


def precompress(path):
    if path.suffix not in {".js", ".css", ".html", ".json", ".svg", ".wasm", ".duckdb"}:
        return
    destination = path.with_name(path.name + ".gz")
    if destination.exists():
        return
    encoded = gzip.compress(path.read_bytes(), compresslevel=9, mtime=0)
    if len(encoded) >= path.stat().st_size:
        return
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}")
    temporary.write_bytes(encoded)
    temporary.chmod(0o644)
    os.replace(temporary, destination)


def deploy(source, root):
    if not (source / "index.html").is_file() or not (source / "assets").is_dir():
        raise RuntimeError("Expected a complete Vite production build")
    release_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    release = root / "releases" / release_id
    assets = root / "assets"
    release.mkdir(parents=True, mode=0o755)
    assets.mkdir(parents=True, exist_ok=True, mode=0o755)
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"Unexpected build symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        target = assets / relative.relative_to("assets") if relative.parts[0] == "assets" else release / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        install(path, target)
        precompress(target)
    (release / "assets").symlink_to(assets)
    temporary_link = root / f".current-{release_id}"
    temporary_link.symlink_to(release)
    os.replace(temporary_link, root / "current")
    print(f"Installed {release}; index SHA-256 {digest(source / 'index.html')}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--root", type=Path, default=Path("/srv/time-blast"))
    args = parser.parse_args()
    deploy(args.source.resolve(), args.root.resolve())
