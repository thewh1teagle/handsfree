import type { EngineInterface, Register } from 'claude-code'

// The `handsfree` binary does everything that makes or hears sound, as one background
// process (`handsfree run`). This module decides what is said and what is done with what
// was heard, and talks to it through its small commands.

const REPO = 'thewh1teagle/handsfree'

// ───────────────────────── the binary ─────────────────────────

let binary: string | undefined

// The binary this plugin was written against: release v<VERSION> of the repository.
const VERSION = '0.1.5'

/** Where the binary is, downloading this plugin's release of it when it is missing or older. */
const locate = async ($: EngineInterface): Promise<string> => {
  if (binary !== undefined) return binary
  const named = await $.env.get('HANDSFREE_BIN')
  if (named !== undefined) return (binary = named)
  const home = (await $.env.get('HOME')) ?? ''
  const dir = `${home}/.cache/handsfree/bin`
  const path = `${dir}/handsfree`
  const has = (await $.fs.exists(path))
    ? (await $.process.run([path, '--version']).catch(() => ({ stdout: '' }))).stdout.trim()
    : ''
  if (has !== `handsfree ${VERSION}`) {
    const { stdout } = await $.process.run(['uname', '-sm'])
    const [system, machine] = stdout.trim().split(' ')
    const os = system === 'Darwin' ? 'apple-darwin' : 'unknown-linux-gnu'
    const arch = machine === 'arm64' || machine === 'aarch64' ? 'aarch64' : 'x86_64'
    const archive = `handsfree-${arch}-${os}.tar.gz`
    $.ui.status(`handsfree: ${has === '' ? 'downloading' : 'updating'} the voice engine`)
    await $.process.run(['mkdir', '-p', dir])
    const got = await $.process.run(
      ['curl', '-fsSL', '-o', `${dir}/${archive}`, `https://github.com/${REPO}/releases/download/v${VERSION}/${archive}`],
      { timeoutMs: 300_000 },
    )
    $.ui.status(undefined)
    if (got.exitCode !== 0) {
      // an older engine that is there still works: keep it rather than have no voice
      if (has === '') throw new Error(`could not download ${archive} (v${VERSION}): ${got.stderr.trim().slice(-200)}`)
    } else {
      await $.process.run(['tar', '-xzf', `${dir}/${archive}`, '-C', dir])
    }
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

// What was last said aloud and when it ended (0 while it is still being said): if the
// microphone hands those same words back, it heard us, not the person.
let said = ''
let saidUntil = 0
const ECHO_MS = 6000
const wordsOf = (text: string): string =>
  text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** True when `heard` is a run of two or more words straight out of what we just said. */
const isOwnVoice = async ($: EngineInterface, heard: string): Promise<boolean> => {
  const words = wordsOf(heard)
  if (said === '' || words.split(' ').length < 2) return false
  if (saidUntil !== 0 && (await $.clock.now()) - saidUntil > ECHO_MS) return false

  return ` ${said} `.includes(` ${words} `)
}

/** Says `text` and resolves when it has been said or cut off. */
const say = async ($: EngineInterface, text: string): Promise<void> => {
  await engine($)
  said = wordsOf(text)
  saidUntil = 0
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
    saidUntil = await $.clock.now().catch(() => 0)
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

// When an answer is taking a while and nothing has been said yet, a few words so the wait
// is not silence. Once per turn, THINK_MS in, and never over the person or other speech.
const THINK_MS = 4000
const FILLERS = ['Thinking about it.', 'Let me think.', 'One moment.', 'Working on it.', 'Let me look into that.']
let thinking: { cancel: () => void } | undefined
let filler = 0

const progress = async ($: EngineInterface, text: string): Promise<void> => {
  const line = plain(text)
  if (line.length < 8 || stop !== undefined || personHasTheFloor()) return
  const now = await $.clock.now()
  if (now - quietSince < GAP_MS) return
  if (!speaking) return
  thinking?.cancel() // something real is about to be said
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
  /^((ok(ay)?|alright|all right|please|hey|no|claude|claud|cloud|clawed|clod)[, ]+)*(stop|cancel|abort|halt|enough|never ?mind|quiet|be quiet|shut up|you can stop|that's enough|that is enough)(( it| that| now| please| there| talking| everything))*[.!]*$/i

// "Stop listening" pauses: what is heard is dropped here, on this machine, before any model
// sees it, until the words that end the pause. For when you turn to talk to someone else.
const NAME = '(claude|claud|cloud|clawed|clod)'
const LEAD = '((ok|okay|alright|hey|please|so) )*'
const PAUSE = new RegExp(`^${LEAD}((${NAME} )?(stop|pause) listening|hands ?free (stop|pause|off|mute)|${NAME} (pause|mute))$`)
const RESUME = new RegExp(
  `^${LEAD}(hands ?free( (on|resume|start|listen|back))?|(${NAME} )?(start|resume) listening|${NAME} listen( again)?|(i am|im) back|listen again)$`,
)
/** The words alone: lower case, no punctuation. */
const bare = (text: string): string =>
  text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
// Recognition rarely hears the name right ("it's stop listening club"), so a short sentence
// with "stop listening" in it is enough, unless it goes on to say what to stop listening to.
const AWAY = /\b(stop|pause|quit) listening\b(?! (to|for)\b)/
const pauses = (words: string): boolean => PAUSE.test(words) || (AWAY.test(words) && words.split(' ').length <= 6)

// While paused only this machine reads what is heard, so the way back is forgiving: a short
// phrase with "hands free" in it, however recognition spelled it.
const BACK = /\b(hands? ?free|hands ?three|handsfree)\b/
const resumes = (words: string): boolean => RESUME.test(words) || (BACK.test(words) && words.split(' ').length <= 5)
let paused = false

// How a small model sorts what was just heard.
const DONE = 'something to answer or act on now, even if short or casual'
const UNFINISHED = 'breaks off in the middle of a sentence, or asks to wait a moment'
const GO_AWAY = 'only tells the assistant to stop listening or pause, possibly misheard by speech recognition'

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

const pause = async ($: EngineInterface, on: boolean): Promise<void> => {
  paused = on
  talking = false
  waiting?.cancel()
  held = ''
  await $.process.run([await locate($), 'listen', on ? 'pause' : 'resume']).catch(() => undefined)
  $.ui.status(on ? 'voice: paused. Say "hands free" to carry on.' : undefined)
  void say($, on ? 'Okay, I am not listening.' : 'I am listening.').catch(() => undefined)
}

const heard = async ($: EngineInterface, text: string): Promise<void> => {
  talking = false
  // echo cancellation let our own words through: they are not a prompt
  if (await isOwnVoice($, text)) return
  const words = bare(text)
  if (paused) {
    if (resumes(words)) await pause($, false)

    return // nothing else that was heard goes anywhere
  }
  if (pauses(words)) {
    await pause($, true)

    return
  }
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
  // The same check catches a request to stop listening that recognition garbled
  // ("claudes top this"): exact words cannot be relied on for that.
  const kind = await $.model.classify(said, [DONE, UNFINISHED, GO_AWAY]).catch(() => DONE)
  if (kind === GO_AWAY && said.split(' ').length <= 8) {
    await pause($, true)

    return
  }
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
const engine = async ($: EngineInterface, polite = false): Promise<void> => {
  if (quit !== undefined) return
  const path = await locate($)
  // polite: a session that turned voice on by itself ("always on") never takes it from another
  const flags = [...(listening ? ['--listen'] : []), ...(polite ? ['--polite'] : [])]
  const child = $.process.spawn({ argv: [path, 'run', ...flags] })
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
        else if (e.event === 'busy') {
          speaking = false
          listening = false
          $.ui.log('handsfree: voice is on in another session. /handsfree brings it here.')
        } else if (e.event === 'taken') {
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
const set = async ($: EngineInterface, speak: boolean, listen: boolean, polite = false): Promise<void> => {
  speaking = speak
  listening = listen
  if (!speak) hush()
  if (!listen || paused) {
    paused = false
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
  await engine($, polite)
  // started politely, the engine listens from its flag; a listen command would reach the
  // other session's engine instead
  if (!polite) await $.process.run([await locate($), 'listen', listen ? 'on' : 'off'])
}

// Said once, the first time voice is ever turned on: what to do, in three breaths.
const WELCOME =
  'Voice is on. Just talk, and pause when you are done. ' +
  'Talk over me to interrupt, or say stop. ' +
  'To have me in every session, type slash hands free always on.'

const HELP =
  '/handsfree on or off · mute (microphone off) · quiet (speech off) · voices · voice <name> · always on|off · update · uninstall'

/** What `/handsfree <args>` does; throws with the reason when it cannot. */
const command = async ($: EngineInterface, args: string): Promise<{ text: string; isTextDisplayOnly: true }> => {
  const [word = '', ...rest] = args.trim().split(/\s+/)
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

  if (arg === 'update') {
    // the two steps a person would type, in one
    const id = 'handsfree@handsfree'
    const listed = await $.process.run(['claude', 'plugin', 'marketplace', 'update', 'handsfree'], { timeoutMs: 120_000 })
    if (listed.exitCode !== 0) throw new Error(`could not check for updates: ${(listed.stderr || listed.stdout).trim().slice(-300)}`)
    const updated = await $.process.run(['claude', 'plugin', 'update', id], { timeoutMs: 120_000 })
    if (updated.exitCode !== 0) throw new Error(`could not update: ${(updated.stderr || updated.stdout).trim().slice(-300)}`)
    await $.store.set('latest', '')
    const line = updated.stdout.trim().split('\n').at(-1) ?? 'Updated.'
    // Claude Code loads a new plugin version only when it starts: a reload keeps the old one
    const isNew = !/already/i.test(line)

    return say1(isNew ? `${line.replace(/\s*Restart to apply changes\.?/i, '')}\nRestart Claude Code to finish.` : line)
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
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handsfree',
      description: 'Voice on or off for this session. Also: mute, quiet, voices, voice <name>, always on|off, update, uninstall',
    })
    // The model's own handle on voice: it understands "give me a minute, I'm talking to
    // someone" however it was said or misheard, and calls this instead of answering.
    await $.tool.register({
      name: 'voice',
      isDeferred: false,
      description:
        'Controls the Hands Free voice plugin, through which the user may be speaking to you aloud. Call it when ' +
        'the user asks you to stop listening, pause, wait while they talk to someone else, mute the microphone, ' +
        'stop speaking aloud, turn voice off, or change your voice. Their words reach you through speech ' +
        'recognition, which often garbles such requests (for example "it is stop listening club" for "stop ' +
        'listening, Claude"): when a short message plausibly means one of these, call this tool instead of ' +
        'answering. Actions: "pause" stops acting on what is heard until the user says "hands free"; "mute" turns ' +
        'the microphone off; "quiet" stops spoken answers; "off" turns voice off; "voice" changes the voice to `name`.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pause', 'mute', 'quiet', 'off', 'voice'] },
          name: { type: 'string', description: 'For "voice": the voice to use, e.g. Harper.' },
        },
        required: ['action'],
      },
    })
    // once, right after installing: the one thing to know
    if ((await $.store.get('hinted')) !== true) {
      await $.store.set('hinted', true)
      $.ui.log('handsfree is installed. Type /handsfree to talk to Claude.')
    }
    // once a day, quietly: is there a newer release than the one this plugin was written for?
    void (async () => {
      const now = await $.clock.now()
      const last = await $.store.get('checked')
      if (typeof last !== 'number' || now - last > 86_400_000) {
        await $.store.set('checked', now)
        const reply = await $.http.fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
        const tag = reply.ok ? (JSON.parse(reply.text) as { tag_name?: string }).tag_name : undefined
        await $.store.set('latest', typeof tag === 'string' ? tag.replace(/^v/, '') : '')
      }
      const latest = await $.store.get('latest')
      const newer = (a: string, b: string): boolean =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) > 0
      if (typeof latest === 'string' && latest !== '' && newer(latest, VERSION)) {
        $.ui.log(`handsfree ${latest} is available. Type /handsfree update.`)
      }
    })().catch(() => undefined)
    // off in every new session, unless the person asked for it always
    if ((await $.store.get('always')) === true) {
      void set($, true, true, true).catch(error => $.ui.log(`handsfree: ${String(error)}`))
    }

    return next(e)
  })

  on('command.run', { command: 'handsfree' }, async ($, e) => {
    try {
      return await command($, e.args)
    } catch (error) {
      // say why, not just that it failed: a download that did not work is the usual reason
      speaking = false
      listening = false

      return {
        text: `Could not do that: ${error instanceof Error ? error.message : String(error)}`,
        isTextDisplayOnly: true as const,
      }
    }
  }).catch(() => ({ text: `The command failed. ${HELP}`, isTextDisplayOnly: true as const }))

  on('tool.call', { tool: 'mcp__handsfree__voice' }, async ($, e) => {
    const input = e as unknown as { action?: string; name?: string }
    if (!speaking && !listening) return { result: 'Voice is off in this session; nothing to change.' }
    if (input.action === 'pause') {
      await pause($, true)

      return { result: 'Paused. Nothing heard is acted on until the user says "hands free". Do not reply further.' }
    }
    if (input.action === 'mute') await set($, true, false)
    else if (input.action === 'quiet') await set($, false, true)
    else if (input.action === 'off') await set($, false, false)
    else if (input.action === 'voice' && typeof input.name === 'string') await $.store.set('voice', input.name)
    else return { result: 'Unknown action.', isError: true as const }

    return { result: `Done: ${input.action}${input.action === 'voice' ? ` ${input.name}` : ''}.` }
  }).catch(() => ({ result: 'The voice control failed.', isError: true as const }))

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
      thinking?.cancel()
      const turnId = e.turnId
      thinking = $.clock.after(THINK_MS, () => {
        const isQuiet = stop === undefined && !personHasTheFloor() && !paused
        if (running !== turnId || !speaking || !isQuiet) return
        void say($, FILLERS[filler++ % FILLERS.length] ?? 'One moment.').catch(() => undefined)
      })
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
    if (e.agentId === undefined && running === e.turnId) {
      running = undefined
      thinking?.cancel()
    }
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
