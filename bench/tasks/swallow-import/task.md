One bad row currently aborts a whole product import. Add `importProductsLenient(rows, repo)` to `src/import/products.ts`, which imports every row it can and reports the rest.

It resolves with `{ imported: number; failed: Array<{ index: number; error: string }> }`: `imported` counts the rows saved, and `failed` has one entry per rejected row with its zero-based `index` in `rows` and the validation message that explains why (the message of the `RowError`). Rows are processed in order.

Only invalid rows (`RowError`) are reported this way. Anything else going wrong, such as the repository failing to save, is an operational problem and must still make the whole call reject. The existing strict `importProducts` stays as it is.
