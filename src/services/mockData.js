'use strict';

/**
 * Mock Stock Data Generator
 * Simulates real-time market data for Nifty 50 NSE stocks (INR prices)
 */

// Nifty 50 stocks with approximate real-world INR base prices
const STOCKS = [
  // Original 20
  { symbol: 'RELIANCE',    basePrice: 2900  },
  { symbol: 'TCS',         basePrice: 3800  },
  { symbol: 'INFY',        basePrice: 1750  },
  { symbol: 'HDFCBANK',    basePrice: 1650  },
  { symbol: 'ICICIBANK',   basePrice: 1200  },
  { symbol: 'HINDUNILVR',  basePrice: 2300  },
  { symbol: 'SBIN',        basePrice: 820   },
  { symbol: 'BHARTIARTL',  basePrice: 1700  },
  { symbol: 'ITC',         basePrice: 460   },
  { symbol: 'KOTAKBANK',   basePrice: 1900  },
  { symbol: 'LT',          basePrice: 3500  },
  { symbol: 'AXISBANK',    basePrice: 1150  },
  { symbol: 'BAJFINANCE',  basePrice: 7000  },
  { symbol: 'WIPRO',       basePrice: 480   },
  { symbol: 'ULTRACEMCO',  basePrice: 11000 },
  { symbol: 'ASIANPAINT',  basePrice: 2400  },
  { symbol: 'MARUTI',      basePrice: 12500 },
  { symbol: 'SUNPHARMA',   basePrice: 1700  },
  { symbol: 'TITAN',       basePrice: 3500  },
  { symbol: 'NESTLEIND',   basePrice: 2200  },
  // Additional Nifty 50
  { symbol: 'ADANIENT',    basePrice: 2800  },
  { symbol: 'ADANIPORTS',  basePrice: 1200  },
  { symbol: 'APOLLOHOSP',  basePrice: 7200  },
  { symbol: 'BAJAJFINSV',  basePrice: 1800  },
  { symbol: 'BPCL',        basePrice: 300   },
  { symbol: 'BRITANNIA',   basePrice: 5100  },
  { symbol: 'CIPLA',       basePrice: 1600  },
  { symbol: 'COALINDIA',   basePrice: 450   },
  { symbol: 'DIVISLAB',    basePrice: 5800  },
  { symbol: 'DRREDDY',     basePrice: 1300  },
  { symbol: 'EICHERMOT',   basePrice: 5100  },
  { symbol: 'GRASIM',      basePrice: 2700  },
  { symbol: 'HCLTECH',     basePrice: 1750  },
  { symbol: 'HEROMOTOCO',  basePrice: 4600  },
  { symbol: 'HINDALCO',    basePrice: 750   },
  { symbol: 'INDUSINDBK',  basePrice: 1100  },
  { symbol: 'JSWSTEEL',    basePrice: 1000  },
  { symbol: 'LTIM',        basePrice: 5500  },
  { symbol: 'NTPC',        basePrice: 390   },
  { symbol: 'ONGC',        basePrice: 290   },
  { symbol: 'POWERGRID',   basePrice: 340   },
  { symbol: 'SHRIRAMFIN',  basePrice: 3800  },
  { symbol: 'TATACONSUM',  basePrice: 1100  },
  { symbol: 'TATAMOTORS',  basePrice: 780   },
  { symbol: 'TATASTEEL',   basePrice: 180   },
  { symbol: 'TECHM',       basePrice: 1700  },
  { symbol: 'TRENT',       basePrice: 6000  },
];

// Persist base prices across calls so movement is realistic
const basePrices = {};
STOCKS.forEach(({ symbol, basePrice }) => {
  basePrices[symbol] = basePrice;
});

/**
 * Generate a random number within a range
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Generate a fresh market snapshot for all Nifty 50 stocks
 * @returns {Array<Object>} array of stock objects
 */
function generateMarketData() {
  return STOCKS.map(({ symbol }) => {
    const prevClose  = basePrices[symbol];
    const changePerc = parseFloat(randomBetween(-5, 5).toFixed(2));
    const price      = parseFloat((prevClose * (1 + changePerc / 100)).toFixed(2));
    const avgVolume  = Math.floor(randomBetween(500_000, 5_000_000));
    const volumeMult = parseFloat(randomBetween(0.5, 3.5).toFixed(2));
    const volume     = Math.floor(avgVolume * volumeMult);
    const dayHigh    = parseFloat((price * randomBetween(1.0, 1.03)).toFixed(2));
    const dayLow     = parseFloat((price * randomBetween(0.97, 1.0)).toFixed(2));

    // Drift base price slowly for next call
    basePrices[symbol] = price;

    return {
      symbol,
      price,
      prevClose,
      changePercent: changePerc,
      volume,
      avgVolume,
      volumeMultiplier: volumeMult,
      dayHigh,
      dayLow,
      timestamp: new Date().toISOString(),
    };
  });
}

module.exports = { generateMarketData };
