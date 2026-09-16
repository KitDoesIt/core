# Asphyxia CORE (Bun)

KONMAI FUN TIME — a rhythm-game server. This branch ports CORE to
[Bun](https://bun.sh) 1.4+, replacing most third-party dependencies with
Bun built-ins.

## Requirements

- [Bun](https://bun.sh) **1.4.2** or newer (`Bun.XML` is required)

## Run from source

```bash
bun install
bun start              # same as: bun src/AsphyxiaCore.ts
```

Optional flags (`bun start --help`):

```
-p, --port            listening port (default 8083)
-b, --bind            hostname binding (default "localhost")
-m, --matching-port   matchmaking port (default 5700)
--dev, --console      developer mode (console + query shell)
-pa, --ping-addr      ICMP pingable target for "online" games
--force-load-db       force load savedata, discard corrupted records
-d, --savedata-dir    change the savedata directory
```

`config.ini`, `savedata/`, `plugins/` and `assets/` live next to the
process working directory in development, or next to the executable for
compiled builds.

## Build

```bash
bun run build                      # native standalone binary -> build/asphyxia-core
bash build-linux.sh                # linux-x64 + linux-arm64 + windows-x64 zips
bash build-win.sh                  # windows-x64 zip
```

Standalone binaries are produced with `bun build --compile`. The zip
artifacts contain the binary plus `assets/` and `plugins/`; extract and
run the executable from any directory.

## Plugins

Plugins stay as plain directories under `plugins/` and are loaded at
startup. Both JavaScript and TypeScript sources are supported natively
(Bun transpiles `.ts` on import), so `ts-node` is not required. The
global API (`$`, `K`, `IO`, `DB`, `U`, `R`, ...) is unchanged; see
`plugins/asphyxia-core.d.ts`.

## Docker

```bash
docker build -t asphyxia-core .
docker run -p 8083:8083 -p 5700:5700 -v $PWD/savedata:/app/savedata asphyxia-core
```

## Port notes

The port keeps observable behavior (HTTP responses, EAMUSE XML/KBin
protocol, savedata format, console output) identical to the previous
Node.js implementation, verified against a golden test suite. Bun
built-ins replace several packages:

| Previous dependency | Replacement |
| --- | --- |
| express, body-parser, cookie-parser, express-session, memorystore, connect-flash, multer | express-compatible layer on `Bun.serve`, built-in `FormData` |
| ts-node | native Bun TypeScript transpilation |
| fast-xml-parser | `Bun.XML` + local serializer |
| winston, chalk | small local logger/colors implementation |
| argparse, ini | local compatible implementations |
| open, pretty-bytes, sizeof, hashids | local implementations |
| @vercel/ncc, pkg | `bun build --compile` |

`lodash` (exposed to plugins as `_`), `pug`, `ejs`, `iconv-lite`
(Shift_JIS/EUC-JP encoding), `showdown` and `@seald-io/nedb` are kept
because they have no behaviorally-compatible Bun built-in.
