/**
 * Describes the final "exit" status of a release operation.
 * If `isError` is `true`, then `error` may contain the reason this release is happening
 * (e.g. a thrown error during acquire).
 */
export type Exit = {
  /**
   * Indicates whether this release is happening due to an error (`true`)
   * or a normal successful completion (`false`).
   */
  isError: boolean

  /**
   * The error object that triggered the rollback, if any.
   * Will be `undefined` if `isError` is `false`.
   */
  error?: unknown
}

/**
 * An asynchronous or synchronous function that acquires a resource.
 * It may return the resource directly or a promise that resolves to the resource.
 */
export type AcquireFunc<Prev, Current> = (
  prev: Prev
) => Current | Promise<Current>

/**
 * An asynchronous or synchronous function that releases a resource.
 * It may return nothing (void) or a promise that resolves to nothing (void).
 */
export type ReleaseFunc<Current> = (
  resource: Current,
  exit: Exit
) => void | Promise<void>

/**
 * A single step in the bracket/transaction workflow.
 *
 * @template K - A string literal (e.g. `"db"`, `"file"`) to identify the resource.
 * @template Prev - The shape of previously acquired resources.
 * @template Current - The type of the resource acquired by this step.
 */
export type AcquireRelease<K extends string, Prev, Current> = {
  /**
   * Unique string identifier for the resource acquired by this step.
   */
  tag: K

  /**
   * An (a)sync function that acquires the resource.
   * Receives all previously acquired resources (`prev`) so you can
   * depend on them if necessary.
   *
   * @param prev - The previously acquired resources, keyed by their tags.
   * @returns Either a value (`Current`) or a Promise resolving to `Current`.
   */
  acquire: AcquireFunc<Prev, Current>

  /**
   * An optional (a)sync function to release or clean up this resource.
   * If the workflow is rolling back (i.e. an error occurred in a subsequent step),
   * then `exit.isError` is `true` and `exit.error` holds the thrown error.
   * Otherwise, if the workflow finishes successfully, `exit.isError` is `false`.
   *
   * @param resource - The resource this step acquired.
   * @param exit - Information about the reason for release:
   *               - `isError = true` if we're rolling back;
   *               - `isError = false` if this is a normal completion;
   *               - `error` holds the original error if rolling back.
   */
  release?: ReleaseFunc<Current>
}

/**
 * Creates a new builder (transaction) with an initial empty set of tasks.
 * Use `.add(...)` to define your resources in sequence, then `.build()` to finalize.
 *
 * @returns A builder that starts with an empty set of acquired resources (`{}`).
 */
export function createTransaction() {
  return createBuilder([], {})
}

/**
 * An alias of `createTransaction()`, for those who prefer the term "bracket."
 * @returns The same builder type, starting with an empty resource set.
 */
export function createBracket() {
  return createBuilder([], {})
}

/**
 * Another alias of `createTransaction()`, for those who see it as a "scope."
 * @returns The same builder type, starting with an empty resource set.
 */
export function createScope() {
  return createBuilder([], {})
}

/**
 * A fluent builder interface that accumulates resources step by step.
 *
 * @template Accumulated - The shape of resources acquired so far.
 */
interface Builder<Accumulated extends object> {
  /**
   * Adds a new AcquireRelease step to the workflow.
   * Merges the newly acquired resource type into the "accumulated" shape.
   *
   * @template K - The resource's string tag.
   * @template Current - The type of the resource being acquired.
   *
   * @param tag - A unique identifier for this resource.
   * @param acquire - (a)sync function that acquires the resource. Receives all previously acquired resources.
   * @param release - Optional (a)sync function that releases this resource (on rollback or success).
   *
   * @returns A new Builder whose `Accumulated` type has been merged with `{ [K]: Current }`.
   */
  add<K extends string, Current>(
    tag: K,
    acquire: AcquireFunc<Accumulated, Current>,
    release?: ReleaseFunc<Current>
  ): Builder<Accumulated & { [P in K]: Current }>

  /**
   * Finalizes the builder, returning an async function that runs the entire acquire–release workflow:
   * - Acquire each resource in sequence
   * - If any acquire fails, rollback all previous resources in reverse
   * - If all succeed, release them in reverse order on success
   *
   * @returns A function that, when called, returns a Promise of the final accumulated resources.
   */
  build(): () => Promise<Accumulated>
}

/**
 * Internal function to create a builder with a shared tasks array
 * and a phantom type parameter that tracks the accumulated resource shape.
 *
 * @param tasks - The array of AcquireRelease steps built so far.
 * @param _phantom - A phantom type parameter that helps TS track the shape of previously acquired resources.
 * @returns A `Builder` object that can `.add(...)` more resources or `.build()` the workflow.
 */
function createBuilder<Accumulated extends object>(
  tasks: AcquireRelease<string, any, any>[],
  _phantom?: Accumulated
): Builder<Accumulated> {
  return {
    add<K extends string, Current>(
      tag: K,
      acquire: AcquireFunc<Accumulated, Current>,
      release?: ReleaseFunc<Current>
    ) {
      tasks.push({ tag, acquire, release })

      // Merge the new resource into the accumulated type
      type NewAccumulated = Accumulated & { [P in K]: Current }
      // Return a new builder with the same tasks array
      return createBuilder<NewAccumulated>(tasks)
    },

    build() {
      // Build a transaction runner with the final tasks array
      return Transaction(tasks) as () => Promise<Accumulated>
    }
  }
}

/**
 * Orchestrates the acquire–release workflow for an array of tasks.
 * The returned function acquires each resource in forward order,
 * and releases all resources in reverse (rollback if error, or normal release on success).
 *
 * If an acquire fails, it rolls back previously acquired resources, collecting any release errors,
 * and throws an AggregateError that includes the original acquire error plus all release errors.
 *
 * On successful acquisition of all tasks, it releases them in reverse.
 * If any releases fail during the success path, it throws an AggregateError of those release errors.
 *
 * @param tasks - The list of AcquireRelease steps to run in sequence.
 * @returns A function that, when called, returns a Promise with all final acquired resources.
 */
function Transaction(tasks: AcquireRelease<string, any, any>[]) {
  return async function runTransaction() {
    const results: Record<string, any> = {}
    let i = 0

    // Acquire resources in forward order
    for (; i < tasks.length; i++) {
      const task = tasks[i]
      try {
        // Wrap both sync and async acquisitions in Promise.resolve
        results[task.tag] = await Promise.resolve(task.acquire(results))
      } catch (acquireError) {
        // Acquire failed—rollback in reverse
        i--
        const releaseErrors: unknown[] = []

        while (i >= 0) {
          const { tag, release } = tasks[i]
          if (release) {
            try {
              // Also wrap the release in Promise.resolve
              await Promise.resolve(
                release(results[tag], {
                  isError: true,
                  error: acquireError
                })
              )
            } catch (releaseErr) {
              releaseErrors.push(releaseErr)
            }
          }
          i--
        }

        // If we encountered release errors, throw them aggregated with the original
        if (releaseErrors.length > 0) {
          const combinedError = new AggregateError(
            [acquireError, ...releaseErrors],
            'Acquire failed and some releases also failed.'
          )
          throw combinedError
        } else {
          // Otherwise, re-throw the original acquire error
          throw acquireError
        }
      }
    }

    // All acquires succeeded; release in reverse order
    i--
    const successReleaseErrors: unknown[] = []

    while (i >= 0) {
      const { tag, release } = tasks[i]
      if (release) {
        try {
          await Promise.resolve(release(results[tag], { isError: false }))
        } catch (err) {
          successReleaseErrors.push(err)
        }
      }
      i--
    }

    // If any releases failed during success path, aggregate them
    if (successReleaseErrors.length > 0) {
      throw new AggregateError(
        successReleaseErrors,
        'All acquires succeeded, but there were errors during final release.'
      )
    }

    return results
  }
}
