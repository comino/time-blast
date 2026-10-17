"""Run the current application smoke (persistent canvases and real engine).

Compatibility entry point for the documented UI smoke command:
    python3 tests/ui_smoke.py http://127.0.0.1:5395

Build and start Vite preview first. Requires aiohttp, Playwright and Chromium.
The former fake-engine smoke covered the retired transient-card application;
canvas_smoke exercises the current application with scripted inference only.
"""
import runpy
from pathlib import Path


if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).with_name("canvas_smoke.py")), run_name="__main__")
