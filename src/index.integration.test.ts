import { execSync } from "node:child_process";
import { Kysely, sql } from "kysely";
import { createPool } from "mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySQLDialectWithDeadlockRetries } from "./index.js";

interface Database {
	users: {
		id: number;
		name: string;
	};
	deadlock_test: {
		id: number;
		value: number;
	};
}

let db: Kysely<Database> | undefined;

describe("MySQLDialectWithDeadlockRetries Integration Tests", () => {
	beforeAll(async () => {
		try {
			execSync("docker compose down || true");
			console.log("Starting MySQL container using docker-compose...");
			execSync("docker compose up -d mysql");
			console.log("Waiting for MySQL to be ready...");
			let ready = false;
			let attempts = 0;

			while (!ready && attempts < 30) {
				try {
					attempts++;
					execSync(
						"docker exec mysql-dialect-deadlock-test mysqladmin ping -h localhost -u root -ptestpassword",
					);
					ready = true;
					console.log("MySQL is ready!");
					await new Promise((resolve) => setTimeout(resolve, 3000));
				} catch (e) {
					console.log(
						`Waiting for MySQL to be ready (attempt ${attempts}/30)...`,
					);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}

			if (!ready) {
				throw new Error("MySQL failed to become ready in time");
			}

			db = new Kysely<Database>({
				dialect: new MySQLDialectWithDeadlockRetries({
					pool: createPool({
						host: "localhost",
						port: 3307,
						user: "root",
						password: "testpassword",
						database: "testdb",
					}),
					deadlock: {
						maxAttempts: 3,
						onRetry: (error, attempt) => {
							console.log(
								`Retry attempt ${attempt} after error: ${error.message}`,
							);
						},
					},
				}),
			});

			await db.schema
				.createTable("users")
				.ifNotExists()
				.addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
				.addColumn("name", "varchar(255)", (col) => col.notNull())
				.execute();

			await db.schema
				.createTable("deadlock_test")
				.ifNotExists()
				.addColumn("id", "integer", (col) => col.primaryKey())
				.addColumn("value", "integer", (col) => col.notNull())
				.execute();

			await db
				.insertInto("users")
				.values([
					{ id: 1, name: "User 1" },
					{ id: 2, name: "User 2" },
					{ id: 3, name: "User 3" },
				])
				.ignore()
				.execute();

			await db
				.insertInto("deadlock_test")
				.values([
					{ id: 1, value: 10 },
					{ id: 2, value: 20 },
				])
				.ignore()
				.execute();

			console.log("Database setup completed successfully");
		} catch (error) {
			console.error("Setup failed:", error);
			throw error;
		}
	}, 60000);

	afterAll(async () => {
		if (db) await db.destroy();
		try {
			console.log("Stopping and removing MySQL container...");
			execSync("docker compose down || true");
			console.log("Container stopped and removed successfully");
		} catch (error) {
			console.error("Error stopping container:", error);
		}
	}, 30000);

	it("should execute a simple query", async () => {
		if (!db) {
			throw new Error("Database not initialized");
		}
		const users = await db.selectFrom("users").select(["id", "name"]).execute();
		expect(users).toHaveLength(3);
		expect(users[0]?.name).toBe("User 1");
		expect(users[1]?.name).toBe("User 2");
		expect(users[2]?.name).toBe("User 3");
	});

	it("should execute an update query", async () => {
		if (!db) {
			throw new Error("Database not initialized");
		}
		const uniqueName = `Updated User ${Date.now()}`;
		await db
			.updateTable("users")
			.set({ name: uniqueName })
			.where("id", "=", 3)
			.execute();
		const user = await db
			.selectFrom("users")
			.select(["id", "name"])
			.where("id", "=", 3)
			.executeTakeFirst();

		expect(user?.name).toBe(uniqueName);
	});

	it("should retry on deadlock and eventually succeed", async () => {
		if (!db) {
			throw new Error("Database not initialized");
		}
		let retryAttempts = 0;
		const dbWithRetryTracking = new Kysely<Database>({
			dialect: new MySQLDialectWithDeadlockRetries({
				pool: createPool({
					host: "localhost",
					port: 3307,
					user: "root",
					password: "testpassword",
					database: "testdb",
					connectionLimit: 20,
				}),
				deadlock: {
					maxAttempts: 5,
					onRetry: (error, attempt) => {
						console.log(
							`Custom onRetry callback: attempt ${attempt}, error: ${error.message}`,
						);
						retryAttempts++;
					},
				},
			}),
		});

		try {
			console.log("Setting innodb_lock_wait_timeout to a lower value...");
			await sql`SET GLOBAL innodb_lock_wait_timeout = 1`.execute(
				dbWithRetryTracking,
			);
			await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(
				dbWithRetryTracking,
			);
			await dbWithRetryTracking.schema
				.dropTable("deadlock_test")
				.ifExists()
				.execute();
			await dbWithRetryTracking.schema
				.createTable("deadlock_test")
				.ifNotExists()
				.addColumn("id", "integer", (col) => col.primaryKey())
				.addColumn("value", "integer", (col) => col.notNull())
				.execute();
			await dbWithRetryTracking
				.insertInto("deadlock_test")
				.values([
					{ id: 1, value: 10 },
					{ id: 2, value: 20 },
				])
				.execute();

			console.log("Setting up table-level locking to force deadlocks...");
			const createTableLockTransaction = (
				name: string,
				lockOrder: string[],
			) => {
				return async () => {
					try {
						console.log(
							`Transaction ${name}: Acquiring locks in order: ${lockOrder.join(", ")}`,
						);

						return await dbWithRetryTracking
							.transaction()
							.execute(async (trx) => {
								await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(
									trx,
								);
								for (const tableLock of lockOrder) {
									console.log(
										`Transaction ${name}: Acquiring ${tableLock} lock`,
									);

									await sql`LOCK TABLES deadlock_test ${sql.raw(tableLock)}`.execute(
										trx,
									);

									await new Promise((resolve) => setTimeout(resolve, 50));

									if (tableLock.includes("WRITE")) {
										await trx
											.updateTable("deadlock_test")
											.set((eb) => ({ value: eb("value", "+", 1) }))
											.where("id", "=", 1)
											.execute();
									} else {
										await trx
											.selectFrom("deadlock_test")
											.selectAll()
											.where("id", "=", 1)
											.execute();
									}
									await sql`UNLOCK TABLES`.execute(trx);
								}

								return `Transaction ${name} completed`;
							});
					} catch (error) {
						console.error(`Transaction ${name} failed:`, error);
						throw error;
					}
				};
			};
			const tableLockTransactions = [
				createTableLockTransaction("TL1", ["READ", "WRITE"]),
				createTableLockTransaction("TL2", ["WRITE", "READ"]),
				createTableLockTransaction("TL3", ["READ", "WRITE"]),
				createTableLockTransaction("TL4", ["WRITE", "READ"]),
				createTableLockTransaction("TL5", ["READ", "WRITE"]),
				createTableLockTransaction("TL6", ["WRITE", "READ"]),
				createTableLockTransaction("TL7", ["READ", "WRITE"]),
				createTableLockTransaction("TL8", ["WRITE", "READ"]),
				createTableLockTransaction("TL9", ["READ", "WRITE"]),
				createTableLockTransaction("TL10", ["WRITE", "READ"]),
			];

			console.log(
				`Starting ${tableLockTransactions.length} concurrent table-locking transactions...`,
			);
			const results = await Promise.allSettled(
				tableLockTransactions.map((t) => t()),
			);

			console.log("Transaction results summary:");
			const successCount = results.filter(
				(r) => r.status === "fulfilled",
			).length;
			const failureCount = results.filter(
				(r) => r.status === "rejected",
			).length;
			console.log(`Successful transactions: ${successCount}`);
			console.log(`Failed transactions: ${failureCount}`);

			results.forEach((result, index) => {
				if (result.status === "rejected") {
					console.log(
						`Transaction ${index + 1} failed: ${result.reason?.message}`,
					);
				}
			});
			if (retryAttempts === 0) {
				console.log(
					"No deadlocks detected with table locks, trying with explicit row locking...",
				);
				const createRowLockTransaction = (
					name: string,
					lockSequence: Array<[number, string]>,
				) => {
					return async () => {
						return dbWithRetryTracking.transaction().execute(async (trx) => {
							// Set session timeout for this transaction
							await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(trx);

							for (const [id, lockType] of lockSequence) {
								if (lockType === "FOR UPDATE") {
									await sql`SELECT * FROM deadlock_test WHERE id = ${id} FOR UPDATE`.execute(
										trx,
									);
								} else {
									await sql`SELECT * FROM deadlock_test WHERE id = ${id} LOCK IN SHARE MODE`.execute(
										trx,
									);
								}

								console.log(
									`Transaction ${name}: Locked row ${id} with ${lockType}`,
								);
								await new Promise((resolve) => setTimeout(resolve, 20));
								if (lockType === "FOR UPDATE") {
									await trx
										.updateTable("deadlock_test")
										.set((eb) => ({ value: eb("value", "+", 1) }))
										.where("id", "=", id)
										.execute();
								}
							}
							return `Transaction ${name} completed`;
						});
					};
				};
				const rowLockTransactions = [
					createRowLockTransaction("RL1", [
						[1, "FOR UPDATE"],
						[2, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL2", [
						[2, "FOR UPDATE"],
						[1, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL3", [
						[1, "LOCK IN SHARE MODE"],
						[2, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL4", [
						[2, "LOCK IN SHARE MODE"],
						[1, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL5", [
						[1, "FOR UPDATE"],
						[2, "LOCK IN SHARE MODE"],
					]),
					createRowLockTransaction("RL6", [
						[2, "FOR UPDATE"],
						[1, "LOCK IN SHARE MODE"],
					]),
					createRowLockTransaction("RL7", [
						[1, "FOR UPDATE"],
						[2, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL8", [
						[2, "FOR UPDATE"],
						[1, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL9", [
						[1, "FOR UPDATE"],
						[2, "FOR UPDATE"],
					]),
					createRowLockTransaction("RL10", [
						[2, "FOR UPDATE"],
						[1, "FOR UPDATE"],
					]),
				];
				console.log(
					`Starting ${rowLockTransactions.length} concurrent row-locking transactions...`,
				);
				const rowLockResults = await Promise.allSettled(
					rowLockTransactions.map((t) => t()),
				);

				console.log("Row lock transaction results summary:");
				const rowLockSuccessCount = rowLockResults.filter(
					(r) => r.status === "fulfilled",
				).length;
				const rowLockFailureCount = rowLockResults.filter(
					(r) => r.status === "rejected",
				).length;
				console.log(`Successful transactions: ${rowLockSuccessCount}`);
				console.log(`Failed transactions: ${rowLockFailureCount}`);
			}

			if (retryAttempts === 0) {
				console.log(
					"No deadlocks detected with row locks, trying with gap locks and inserts...",
				);
				await dbWithRetryTracking.schema
					.dropTable("deadlock_test")
					.ifExists()
					.execute();

				await dbWithRetryTracking.schema
					.createTable("deadlock_test")
					.ifNotExists()
					.addColumn("id", "integer", (col) => col.primaryKey())
					.addColumn("value", "integer", (col) => col.notNull())
					.execute();

				await dbWithRetryTracking
					.insertInto("deadlock_test")
					.values([
						{ id: 10, value: 10 },
						{ id: 20, value: 20 },
						{ id: 30, value: 30 },
					])
					.execute();
				const createGapLockTransaction = (
					name: string,
					operations: Array<[string, number, number]>,
				) => {
					return async () => {
						return dbWithRetryTracking.transaction().execute(async (trx) => {
							await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(trx);

							for (const [op, id, value] of operations) {
								if (op === "SELECT") {
									await sql`SELECT * FROM deadlock_test WHERE id BETWEEN ${id - 5} AND ${id + 5} FOR UPDATE`.execute(
										trx,
									);
									console.log(
										`Transaction ${name}: Gap lock for range around ${id}`,
									);
								} else if (op === "INSERT") {
									await trx
										.insertInto("deadlock_test")
										.values({ id, value })
										.onDuplicateKeyUpdate({ value })
										.execute();
									console.log(
										`Transaction ${name}: Inserted id=${id}, value=${value}`,
									);
								}
								await new Promise((resolve) => setTimeout(resolve, 30));
							}
							return `Transaction ${name} completed`;
						});
					};
				};

				const gapLockTransactions = [
					createGapLockTransaction("GL1", [
						["SELECT", 15, 0],
						["INSERT", 25, 100],
					]),
					createGapLockTransaction("GL2", [
						["SELECT", 25, 0],
						["INSERT", 15, 100],
					]),
					createGapLockTransaction("GL3", [
						["SELECT", 15, 0],
						["INSERT", 25, 100],
					]),
					createGapLockTransaction("GL4", [
						["SELECT", 25, 0],
						["INSERT", 15, 100],
					]),
					createGapLockTransaction("GL5", [
						["INSERT", 15, 100],
						["SELECT", 25, 0],
					]),
					createGapLockTransaction("GL6", [
						["INSERT", 25, 100],
						["SELECT", 15, 0],
					]),
					createGapLockTransaction("GL7", [
						["SELECT", 15, 0],
						["INSERT", 25, 100],
					]),
					createGapLockTransaction("GL8", [
						["SELECT", 25, 0],
						["INSERT", 15, 100],
					]),
					createGapLockTransaction("GL9", [
						["INSERT", 15, 100],
						["SELECT", 25, 0],
					]),
					createGapLockTransaction("GL10", [
						["INSERT", 25, 100],
						["SELECT", 15, 0],
					]),
				];
				console.log(
					`Starting ${gapLockTransactions.length} concurrent gap-locking transactions...`,
				);
				const gapLockResults = await Promise.allSettled(
					gapLockTransactions.map((t) => t()),
				);

				console.log("Gap lock transaction results summary:");
				const gapLockSuccessCount = gapLockResults.filter(
					(r) => r.status === "fulfilled",
				).length;
				const gapLockFailureCount = gapLockResults.filter(
					(r) => r.status === "rejected",
				).length;
				console.log(`Successful transactions: ${gapLockSuccessCount}`);
				console.log(`Failed transactions: ${gapLockFailureCount}`);
			}
			expect(retryAttempts).toBeGreaterThan(0);
		} finally {
			await dbWithRetryTracking.destroy();
		}
	}, 60000);
});
