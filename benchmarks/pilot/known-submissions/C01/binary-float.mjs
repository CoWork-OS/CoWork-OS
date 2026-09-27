import { readFileSync } from 'node:fs';

const payload = JSON.parse(readFileSync(0, 'utf8'));
const result = payload.cases.map((invoice) => {
  const lineCents = invoice.lines.map((line) => Math.round(Number(line.unitPrice) * line.quantity * 100));
  const subtotalCents = lineCents.reduce((sum, value) => sum + value, 0);
  const discountCents = Math.round(subtotalCents * Number(invoice.discountPercent) / 100);
  const refundCents = Math.round(Number(invoice.refund) * 100);
  const amountDueCents = Math.max(0, subtotalCents - discountCents - Math.min(refundCents, subtotalCents - discountCents));
  return { id: invoice.id, lineCents, subtotalCents, discountCents, refundCents, amountDueCents };
});
process.stdout.write(JSON.stringify(result));
