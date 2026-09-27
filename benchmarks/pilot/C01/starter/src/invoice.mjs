// Intentionally faulty starter: binary floating-point and Math.round do not
// implement the task's decimal round-half-up contract at half-cent boundaries.
import { readFileSync } from 'node:fs';

function run(payload) {
  return payload.cases.map((invoice) => {
    const lineCents = invoice.lines.map((line) =>
      Math.round(Number(line.unitPrice) * line.quantity * 100),
    );
    const subtotalCents = lineCents.reduce((sum, cents) => sum + cents, 0);
    const discountCents = Math.round(
      subtotalCents * (Number(invoice.discountPercent) / 100),
    );
    const refundCents = Math.round(Number(invoice.refund) * 100);
    const amountDueCents = Math.max(
      0,
      subtotalCents - discountCents - Math.min(refundCents, subtotalCents - discountCents),
    );
    return {
      id: invoice.id,
      lineCents,
      subtotalCents,
      discountCents,
      refundCents,
      amountDueCents,
    };
  });
}

const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(run(input)));
