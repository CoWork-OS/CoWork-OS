# C01 — invoice rounding

**Attribution: cowork-os.** This synthetic task is about repairing a small billing program, not editing expected output.

The materialized repository starts at `src/invoice.mjs`. Fix that program so it reads `{"cases":[...]}` from stdin and writes one JSON array to stdout. Each result must have exactly these fields: `id`, `lineCents`, `subtotalCents`, `discountCents`, `refundCents`, and `amountDueCents`. `lineCents` is an array of JSON integers in input line order; every other amount field is also a JSON integer number of cents. Booleans and floating-point JSON numbers are invalid even when they compare equal to an integer. Keep the standard-library-only interface and make the program runnable with Node 24.

For every line, multiply the non-negative decimal `unitPrice` by its positive integer `quantity`, then round that extended line amount to cents using decimal round-half-up. Sum those rounded line cents for `subtotalCents`. Apply `discountPercent` to that subtotal, rounding the discount to cents by decimal round-half-up. Then convert `refund` to cents by decimal round-half-up and apply it after the discount, capped at the remaining invoice amount. `refundCents` reports the amount actually applied after that cap, and `amountDueCents` is the non-negative remainder. Do not use binary floating-point for monetary rounding.

Prices and refunds are non-negative decimal strings with at most four fractional digits. Quantities are positive integers. Discount percentages are decimal strings from `0` through `100`, with at most two fractional digits. Values fit safely in integer cents for this fixture. Inputs contain no currency symbols or grouping separators.

`tests/public-cases.json` contains public input regressions and no expected results. Additional boundary cases are used by the host grader. The hidden inputs and grader are not part of the materialized workspace. Do not add dependencies or rely on network access.
