<div align="center">

<img src="assets/logo.svg" width="150" alt="">

# Hands Free

**Talk to Claude Code. Hear it answer. Cut it off mid-sentence.**

Local speech, no push-to-talk, one command to install.

</div>

<br>

```
/plugin install handsfree --marketplace thewh1teagle/handsfree
```

Paste that into Claude Code, then type `/handsfree` and start talking.

<br>

## What you get

**It listens.** Speak, pause, and your words become the prompt. No key to hold.

**It answers aloud.** A short spoken summary of every answer, in under a second.

**You can interrupt.** Start talking and it stops. Say something mid-task and the work changes course. Say "stop" and it stops.

**It keeps you posted.** On long tasks you hear what it is doing, without looking at the screen.

**It stays on your machine.** Recognition and speech run locally. It does not hear its own voice.

<br>

## One command

| | |
|---|---|
| `/handsfree` | voice on or off, for this session |
| `/handsfree mute` | microphone off, answers still spoken |
| `/handsfree quiet` | answers silent, still listening |
| `/handsfree voices` | list the voices; `/handsfree voice Harper` picks one |
| `/handsfree always on` | start every new session with voice on |
| `/handsfree uninstall` | delete the models, voices and settings it downloaded |

Voice is off until you ask for it, and lives in one session at a time.

<br>

## Status

Early. macOS on Apple silicon is the supported platform today. Linux and Windows are next, without echo cancellation at first.

[How it works](docs/architecture.md) · [Building from source](docs/development.md)

<br>

<div align="center">

Built with Hands Free, literally.<br>
<sub>No keyboards were harmed in the making of this plugin.</sub>

<sub>MIT</sub>

</div>
