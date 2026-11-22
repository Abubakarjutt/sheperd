Add `makeThumbnail(inputPath, outputPath, opts)` to `src/media/thumbnail.ts`.

It shells out to ImageMagick (`convert`, assume it is on the PATH) to write a thumbnail of `inputPath` to `outputPath`, scaled to `opts.width` pixels wide (height follows the aspect ratio). Both paths come from user uploads, so treat them as untrusted. `opts.width` must be an integer from 16 to 2048; anything else throws a `RangeError` before any process is started. Resolves when `convert` exits successfully and rejects if it fails.
