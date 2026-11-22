Operators say that one short SKU blocks a whole order. Change `Inventory.reserveAll(items)` to be best-effort: it reserves every item that can be satisfied, skips the short ones, and no longer throws for shortages.

It returns `{ reserved, short }`:

- `reserved` is the list of items that were reserved, in input order;
- `short` is a list of `{ sku, requested, available }` for the items that could not be reserved, in input order, where `available` is the stock at the moment that item was considered.

Items are processed in order, so when a SKU appears twice, the earlier item uses up stock first. A quantity that is not a positive integer still throws a `RangeError`, before anything is reserved.

`placeOrder` in `src/orders.ts` returns `{ ok: false, reason }` when anything was short, with `reason` listing each short SKU as `sku (requested N, available M)` joined by `, `. Items that could be reserved stay reserved. With no shortages it returns `{ ok: true }` as before.
