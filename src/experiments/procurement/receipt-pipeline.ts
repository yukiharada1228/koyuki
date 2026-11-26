// Framework composition over ordinary domain rules; no repository access here.
import { withInput, ok } from '../../framework/index.js';
import { receiveOrder, returnCheckedReceipt, receiptCorrectionInput, finishReceiptCorrection, type ReceivedChange } from './domain.js';
// The domain rules accept extra context without depending on stock/depletion.
// The application connects these generic rules directly as named stages.
export const receiveDecision = withInput(receiveOrder);
export const returnDecision = withInput(returnCheckedReceipt);
type CorrectionContext = Parameters<typeof receiptCorrectionInput>[0];
function revalidateCorrection<T extends CorrectionContext>(value: T) {
  return receiveOrder(receiptCorrectionInput(value));
}
export const correctedQuantities = withInput(revalidateCorrection);
export function correctionPlan<T extends CorrectionContext>({ input, value }: Readonly<{ input: T; value: ReceivedChange }>) {
  return ok(Object.freeze({ input, value: finishReceiptCorrection(input, value) }));
}
