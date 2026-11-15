import type { EngineInterface, Register } from 'claude-code'

// The `handsfree` binary does everything that makes or hears sound, as one background
// process (`handsfree run`). This module decides what is said and what is done with what
// was heard, and talks to it through its small commands.

const REPO = 'thewh1teagle/handsfree'

// ───────────────────────── the binary ─────────────────────────

let binary: string | undefined

/** Where the binary is, downloading the release build for this machine the first time. */
const locate = async ($: EngineInterface): Promise<string> => {
  if (binary !== undefined) return binary
  const named = await $.env.get('HANDSFREE_BIN')
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/.cache/handsfree/bin`
  const path = named ?? `${dir}/handsfree`
  if (named === undefined && !(await $.fs.exists(path))) {
    const { stdout } = await $.process.run(['uname', '-sm'])
    const [system, machine] = stdout.trim().split(' ')
    const os = system === 'Darwin' ? 'apple-darwin' : 'unknown-linux-gnu'
    const arch = machine === 'arm64' || machine === 'aarch64' ? 'aarch64' : 'x86_64'
    const archive = `handsfree-${arch}-${os}.tar.gz`
    $.ui.status('handsfree: downloading the voice engine')
    await $.process.run(['mkdir', '-p', dir])
    const got = await $.process.run(
      ['curl', '-fsSL', '-o', `${dir}/${archive}`, `https://github.com/${REPO}/releases/latest/download/${archive}`],
      { timeoutMs: 300_000 },
    )
    if (got.exitCode !== 0) {
      $.ui.status(undefined)
      throw new Error(`could not download ${archive}: ${got.stderr.trim().slice(-200)}`)
    }
    await $.process.run(['tar', '-xzf', `${dir}/${archive}`, '-C', dir])
    $.ui.status(undefined)
  }
  binary = path

  return path
}

// ───────────────────────── speaking ─────────────────────────

// What the small model is asked for: the spoken version of an answer.
const BRIEF =
  'You write what a voice assistant says aloud. You are given the recent conversation between a user and a ' +
  "coding assistant, then the assistant's final answer. Reply with only what the assistant should say aloud " +
  'about that answer: one or two short, conversational English sentences, in the first person, giving the ' +
  'outcome and anything the user must do next. Plain words only: no markdown, code, file paths, lists or ' +
  'quotation marks.'
const RECENT = 6 // messages of context before the answer
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)} [...]` : text)

const brief = async ($: EngineInterface, answer: string): Promise<string | undefined> => {
  const spoken = (await $.session.messages()).filter(m => m.text.trim() !== '')
  // the answer itself is the transcript's last assistant message: leave it out of the context
  if (spoken.at(-1)?.role === 'assistant') spoken.pop()
  const recent = spoken
    .slice(-RECENT)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.text.trim(), 600)}`)
    .join('\n\n')
  const reply = await $.model.complete({
    model: 'haiku',
    system: BRIEF,
    prompt: `Recent conversation, oldest first:\n\n${recent}\n\nThe final answer to speak about:\n<answer>\n${clip(answer, 6000)}\n</answer>`,
    maxTokens: 150,
    timeoutMs: 8000,
  })

  return reply.isAnswered ? reply.text.trim() : undefined
}

// The fallback when the small model does not answer: the session's own model, over the
// whole conversation. No `effort` is named, so the conversation is read from the cache.
const ask = (answer: string): string =>
  [
    'This message comes from the speech plugin, not from the user. Do not continue the task.',
    'You have no tools here: answer straight away, without thinking it over.',
    'Your final answer of this turn was:',
    '<answer>',
    answer,
    '</answer>',
    'Reply with only what should be said aloud to the user about it: one or two short,',
    'conversational English sentences giving the outcome and anything they must do next.',
    'Plain words only: no markdown, code, file paths, lists or quotation marks.',
  ].join('\n')

// Voice is per session and starts off: nothing speaks and nothing listens until `/handsfree`.
let speaking = false
let listening = false

// Ends the `handsfree say` in flight; the engine stops talking when its client goes away.
let stop: (() => void) | undefined
let latest = 0

const hush = (): void => {
  latest++
  stop?.()
  stop = undefined
}

/** Says `text` and resolves when it has been said or cut off. */
const say = async ($: EngineInterface, text: string): Promise<void> => {
  await engine($)
  const voice = await $.store.get('voice')
  const argv = [await locate($), 'say', ...(typeof voice === 'string' && voice !== '' ? ['--voice', voice] : [])]
  const child = $.process.spawn({ argv, input: text })
  const stopMine = (): void => {
    void child.return({ code: null, signal: 'SIGTERM' })
  }
  stop = stopMine
  try {
    for await (const piece of child) void piece
  } finally {
    if (stop === stopMine) stop = undefined
  }
}

// Progress during a long turn: what the model writes between its tool calls, and what its
// commands say they do, is said aloud as it is, with no extra model request. At most one
// update every GAP_MS, never over speech still playing, the first one FIRST_MS into the turn.
const GAP_MS = 25_000
const FIRST_MS = 10_000
let quietSince = 0

const plain = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let out = ''
  for (const sentence of flat.match(/[^.!?]+[.!?]*/g) ?? []) {
    if (out !== '' && out.length + sentence.length > 180) break
    out += sentence
  }

  return out.trim().slice(0, 240)
}

const progress = async ($: EngineInterface, text: string): Promise<void> => {
  const line = plain(text)
  if (line.length < 8 || stop !== undefined || personHasTheFloor()) return
  const now = await $.clock.now()
  if (now - quietSince < GAP_MS) return
  if (!speaking) return
  quietSince = now
  await say($, line)
}

// ───────────────────────── listening ─────────────────────────

// True from the moment the person starts to speak until their words arrive (or it was only
// a noise). Nothing is said aloud meanwhile, nor while half a thought of theirs is held.
let talking = false
const personHasTheFloor = (): boolean => talking || held !== ''

// The main loop's running turn: speech during it interrupts it.
let running: string | undefined

// Set when speech ended a running turn: the prompt that follows carries INTERRUPTED.
let cutIn = false
const INTERRUPTED =
  'The user said this aloud while you were in the middle of a task, and speaking ended that turn before it was finished. ' +
  'Respond to what they said first. Then, unless it tells you to stop or to do something else instead, ' +
  'continue the interrupted task from where it was cut off, redoing the step that was in progress if needed.'

// "Stop", said alone, is a command to the session and is never sent to the model.
const STOP =
  /^((ok(ay)?|alright|all right|please|hey|no)[, ]+)*(stop|cancel|abort|halt|enough|never ?mind|quiet|be quiet|shut up|you can stop|that's enough|that is enough)(( it| that| now| please| there| talking| everything))*[.!]*$/i

// How a small model sorts what was just heard.
const DONE = 'something to answer or act on now, even if short or casual'
const UNFINISHED = 'breaks off in the middle of a sentence, or asks to wait a moment'

// Speech heard so far that was not yet a whole thought, and the timer that sends it anyway.
let held = ''
let waiting: { cancel: () => void } | undefined
const HOLD_MS = 4000

/** What was heard becomes a prompt of the person's own; said during a turn, it ends that turn first. */
const send = ($: EngineInterface, text: string): void => {
  waiting?.cancel()
  waiting = undefined
  held = ''
  $.ui.status(undefined)
  if (text.trim() === '') return
  const turnId = running
  void (async () => {
    if (turnId !== undefined) {
      hush()
      cutIn = true
      await $.turn.abort({ turnId }).catch(() => undefined)
    }
    await $.prompt.submit({ text, asUser: true })
  })().catch(error => {
    $.ui.log(`handsfree: could not send what was heard: ${String(error)}`)
  })
}

const heard = async ($: EngineInterface, text: string): Promise<void> => {
  talking = false
  if (STOP.test(text)) {
    const turnId = running
    hush()
    waiting?.cancel()
    held = ''
    if (turnId !== undefined) await $.turn.abort({ turnId }).catch(() => undefined)
    $.ui.status(undefined)
    $.ui.toast(turnId === undefined ? 'Voice: quiet.' : 'Voice: stopped.')

    return
  }
  waiting?.cancel()
  const said = `${held} ${text}`.trim()
  // Only a thought plainly cut off by a pause, or "wait a second", is kept back and joined
  // to what comes next; with nothing more said within HOLD_MS it is sent as it stands.
  const kind = await $.model.classify(said, [DONE, UNFINISHED]).catch(() => DONE)
  if (kind === UNFINISHED) {
    held = said
    $.ui.status(`voice: waiting ${HOLD_MS / 1000}s for the rest of "${said.slice(-40)}"`)
    waiting = $.clock.after(HOLD_MS, () => send($, held))

    return
  }
  send($, said)
}

// ───────────────────────── the engine process ─────────────────────────

// Ends the engine's stream, which ends the process: the microphone and the speaker are freed.
let quit: (() => void) | undefined

/** Starts `handsfree run` once per session and follows its events. */
const engine = async ($: EngineInterface): Promise<void> => {
  if (quit !== undefined) return
  const path = await locate($)
  const child = $.process.spawn({ argv: [path, 'run', ...(listening ? ['--listen'] : [])] })
  const mine = (): void => {
    void child.return({ code: null, signal: 'SIGTERM' })
  }
  quit = mine
  void (async () => {
    let pending = ''
    for await (const piece of child) {
      if (piece.stream !== 'stdout') continue
      pending += piece.text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        const e = JSON.parse(line) as { event: string; text?: string; file?: string; percent?: number; message?: string }
        if (e.event === 'speech') {
          talking = true
          hush() // they began to speak: stop talking, as one would
        } else if (e.event === 'quiet' || e.event === 'deaf') talking = false
        else if (e.event === 'heard' && e.text !== undefined) await heard($, e.text)
        else if (e.event === 'download') $.ui.status(e.percent === 100 ? undefined : `handsfree: downloading ${e.file} ${e.percent}%`)
        else if (e.event === 'error') $.ui.log(`handsfree: ${e.message}`)
        else if (e.event === 'taken') {
          // another session turned voice on: there is one microphone and one speaker
          speaking = false
          listening = false
          $.ui.log('handsfree: voice moved to another session. /handsfree brings it back here.')
        }
      }
    }
  })()
    .catch(error => {
      $.ui.log(`handsfree: the voice engine stopped: ${String(error)}`)
    })
    .finally(() => {
      talking = false
      if (quit === mine) quit = undefined
    })
}

// ───────────────────────── hooks ─────────────────────────

/** Turns the two halves of voice on or off for this session. */
const set = async ($: EngineInterface, speak: boolean, listen: boolean): Promise<void> => {
  speaking = speak
  listening = listen
  if (!speak) hush()
  if (!listen) {
    waiting?.cancel()
    held = ''
    talking = false
    $.ui.status(undefined)
  }
  if (!speak && !listen) {
    quit?.() // frees the microphone, the speaker and the memory
    quit = undefined

    return
  }
  await engine($)
  await $.process.run([await locate($), 'listen', listen ? 'on' : 'off'])
}

// Said once, the first time voice is ever turned on: what to do, in three breaths.
const WELCOME =
  'Voice is on. Just talk, and pause when you are done. ' +
  'Talk over me to interrupt, or say stop. ' +
  'To have me in every session, type slash hands free always on.'

const HELP =
  '/handsfree on or off · mute (microphone off) · quiet (speech off) · voices · voice <name> · always on|off · uninstall'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handsfree',
      description: 'Voice on or off for this session. Also: mute, quiet, voices, voice <name>, always on|off, uninstall',
    })
    // once, right after installing: the one thing to know
    if ((await $.store.get('hinted')) !== true) {
      await $.store.set('hinted', true)
      $.ui.log('handsfree is installed. Type /handsfree to talk to Claude.')
    }
    // off in every new session, unless the person asked for it always
    if ((await $.store.get('always')) === true) {
      void set($, true, true).catch(error => $.ui.log(`handsfree: ${String(error)}`))
    }

    return next(e)
  })

  on('command.run', { command: 'handsfree' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = word.toLowerCase()
    const say1 = (text: string) => ({ text, isTextDisplayOnly: true as const })
    const isOn = speaking || listening

    if (arg === '' || arg === 'on' || arg === 'off') {
      const turnOn = arg === 'on' || (arg === '' && !isOn)
      await set($, turnOn, turnOn)
      if (turnOn && (await $.store.get('welcomed')) !== true) {
        await $.store.set('welcomed', true)
        void say($, WELCOME).catch(() => undefined)
      }

      return say1(
        turnOn
          ? 'Voice on. Speak, pause, and it is sent. Talk over me to interrupt; say "stop" to cut me off.'
          : 'Voice off.',
      )
    }
    if (arg === 'mute') {
      await set($, true, false)

      return say1('Microphone off. I still answer aloud. /handsfree on turns it back on.')
    }
    if (arg === 'quiet') {
      await set($, false, true)

      return say1('Spoken answers off. I am still listening. /handsfree on turns them back on.')
    }
    if (arg === 'always') {
      const always = rest[0]?.toLowerCase() !== 'off'
      await $.store.set('always', always)

      return say1(always ? 'Voice will start on in every new session.' : 'Voice will start off in new sessions.')
    }
    if (arg === 'voices') {
      const listed = await $.process.run([await locate($), 'voices'], { timeoutMs: 60_000 })
      const current = await $.store.get('voice')
      const now = typeof current === 'string' && current !== '' ? current : 'the default'

      return say1(
        listed.exitCode === 0
          ? `Voices (now: ${now}). Pick one with /handsfree voice <name>.\n\n${listed.stdout.trim()}`
          : `Could not list the voices: ${listed.stderr.trim().slice(-200)}`,
      )
    }
    if (arg === 'voice') {
      const name = rest.join(' ')
      const isDefault = name === '' || name.toLowerCase() === 'default'
      await $.store.set('voice', isDefault ? '' : name)
      if (speaking) void say($, isDefault ? 'This is the default voice.' : `This is ${name}.`).catch(() => undefined)

      return say1(isDefault ? 'Voice reset to the default.' : `Voice: ${name}.`)
    }

    if (arg === 'uninstall') {
      await set($, false, false)
      // the binary removes its own folder (itself, the models, the settings) and the voices
      const gone = await $.process.run([await locate($), 'uninstall'], { timeoutMs: 60_000 })
      binary = undefined
      for (const key of ['always', 'voice', 'welcomed', 'hinted']) await $.store.delete(key)

      return say1(
        `${gone.stdout.trim() || gone.stderr.trim()}\n\nThe downloads are gone. To remove the plugin itself: /plugin uninstall handsfree`,
      )
    }

    return say1(HELP)
  }).catch(() => ({ text: `The command failed. ${HELP}`, isTextDisplayOnly: true as const }))

  // A new prompt cuts off whatever is still being said.
  on('prompt.submit', ($, e, next) => {
    hush()
    if (!cutIn) return next(e)
    cutIn = false

    // The model is told its work was cut short by these words, so that it deals with them
    // and then picks the work up again unless they said otherwise.
    return next({ ...e, context: [...(e.context ?? []), INTERRUPTED] })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      running = e.turnId
      quietSince = (await $.clock.now()) - GAP_MS + FIRST_MS
    }

    return next(e)
  })

  // A step that goes on to call tools is not the answer: its text is a note on the way.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    if (e.agentId === undefined && step.toolUses.length > 0 && step.answer.trim() !== '') {
      void progress($, step.answer).catch(() => undefined)
    }

    return step
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (e.agentId === undefined && typeof e.description === 'string') {
      void progress($, e.description).catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // a fault here must never stand in a command's way

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && running === e.turnId) running = undefined
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'
    if (!isMainAnswer || e.answer.trim() === '') return done
    if (!speaking) return done

    const mine = ++latest
    // Not awaited: the turn ends now, the speech follows on its own.
    void (async () => {
      let text = await brief($, e.answer).catch(() => undefined)
      if (text === undefined || text === '') {
        const reply = await $.model.fork({ prompt: ask(e.answer) })
        if (!reply.isAnswered) return
        text = reply.text
      }
      // never over the person: wait for them to finish; their words, once sent, cancel this
      for (let waited = 0; personHasTheFloor() && waited < 10_000; waited += 150) {
        await $.clock.sleep(150)
      }
      if (personHasTheFloor() || mine !== latest) return
      await say($, text)
    })().catch(error => {
      $.ui.log(`handsfree: ${String(error)}`, { to: 'debug' })
    })

    return done
  })
}
