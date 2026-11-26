// Framework composition over ordinary domain rules; no repository access here.
import { withInput, workflow, ok } from '../../framework/index.js';
import { receiveOrder, returnCheckedReceipt, receiptCorrectionInput, finishReceiptCorrection, type CheckedReceipt, type CorrectInput } from './domain.js';
import type { ReceiptStockContext } from './inventory.js';
import { includeChangedStock } from './inventory.js';
// The domain rules accept extra context without depending on stock/depletion.
// The application connects these generic rules directly as named stages.
export const receiveDecision = withInput(receiveOrder);
export const returnDecision = withInput(returnCheckedReceipt);
export const correctDecision = workflow('revalidate-correction', withInput((value: CheckedReceipt<ReceiptStockContext<CorrectInput>>) => receiveOrder(receiptCorrectionInput(value))))
  .then('correct-receipt-plan', ({ input, value }) => ok(Object.freeze({ input, value: finishReceiptCorrection(input, value) })));

// Correction still needs a concrete stock context to compose its inner steps.
export const correctStockDecision = correctDecision
  .then('run:3', pair => includeChangedStock(pair));
