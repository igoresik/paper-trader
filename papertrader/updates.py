"""Is there a newer release? Asked once per start, only when the setting is on. The request carries nothing about
you or your trades; GitHub only sees that some copy asked."""

import json
import logging
import urllib.request

from . import __version__

log = logging.getLogger("papertrader")
LATEST = "https://api.github.com/repos/igoresik/paper-trader/releases/latest"


def _version(tag):
    return tuple(int(part) for part in tag.lstrip("v").split(".")[:3])


def newer():
    """The latest release if it's newer than this copy, else None. A failed check is None too: it never matters."""
    request = urllib.request.Request(
        LATEST, headers={"Accept": "application/vnd.github+json", "User-Agent": f"PaperTrader/{__version__}"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            release = json.load(response)
        if _version(release["tag_name"]) > _version(__version__):
            return {"version": release["tag_name"].lstrip("v"), "url": release["html_url"]}
    except Exception as error:  # offline, a private repo (404), rate limits: try again next start
        log.info("update check skipped: %s", error)
    return None
