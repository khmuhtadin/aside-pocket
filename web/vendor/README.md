# Vendored libraries

The app has no build step, so its two dependencies are checked in as downloaded. The files are unmodified; to update one, download the new version from the same place and change this table.

| File | Upstream | Version | License | Downloaded from |
|---|---|---|---|---|
| `preact-htm.js` | [htm](https://github.com/developit/htm) standalone build, which bundles [Preact](https://github.com/preactjs/preact) | htm 3.1.1 | htm: Apache-2.0; Preact: MIT | https://unpkg.com/htm@3.1.1/preact/standalone.module.js |
| `jsqr.js` | [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | https://unpkg.com/jsqr@1.4.0/dist/jsQR.js |

`jsqr.js` is loaded only when the QR scanner on the pairing screen opens.
