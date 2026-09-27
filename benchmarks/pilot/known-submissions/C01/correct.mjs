import { readFileSync } from 'node:fs';

function scaledDecimal(value, digits) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('invalid decimal');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > digits) throw new Error('too many decimal places');
  return BigInt(whole) * 10n ** BigInt(digits) + BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
}

function roundHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function toCents(amount) {
  return roundHalfUp(scaledDecimal(amount, 4), 100n);
}

function invoiceResult(invoice) {
  const lineCents = invoice.lines.map((line) =>
    Number(roundHalfUp(scaledDecimal(line.unitPrice, 4) * BigInt(line.quantity), 100n)),
  );
  const subtotal = lineCents.reduce((sum, cents) => sum + cents, 0);
  const discountRate = scaledDecimal(invoice.discountPercent, 2);
  const discount = Number(roundHalfUp(BigInt(subtotal) * discountRate, 10000n));
  const refund = Math.min(Number(toCents(invoice.refund)), Math.max(0, subtotal - discount));
  return {
    id: invoice.id,
    lineCents,
    subtotalCents: subtotal,
    discountCents: discount,
    refundCents: refund,
    amountDueCents: Math.max(0, subtotal - discount - refund),
  };
}

const payload = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(payload.cases.map(invoiceResult)));
