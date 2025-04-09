import { MysqlQueryCompiler, MysqlAdapter, MysqlIntrospector, CompiledQuery } from 'kysely';
import { retry } from '@harisk/retryx';

var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var _config, _connections, _pool, _MysqlDriverWithDeadlockRetries_instances, acquireConnection_fn, _rawConnection, _config2, _MysqlConnectionWithDeadlockRetries_instances, executeQuery_fn, _config3;
const PRIVATE_RELEASE_METHOD = Symbol();
function isFunction(obj) {
  return typeof obj === "function";
}
function isObject(obj) {
  return typeof obj === "object" && obj !== null;
}
function isString(obj) {
  return typeof obj === "string";
}
function isStackHolder(obj) {
  return isObject(obj) && isString(obj.stack);
}
function extendStackTrace(err, stackError) {
  if (isStackHolder(err) && stackError.stack) {
    const stackExtension = stackError.stack.split("\n").slice(1).join("\n");
    err.stack += `
${stackExtension}`;
    return err;
  }
  return err;
}
class MysqlDriverWithDeadlockRetries {
  constructor(configOrPool) {
    __privateAdd(this, _MysqlDriverWithDeadlockRetries_instances);
    __privateAdd(this, _config);
    __privateAdd(this, _connections, /* @__PURE__ */ new WeakMap());
    __privateAdd(this, _pool);
    __privateSet(this, _config, { ...configOrPool });
  }
  async init() {
    __privateSet(this, _pool, isFunction(__privateGet(this, _config).pool) ? await __privateGet(this, _config).pool() : __privateGet(this, _config).pool);
  }
  async acquireConnection() {
    const rawConnection = await __privateMethod(this, _MysqlDriverWithDeadlockRetries_instances, acquireConnection_fn).call(this);
    let connection = __privateGet(this, _connections).get(rawConnection);
    if (!connection) {
      connection = new MysqlConnectionWithDeadlockRetries(
        rawConnection,
        __privateGet(this, _config)
      );
      __privateGet(this, _connections).set(rawConnection, connection);
      if (__privateGet(this, _config)?.onCreateConnection) {
        await __privateGet(this, _config).onCreateConnection(connection);
      }
    }
    if (__privateGet(this, _config)?.onReserveConnection) {
      await __privateGet(this, _config).onReserveConnection(connection);
    }
    return connection;
  }
  async beginTransaction(connection, settings) {
    if (settings.isolationLevel) {
      await connection.executeQuery(
        CompiledQuery.raw(
          `set transaction isolation level ${settings.isolationLevel}`
        )
      );
    }
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }
  async commitTransaction(connection) {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }
  async rollbackTransaction(connection) {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }
  releaseConnection(connection) {
    connection[PRIVATE_RELEASE_METHOD]();
  }
  async destroy() {
    return new Promise((resolve, reject) => {
      __privateGet(this, _pool)?.end((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
_config = new WeakMap();
_connections = new WeakMap();
_pool = new WeakMap();
_MysqlDriverWithDeadlockRetries_instances = new WeakSet();
acquireConnection_fn = async function() {
  return new Promise((resolve, reject) => {
    __privateGet(this, _pool)?.getConnection((err, rawConnection) => {
      if (err) {
        reject(err);
      } else {
        resolve(rawConnection);
      }
    });
  });
};
function isOkPacket(obj) {
  return isObject(obj) && "insertId" in obj && "affectedRows" in obj;
}
class MysqlConnectionWithDeadlockRetries {
  constructor(rawConnection, config) {
    __privateAdd(this, _MysqlConnectionWithDeadlockRetries_instances);
    __privateAdd(this, _rawConnection);
    __privateAdd(this, _config2);
    __privateSet(this, _rawConnection, rawConnection);
    __privateSet(this, _config2, config);
  }
  async executeQuery(compiledQuery) {
    try {
      const result = await __privateMethod(this, _MysqlConnectionWithDeadlockRetries_instances, executeQuery_fn).call(this, compiledQuery, __privateGet(this, _config2));
      if (isOkPacket(result)) {
        const { insertId, affectedRows, changedRows } = result;
        const numAffectedRows = affectedRows !== void 0 && affectedRows !== null ? BigInt(affectedRows) : void 0;
        const numChangedRows = changedRows !== void 0 && changedRows !== null ? BigInt(changedRows) : void 0;
        return {
          insertId: insertId !== void 0 && insertId !== null && insertId.toString() !== "0" ? BigInt(insertId) : void 0,
          // TODO: remove.
          numUpdatedOrDeletedRows: numAffectedRows,
          numAffectedRows,
          numChangedRows,
          rows: []
        };
      } else if (Array.isArray(result)) {
        return {
          rows: result
        };
      }
      return {
        rows: []
      };
    } catch (err) {
      throw extendStackTrace(err, new Error("Error executing query"));
    }
  }
  async *streamQuery(compiledQuery, _chunkSize) {
    const stream = __privateGet(this, _rawConnection).query(compiledQuery.sql, compiledQuery.parameters).stream({
      objectMode: true
    });
    try {
      for await (const row of stream) {
        yield {
          rows: [row]
        };
      }
    } catch (ex) {
      if (ex && typeof ex === "object" && "code" in ex && // @ts-ignore
      ex.code === "ERR_STREAM_PREMATURE_CLOSE") {
        return;
      }
      throw ex;
    }
  }
  [PRIVATE_RELEASE_METHOD]() {
    __privateGet(this, _rawConnection).release();
  }
}
_rawConnection = new WeakMap();
_config2 = new WeakMap();
_MysqlConnectionWithDeadlockRetries_instances = new WeakSet();
executeQuery_fn = function(compiledQuery, options) {
  return new Promise((resolve, reject) => {
    __privateGet(this, _rawConnection).query(
      compiledQuery.sql,
      compiledQuery.parameters,
      (err, result) => {
        if (err) {
          if (typeof err === "object" && err !== null && "code" in err && // @ts-ignore
          [
            "ER_LOCK_DEADLOCK",
            "ER_LOCK_WAIT_TIMEOUT",
            "ER_LOCK_TIMEOUT"
          ].includes(err.code) && options.deadlock !== void 0) {
            resolve(
              retry(async () => {
                await new Promise((r) => setTimeout(r, 50));
                return new Promise(
                  (innerResolve, innerReject) => {
                    __privateGet(this, _rawConnection).query(
                      compiledQuery.sql,
                      compiledQuery.parameters,
                      (innerErr, innerResult) => {
                        if (innerErr) {
                          innerReject(innerErr);
                        } else {
                          innerResolve(innerResult);
                        }
                      }
                    );
                  }
                );
              }, options.deadlock)
            );
          } else {
            reject(err);
          }
        } else {
          resolve(result);
        }
      }
    );
  });
};
class MySQLDialectWithDeadlockRetries {
  constructor(config) {
    __privateAdd(this, _config3);
    __privateSet(this, _config3, config);
  }
  createDriver() {
    return new MysqlDriverWithDeadlockRetries(__privateGet(this, _config3));
  }
  createQueryCompiler() {
    return new MysqlQueryCompiler();
  }
  createAdapter() {
    return new MysqlAdapter();
  }
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  createIntrospector(db) {
    return new MysqlIntrospector(db);
  }
}
_config3 = new WeakMap();

export { MySQLDialectWithDeadlockRetries };
