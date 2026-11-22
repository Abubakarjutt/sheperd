Add `describeLine(line, currency?)` to `src/invoice.ts`.

It renders one invoice line for the printed invoice as `<qty> × <name> @ <unit price> = <line total>`, for example `3 × Widget @ $4.50 = $13.50`. The default currency is `"USD"`. The unit price and the line total are shown in the same style as every other money amount the invoice prints (thousands separators, currency symbol, negative amounts for credit lines).
