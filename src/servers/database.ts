/* This is free and unencumbered software released into the public domain. */

import { SkeletonServer } from './skeleton.js';

import * as api from '../api.js';
//import { unimplemented } from '../errors.js';
import { compileTopics } from '../topics.js';

import { Address, BlockID, bytesToHex, exportJSON, formatU256, hexToBytes, intToHex } from '@aurora-is-near/engine';
import pg from 'pg';

import sql from 'sql-bricks';
const sqlConvert = (sql as any).convert;
(sql as any).convert = (val: unknown) => {
    if (val instanceof Uint8Array) {
        return `'\\x${Buffer.from(val).toString('hex')}'`;
    }
    return sqlConvert(val);
};

export class DatabaseServer extends SkeletonServer {
    protected pgClient?: pg.Client;

    protected async _init(): Promise<void> {
        const pgClient = new pg.Client(this.config.database);
        this.pgClient = pgClient;
        await pgClient.connect();

        // Add type parsers for relevant numeric types:
        (pgClient as any).setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));
        (pgClient as any).setTypeParser(pg.types.builtins.NUMERIC, (val: string) => BigInt(val));
        for (const typeName of ['blockno', 'chainid', 'u64', 'u256']) {
            const query = sql.select('oid').from('pg_type').where({'typname': typeName});
            const { rows } = await pgClient.query(query.toParams());
            if (rows.length > 0) {
                const [{ oid }] = rows;
                (pgClient as any).setTypeParser(oid, (val: string) => BigInt(val));
            }
        }

        // Listen to new block notifications:
        pgClient.on('notification', (message: pg.Notification) => {
            if (!message.payload) return;
            if (message.channel === 'block') {
                const blockID = parseInt(message.payload);
                if (isNaN(blockID)) return; // ignore UFOs

                this.logger.info({ block: { id: blockID } }, "block received");

                // TODO: notify subscribers
            }
        });
        pgClient.query('LISTEN block');
    }

    protected _query(query: string | sql.SelectStatement, args?: unknown[]): Promise<pg.QueryResult<any>> {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.pgClient!.query((typeof query === 'string') ? query : query.toParams(), args);
    }

    async eth_blockNumber(): Promise<api.Quantity> {
        const { rows: [{ result }] } = await this._query('SELECT eth_blockNumber() AS result');
        return intToHex(result);
    }

    async eth_call(transaction: api.TransactionForCall, blockNumber?: api.Quantity | api.Tag): Promise<api.Data> {
        return super.eth_call(transaction, blockNumber); // TODO
    }

    async eth_chainId(): Promise<api.Quantity> { // EIP-695
        const chainID = (await this.engine.getChainID()).unwrap();
        return intToHex(chainID);
    }

    async eth_coinbase(): Promise<api.Data> {
        return (await this.engine.getCoinbase()).unwrap().toString();
    }

    async eth_getBalance(address: api.Data, blockNumber?: api.Quantity | api.Tag): Promise<api.Quantity> {
        const address_ = Address.parse(address).unwrap();
        const balance = (await this.engine.getBalance(address_)).unwrap();
        return intToHex(balance);
    }

    async eth_getBlockByHash(blockHash: api.Data, fullObject?: boolean): Promise<api.BlockResult | null> {
        const blockHash_ = blockHash.startsWith('0x') ? hexToBytes(blockHash) : blockHash;
        try {
            const { rows } = await this._query('SELECT * FROM eth_getBlockByHash($1)', [blockHash_]);
            return exportJSON(rows.map((row: Record<string, unknown>) => {
                row['uncles'] = [];
                row['transactions'] = []; // TODO
                return row;
            }));
        } catch (error) {
            if (this.config.debug) {
                console.debug('eth_getBlockByHash', error);
            }
            return null;
        }
    }

    async eth_getBlockByNumber(blockNumber: api.Quantity | api.Tag, fullObject?: boolean): Promise<api.BlockResult | null> {
        const blockNumber_ = blockNumber.startsWith('0x') ? parseInt(blockNumber, 16) : blockNumber;
        try {
            const { rows } = await this._query('SELECT * FROM eth_getBlockByNumber($1)', [blockNumber_]);
            return exportJSON(rows.map((row: Record<string, unknown>) => {
                row['uncles'] = [];
                row['transactions'] = []; // TODO
                return row;
            }));
        } catch (error) {
            if (this.config.debug) {
                console.debug('eth_getBlockByNumber', error);
            }
            return null;
        }
    }

    async eth_getBlockTransactionCountByHash(blockHash: api.Data): Promise<api.Quantity | null> {
        const blockHash_ = blockHash.startsWith('0x') ? hexToBytes(blockHash) : blockHash;
        const { rows: [{ result }] } = await this._query('SELECT eth_getBlockTransactionCountByHash($1) AS result', [blockHash_]);
        return intToHex(result);
    }

    async eth_getBlockTransactionCountByNumber(blockNumber: api.Quantity | api.Tag): Promise<api.Quantity | null> {
        const blockNumber_ = blockNumber.startsWith('0x') ? parseInt(blockNumber, 16) : blockNumber;
        const { rows: [{ result }] } = await this._query('SELECT eth_getBlockTransactionCountByNumber($1) AS result', [blockNumber_]);
        return intToHex(result);
    }

    async eth_getCode(address: api.Data, _blockNumber: api.Quantity | api.Tag): Promise<api.Data> {
        const address_ = Address.parse(address).unwrap();
        const code = (await this.engine.getCode(address_)).unwrap();
        return bytesToHex(code);
    }

    async eth_getFilterChanges(filterID: api.Quantity): Promise<api.LogObject[]> {
        const filterID_ = parseInt(filterID, 16);
        if (filterID_ === 0) {
            return [];
        }

        const { rows: [{ type }] } = await this._query(sql.select('type').from('filter').where({'id': filterID_}));
        switch (type) {
            case 'block': {
                const { rows } = await this._query('SELECT * FROM eth_getFilterChanges_block($1::bigint)', [filterID_]);
                const buffers = rows.flatMap((row: Record<string, unknown>) => Object.values(row)) as Buffer[];
                return buffers.map(bytesToHex);
            }
            case 'event': {
                const { rows } = await this._query('SELECT * FROM eth_getFilterChanges_event($1::bigint)', [filterID_]);
                return exportJSON(rows);
            }
            case 'transaction':
            default: return [];
        }
    }

    async eth_getFilterLogs(filterID: api.Quantity): Promise<api.LogObject[]> {
        const filterID_ = parseInt(filterID, 16);
        if (filterID_ === 0) {
            return [];
        }

        const { rows: [{ type }] } = await this._query(sql.select('type').from('filter').where({'id': filterID_}));
        switch (type) {
            case 'block': {
                const { rows } = await this._query('SELECT * FROM eth_getFilterLogs_block($1::bigint)', [filterID_]);
                const buffers = rows.flatMap((row: Record<string, unknown>) => Object.values(row)) as Buffer[];
                return buffers.map(bytesToHex);
            }
            case 'event': {
                const { rows } = await this._query('SELECT * FROM eth_getFilterLogs_event($1::bigint)', [filterID_]);
                return exportJSON(rows);
            }
            case 'transaction':
            default: return [];
        }
    }

    async eth_getLogs(filter: api.FilterOptions): Promise<api.LogObject[]> {
        const { rows: [{ id: latestBlockID }] } = await this._query('SELECT eth_blockNumber() AS id');
        const where = [];
        if (filter.blockHash !== undefined && filter.blockHash !== null) { // EIP-234
            where.push({ 'b.hash': hexToBytes(filter.blockHash) });
        }
        else {
            const fromBlock = resolveBlockSpec(latestBlockID, filter.fromBlock);
            if (fromBlock) {
                where.push(sql.gte('b.id', fromBlock));
            }
            const toBlock = resolveBlockSpec(latestBlockID, filter.toBlock);
            if (toBlock) {
                where.push(sql.lte('b.id', toBlock));
            }
        }
        if (filter.address) {
            const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address])
                .map((address: string) => Address.parse(address).unwrap());
            where.push(sql.in('t.from', addresses.map((address: Address) => address.toBytes())));
        }
        if (filter.topics) {
            const clauses = compileTopics(filter.topics);
            if (clauses) {
                where.push(clauses);
            }
        }

        const query =
            sql.select(
                'b.id AS "blockNumber"',
                'b.hash AS "blockHash"',
                '0 AS "transactionIndex"',     // TODO
                't.hash AS "transactionHash"',
                '0 AS "logIndex"',             // TODO
                't.from AS "address"',         // FIXME
                'e.topics AS "topics"',
                'e.data AS "data"',
                '0::boolean AS "removed"'
            )
            .from('event e')
            .leftJoin('transaction t', {'e.transaction': 't.id'})
            .leftJoin('block b', {'t.block': 'b.id'})
            .where(sql.and(...where));
        if (this.config.debug) {
            console.debug('eth_getLogs', 'query:', query.toParams());
            console.debug('eth_getLogs', 'query:', query.toString());
        }
        const { rows } = await this._query(query);
        if (this.config.debug) {
            console.debug('eth_getLogs', 'result:', rows);
        }
        return exportJSON(rows);
    }

    async eth_getStorageAt(address: api.Data, key: api.Quantity, blockNumber: api.Quantity | api.Tag): Promise<api.Data> {
        const address_ = Address.parse(address).unwrap();
        const result = (await this.engine.getStorageAt(address_, key)).unwrap();
        return formatU256(result);
    }

    async eth_getTransactionByBlockHashAndIndex(blockHash: api.Data, transactionIndex: api.Quantity): Promise<api.TransactionResult | null> {
        const [blockHash_, transactionIndex_] = [hexToBytes(blockHash), parseInt(transactionIndex)];
        try {
            const { rows } = await this._query('SELECT * FROM eth_getTransactionByBlockHashAndIndex($1::hash, $2::int)', [blockHash_, transactionIndex_]);
            return (rows.length > 0) ? exportJSON(rows[0]) : null;
        } catch (error) {
            if (this.config.debug) {
                console.debug('eth_getTransactionByBlockHashAndIndex', error);
            }
            return null;
        }
    }

    async eth_getTransactionByBlockNumberAndIndex(blockNumber: api.Quantity | api.Tag, transactionIndex: api.Quantity): Promise<api.TransactionResult | null> {
        const [blockNumber_, transactionIndex_] = [parseInt(blockNumber), parseInt(transactionIndex)];
        try {
            const { rows } = await this._query('SELECT * FROM eth_getTransactionByBlockNumberAndIndex($1::blockno, $2::int)', [blockNumber_, transactionIndex_]);
            return (rows.length > 0) ? exportJSON(rows[0]) : null;
        } catch (error) {
            if (this.config.debug) {
                console.debug('eth_getTransactionByBlockNumberAndIndex', error);
            }
            return null;
        }
    }

    async eth_getTransactionByHash(transactionHash: api.Data): Promise<api.TransactionResult | null> {
        const transactionHash_ = hexToBytes(transactionHash);
        try {
            const { rows } = await this._query('SELECT * FROM eth_getTransactionByHash($1)', [transactionHash_]);
            return (rows.length > 0) ? exportJSON(rows[0]) : null;
        } catch (error) {
            if (this.config.debug) {
                console.debug('eth_getTransactionByHash', error);
            }
            return null;
        }
    }

    async eth_getTransactionCount(address: api.Data, _blockNumber: api.Quantity | api.Tag): Promise<api.Quantity> {
        const address_ = Address.parse(address).unwrap();
        const nonce = (await this.engine.getNonce(address_)).unwrap();
        return intToHex(nonce);
    }

    async eth_getTransactionReceipt(transactionHash: string): Promise<api.TransactionReceipt | null> {
        return super.eth_getTransactionReceipt(transactionHash); // TODO
    }

    async eth_getUncleCountByBlockHash(blockHash: api.Data): Promise<api.Quantity | null> {
        const blockHash_ = blockHash.startsWith('0x') ? hexToBytes(blockHash) : blockHash;
        const { rows: [{ result }] } = await this._query('SELECT eth_getUncleCountByBlockHash($1) AS result', [blockHash_]);
        return intToHex(result);
    }

    async eth_getUncleCountByBlockNumber(blockNumber: api.Quantity | api.Tag): Promise<api.Quantity | null> {
        const blockNumber_ = blockNumber.startsWith('0x') ? parseInt(blockNumber, 16) : blockNumber;
        const { rows: [{ result }] } = await this._query('SELECT eth_getUncleCountByBlockNumber($1) AS result', [blockNumber_]);
        return intToHex(result);
    }

    async eth_newBlockFilter(): Promise<api.Quantity> {
        const { rows: [{ id }] } = await this._query('SELECT eth_newBlockFilter($1) AS id', ['0.0.0.0']); // TODO: IPv4
        return intToHex(id);
    }

    async eth_newFilter(filter: api.FilterOptions): Promise<api.Quantity> {
        return super.eth_newFilter(filter); // TODO
    }

    async eth_newPendingTransactionFilter(): Promise<api.Quantity> {
        const { rows: [{ id }] } = await this._query('SELECT eth_newPendingTransactionFilter() AS id');
        return intToHex(id);
    }

    async eth_sendRawTransaction(transaction: api.Data): Promise<api.Data> {
        const output = (await this.engine.rawCall(transaction)).unwrap();
        return bytesToHex(output);
    }

    async eth_sendTransaction(transaction: api.TransactionForSend): Promise<api.Data> {
        return super.eth_sendTransaction(transaction); // TODO
    }

    async eth_sign(account: api.Data, message: api.Data): Promise<api.Data> {
        return super.eth_sign(account, message); // TODO
    }

    async eth_signTransaction(transaction: api.TransactionForSend): Promise<api.Data> {
        return super.eth_signTransaction(transaction); // TODO
    }

    async eth_signTypedData(address: api.Data, data: api.TypedData): Promise<api.Data> { // EIP-712
        return super.eth_signTypedData(address, data); // TODO
    }

    async eth_uninstallFilter(filterID: api.Quantity): Promise<boolean> {
        const filterID_ = parseInt(filterID, 16);
        if (filterID_ === 0) {
            return true;
        }
        const { rows: [{ found }] } = await this._query('SELECT eth_uninstallFilter($1::inet, $2::bigint) AS found', ['0.0.0.0', filterID_]); // TODO: IPv4
        return found;
    }
}

function resolveBlockSpec(latestBlockID: BlockID, blockSpec?: string): BlockID {
    if (blockSpec === undefined || blockSpec === null) {
        return latestBlockID;
    }
    switch (blockSpec) {
        case 'earliest': return 0;
        case 'latest': return latestBlockID;
        case 'pending': return latestBlockID;
        default: {
            const blockID = parseInt(blockSpec, 16);
            if (isNaN(blockID)) {
                throw Error(`invalid block ID: ${ blockSpec }`)
            }
            return blockID;
        }
    }
}
