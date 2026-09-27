import { readFileSync } from 'node:fs';

const payload = JSON.parse(readFileSync(0, 'utf8'));
const result = payload.cases.map((invoice) => {
  const rawLines = invoice.lines.map((line) => Number(line.unitPrice) * line.quantity);
  const rawSubtotal = rawLines.reduce((sum, amount) => sum + amount, 0);
  const rawDiscount = rawSubtotal * Number(invoice.discountPercent) / 100;
  const rawRefund = Number(invoice.refund);
  const displayAmount = Number(Math.max(0, rawSubtotal - rawDiscount - rawRefund).toFixed(2));
  return {
    id: invoice.id,
    lineCents: rawLines.map((amount) => Math.round(amount * 100)),
    subtotalCents: Math.round(rawSubtotal * 100),
    discountCents: Math.round(rawDiscount * 100),
    refundCents: Math.round(rawRefund * 100),
    amountDueCents: displayAmount * 100,
  };
});
process.stdout.write(JSON.stringify(result));
