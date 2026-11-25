import { defineUseCase, step, ok, err, type Result } from 'koyuki';
import type { PrismaClient, Prisma } from './.generated/prisma/client.js';
import { validate, move, validInput, type Input, type Loaded, type Change, type Movement } from './domain.js';
import { inTransaction, unavailable, type StorageError } from './transaction.js';
type BoundaryError = StorageError | { kind: 'NotFound' } | { kind: 'Conflict' } | { kind: 'DuplicateRequest' } | { kind: 'InvalidInput' };
/** Every query is bound to tx, never a global Prisma client. */
export function stockMovement(tx: Prisma.TransactionClient) {
  const load = async (input: Input): Promise<Result<Loaded, BoundaryError>> => {
    if (!validInput(input)) return err({ kind: 'InvalidInput' });
    try {
      const [source, target, existing] = await Promise.all([
        tx.stock.findUnique({ where: { id: input.source } }),
        tx.stock.findUnique({ where: { id: input.target } }),
        tx.movement.findUnique({ where: { id: input.requestId } }),
      ]);
      if (existing) return err({ kind: 'DuplicateRequest' });
      return source && target ? ok({ source, target, input }) : err({ kind: 'NotFound' });
    } catch (cause) { return unavailable(cause); }
  };
  const save = async (change: Change): Promise<Result<Movement, BoundaryError>> => {
    try {
      const source = await tx.stock.updateMany({ where: { id: change.source.id, version: change.before.source.version }, data: { units: change.source.units, version: change.source.version } });
      if (source.count !== 1) return err({ kind: 'Conflict' });
      const target = await tx.stock.updateMany({ where: { id: change.target.id, version: change.before.target.version }, data: { units: change.target.units, version: change.target.version } });
      if (target.count !== 1) return err({ kind: 'Conflict' });
      return ok(await tx.movement.create({ data: change.movement }));
    } catch (cause) { return unavailable(cause); }
  };
  return defineUseCase({ operation: 'stock.move.v1', load,
    transition: { validate: step('validate-stock', validate), require: [] as const, evolve: step('move-stock', move) }, save });
}
export function moveStock(createClient: () => PrismaClient, input: Input) {
  return inTransaction(createClient, tx => stockMovement(tx).run(input));
}
