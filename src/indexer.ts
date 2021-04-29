/* This is free and unencumbered software released into the public domain. */

import { Config, parseConfig } from './config.js';

import {
  AccountID,
  BlockHeight,
  ConnectEnv,
  Engine,
  hexToBytes,
  NetworkConfig,
  Transaction,
} from '@aurora-is-near/engine';
import { program } from 'commander';
import externalConfig from 'config';
import pg from 'pg';
import pino, { Logger } from 'pino';

import sql from 'sql-bricks';
const sqlConvert = (sql as any).convert;
(sql as any).convert = (val: unknown) => {
  if (val instanceof Uint8Array) {
    return `'\\x${Buffer.from(val).toString('hex')}'`;
  }
  return sqlConvert(val);
};

export class Indexer {
  protected readonly pgClient: pg.Client;
  protected blockID = 0;

  constructor(
    public readonly config: Config,
    public readonly network: NetworkConfig,
    public readonly logger: Logger,
    public readonly engine: Engine
  ) {
    this.pgClient = new pg.Client(config.database);
  }

  async start(): Promise<void> {
    await this.pgClient.connect();
    const {
      rows: [{ maxID }],
    } = await this.pgClient.query('SELECT MAX(id)::int AS "maxID" FROM block');
    this.blockID = maxID === null ? 0 : maxID + 1;
    this.logger.info(`resuming from block #${this.blockID}`);
    for (;;) {
      await this.indexBlock(this.blockID);
      this.blockID += 1;
    }
  }

  async indexBlock(blockID: BlockHeight): Promise<void> {
    this.logger.info({ block: { id: blockID } }, `indexing block #${blockID}`);
    for (;;) {
      const proxy = await this.engine.getBlock(blockID, {
        transactions: 'full',
        contractID: AccountID.parse(this.config.engine).unwrap(),
      });
      if (proxy.isErr()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const block = proxy.unwrap().getMetadata();
      const query = sql.insert('block', {
        chain: this.network.chainID,
        id: block.number,
        hash: hexToBytes(block.hash!),
        timestamp: new Date((block.timestamp as number) * 1000).toISOString(),
        size: block.size,
        gas_limit: block.gasLimit,
        gas_used: block.gasUsed,
        parent_hash: hexToBytes(block.parentHash),
        transactions_root: block.transactionsRoot,
        state_root: block.stateRoot,
        receipts_root: block.receiptsRoot,
      });
      if (this.config.debug) {
        //console.debug(query.toString()); // DEBUG
      }
      await this.pgClient.query(query.toParams());
      let transactionIndex = 0;
      for (const transaction of block.transactions as Transaction[]) {
        await this.indexTransaction(blockID, transactionIndex, transaction);
        transactionIndex += 1;
      }
      return;
    }
  }

  async indexTransaction(
    blockID: BlockHeight,
    transactionIndex: number,
    transaction: Transaction
  ): Promise<void> {
    this.logger.info(
      {
        block: { id: blockID },
        transaction: { index: transactionIndex, hash: transaction.hash },
      },
      `indexing transaction ${transaction.hash} at #${blockID}:${transactionIndex}`
    );
    const to = transaction.to;
    const query = sql.insert('transaction', {
      block: blockID,
      index: transactionIndex,
      //id: null,
      hash: Buffer.from(hexToBytes(transaction.hash!)),
      from: Buffer.from(transaction.from!.toBytes()),
      to: to?.isSome() ? Buffer.from(to.unwrap().toBytes()) : null,
      nonce: transaction.nonce,
      gas_price: 0, // TODO
      gas_limit: 0, // TODO
      gas_used: 0, // TODO
      value: transaction.value,
      data: transaction.data,
      v: transaction.v,
      r: transaction.r,
      s: transaction.s,
      status: true, // TODO
    });
    if (this.config.debug) {
      //console.debug(query.toParams()); // DEBUG
    }
    await this.pgClient.query(query.toParams());
  }

  async indexEvent(): Promise<void> {
    // TODO
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface ProcessEnv extends ConnectEnv {}
  }
}

async function main(argv: string[], env: NodeJS.ProcessEnv) {
  program
    .option('-d, --debug', 'enable debug output')
    .option('-v, --verbose', 'enable verbose output')
    .option(
      '--database <url>',
      `specify PostgreSQL database URL (default: none)`
    )
    .option(
      '--network <network>',
      `specify NEAR network ID (default: "${env.NEAR_ENV || 'local'}")`
    )
    .option(
      '--endpoint <url>',
      `specify NEAR RPC endpoint URL (default: "${env.NEAR_URL || ''}")`
    )
    .option(
      '--engine <account>',
      `specify Aurora Engine account ID (default: "${
        env.AURORA_ENGINE || 'aurora.test.near'
      }")`
    )
    .parse(argv);

  const [network, config] = parseConfig(
    program.opts() as Config,
    (externalConfig as unknown) as Config,
    env
  );

  if (config.debug) {
    for (const source of externalConfig.util.getConfigSources()) {
      console.error(`Loaded configuration file ${source.name}.`);
    }
    console.error('Configuration:', config);
  }

  const logger = pino();
  const engine = await Engine.connect(
    {
      network: network.id,
      endpoint: config.endpoint,
      contract: config.engine,
    },
    env
  );

  logger.info('starting indexer');
  const indexer = new Indexer(config, network, logger, engine);
  await indexer.start();
}

main(process.argv, process.env);
