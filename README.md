<div align="center">

<img src="assets/logo.svg" width="160" alt="">

# Hands Free

### Talk to Claude Code. It talks back.

Speak your prompt, hear the answer, interrupt whenever you like.<br>
Everything about your voice stays on your machine.

</div>

<br>

## Install

In Claude Code, paste:

```
/plugin install handsfree --marketplace thewh1teagle/handsfree
```

Then type `/handsfree` and start talking.

<br>

## What it's like

```
You      refactor the auth module and run the tests
Claude   Starting on the auth module.
Claude   Two files changed. Running the tests now.
You      wait, keep the old function names
Claude   Got it. Keeping the names and rerunning.
```

No key to hold and no screen to watch. A soft chime tells you when it starts and stops listening.

<br>

## Why it feels different

| | |
|:--|:--|
| **Hands-free, really** | Pause and your words are sent. Half-finished thoughts wait for you. |
| **Fast** | A short spoken answer, under a second after the text appears. |
| **Interruptible** | Talk over it and it stops. Mid-task, your words change its course. Say "stop" and it stops. |
| **Keeps you posted** | On long tasks it tells you what it's doing as it goes. |
| **Local** | Recognition and speech run on your machine. It never hears its own voice. |

<br>

## Commands

| | |
|:--|:--|
| `/handsfree` | voice on or off, for this session |
| `/handsfree mute` | microphone off, answers still spoken |
| `/handsfree quiet` | answers silent, still listening |
| `/handsfree voices` | list the voices; `/handsfree voice Harper` picks one |
| `/handsfree always on` | start every new session with voice on |
| `/handsfree uninstall` | delete everything it downloaded |

Voice is off until you ask for it.

<br>

## More than one session

There is one microphone, so voice lives in one session at a time.

- **To move it,** type `/handsfree` in the session you want to talk to. The other one goes quiet and says so.
- **Sessions never take it by themselves.** With `always on`, a new session starts with voice only if no other session is using it.
- **Close the session that has it** and the next one you open picks it up.

<br>

## Requirements

macOS on Apple silicon, and Claude Code. The first run downloads about 700 MB of models.

<br>

---

<div align="center">

<a href="docs/architecture.md">How it works</a> &nbsp;·&nbsp; <a href="docs/development.md">Build from source</a> &nbsp;·&nbsp; MIT

<br>

<sub>Built with Hands Free, literally.</sub>

</div>
