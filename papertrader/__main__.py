"""Command line: python -m papertrader serve | ingest SYMBOL | train SYMBOL"""

import argparse
import sys
from dataclasses import replace
from datetime import datetime

from . import db, features, market, model


def ingest(args):
    symbol = market.clean(args.symbol)
    stored = market.refresh(symbol, args.interval)
    table = features.build(symbol, args.interval).dropna()
    first, last = (datetime.fromtimestamp(ts, market.NY).strftime("%Y-%m-%d %H:%M") for ts in table.index[[0, -1]])
    print(f"{symbol} {args.interval}: {stored} bars stored, features for {len(table)} of them ({first} to {last})")
    print("latest:", ", ".join(f"{name} {value:.4f}" for name, value in table.iloc[-1].items()))


def _day(ts):
    return datetime.fromtimestamp(ts, market.NY).strftime("%Y-%m-%d")


def train(args):
    symbol = market.clean(args.symbol)
    if market.needs_refresh(symbol, args.interval):
        market.refresh(symbol, args.interval)
    p = replace(model.defaults(args.interval), estimator=args.estimator)
    result = model.validate(symbol, p)
    m = result["metrics"]
    print(f"{symbol} {args.interval}, {p.estimator}, threshold {p.threshold:.1%}, walk-forward over {m['rows']} bars")
    print(f"{'fold':>4}  {'tested':<23} {'acc':>6} {'bal':>6} {'f1':>6} {'major':>6} {'buy':>6} {'yday':>6} {'train':>6}")
    for f in m["folds"]:
        b = f["baselines"]
        print(f"{f['fold']:>4}  {_day(f['test_from'])} to {_day(f['test_to'])} {f['accuracy']:6.1%} "
              f"{f['balanced_accuracy']:6.1%} {f['macro_f1']:6.1%} {b['majority']:6.1%} {b['always_buy']:6.1%} "
              f"{b['yesterday']:6.1%} {f['train_balanced_accuracy']:6.1%}")
    s = m["summary"]
    for name, score in s["scores"].items():
        print(f"{name:>10}: accuracy {score['accuracy']:.1%}, balanced accuracy {score['balanced_accuracy']:.1%}")
    low, high = s["edge_range"]
    print(f"verdict: {s['verdict']} (edge {s['edge']:+.1%} balanced accuracy, likely {low:+.1%} to {high:+.1%}"
          f" allowing for {s['tries']} run(s) on this data)")
    bt = m["backtest"]
    for name in ("strategy", "sized", "steady", "buy_hold"):
        r = bt[name]
        print(f"{name:>10}: total {r['total_return']:+.1%}, CAGR {r['cagr']:+.1%}, Sharpe {r['sharpe']:.2f}, "
              f"max drawdown {r['max_drawdown']:.1%}")
    print(f"exposure {bt['exposure']:.0%}, {bt['trades']} trades, {p.cost_bps:g} bps per change of position")
    if args.activate:
        model.activate(result["id"])
        print(f"run {result['id']} now drives the live signal for {symbol}")


def serve(args):
    import uvicorn

    from .api import create_app

    uvicorn.run(create_app(), host=args.host, port=args.port)


def main():
    parser = argparse.ArgumentParser(prog="papertrader")
    commands = parser.add_subparsers(required=True)
    cmd = commands.add_parser("serve", help="run the API and the app in a browser, without the desktop window")
    cmd.add_argument("--host", default="127.0.0.1")
    cmd.add_argument("--port", type=int, default=8000)
    cmd.set_defaults(run=serve)
    cmd = commands.add_parser("ingest", help="download history and store its indicators")
    cmd.add_argument("symbol")
    cmd.add_argument("--interval", choices=["1d", "1h"], default="1d")
    cmd.set_defaults(run=ingest)
    cmd = commands.add_parser("train", help="walk-forward validation against baselines and buy-and-hold")
    cmd.add_argument("symbol")
    cmd.add_argument("--interval", choices=["1d", "1h"], default="1d")
    cmd.add_argument("--estimator", choices=["random_forest", "gradient_boosting"], default="random_forest")
    cmd.add_argument("--activate", action="store_true", help="use this run for live signals")
    cmd.set_defaults(run=train)
    args = parser.parse_args()
    db.init()
    try:
        args.run(args)
    except (market.MarketError, model.ModelError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
