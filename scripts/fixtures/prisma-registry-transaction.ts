import { err, type Result } from 'koyuki';
import { DriverAdapterError } from '@prisma/driver-adapter-utils';
import { Prisma, type PrismaClient } from './.generated/prisma/client.js';
export type StorageError = { kind: 'StorageUnavailable' };
export function unavailable(cause: unknown): Result<never, StorageError> {
  if (cause instanceof Prisma.PrismaClientKnownRequestError || cause instanceof Prisma.PrismaClientUnknownRequestError || cause instanceof Prisma.PrismaClientInitializationError || cause instanceof DriverAdapterError)
    return err({ kind: 'StorageUnavailable' });
  throw cause;
}
/** Prisma adapter: an Err return must abort the transaction instead of committing. */
export async function inTransaction<O, E>(createClient: () => PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<Result<O, E>>): Promise<Result<O, E | StorageError>> {
  const abort = Object.freeze({});
  let rejected: { ok: false; error: E } | undefined;
  try {
    const client = createClient();
    try {
      return await client.$transaction(async tx => {
        const result = await work(tx);
        if (!result.ok) { rejected = result; throw abort; }
        return result;
      });
    } finally { await client.$disconnect(); }
  } catch (cause) {
    // Only this invocation's marker means Prisma successfully returned our abort.
    // A rollback/commit/driver failure remains an infrastructure error.
    return cause === abort && rejected ? rejected : unavailable(cause);
  }
}
