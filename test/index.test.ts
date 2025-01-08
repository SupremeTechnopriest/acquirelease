import { describe, test, expect } from 'bun:test'
import { createTransaction, createBracket, createScope } from '../src'

/**
 * A tiny helper to simulate asynchronous operations:
 *   - If "shouldReject" is true, it rejects with "value"
 *   - Otherwise, resolves after "ms" with "value"
 */
function delay<T>(ms: number, value: T, shouldReject = false): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    setTimeout(() => (shouldReject ? reject(value) : resolve(value)), ms)
  )
}

/**
 * A minimal "mock" function that stores calls for assertion:
 *   const mockFn = createMock()
 *   mockFn("hello", 123)
 *   mockFn.calls -> [ ["hello", 123] ]
 */
function createMock() {
  const calls: any[][] = []
  const mockFn = (...args: any[]) => {
    calls.push(args)
  }
  mockFn.calls = calls
  return mockFn
}

describe('Transaction Builder (sync & async)', () => {
  test('single-step with synchronous acquire and release', async () => {
    // Acquire returns a plain object (no promise),
    // Release also returns void (no promise).
    const releaseMock = createMock()

    const builder = createTransaction()
    const pipeline = builder.add(
      'res1',
      (prev) => {
        expect(prev).toEqual({})
        // synchronous acquire
        return { foo: 'bar', isSync: true }
      },
      (resource, exit) => {
        // synchronous release
        releaseMock(resource, exit.isError, exit.error)
      }
    )

    const run = pipeline.build()
    const results = await run() // still awaits, but everything inside is sync

    expect(results).toEqual({ res1: { foo: 'bar', isSync: true } })
    // Release called once with isError = false
    expect(releaseMock.calls.length).toBe(1)
    expect(releaseMock.calls[0]).toEqual([
      { foo: 'bar', isSync: true },
      false,
      undefined
    ])
  })

  test('single-step with asynchronous acquire and release', async () => {
    // Acquire returns a promise
    // Release also returns a promise
    const releaseMock = createMock()

    const builder = createTransaction()
    const pipeline = builder.add(
      'res1',
      async (prev) => {
        expect(prev).toEqual({})
        // async acquire
        const value = await delay(5, { foo: 'bar', isAsync: true })
        return value
      },
      async (resource, exit) => {
        // async release
        await delay(5, null)
        releaseMock(resource, exit.isError, exit.error)
      }
    )

    const run = pipeline.build()
    const results = await run()

    expect(results).toEqual({ res1: { foo: 'bar', isAsync: true } })
    // Release called once with isError = false
    expect(releaseMock.calls.length).toBe(1)
    expect(releaseMock.calls[0]).toEqual([
      { foo: 'bar', isAsync: true },
      false,
      undefined
    ])
  })

  test('multi-step with mixed sync/async', async () => {
    const releaseDbMock = createMock()
    const releaseFileMock = createMock()

    const builder = createBracket() // same as createTransaction
    const pipeline = builder
      .add(
        'db',
        (prev) => {
          // sync acquire
          expect(prev).toEqual({})
          return { client: 'fakeDbClient', sync: true }
        },
        async (db, exit) => {
          // async release
          await delay(5, null)
          releaseDbMock(db, exit.isError, exit.error)
        }
      )
      .add(
        'file',
        async (prev) => {
          // async acquire
          expect(prev.db).toEqual({ client: 'fakeDbClient', sync: true })
          return delay(5, { fileHandle: 'fakeFileHandle', async: true })
        },
        (file, exit) => {
          // sync release
          releaseFileMock(file, exit.isError, exit.error)
        }
      )

    const run = pipeline.build()
    const results = await run()

    expect(results).toEqual({
      db: { client: 'fakeDbClient', sync: true },
      file: { fileHandle: 'fakeFileHandle', async: true }
    })

    // Releases in reverse order: file -> db
    expect(releaseFileMock.calls.length).toBe(1)
    expect(releaseFileMock.calls[0]).toEqual([
      { fileHandle: 'fakeFileHandle', async: true },
      false,
      undefined
    ])
    expect(releaseDbMock.calls.length).toBe(1)
    expect(releaseDbMock.calls[0]).toEqual([
      { client: 'fakeDbClient', sync: true },
      false,
      undefined
    ])
  })

  test('rollback if second (async) acquire fails, first release is sync', async () => {
    // We'll intentionally fail the second resource's acquire,
    // and confirm the first resource's release is called with isError=true
    const releaseFirstMock = createMock()

    const builder = createTransaction()
    const pipeline = builder
      .add(
        'first',
        () => {
          // sync acquire
          return { name: 'first', sync: true }
        },
        (resource, exit) => {
          // sync release
          releaseFirstMock(resource, exit.isError, exit.error)
        }
      )
      .add('failing', async () => {
        // async acquire that fails
        await delay(5, null)
        throw new Error('Acquisition of failing resource failed')
      })

    const run = pipeline.build()
    let thrownErr: unknown

    try {
      await run()
    } catch (err) {
      thrownErr = err
    }

    // Because second acquisition fails, we expect an error
    expect(thrownErr).toBeInstanceOf(Error)
    const errorMsg = (thrownErr as Error).message
    expect(errorMsg).toContain('Acquisition of failing resource failed')

    // The first resource was rolled back with isError=true
    expect(releaseFirstMock.calls.length).toBe(1)
    expect(releaseFirstMock.calls[0][0]).toEqual({ name: 'first', sync: true })
    expect(releaseFirstMock.calls[0][1]).toBe(true) // isError
    expect(releaseFirstMock.calls[0][2]).toBeInstanceOf(Error) // the original error
  })

  test('all acquires succeed, but final release fails (sync or async), throws AggregateError', async () => {
    const release1Mock = createMock()
    const release2Failing = async () => {
      // async release that fails
      await delay(5, null)
      throw new Error('release2 fails on success path')
    }

    const builder = createScope() // same as createTransaction
    const pipeline = builder
      .add(
        'res1',
        () => {
          // sync acquire
          return { name: 'res1' }
        },
        (res, exit) => {
          // sync release
          release1Mock(res, exit.isError, exit.error)
        }
      )
      .add(
        'res2',
        async (prev) => {
          // async acquire
          await delay(5, null)
          expect(prev.res1).toEqual({ name: 'res1' })
          return { name: 'res2' }
        },
        release2Failing
      )

    const run = pipeline.build()
    let thrownErr: unknown

    // run() will throw due to the failing release
    const results = await run().catch((err) => {
      thrownErr = err
    })

    // So we never actually "resolve" results in a normal sense
    // with the aggregator logic, we throw at the end instead
    expect(results).toBeUndefined()
    expect(thrownErr).toBeInstanceOf(AggregateError)

    const aggErr = thrownErr as AggregateError
    expect(aggErr.errors.length).toBe(1)
    expect(aggErr.errors[0]?.message).toEqual('release2 fails on success path')

    // The first release function was called successfully
    expect(release1Mock.calls.length).toBe(1)
    expect(release1Mock.calls[0]).toEqual([{ name: 'res1' }, false, undefined])
  })
})
