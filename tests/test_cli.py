import sys

import pandas as pd
import pytest

from papertrader import __main__ as cli
from papertrader import features, market, model


@pytest.mark.parametrize("horizon", ["0", "21"])
def test_train_refuses_a_horizon_the_api_would_refuse(monkeypatch, horizon):
    def offline(*args, **kwargs):
        raise AssertionError("refused before any download")

    monkeypatch.setattr(market, "needs_refresh", offline)
    monkeypatch.setattr(sys, "argv", ["papertrader", "train", "SPY", "--horizon", horizon])
    with pytest.raises(SystemExit) as refused:
        cli.main()
    assert refused.value.code == 2


def test_train_downloads_the_market_context_it_reads(monkeypatch):
    fetched, tested = [], []
    monkeypatch.setattr(market, "needs_refresh", lambda symbol, interval, now=None: symbol == "^VIX")
    monkeypatch.setattr(market, "refresh_context", lambda: fetched.append("context"))

    def validate(symbol, p):
        tested.append(fetched[:])
        raise model.ModelError("stop here")

    monkeypatch.setattr(model, "validate", validate)
    monkeypatch.setattr(sys, "argv", ["papertrader", "train", "SPY"])
    with pytest.raises(SystemExit):
        cli.main()
    assert tested == [["context"]]


def test_ingest_says_so_when_there_are_too_few_bars_for_the_indicators(monkeypatch):
    monkeypatch.setattr(market, "refresh", lambda symbol, interval: 10)
    monkeypatch.setattr(features, "build", lambda symbol, interval: pd.DataFrame({"rsi": [None] * 10}))
    monkeypatch.setattr(sys, "argv", ["papertrader", "ingest", "NEWCO"])
    with pytest.raises(SystemExit) as stopped:
        cli.main()
    assert "not enough" in str(stopped.value)
