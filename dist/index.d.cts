import { Dialect, MysqlDialectConfig, Driver, QueryCompiler, DialectAdapter, Kysely, DatabaseIntrospector } from 'kysely';
import { RetryOptions } from '@harisk/retryx';

interface MysqlWithDeadlockRetriesConfig extends MysqlDialectConfig {
    deadlock?: RetryOptions;
}
declare class MySQLDialectWithDeadlockRetries implements Dialect {
    #private;
    constructor(config: MysqlWithDeadlockRetriesConfig);
    createDriver(): Driver;
    createQueryCompiler(): QueryCompiler;
    createAdapter(): DialectAdapter;
    createIntrospector(db: Kysely<any>): DatabaseIntrospector;
}

export { MySQLDialectWithDeadlockRetries };
