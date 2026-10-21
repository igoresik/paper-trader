"""The desktop app: the API and its UI in a native window (WebView2). Closing the window stops everything."""

import ctypes
import json
import logging
import socket
import sys
import threading
import time
import urllib.request
from logging.handlers import RotatingFileHandler

import webview

from . import db  # standard library only, so the window can open before the heavy imports

NAME = "Paper Trader"
STATE = db.DATA_DIR / "window.json"
LOADING = """<!doctype html>
<body style="margin:0;height:100vh;display:grid;place-content:center;gap:8px;text-align:center;
  background:#15171c;color:#a4a8b4;font:13px 'Segoe UI',sans-serif">
  <div style="color:#e9eaee;font-size:15px">Opening the desk&hellip;</div>
  <div id="slow" style="visibility:hidden;max-width:380px">The first start after installing takes longer
    while Windows checks the new files. It is quick from then on.</div>
  <script>setTimeout(() => document.getElementById("slow").style.visibility = "visible", 5000)</script>
</body>"""
_mutex = None  # held for the life of the process


def already_open():
    """A second launch brings the open window forward instead of starting another copy."""
    global _mutex
    # use_last_error saves the error right after the call; a later GetLastError can see a different one
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _mutex = kernel32.CreateMutexW(None, False, "PaperTrader.SingleInstance")
    if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
        return False
    if window := ctypes.windll.user32.FindWindowW(None, NAME):
        ctypes.windll.user32.ShowWindow(window, 9)  # SW_RESTORE
        ctypes.windll.user32.SetForegroundWindow(window)
    return True


def _free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _saved_size():
    try:
        saved = json.loads(STATE.read_text(encoding="utf-8"))
        return max(1100, int(saved["width"])), max(700, int(saved["height"]))
    except (OSError, ValueError, KeyError, TypeError):
        return 1440, 900


def main():
    if already_open():
        return
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = RotatingFileHandler(db.DATA_DIR / "app.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[log], format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if sys.stdout is None:  # a windowed exe has no console to print to
        sys.stdout = sys.stderr = open(db.DATA_DIR / "console.log", "w", encoding="utf-8")

    width, height = _saved_size()
    window = webview.create_window(NAME, html=LOADING, width=width, height=height, min_size=(1100, 700),
                                   background_color="#15171C")
    engine = {}

    def start_engine():  # runs once the window is up
        import uvicorn

        from .api import create_app

        port = _free_port()
        engine["server"] = uvicorn.Server(
            uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_config=None, access_log=False))
        threading.Thread(target=engine["server"].run, daemon=True).start()
        for _ in range(600):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        window.load_url(f"http://127.0.0.1:{port}/")

    def remember():
        try:
            STATE.write_text(json.dumps({"width": window.width, "height": window.height}), encoding="utf-8")
        except OSError:
            pass

    window.events.closing += remember
    webview.settings["ALLOW_DOWNLOADS"] = True  # the history's CSV export
    try:
        webview.start(start_engine, gui="edgechromium", private_mode=False, storage_path=str(db.DATA_DIR / "webview"))
    except Exception:
        logging.exception("the window could not open")
        ctypes.windll.user32.MessageBoxW(
            None, f"{NAME} needs the Microsoft Edge WebView2 Runtime. Install it from Microsoft's website, then open "
            f"{NAME} again.", NAME, 0x10)
    if "server" in engine:
        engine["server"].should_exit = True
