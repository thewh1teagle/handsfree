# How it works

Hands Free is two parts: a Rust binary that owns everything to do with sound, and a small
Claude Code plugin that decides what is said and what is done with what was heard.

```
 Claude Code                               handsfree (one process)
┌────────────────────────┐   heard text   ┌──────────────────────────────────────┐
│ plugin (TypeScript)    │ ◀───────────── │ microphone ─▶ voice detection        │
│  · starts the binary   │                │   (echo cancelled)   ─▶ recognition  │
│  · speech ─▶ prompt    │ ─────────────▶ │                                      │
│  · writes the summary  │   say / stop   │ speech model ─▶ speaker (+ chimes)   │
└────────────────────────┘                └──────────────────────────────────────┘
```

## The binary

`handsfree run` is the background process. It prints one JSON event per line:

| event | meaning |
|---|---|
| `ready` | the speech model is loaded |
| `listening` / `deaf` | the microphone was opened / released |
| `speech` | someone started to speak; it has already stopped talking |
| `heard` | they paused; `text` is what they said |
| `quiet` | it was only a noise |
| `download` | a model file is downloading (`file`, `percent`) |
| `taken` | another session started its own; this one exits |
| `busy` | started with `--polite` while another was running; it exits without taking over |

The other commands are small clients that talk to it over a loopback socket:

```
handsfree say "Build passed."     # ends when it has been said; kill it to cut it off
handsfree stop
handsfree listen on|off
```

Inside the process:

- **Microphone.** On macOS it goes through the system's voice processing, which removes
  whatever the computer is playing, the assistant's own voice included. That is what makes
  interrupting possible. Elsewhere it is a plain input, deaf while the assistant talks.
- **Voice detection** is Silero VAD. A pause of 1.5 s ends an utterance.
- **Recognition** is Parakeet TDT 0.6B v2, run once per utterance.
- **Speech** is Phonon, kept loaded, played as it is generated. The default voice is Harper.
- **Chimes** are synthesized: two notes rising when it starts to listen, falling when it stops.

Models are downloaded on first use into `~/.cache/handsfree`. Settings can be put in
`~/.cache/handsfree/config.json` (`model`, `voice`, `silence`, `chimes`).

## The plugin

`plugin/hooks/register.ts` is one hooks module.

- **Spoken summary.** When a turn ends, a small model writes one or two sentences from the
  answer and the last six messages. It is a separate request; nothing is added to the
  session's own prompt.
- **Progress.** Notes the model writes between tool calls are read aloud as they are, at
  most one every 25 s.
- **Unfinished sentences.** What was heard is checked by a small model. A thought that
  breaks off is held for up to 4 s and joined to what comes next.
- **Interrupting.** Speech during a running turn ends that turn and becomes the next prompt,
  with a note telling the model it was interrupted. "Stop" on its own ends the turn and is
  not sent.
- **Never over you.** Nothing is said while you are speaking or mid-thought.
- **One session at a time.** Voice is off in every new session until `/handsfree`. Turning it
  on starts the binary; a binary started later tells the earlier one to quit (`taken`), so
  the microphone and speaker follow the session you last asked in.
