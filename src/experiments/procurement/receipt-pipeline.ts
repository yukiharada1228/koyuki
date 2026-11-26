// Framework composition over ordinary domain rules; no repository access here.
import { withInput, workflow, ok } from '../../framework/index.js';
import { receiveOrder, returnCheckedReceipt, receiptCorrectionInput, finishReceiptCorrection, type CheckedReceipt, type ReasonInput, type CorrectInput } from './domain.js';
import type { ReceiveStockContext, ReceiptStockContext } from './inventory.js';
// Explicit context annotations retain stock/depletion facts that the receipt-only
// rules do not need. No Result unpacking is performed by these adapters.
export const receiveDecision = withInput((value: ReceiveStockContext) => receiveOrder(value));
export const returnDecision = withInput((value: CheckedReceipt<ReceiptStockContext<ReasonInput>>) => returnCheckedReceipt(value));
export const correctDecision = workflow('revalidate-correction', withInput((value: CheckedReceipt<ReceiptStockContext<CorrectInput>>) => receiveOrder(receiptCorrectionInput(value))))
  .then('correct-receipt-plan', ({ input, value }) => ok(Object.freeze({ input, value: finishReceiptCorrection(input, value) })));
