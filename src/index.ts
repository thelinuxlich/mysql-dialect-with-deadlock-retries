import {
	CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	MysqlAdapter,
	type MysqlDialectConfig,
	MysqlIntrospector,
	type MysqlOkPacket,
	type MysqlPool,
	type MysqlPoolConnection,
	MysqlQueryCompiler,
	type MysqlQueryResult,
	type QueryCompiler,
	type QueryResult,
	type TransactionSettings,
} from "kysely";

import { type RetryOptions, retry } from "@harisk/retryx";

const PRIVATE_RELEASE_METHOD = Symbol();

type DrainOuterGeneric<T> = [T] extends [unknown] ? T : never;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type ShallowRecord<K extends keyof any, T> = DrainOuterGeneric<{
	[P in K]: T;
}>;

// biome-ignore lint/complexity/noBannedTypes: <explanation>
function isFunction(obj: unknown): obj is Function {
	return typeof obj === "function";
}

function isObject(obj: unknown): obj is ShallowRecord<string, unknown> {
	return typeof obj === "object" && obj !== null;
}

function isString(obj: unknown): obj is string {
	return typeof obj === "string";
}

interface StackHolder {
	stack: string;
}

function isStackHolder(obj: unknown): obj is StackHolder {
	return isObject(obj) && isString(obj.stack);
}

function extendStackTrace(err: unknown, stackError: Error): unknown {
	if (isStackHolder(err) && stackError.stack) {
		// Remove the first line that just says `Error`.
		const stackExtension = stackError.stack.split("\n").slice(1).join("\n");

		err.stack += `\n${stackExtension}`;
		return err;
	}

	return err;
}

interface MysqlWithDeadlockRetriesConfig extends MysqlDialectConfig {
	deadlock?: RetryOptions;
}

class MysqlDriverWithDeadlockRetries implements Driver {
	readonly #config: MysqlWithDeadlockRetriesConfig;
	readonly #connections = new WeakMap<
		MysqlPoolConnection,
		DatabaseConnection
	>();
	#pool?: MysqlPool;

	constructor(configOrPool: MysqlWithDeadlockRetriesConfig) {
		this.#config = { ...configOrPool };
	}

	async init(): Promise<void> {
		this.#pool = isFunction(this.#config.pool)
			? await this.#config.pool()
			: this.#config.pool;
	}

	async acquireConnection(): Promise<DatabaseConnection> {
		const rawConnection = await this.#acquireConnection();
		let connection = this.#connections.get(rawConnection);

		if (!connection) {
			connection = new MysqlConnectionWithDeadlockRetries(
				rawConnection,
				this.#config,
			);
			this.#connections.set(rawConnection, connection);

			// The driver must take care of calling `onCreateConnection` when a new
			// connection is created. The `mysql2` module doesn't provide an async hook
			// for the connection creation. We need to call the method explicitly.
			if (this.#config?.onCreateConnection) {
				await this.#config.onCreateConnection(connection);
			}
		}

		if (this.#config?.onReserveConnection) {
			await this.#config.onReserveConnection(connection);
		}

		return connection;
	}

	async #acquireConnection(): Promise<MysqlPoolConnection> {
		return new Promise((resolve, reject) => {
			this.#pool?.getConnection((err, rawConnection) => {
				if (err) {
					reject(err);
				} else {
					resolve(rawConnection);
				}
			});
		});
	}

	async beginTransaction(
		connection: DatabaseConnection,
		settings: TransactionSettings,
	): Promise<void> {
		if (settings.isolationLevel) {
			// On MySQL this sets the isolation level of the next transaction.
			await connection.executeQuery(
				CompiledQuery.raw(
					`set transaction isolation level ${settings.isolationLevel}`,
				),
			);
		}
		await connection.executeQuery(CompiledQuery.raw("begin"));
	}

	async commitTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("commit"));
	}

	async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("rollback"));
	}

	releaseConnection(
		connection: MysqlConnectionWithDeadlockRetries,
		//@ts-ignore
	): Promise<void> {
		connection[PRIVATE_RELEASE_METHOD]();
	}

	async destroy(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#pool?.end((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}
}

function isOkPacket(obj: unknown): obj is MysqlOkPacket {
	return isObject(obj) && "insertId" in obj && "affectedRows" in obj;
}

class MysqlConnectionWithDeadlockRetries implements DatabaseConnection {
	readonly #rawConnection: MysqlPoolConnection;
	readonly #config: MysqlWithDeadlockRetriesConfig;

	constructor(
		rawConnection: MysqlPoolConnection,
		config: MysqlWithDeadlockRetriesConfig,
	) {
		this.#rawConnection = rawConnection;
		this.#config = config;
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		try {
			const result = await this.#executeQuery(compiledQuery, this.#config);

			if (isOkPacket(result)) {
				const { insertId, affectedRows, changedRows } = result;

				const numAffectedRows =
					affectedRows !== undefined && affectedRows !== null
						? BigInt(affectedRows)
						: undefined;

				const numChangedRows =
					changedRows !== undefined && changedRows !== null
						? BigInt(changedRows)
						: undefined;

				return {
					insertId:
						insertId !== undefined &&
						insertId !== null &&
						insertId.toString() !== "0"
							? BigInt(insertId)
							: undefined,
					// TODO: remove.
					numUpdatedOrDeletedRows: numAffectedRows,
					numAffectedRows,
					numChangedRows,
					rows: [],
				};
				// biome-ignore lint/style/noUselessElse: <explanation>
			} else if (Array.isArray(result)) {
				return {
					rows: result as O[],
				};
			}

			return {
				rows: [],
			};
		} catch (err) {
			throw extendStackTrace(err, new Error("Error executing query"));
		}
	}

	#executeQuery(
		compiledQuery: CompiledQuery,
		options: MysqlWithDeadlockRetriesConfig,
	): Promise<MysqlQueryResult> {
		return new Promise((resolve, reject) => {
			this.#rawConnection.query(
				compiledQuery.sql,
				compiledQuery.parameters,
				(err, result) => {
					if (err) {
						if (
							typeof err === "object" &&
							err !== null &&
							"code" in err &&
							// @ts-ignore
							[
								"ER_LOCK_DEADLOCK",
								"ER_LOCK_WAIT_TIMEOUT",
								"ER_LOCK_TIMEOUT",
							].includes(err.code as string) &&
							options.deadlock !== undefined
						) {
							resolve(
								retry(async () => {
									// Add a small delay before retrying to allow other transactions to complete
									await new Promise((r) => setTimeout(r, 50));
									return new Promise<MysqlQueryResult>(
										(innerResolve, innerReject) => {
											this.#rawConnection.query(
												compiledQuery.sql,
												compiledQuery.parameters,
												(innerErr, innerResult) => {
													if (innerErr) {
														innerReject(innerErr);
													} else {
														innerResolve(innerResult);
													}
												},
											);
										},
									);
								}, options.deadlock),
							);
						} else {
							reject(err);
						}
					} else {
						resolve(result);
					}
				},
			);
		});
	}

	async *streamQuery<O>(
		compiledQuery: CompiledQuery,
		_chunkSize: number,
	): AsyncIterableIterator<QueryResult<O>> {
		const stream = this.#rawConnection
			.query(compiledQuery.sql, compiledQuery.parameters)
			.stream<O>({
				objectMode: true,
			});

		try {
			for await (const row of stream) {
				yield {
					rows: [row],
				};
			}
		} catch (ex) {
			if (
				ex &&
				typeof ex === "object" &&
				"code" in ex &&
				// @ts-ignore
				ex.code === "ERR_STREAM_PREMATURE_CLOSE"
			) {
				// Most likely because of https://github.com/mysqljs/mysql/blob/master/lib/protocol/sequences/Query.js#L220
				return;
			}

			throw ex;
		}
	}

	[PRIVATE_RELEASE_METHOD](): void {
		this.#rawConnection.release();
	}
}

export class MySQLDialectWithDeadlockRetries implements Dialect {
	#config: MysqlWithDeadlockRetriesConfig;
	constructor(config: MysqlWithDeadlockRetriesConfig) {
		this.#config = config;
	}
	createDriver(): Driver {
		return new MysqlDriverWithDeadlockRetries(this.#config);
	}

	createQueryCompiler(): QueryCompiler {
		return new MysqlQueryCompiler();
	}

	createAdapter(): DialectAdapter {
		return new MysqlAdapter();
	}

	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new MysqlIntrospector(db);
	}
}
