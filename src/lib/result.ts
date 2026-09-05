/** Result / Option algebraic types. Errors are values; no exceptions in the core. */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));

export const andThen = <T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

/** First error wins; otherwise the list of values in order. */
export const all = <T, E>(rs: readonly Result<T, E>[]): Result<T[], E> =>
  rs.reduce<Result<T[], E>>(
    (acc, r) => (acc.ok ? (r.ok ? ok([...acc.value, r.value]) : r) : acc),
    ok([]),
  );

/** Split into successes and failures, preserving order within each. */
export const partition = <T, E>(rs: readonly Result<T, E>[]): { oks: T[]; errs: E[] } =>
  rs.reduce<{ oks: T[]; errs: E[] }>(
    (acc, r) => (r.ok ? { ...acc, oks: [...acc.oks, r.value] } : { ...acc, errs: [...acc.errs, r.error] }),
    { oks: [], errs: [] },
  );

/** Run a thunk that may throw at the IO boundary and capture the throw as an Err. */
export const tryCatch = <T, E>(thunk: () => T, onThrow: (e: unknown) => E): Result<T, E> => {
  try {
    return ok(thunk());
  } catch (e) {
    return err(onThrow(e));
  }
};

export const tryCatchAsync = async <T, E>(
  thunk: () => Promise<T>,
  onThrow: (e: unknown) => E,
): Promise<Result<T, E>> => {
  try {
    return ok(await thunk());
  } catch (e) {
    return err(onThrow(e));
  }
};

export type Some<T> = { readonly some: true; readonly value: T };
export type None = { readonly some: false };
export type Option<T> = Some<T> | None;

export const some = <T>(value: T): Some<T> => ({ some: true, value });
export const none: None = { some: false };
export const fromNullable = <T>(v: T | null | undefined): Option<T> =>
  v === null || v === undefined ? none : some(v);
export const optionMap = <T, U>(o: Option<T>, f: (t: T) => U): Option<U> => (o.some ? some(f(o.value)) : none);
export const getOr = <T>(o: Option<T>, fallback: T): T => (o.some ? o.value : fallback);
export const toUndefined = <T>(o: Option<T>): T | undefined => (o.some ? o.value : undefined);
