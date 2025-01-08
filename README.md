# acqui(re)lease

(Bracket/Transaction/Scope) for TypeScript

A small utility library for **acquiring multiple resources** in sequence and **releasing** them in reverse order upon success or error — sometimes referred to as a _bracket pattern_, _transaction_, or _scope-based resource management_.

- **Acquire** resources one by one (either sync or async)
- **Rollback** (release in reverse order) if any step fails
- **Success** finalization (release in reverse order) if all steps succeed
- **Optional** release function if a resource needs no cleanup
- **Fluent builder** pattern for easy type inference of previously acquired resources
- **AggregateError** thrown if multiple things fail (original acquisition plus release errors)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Basic Concepts](#basic-concepts)
- [Usage Example](#usage-example)
- [Synchronous vs Asynchronous Acquisition/Release](#synchronous-vs-asynchronous-acquisitionrelease)
- [API Reference](#api-reference)
  - [createTransaction / createBracket / createScope](#createtransaction--createbracket--createscope)
  - [Builder<Accumulated>](#builderaccumulated)
  - [AcquireRelease<K, Prev, Current>](#acquirereleasek-prev-current)
- [Advanced Usage](#advanced-usage)
  - [Rollback and Release Errors](#rollback-and-release-errors)
  - [Optional Release](#optional-release)
- [Testing](#testing)
- [License](#license)

---

## Features

1. **Typed “Builder” API**: Each resource step infers the types of previously acquired resources.
2. **Easy Rollback**: If any acquisition fails, all previously acquired resources are released in reverse order.
3. **Optional Cleanup**: Release is optional—some tasks don’t need finalization.
4. **Multiple Entry Points**:
   - `createTransaction()` – a straightforward name if you think of these steps as a transaction
   - `createBracket()` – for functional/bracket pattern folks
   - `createScope()` – for those who see it as a scope-based resource manager
5. **Sync/Async Support**: You can implement both your `acquire` and `release` functions as **regular (sync)** or **async** functions. The library will handle both seamlessly.

---

## Installation

Using **bun**:

```bash
bun add acquirelease
```

Using **npm**:

```bash
npm install acquirelease
```

Using **yarn**:

```bash
yarn add acquirelease
```

Using **pnpm**:

```bash
pnpm add acquirelease
```

---

## Basic Concepts

1. **Acquire**: Each step defines an `(a)sync` function `acquire(prev)` that returns a resource. This can be:
   - A **plain object** (sync)
   - A **promise** resolving to a resource (async)
2. **Release** (optional): Each step can define an `(a)sync` function `release(resource, exit)` to free or clean up the resource.
   - Called with `{ isError: true, error }` if a subsequent acquire fails (rollback scenario).
   - Called with `{ isError: false }` if the transaction completes successfully.
3. **Chaining**: By calling `.add(...)` repeatedly, you build a pipeline of resources. Each step can see all previously acquired resources for typed references.

---

## Usage Example

```ts
import { createTransaction } from 'acquirelease'

async function main() {
  // 1) Create a builder
  const builder = createTransaction()

  // 2) Add tasks in sequence
  const pipeline = builder
    .add(
      'db',
      // Acquire can be sync or async. Here, we return an object directly (sync).
      (prev) => {
        console.log('Acquiring DB connection (sync) with prev:', prev)
        return { client: 'fakeDbClient', sync: true }
      },
      // Release can be sync or async. Let's do an async example.
      async (db, exit) => {
        console.log(`Releasing DB connection; isError=${exit.isError}`)
        // simulate async cleanup
        await new Promise((res) => setTimeout(res, 50))
        if (exit.error) {
          console.log('DB release saw original error:', exit.error)
        }
      }
    )
    .add(
      'file',
      async (prev) => {
        // Acquire this one asynchronously
        console.log('Acquiring file (async), DB client =', prev.db.client)
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ fileHandle: 'fakeFileHandle', async: true }),
            50
          )
        )
      },
      (file, exit) => {
        // release is synchronous
        console.log(`Releasing file. isError=${exit.isError}, file=`, file)
      }
    )

  // 3) Build the transaction runner and run
  const run = pipeline.build()

  try {
    const results = await run()
    console.log('All steps succeeded! Final results:', results)
    // results is typed as {
    //   db: { client: string; sync: boolean }
    //   file: { fileHandle: string; async: boolean }
    // }
  } catch (err) {
    console.error('Transaction failed:', err)
  }
}

main()
```

- If **any** `.acquire(...)` fails, the library automatically **rolls back** all previously acquired resources.
- If everything succeeds, it runs all releases with `{ isError: false }`.
- You get typed results referencing each resource by its “tag.”

---

## Synchronous vs Asynchronous Acquisition/Release

You can freely mix sync and async steps:

- **Sync Acquire**:
  ```ts
  acquire: (prev) => {
    return { client: 'syncDbClient' }
  }
  ```
- **Async Acquire**:
  ```ts
  acquire: async (prev) => {
    await doSomethingAsync()
    return { client: 'asyncDbClient' }
  }
  ```
- **Sync Release**:
  ```ts
  release: (resource, exit) => {
    console.log('Cleaning up:', resource)
  }
  ```
- **Async Release**:
  ```ts
  release: async (resource, exit) => {
    await asyncCloseHandle(resource)
  }
  ```

The library automatically wraps return values in `Promise.resolve(...)` so that synchronous returns are handled seamlessly.

---

## API Reference

### createTransaction / createBracket / createScope

All three functions produce **the same builder** API — just different naming conventions.
Use whichever best fits your mental model:

```ts
function createTransaction(): Builder<{}>
function createBracket(): Builder<{}>
function createScope(): Builder<{}>
```

They each return a **Builder** that starts with an empty resource shape (`{}`).

---

### Builder<Accumulated>

```ts
interface Builder<Accumulated extends object> {
  add<K extends string, Current>(
    tag: K,
    acquire: (prev: Accumulated) => Current | Promise<Current>,
    release?: (resource: Current, exit: Exit) => void | Promise<void>
  ): Builder<Accumulated & { [P in K]: Current }>

  build(): () => Promise<Accumulated>
}
```

- **`add(tag, acquire, release?)`**:

  - **`tag`**: a string literal identifying the resource (e.g. `"db"`).
  - **`acquire(prev)`**: a **sync** or **async** function that returns the newly acquired resource.
  - **`release?(resource, exit)`**: an **optional**, **sync** or **async** cleanup function.
  - Returns **another Builder** whose “accumulated” shape merges this new resource’s type.

- **`build()`**:
  - Finalizes the array of tasks and returns a function: `() => Promise<Accumulated>`.
  - When called, executes all acquires in sequence, then releases them in reverse order.

---

### AcquireRelease<K, Prev, Current>

Internally used to store each step’s definition. If you want, you can use it for advanced scenarios or type constraints. Typically you just use `.add(...)`.

```ts
export type AcquireRelease<K extends string, Prev, Current> = {
  tag: K
  acquire: (prev: Prev) => Current | Promise<Current>
  release?: (resource: Current, exit: Exit) => void | Promise<void>
}
```

---

## Advanced Usage

### Rollback and Release Errors

- If **any** acquire fails, everything acquired so far is **rolled back** with `isError = true` and `error = theOriginalError`.
- If a release function itself throws an error (sync or async), the system **continues** releasing the remaining resources.
- After rollback, a single `AggregateError` is thrown containing **both** the original error from acquisition and any release errors.
- On success, if one or more releases fail, a single `AggregateError` is thrown with those errors.

### Optional Release

You can omit `release` if no cleanup is necessary:

```ts
builder.add('noCleanup', async (prev) => {
  return { anything: 'goes here' }
})
```

No release will be called for that resource.

---

## Testing

A test suite using [Bun’s built-in test runner](https://bun.sh) is provided in [`tests/index.test.ts`](./tests/index.test.ts). It demonstrates:

- **Synchronous** acquire/release
- **Asynchronous** acquire/release
- **Rollback** on error
- **Mixed** sync/async steps
- **Handling** multiple release errors via `AggregateError`

To run the tests:

```bash
bun test
```

---

## License

[MIT License](./LICENSE) – Feel free to use, modify, and distribute. Contributions are welcome!
