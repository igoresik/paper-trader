"""The stocks and ETFs the Discover view offers, in rough order of how widely they are held. A symbol Yahoo no longer
knows is left out of the view, so the list can go a little stale without breaking anything."""

CATEGORIES = [
    ("tech", "Big tech", "The largest technology companies"),
    ("ai", "AI and chips", "Chip makers and companies building AI"),
    ("software", "Software and cloud", "Cloud, security and business software"),
    ("finance", "Banks and finance", "Banks, card networks, insurers and brokers"),
    ("health", "Health care", "Drug makers, devices, insurers and biotech"),
    ("consumer", "Consumer brands", "Food, drink, household names and restaurants"),
    ("retail", "Retail and travel", "Shops, delivery, streaming, hotels and airlines"),
    ("cars", "Cars and EVs", "Car makers, electric vehicles and the supply chain"),
    ("energy", "Energy and materials", "Oil, gas, utilities, mining and chemicals"),
    ("industrial", "Industrials", "Aerospace, defense, machinery and transport"),
    ("dividend", "Dividend payers", "Steady companies known for paying out cash"),
    ("etf", "ETFs", "Funds that hold a whole index, sector or asset at once"),
]

# symbol, name, kind (S stock, E ETF), categories
_ROWS = """
AAPL|Apple|S|tech
MSFT|Microsoft|S|tech,software,ai
NVDA|NVIDIA|S|tech,ai
GOOGL|Alphabet (Google)|S|tech,ai
AMZN|Amazon|S|tech,retail
META|Meta Platforms|S|tech,ai
TSLA|Tesla|S|cars,tech
AVGO|Broadcom|S|ai,tech
ORCL|Oracle|S|software,tech
NFLX|Netflix|S|retail,tech
AMD|Advanced Micro Devices|S|ai
INTC|Intel|S|ai
QCOM|Qualcomm|S|ai
TSM|Taiwan Semiconductor|S|ai
MU|Micron Technology|S|ai
ARM|Arm Holdings|S|ai
ASML|ASML|S|ai
AMAT|Applied Materials|S|ai
LRCX|Lam Research|S|ai
TXN|Texas Instruments|S|ai,dividend
PLTR|Palantir|S|ai,software
SMCI|Super Micro Computer|S|ai
CRM|Salesforce|S|software
ADBE|Adobe|S|software
NOW|ServiceNow|S|software
INTU|Intuit|S|software
SNOW|Snowflake|S|software
CRWD|CrowdStrike|S|software
PANW|Palo Alto Networks|S|software
NET|Cloudflare|S|software
SHOP|Shopify|S|software,retail
UBER|Uber|S|retail,tech
SPOT|Spotify|S|retail,tech
IBM|IBM|S|software,dividend
CSCO|Cisco|S|tech,dividend
JPM|JPMorgan Chase|S|finance,dividend
BAC|Bank of America|S|finance
WFC|Wells Fargo|S|finance
GS|Goldman Sachs|S|finance
MS|Morgan Stanley|S|finance
C|Citigroup|S|finance
V|Visa|S|finance
MA|Mastercard|S|finance
AXP|American Express|S|finance
PYPL|PayPal|S|finance,tech
XYZ|Block (Square)|S|finance,tech
COIN|Coinbase|S|finance
SCHW|Charles Schwab|S|finance
BLK|BlackRock|S|finance,dividend
BRK-B|Berkshire Hathaway|S|finance
HOOD|Robinhood|S|finance
LLY|Eli Lilly|S|health
NVO|Novo Nordisk|S|health
JNJ|Johnson & Johnson|S|health,dividend
UNH|UnitedHealth Group|S|health
PFE|Pfizer|S|health,dividend
MRK|Merck|S|health,dividend
ABBV|AbbVie|S|health,dividend
AMGN|Amgen|S|health,dividend
TMO|Thermo Fisher Scientific|S|health
ABT|Abbott Laboratories|S|health,dividend
ISRG|Intuitive Surgical|S|health
MRNA|Moderna|S|health
GILD|Gilead Sciences|S|health,dividend
CVS|CVS Health|S|health,retail
KO|Coca-Cola|S|consumer,dividend
PEP|PepsiCo|S|consumer,dividend
PG|Procter & Gamble|S|consumer,dividend
MCD|McDonald's|S|consumer,dividend
SBUX|Starbucks|S|consumer
NKE|Nike|S|consumer
DIS|Walt Disney|S|consumer,retail
CMG|Chipotle|S|consumer
MDLZ|Mondelez|S|consumer,dividend
CL|Colgate-Palmolive|S|consumer,dividend
PM|Philip Morris|S|consumer,dividend
MO|Altria|S|consumer,dividend
LULU|Lululemon|S|consumer,retail
WMT|Walmart|S|retail,consumer,dividend
COST|Costco|S|retail,consumer
HD|Home Depot|S|retail,dividend
LOW|Lowe's|S|retail
TGT|Target|S|retail,dividend
TJX|TJX Companies|S|retail
ABNB|Airbnb|S|retail
BKNG|Booking Holdings|S|retail
MAR|Marriott|S|retail
DAL|Delta Air Lines|S|retail
UAL|United Airlines|S|retail
CCL|Carnival|S|retail
EBAY|eBay|S|retail
ETSY|Etsy|S|retail
DASH|DoorDash|S|retail
F|Ford|S|cars,dividend
GM|General Motors|S|cars
RIVN|Rivian|S|cars
LCID|Lucid|S|cars
NIO|NIO|S|cars
TM|Toyota|S|cars
HMC|Honda|S|cars
STLA|Stellantis|S|cars
XPEV|XPeng|S|cars
XOM|Exxon Mobil|S|energy,dividend
CVX|Chevron|S|energy,dividend
COP|ConocoPhillips|S|energy
SLB|SLB (Schlumberger)|S|energy
OXY|Occidental Petroleum|S|energy
NEE|NextEra Energy|S|energy,dividend
DUK|Duke Energy|S|energy,dividend
SO|Southern Company|S|energy,dividend
ENPH|Enphase Energy|S|energy
FSLR|First Solar|S|energy
FCX|Freeport-McMoRan|S|energy
NEM|Newmont|S|energy
LIN|Linde|S|energy
BA|Boeing|S|industrial
LMT|Lockheed Martin|S|industrial,dividend
RTX|RTX (Raytheon)|S|industrial,dividend
GE|GE Aerospace|S|industrial
CAT|Caterpillar|S|industrial,dividend
DE|Deere|S|industrial
HON|Honeywell|S|industrial,dividend
UPS|UPS|S|industrial,dividend
FDX|FedEx|S|industrial
UNP|Union Pacific|S|industrial,dividend
MMM|3M|S|industrial,dividend
VZ|Verizon|S|dividend
T|AT&T|S|dividend
O|Realty Income|S|dividend
KMI|Kinder Morgan|S|dividend,energy
SPY|SPDR S&P 500 ETF|E|etf
VOO|Vanguard S&P 500 ETF|E|etf
IVV|iShares Core S&P 500 ETF|E|etf
VTI|Vanguard Total Stock Market ETF|E|etf
QQQ|Invesco QQQ (Nasdaq-100)|E|etf
DIA|SPDR Dow Jones Industrial ETF|E|etf
IWM|iShares Russell 2000 ETF|E|etf
VEA|Vanguard Developed Markets ETF|E|etf
VWO|Vanguard Emerging Markets ETF|E|etf
EFA|iShares MSCI EAFE ETF|E|etf
XLK|Technology Select Sector SPDR|E|etf,tech
XLF|Financial Select Sector SPDR|E|etf,finance
XLE|Energy Select Sector SPDR|E|etf,energy
XLV|Health Care Select Sector SPDR|E|etf,health
SMH|VanEck Semiconductor ETF|E|etf,ai
SOXX|iShares Semiconductor ETF|E|etf,ai
ARKK|ARK Innovation ETF|E|etf,tech
SCHD|Schwab US Dividend Equity ETF|E|etf,dividend
VYM|Vanguard High Dividend Yield ETF|E|etf,dividend
JEPI|JPMorgan Equity Premium Income ETF|E|etf,dividend
BND|Vanguard Total Bond Market ETF|E|etf
TLT|iShares 20+ Year Treasury Bond ETF|E|etf
GLD|SPDR Gold Shares|E|etf
SLV|iShares Silver Trust|E|etf
USO|United States Oil Fund|E|etf,energy
"""


def _rows():
    for line in _ROWS.strip().splitlines():
        symbol, name, kind, cats = line.split("|")
        yield {"symbol": symbol, "name": name, "kind": "ETF" if kind == "E" else "EQUITY", "categories": cats.split(",")}


UNIVERSE = list(_rows())
