"""Install/restart the Rust tb1 inference service on the demo host (run with sudo).

First install reads OPENROUTER_API_KEY from the inherited server environment;
later installs preserve /etc/time-blast/inference.env. No credential is printed.
The binary must already be built and tested. Configure Caddy separately.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run with sudo on the demo host")
    binary = args.binary.resolve(strict=True)
    if not os.access(binary, os.X_OK):
        parser.error("The built binary is not executable")
    directory = Path("/srv/time-blast/backend")
    directory.mkdir(parents=True, exist_ok=True)
    config = Path("/etc/time-blast/inference.env")
    if not config.exists():
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key or any(c in key for c in '\n\r\0'):
            parser.error("First install requires OPENROUTER_API_KEY in the inherited environment")
        config.parent.mkdir(parents=True, exist_ok=True)
        values = {"OPENROUTER_API_KEY": key,
                  "TIME_BLAST_BIND": "127.0.0.1:8787",
                  "TIME_BLAST_PROVIDER_URL": "https://openrouter.ai/api/v1/chat/completions",
                  # No TIME_BLAST_MODEL: the server's default profile applies (docs/batch-2/inference.md).
                  "TIME_BLAST_OPENROUTER": "true",
                  "TIME_BLAST_ALLOWED_ORIGINS": "https://time-blast.46-224-133-201.sslip.io,http://127.0.0.1:5173,http://localhost:5173",
                  # Per-keystroke translation: request ceilings sized for typing, spend capped.
                  "TIME_BLAST_REQUESTS_PER_MINUTE": "600", "TIME_BLAST_REQUESTS_PER_DAY": "30000",
                  "TIME_BLAST_DAILY_BUDGET_USD": "3"}
        def quote(value):
            return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write("".join(f"{name}={quote(value)}\n" for name, value in values.items()))
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temporary:
        stage = Path(temporary.name)
    try:
        shutil.copyfile(binary, stage)
        stage.chmod(0o755)
        stage.replace(directory / "time-blast-inference")
    finally:
        stage.unlink(missing_ok=True)
    shutil.copyfile(ROOT / "deploy/time-blast-inference.service", "/etc/systemd/system/time-blast-inference.service")
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "time-blast-inference.service"], check=True)
    subprocess.run(["systemctl", "restart", "time-blast-inference.service"], check=True)
    for _ in range(60):
        try:
            with urlopen("http://127.0.0.1:8787/health", timeout=1) as response:
                health = json.load(response)
                if response.status == 200 and health.get("protocol") == "tb1":
                    print(f"Rust tb1 inference service healthy on 127.0.0.1:8787 · model {health.get('model')}")
                    return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("Service did not become healthy; inspect systemctl status time-blast-inference")


if __name__ == "__main__":
    main()
