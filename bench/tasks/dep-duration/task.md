Add `parseDuration(text)` to `src/time/parse.ts`: the inverse of `formatDuration` in `src/time/format.ts`, for the "timeout" setting in the config file.

It returns a number of milliseconds. Accepted forms:

- one or more `<number><unit>` parts, optionally separated by spaces, with units `d`, `h`, `m`, `s`, `ms` (for example `"1h30m"`, `"1h 30m"`, `"250ms"`, `"2d"`); the parts add up;
- a number may have a fraction (`"1.5h"` is 5 400 000);
- a bare number with no unit is seconds (`"90"` is 90 000);
- surrounding whitespace and upper-case units are fine (`" 5M "` is 300 000).

Anything else (empty text, a unit used twice, unknown units, negative numbers, garbage) throws a `RangeError` whose message includes the offending text. The result must be a whole number of milliseconds (round fractions).
