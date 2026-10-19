# Third-party notices

This package includes third-party code. It does **not** call any online QR
service; all QR encoding happens locally.

## public/qr.js — QR Code encoder

Based on ["QRCode for JavaScript"](https://www.d-project.com/) by
Kazuhiko Arase (the `qrcode-generator` project), Copyright (c) 2009 Kazuhiko
Arase, licensed under the [MIT license](http://opensource.org/licenses/mit-license.php).

The vendored copy is the `vendor/QRCode` directory as distributed with the
 [`qrcode-terminal`](https://github.com/gtanner/qrcode-terminal) project
(Apache-2.0 project; the vendored file retains its original MIT header).
It has been concatenated into a single browser-friendly file with a small
SVG rendering helper added; the encoder itself is unmodified in behavior.

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
