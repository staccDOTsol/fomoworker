const { createClient } = require('redis');
const dotenv = require('dotenv');
const nodecron = require('node-cron');
const { AnchorProvider, Program } = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js');

const { PROGRAM_IDS, LP_PROGRAM_ID } = require('./src/data');

const {
  generateAMMs,
  updateOHLCV,
  generatePairs,
} = require('./src/pairs');

dotenv.config();

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error('REDIS_URL is not defined in the environment variables');
}

// Redis client
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await redisClient.connect();
})();

const getPairsNew = async () => {
  const count = 500;
  const connection = new Connection(
    `https://rpc.ironforge.network/mainnet?apiKey=${process.env.IRONFORGE_API_KEY}`
  );

  try {
    // Prepare programs
    const programs = {};
    const provider = new AnchorProvider(connection, undefined, {});

    const allProgramIds = [...PROGRAM_IDS, LP_PROGRAM_ID];

    await Promise.all(
      allProgramIds.map(async (programId) => {
        const IDL = await Program.fetchIdl(new PublicKey(programId), provider);
        if (IDL) {
          programs[programId] = new Program(IDL, provider);
        }
      })
    );

    // Generate AMMs
    const amms = await generateAMMs(connection, programs);

    // Update OHLCV data
    await updateOHLCV(connection, amms, redisClient);

    // Generate pairs using the updated OHLCV data
    const pairs = await generatePairs(connection, amms, programs, count, redisClient);
    console.log(`Generated ${pairs.length} pairs`);

    // Convert BigInt values to strings before JSON serialization
    const serializedPairsNew = pairs.map((pair) => {
      return Object.fromEntries(
        Object.entries(pair).map(([key, value]) => {
          if (typeof value === 'bigint') {
            return [key, value.toString()];
          }
          return [key, value];
        })
      );
    });

    // Temp setting fake flags
    const serializedPairsNewWithFlags = serializedPairsNew.map((pair) => {
      return {
        ...pair,
        is_trending: Math.random() < 0.5,
        is_new: Math.random() < 0.5,
        is_top: Math.random() < 0.5,
        is_rising: Math.random() < 0.5,
      };
    });

    await redisClient.set('serializedPairsNew', JSON.stringify(serializedPairsNewWithFlags));
    console.log('NEW PAIRS stored in Redis');
  } catch (error) {
    console.error('Error in GET function:', error);
    return { error: error.message };
  }
}
getPairsNew()

nodecron.schedule('*/1 * * * *', getPairsNew);