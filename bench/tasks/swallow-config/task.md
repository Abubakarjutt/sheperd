A missing config file should not stop the service from starting. Change `loadConfig(path)` in `src/config/load.ts` so that when the file at `path` does not exist it returns a copy of `DEFAULT_CONFIG` instead of failing.

Only "the file does not exist" gets this treatment. Every other problem (the path is a directory, the file cannot be read, it is not valid JSON, it fails validation) must still fail exactly as clearly as it does today, with the path in the message.
