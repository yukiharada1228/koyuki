/** @jsx h */
import { h, Fragment, createContext, useContext, defineOperation, Operation, createApplication } from 'koyuki/experimental';
import { definitions, type BookingProps } from './definitions.js';
import type { Actor, Input } from './domain.js';
export const ActorContext = createContext<Actor>();
const BookingContext = createContext<ReturnType<typeof definitions>>();
function useBookingOperations() { return useContext(BookingContext); }
export const submitBooking = defineOperation('booking.submit.v1', () => useBookingOperations().submit);
export const approveBooking = defineOperation('booking.approve.v1', () => useBookingOperations().approve);
export const cancelBooking = defineOperation('booking.cancel.v1', () => useBookingOperations().cancel);
function BookingOperations() {
  return <Fragment><Operation operation={submitBooking} /><Operation operation={approveBooking} /><Operation operation={cancelBooking} /></Fragment>;
}
export function BookingBusiness(props: BookingProps) {
  const actor = useContext(ActorContext);
  return <BookingContext.Provider value={definitions(props, actor)}><BookingOperations /></BookingContext.Provider>;
}
export function createBookingApplication(props: BookingProps, authenticatedActor: Actor) {
  const app = createApplication(<ActorContext.Provider value={authenticatedActor}><BookingBusiness {...props} /></ActorContext.Provider>);
  return {
    submit: (input: Input) => app.execute(submitBooking, input),
    approve: (input: Input) => app.execute(approveBooking, input),
    cancel: (input: Input) => app.execute(cancelBooking, input),
    detailed: {
      submit: (input: Input) => app.executeDetailed(submitBooking, input),
      approve: (input: Input) => app.executeDetailed(approveBooking, input),
      cancel: (input: Input) => app.executeDetailed(cancelBooking, input),
    },
  };
}
