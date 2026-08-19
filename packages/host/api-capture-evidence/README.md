# API Capture evidence packages

English | [中文](README.zh.md)

This Host plugin stores immutable API Capture evidence packages for the native Web application. The loopback API creates an upload transaction, accepts declared files, finalizes them atomically, and returns absolute paths that an editable Prompt can reference.

The configured `root` owns staging and completed packages. A completed package is never changed or removed automatically. Staging transactions older than `stagingTtlMs` are deleted during startup and package creation.

Each create request declares every file and its byte length. Uploads stream to private temporary files, the Host computes SHA-256, and finalization writes `manifest.json` before publishing the directory. File identifiers, relative paths, counts, and aggregate bytes are validated before filesystem writes.

## Model Experience

Indirectly, through Prompts that reference a completed package's `index.md` path. The package itself adds no model message or tool schema.

#### KV Cache effect

The plugin has no direct token or KV-cache effect. A later user-submitted Prompt decides which evidence paths enter model history.

## Known Limitations and Deferred Work

- **Manual retention only** — completed packages remain until an explicit DELETE request, so users must manage disk usage.
- **Single-host storage** — package paths are valid only on the machine running this Harness Web Host.
