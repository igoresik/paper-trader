import sys

import pytest

from papertrader import __main__ as cli
from papertrader import market


@pytest.mark.parametrize("horizon", ["0", "21"])
def test_train_refuses_a_horizon_the_api_would_refuse(monkeypatch, horizon):
    def offline(*args, **kwargs):
        raise AssertionError("refused before any download")

    monkeypatch.setattr(market, "needs_refresh", offline)
    monkeypatch.setattr(sys, "argv", ["papertrader", "train", "SPY", "--horizon", horizon])
    with pytest.raises(SystemExit) as refused:
        cli.main()
    assert refused.value.code == 2
