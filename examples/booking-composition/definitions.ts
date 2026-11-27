import { ok, err, type Result } from 'koyuki';
import { submission, approval, cancellation, type Booking, type Actor, type Input } from './domain.js';
export interface Repository {
  load(input: Input): Promise<Result<Booking, 'Missing'>>;
  save(booking: Booking): Promise<Result<Booking, 'Conflict'>>;
}
export interface BookingProps {
  readonly repository: Repository;
  readonly cancellationHours: number;
  readonly clock: () => number;
}
export function definitions(props: BookingProps, trustedActor: Actor) {
  if (!Number.isFinite(props.cancellationHours) || props.cancellationHours <= 0) throw new Error('InvalidCancellationHours');
  // Capture scalars/functions at construction, not mutable props or actor objects.
  const { repository, cancellationHours, clock } = props, actor = Object.freeze({ ...trustedActor });
  const load = async (input: Input) => {
    const result = await repository.load(input);
    return result.ok ? ok({ booking: result.value, actor }) : result;
  };
  const loadCancellation = async (input: Input) => {
    const result = await load(input);
    return result.ok ? ok({ ...result.value, now: clock(), cancellationHours }) : result;
  };
  const save = (booking: Booking) => repository.save(booking);
  return {
    submit: { load, execute: submission, save },
    approve: { load, execute: approval, save },
    cancel: { load: loadCancellation, execute: cancellation, save },
  };
}
/** Test/demo adapter only: no DB durability or concurrent-update protection. */
export function memoryRepository(initial: readonly Booking[], failSave = false) {
  const records = new Map(initial.map(booking => [booking.id, Object.freeze({ ...booking })]));
  let saves = 0, loads = 0;
  return {
    get saves() { return saves; }, get loads() { return loads; },
    async load(input: Input): Promise<Result<Booking, 'Missing'>> { loads++; const booking = records.get(input.id); return booking ? ok({ ...booking }) : err('Missing'); },
    async save(booking: Booking): Promise<Result<Booking, 'Conflict'>> {
      if (failSave) return err('Conflict');
      saves++; records.set(booking.id, Object.freeze({ ...booking })); return ok(booking);
    },
  };
}
