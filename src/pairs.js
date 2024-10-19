const dotenv = require('dotenv');
dotenv.config();
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_API_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const { PROGRAM_IDS, LP_PROGRAM_ID } = require('./data');
const { Connection, PublicKey } = require('@solana/web3.js');

const {
  fetchMultipleMintInfos,
  toApiV3Token,
} = require('@raydium-io/raydium-sdk-v2');
const { CpmmPoolInfoLayout } = require('tokengobbler');

const { ApiV3Token } = require('tokengobbler');

const {
  TOKEN_PROGRAM_ID,
  MintLayout,
} = require('@solana/spl-token');
const Decimal = require('decimal.js');

async function fetchWithRetry(url, options, retries = 5, backoff = 300) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        const jsonData = await response.json();
        return jsonData;
      }
      if (response.status !== 429) throw new Error(`HTTP error! status: ${response.status}`);
      console.log(`Rate limited. Retrying in ${backoff}ms...`);
    } catch (error) {
      console.log(`Error occurred. Retrying in ${backoff}ms...`, error);
      if (i === retries - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff *= 2;
  }
}

async function fetchTokenMetadata(mintAddresses) {
  try {
    const batchSize = 1000;
    const results = [];

    for (let i = 0; i < mintAddresses.length; i += batchSize) {
      const batch = mintAddresses.slice(i, i + batchSize);
      const response = await fetchWithRetry(HELIUS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'my-id',
          method: 'getAssetBatch',
          params: { ids: batch },
        }),
      });

      if (!response.result || !Array.isArray(response.result)) {
        console.error('Unexpected response format from Helius API:', response);
        continue;
      }

      const batchResults = response.result.map((asset) => ({
        id: asset?.id || 'unknown',
        content: {
          metadata: asset?.content?.metadata || {},
          links: asset?.content?.links || {},
          image:
            asset?.content?.files?.[0]?.uri ||
            asset?.content?.links?.image ||
            'https://placehold.co/200x200/00000/2b2b2b?text=FOMO',
        },
      }));

      results.push(...batchResults);
    }

    return results;
  } catch (error) {
    console.error('Error fetching token metadata:', error);
    return [];
  }
}

async function fetchProgramAccounts(connection, programId) {
  const accounts = await connection.getProgramAccounts(new PublicKey(programId), {
    encoding: 'base64',
  });
  console.log(`Fetched ${accounts.length} accounts for program ${programId}`);
  return accounts;
}

class AMM {
  constructor(
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    initialVirtualTokenReserves,
    program,
    programId,
    address
  ) {
    this.virtualSolReserves = virtualSolReserves;
    this.virtualTokenReserves = virtualTokenReserves;
    this.realSolReserves = realSolReserves;
    this.realTokenReserves = realTokenReserves;
    this.initialVirtualTokenReserves = initialVirtualTokenReserves;
    this.program = program;
    this.programId = programId;
    this.metadata = null;
    this.mintPubkey = null;
    this.apiV3Token = null;
    this.address = address;
  }

  getBuyPrice(tokens) {
    const productOfReserves = this.virtualSolReserves * this.virtualTokenReserves;
    const newVirtualTokenReserves = this.virtualTokenReserves - tokens;
    const newVirtualSolReserves = productOfReserves / newVirtualTokenReserves + BigInt(1);
    return newVirtualSolReserves - this.virtualSolReserves;
  }

  getSellPrice(tokens) {
    const scaling_factor = this.initialVirtualTokenReserves;
    const token_sell_proportion = (tokens * scaling_factor) / this.virtualTokenReserves;
    const sol_received = (this.virtualSolReserves * token_sell_proportion) / scaling_factor;
    return sol_received < this.realSolReserves ? sol_received : this.realSolReserves;
  }
}

class LPAMM {
  constructor(
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    initialVirtualTokenReserves,
    program,
    programId,
    metadata,
    address,
    baseTokenMint,
    quoteTokenMint,
  ) {
    this.virtualSolReserves = virtualSolReserves;
    this.virtualTokenReserves = virtualTokenReserves;
    this.realSolReserves = realSolReserves;
    this.realTokenReserves = realTokenReserves;
    this.initialVirtualTokenReserves = initialVirtualTokenReserves;
    this.program = program;
    this.programId = programId;
    this.metadata = metadata;
    this.mintPubkey = null;
    this.address = address;
    this.baseTokenMint = baseTokenMint;
    this.quoteTokenMint = quoteTokenMint;
    this.baseTokenSymbol = null;
    this.quoteTokenSymbol = null;
    this.liquidity = null;
  }

  getBuyPrice(tokens) {
    const productOfReserves = this.virtualSolReserves * this.virtualTokenReserves;
    const newVirtualTokenReserves = this.virtualTokenReserves - tokens;
    const newVirtualSolReserves = productOfReserves / newVirtualTokenReserves + BigInt(1);
    return newVirtualSolReserves - this.virtualSolReserves;
  }

  getSellPrice(tokens) {
    const scaling_factor = this.initialVirtualTokenReserves;
    const token_sell_proportion = (tokens * scaling_factor) / this.virtualTokenReserves;
    const sol_received = (this.virtualSolReserves * token_sell_proportion) / scaling_factor;
    return sol_received < this.realSolReserves ? sol_received : this.realSolReserves;
  }
}

async function generateAMMs(connection, programs) {
  const amms = [];
  const allAccountsData = await Promise.all([...PROGRAM_IDS, LP_PROGRAM_ID].map(programId => fetchProgramAccounts(connection, programId)));

  for (let i = 0; i < PROGRAM_IDS.length + 1; i++) {
    const programId = i < PROGRAM_IDS.length ? PROGRAM_IDS[i] : LP_PROGRAM_ID;
    const program = programs[programId];
  
    const accountsData = allAccountsData[i];
    await Promise.all(accountsData.map(async (accountData) => {
      try {
        const data = Buffer.from(accountData.account.data)
        let amm;

        if (programId === LP_PROGRAM_ID && data.length >= 700) {
          console.log(data.length)
          try {
            const s = CpmmPoolInfoLayout.decode(data);
            const poolState = data.slice(CpmmPoolInfoLayout.span);

            amm = new LPAMM(
              poolState.readBigUInt64LE(0),
              poolState.readBigUInt64LE(8),
              poolState.readBigUInt64LE(16),
              poolState.readBigUInt64LE(24),
              poolState.readBigUInt64LE(32),
              program,
              new PublicKey(programId),
              toApiV3Token({
                address: s.mintLp.toString(),
                programId: TOKEN_PROGRAM_ID.toBase58(),
                decimals: 6,
              }),
              accountData.pubkey,
              s.mintA,
              s.mintB
            );
            amm.mintPubkey = s.mintLp;

            // Fetch token info for base and quote tokens
            try {
              let [baseTokenInfo, quoteTokenInfo] = await connection.getMultipleAccountsInfo(
                [s.mintA, s.mintB]
              );

              if (baseTokenInfo && quoteTokenInfo) {
                baseTokenInfo = MintLayout.decode(baseTokenInfo.data)
                quoteTokenInfo = MintLayout.decode(quoteTokenInfo.data)
                amm.baseTokenSymbol = baseTokenInfo.symbol || 'Unknown';
                amm.quoteTokenSymbol = quoteTokenInfo.symbol || 'SOL';

                // Calculate liquidity
                const baseTokenAmount = await connection.getTokenAccountBalance(s.vaultA);
                const quoteTokenAmount = await connection.getTokenAccountBalance(s.vaultB);
                const basePrice = await getCurrentPrice(amm, connection);
                amm.liquidity = baseTokenAmount.value * basePrice + quoteTokenAmount.value;

                amms.push(amm);
              } else {
                console.warn(`Skipping AMM due to missing token info for ${s.mintA} or ${s.mintB}`);
              }
            } catch (fetchError) {
              console.error('Error fetching token info:', fetchError);
            }
          } catch (err) {
            console.error('Error processing LPAMM:', err);
          }
        } else {
          // Ensure data is long enough
          if (data.length < 40) {
            console.warn(`Data length ${data.length} is less than expected 40 bytes. Skipping account.`);
            return null;
          }

          amm = new AMM(
            data.readBigUInt64LE(0),
            data.readBigUInt64LE(8),
            data.readBigUInt64LE(16),
            data.readBigUInt64LE(24),
            data.readBigUInt64LE(32),
            program,
            new PublicKey(programId),
            accountData.pubkey
          );
          const signatures = await connection.getSignaturesForAddress(accountData.pubkey, { limit: 50 });
          const transactions = await connection.getParsedTransactions(
            signatures.map((sig) => sig.signature),
            { maxSupportedTransactionVersion: 0 }
          );

          for (const tx of transactions) {
            if (!tx) continue;
            for (const tokenTransfer of tx.meta?.postTokenBalances ?? []) {
              const [maybeUs] = PublicKey.findProgramAddressSync(
                [Buffer.from('bonding-curve'), new PublicKey(tokenTransfer.mint).toBuffer()],
                new PublicKey(programId)
              );
              if (maybeUs.equals(accountData.pubkey)) {
                amm.mintPubkey = new PublicKey(tokenTransfer.mint);
               
                amms.push(amm);
                break;
              }
            }
            if (amm.mintPubkey) break;
          }
        }
        return amm;
      } catch (err) {
        console.error('Error processing account:', err);
        return null;
      }
    }));
  }

  // Filter out null AMMs and return the result
  return amms.filter((amm) => amm !== null);
}

async function calculateAge(connection, address) {
  try {
    const transactions = await connection.getSignaturesForAddress(address, { limit: 1 });
    if (transactions.length === 0 || !transactions[0].blockTime) return null;
    return Math.floor(Date.now() / 1000) - transactions[0].blockTime;
  } catch (error) {
    console.error('Error calculating age:', error);
    return null;
  }
}

async function generatePairs(connection, amms, programs, count, redisClient) {
  const ammSlice = amms.slice(0, count);
  const pairs = [];

  // Process AMMs in batches of 100
  const batchSize = 100;
  for (let i = 0; i < ammSlice.length; i += batchSize) {
    const batch = ammSlice.slice(i, i + batchSize);
    const mintPubkeys = batch.map(amm => amm.mintPubkey).filter(Boolean);

    // Fetch account infos for the batch
    const accountInfos = await connection.getMultipleAccountsInfo(mintPubkeys);

    // Process each AMM in the batch using Promise.all
    await Promise.all(batch.map(async (amm, j) => {
      if (!amm.mintPubkey) return;

      let relevantMint;
      let isBondingCurve;

      if (PROGRAM_IDS.includes(amm.programId.toBase58())) {
        relevantMint = amm.mintPubkey;
        isBondingCurve = true;
      } else if (amm.programId.toBase58() === LP_PROGRAM_ID) {
        relevantMint = amm.mintPubkey;
        isBondingCurve = false;
      } else {
        console.error(`Unknown program ID: ${amm.programId}`);
        return;
      }

      // Decode mint info using MintLayout

      const [metadataResult] = await fetchTokenMetadata([relevantMint.toBase58()]);
      const metadata = { ...metadataResult?.content, ...metadataResult?.content?.metadata };
      const age = await calculateAge(connection, relevantMint);
      // Retrieve OHLCV data from Redis
      const ohlcvKey = `OHLCV:${amm.mintPubkey.toBase58()}`;
      let ohlcvData = null;
      try {
        const ohlcvJson = await redisClient.hGet(ohlcvKey, 'data');
        ohlcvData = ohlcvJson ? JSON.parse(ohlcvJson) : null;
      } catch (error) {
        console.error('Error retrieving OHLCV data from Redis:', error);
      }

      // Calculate percentage changes and ensure we have valid data
      const latestData = ohlcvData && ohlcvData.length > 0 ? ohlcvData[ohlcvData.length - 1] : null;
      const change5m = latestData && latestData.open5m ? calculatePercentageChange(latestData.close, latestData.open5m) : null;
      const change1h = latestData && latestData.open1h ? calculatePercentageChange(latestData.close, latestData.open1h) : null;
      const change6h = latestData && latestData.open6h ? calculatePercentageChange(latestData.close, latestData.open6h) : null;
      const change24h = latestData && latestData.open24h ? calculatePercentageChange(latestData.close, latestData.open24h) : null;
      const completed = isBondingCurve ? Math.min(100, Math.max(0, Math.floor((await connection.getBalance(amm.address) / (85 * 10 ** 9)) * 100))) : 0;

      
      pairs.push({
        id: `${ammSlice.indexOf(amm) + 1}-${relevantMint.toBase58()}`,
        token: metadata?.name || 'Unknown',
        price: latestData?.close ? `$${latestData.close.toFixed(6)}` : 'N/A',
        age: age !== null ? age.toString() : 'N/A',
        buys: latestData?.buys ?? 'N/A',
        sells: latestData?.sells ?? 'N/A',
        volume: latestData?.volume ? `$${latestData.volume.toFixed(2)}` : 'N/A',
        makers: latestData?.makers ?? 'N/A',
        '5m': change5m !== null ? `${change5m.toFixed(2)}%` : 'N/A',
        '1h': change1h !== null ? `${change1h.toFixed(2)}%` : 'N/A',
        '6h': change6h !== null ? `${change6h.toFixed(2)}%` : 'N/A',
        '24h': change24h !== null ? `${change24h.toFixed(2)}%` : 'N/A',
        mint: {
          address: relevantMint.toBase58(),
          metadata: {
            description: metadata?.description || null,
            image: metadata?.image || null,
            name: metadata?.name || null,
            symbol: metadata?.symbol || null,
          },
        },
        programId: amm.programId.toBase58(),
        isBondingCurve,
        address:amm.address.toBase58(),

    baseTokenMint: amm.baseTokenMint ? amm.baseTokenMint.toBase58() : null,
    quoteTokenMint:  amm.quoteTokenMint ? amm.quoteTokenMint.toBase58() : null,
    completed
      });
    }));
  }

  return pairs;
}

async function createOHLCVEntry(currentPrice) {
  const timestamp = Date.now() / 1000;
  return {
    timestamp,
    open: currentPrice,
    high: currentPrice,
    low: currentPrice,
    close: currentPrice,
    volume: 0,
    buys: 0,
    sells: 0,
    makers: 0,
    open5m: currentPrice,
    open1h: currentPrice,
    open6h: currentPrice,
    open24h: currentPrice,
  };
}

async function updateOHLCV(connection, amms, redisClient) {
  const updatePromises = amms.map(async (amm) => {
    if (!amm.mintPubkey || !amm.programId) return;

    const currentPrice = await getCurrentPrice(amm, connection);

    const ohlcvKey = `OHLCV:${amm.mintPubkey.toBase58()}`;
    let ohlcvData;

    try {
      const ohlcvJson = await redisClient.hGet(ohlcvKey, 'data');
      ohlcvData = ohlcvJson ? JSON.parse(ohlcvJson) : [];
    } catch (error) {
      console.error(`Error retrieving OHLCV data for ${ohlcvKey}:`, error);
      ohlcvData = [];
    }

    if (!Array.isArray(ohlcvData)) {
      ohlcvData = ohlcvData ? [ohlcvData] : [];
    }

    const newOHLCVEntry = await createOHLCVEntry(currentPrice);

    ohlcvData.push(newOHLCVEntry);

    const maxEntries = 1000;
    if (ohlcvData.length > maxEntries) {
      ohlcvData = ohlcvData.slice(-maxEntries);
    }

    try {
      await redisClient.hSet(ohlcvKey, 'data', JSON.stringify(ohlcvData));
    } catch (error) {
      console.error(`Error storing OHLCV data for ${ohlcvKey}:`, error);
    }
  });

  await Promise.all(updatePromises);
}
async function getCurrentPrice(amm, connection) {
  if (PROGRAM_IDS.includes(amm.programId.toString())) {
    const tokenAmount = BigInt(1e6);
    const price = amm.getBuyPrice(tokenAmount);
    return Number(price) / 1e9;
  } else if (amm.programId.toString() === LP_PROGRAM_ID) {
    if (!amm.mintPubkey) {
      throw new Error('Mint pubkey is not defined for LP AMM');
    }
    const virtualPrice = Number(amm.virtualSolReserves.toString()) / Number(amm.virtualTokenReserves.toString());
    const realPrice = Number(amm.realSolReserves.toString()) / Number(amm.realTokenReserves.toString());
    return (virtualPrice + realPrice) / 2;
  } else {
    throw new Error(`Unknown program ID: ${amm.programId}`);
  }
}

function initializeOHLCV() {
  return {
    open: null,
    high: null,
    low: null,
    close: null,
    volume: 0,
    buys: 0,
    sells: 0,
    makers: 0,
    timestamp: Date.now(),
    open5m: null,
    open1h: null,
    open6h: null,
    open24h: null,
  };
}

function updateOHLCVData(ohlcvData, currentPrice) {
  const now = Date.now();

  if (ohlcvData.open === null) ohlcvData.open = currentPrice;

  if (!ohlcvData.open5m || now - ohlcvData.timestamp >= 5 * 60 * 1000) {
    ohlcvData.open5m = currentPrice;
    ohlcvData.timestamp5m = now;
  }
  if (!ohlcvData.open1h || now - ohlcvData.timestamp >= 60 * 60 * 1000) {
    ohlcvData.open1h = currentPrice;
    ohlcvData.timestamp1h = now;
  }
  if (!ohlcvData.open6h || now - ohlcvData.timestamp >= 6 * 60 * 60 * 1000) {
    ohlcvData.open6h = currentPrice;
    ohlcvData.timestamp6h = now;
  }
  if (!ohlcvData.open24h || now - ohlcvData.timestamp >= 24 * 60 * 60 * 1000) {
    ohlcvData.open24h = currentPrice;
    ohlcvData.timestamp24h = now;
  }

  ohlcvData.close = currentPrice;

  ohlcvData.high = ohlcvData.high ? Math.max(ohlcvData.high, currentPrice) : currentPrice;
  ohlcvData.low = ohlcvData.low ? Math.min(ohlcvData.low, currentPrice) : currentPrice;
}

function calculatePercentageChange(current, previous )  {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

module.exports = {
  generateAMMs,
  generatePairs,
  updateOHLCV,
  getCurrentPrice,
  initializeOHLCV,
  updateOHLCVData,
  calculatePercentageChange,
};