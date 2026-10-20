"""Command line: python -m papertrader ingest SYMBOL"""

import argparse
import sys
from datetime import datetime

from . import db, features, market


def ingest(args):
    symbol = market.clean(args.symbol)
    stored = market.refresh(symbol, args.interval)
    table = features.build(symbol, args.interval).dropna()
    first, last = (datetime.fromtimestamp(ts, market.NY).strftime("%Y-%m-%d %H:%M") for ts in table.index[[0, -1]])
    print(f"{symbol} {args.interval}: {stored} bars stored, features for {len(table)} of them ({first} to {last})")
    print("latest:", ", ".join(f"{name} {value:.4f}" for name, value in table.iloc[-1].items()))


def main():
    parser = argparse.ArgumentParser(prog="papertrader")
    commands = parser.add_subparsers(required=True)
    cmd = commands.add_parser("ingest", help="download history and store its indicators")
    cmd.add_argument("symbol")
    cmd.add_argument("--interval", choices=["1d", "1h"], default="1d")
    cmd.set_defaults(run=ingest)
    args = parser.parse_args()
    db.init()
    try:
        args.run(args)
    except market.MarketError as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
