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

Releases are made by hand, from a machine of the platform being released:

```sh
scripts/release.sh
```

It checks that `Cargo.toml`, `plugin/.claude-plugin/plugin.json` and `VERSION` in
`plugin/hooks/register.ts` agree and that `main` is pushed, builds the binary, and attaches
`handsfree-<target>.tar.gz` to release `v<version>`. Run it again on another platform to add
that platform's binary to the same release.

The plugin downloads the release that matches its own version, so bump all three together.
