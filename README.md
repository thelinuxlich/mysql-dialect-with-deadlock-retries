# MySQL Dialect with Deadlock Retries for Kysely

A custom MySQL dialect for [Kysely](https://kysely.dev/) that automatically retries queries when they encounter deadlock errors.

## Features

- 🔄 Automatic retry of queries that fail due to deadlocks
- ⚙️ Configurable retry attempts, exponential backoff and delay
- 📊 Optional retry tracking and logging
- 🔌 Drop-in replacement for Kysely's standard MySQL dialect

## Installation

```bash
npm install mysql-dialect-with-deadlock
# or
pnpm add mysql-dialect-with-deadlock
```

## Usage

```typescript
import { Kysely } from 'kysely'
import { createPool } from 'mysql2'
import { MySQLDialectWithDeadlockRetries } from 'mysql-dialect-with-deadlock'

const db = new Kysely({
  dialect: new MySQLDialectWithDeadlockRetries({
    pool: createPool({
      host: 'localhost',
      user: 'root',
      database: 'test'
    }),
    deadlock: {
      maxAttempts: 3,
      onRetry: (error, attempt) => {
        console.log(`Retry attempt ${attempt} after deadlock: ${error.message}`)
      }
    }
  })
})
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Maximum number of retry attempts |
| `delay` | `number` | `0` | Delay in ms between retries |
| `backoff` | `boolean` | `false` | Use exponential backoff for delays |
| `onRetry` | `function` | `undefined` | Callback function called on each retry |

## License

MIT

