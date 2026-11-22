When `Inventory.reserveAll(items)` fails, the warehouse UI only shows the first SKU that was short, so operators fix the order one SKU at a time.

Make `reserveAll` report every short SKU at once: the `InsufficientStockError` it throws gets a new `shortages` property, an array of `{ sku, requested, available }` with one entry per short SKU, in the order the SKUs first appear in `items`. The existing `sku`, `requested` and `available` properties keep describing the first shortage.

Everything else about `reserveAll` stays as it is.
