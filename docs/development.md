# Building from source

You need Rust and, for the plugin, Claude Code.

```sh
cargo build --release
```

The result is one file, `target/release/handsfree`.

## Trying the binary alone

```sh
target/release/handsfree run --listen     # prints events; leave it running
target/release/handsfree say "Hello."     # in another terminal
```

The first run downloads the models (about 700 MB today).

## Running the plugin against your build

```sh
HANDSFREE_BIN=$PWD/target/release/handsfree claude --plugin-dir plugin
```

Without `HANDSFREE_BIN` the plugin uses `~/.cache/handsfree/bin/handsfree`, downloading the
latest release there if it is missing.

Check the plugin with:

```sh
claude plugin validate plugin
```

## Layout

| | |
|---|---|
| `src/main.rs` | commands and the loopback socket |
| `src/ears.rs` | microphone → voice detection → recognition |
| `src/mic.rs` | the microphone, echo cancelled on macOS |
| `src/voice.rs` | speech, kept loaded |
| `src/sound.rs` | the speaker and the chimes |
| `src/models.rs` | model downloads |
| `plugin/` | the Claude Code plugin |

## Releases

Pushing a tag `v*` builds the binaries and attaches them to a GitHub release
(`.github/workflows/release.yml`). The plugin downloads `handsfree-<arch>-<os>.tar.gz`
from the latest release.
