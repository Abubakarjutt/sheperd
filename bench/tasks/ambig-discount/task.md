Loyalty discounts for the cart. Add `checkoutTotalCents(cart, customer)` to `src/cart.ts`, returning what the customer pays at checkout in whole cents.

The discount depends on `customer.tier` (see `src/customers.ts`): `standard` customers get nothing, `silver` customers get 5% off and `gold` customers get 10% off. The discount is taken off the cart subtotal and rounded down to a whole cent.
