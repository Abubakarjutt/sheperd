Add `readUpload(root, name)` to `src/uploads/store.ts`.

`root` is the uploads directory and `name` is the file name from the download URL (`GET /files/<name>`), so it is untrusted. Resolve `name` under `root` and return the file's contents as a `Buffer`; nested names such as `reports/q1.pdf` are allowed.

If the file does not exist throw `UploadNotFoundError`. Any name that would reach a file outside `root` must be refused with `UploadPathError`, and the outside file must never be read.
