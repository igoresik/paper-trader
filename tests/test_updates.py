import io
import json
import urllib.error

import pytest

from papertrader import market, updates


def answer(monkeypatch, release):
    def urlopen(request, timeout):
        if isinstance(release, Exception):
            raise release
        return io.BytesIO(json.dumps(release).encode())

    monkeypatch.setattr(updates.urllib.request, "urlopen", urlopen)


def test_a_newer_release_is_offered(monkeypatch):
    answer(monkeypatch, {"tag_name": "v99.0.0", "html_url": "https://github.com/igoresik/paper-trader/releases/tag/v99.0.0"})
    assert updates.newer() == {"version": "99.0.0", "url": "https://github.com/igoresik/paper-trader/releases/tag/v99.0.0"}


@pytest.mark.parametrize("release", [{"tag_name": "v0.1.0", "html_url": "x"}, urllib.error.HTTPError("x", 404, "Not Found", {}, None)])
def test_an_older_release_or_no_answer_offers_nothing(monkeypatch, release):
    answer(monkeypatch, release)
    assert updates.newer() is None


def test_yahoo_counts_as_down_until_it_answers_again(monkeypatch):
    class Broken:
        def history(self, **kw):
            raise ConnectionError("no route to host")

    monkeypatch.setattr(market, "_ticker", lambda symbol: Broken())
    with pytest.raises(market.MarketError):
        market.check_splits("SPY")
    assert market.yahoo_down()
    market._answered()
    assert not market.yahoo_down()
