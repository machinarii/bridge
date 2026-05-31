# PRD — Bridge: An AI-First, Accessibility-First Desktop Environment

> **Status:** Draft v0.4
> **Author:** Jin
> **Last updated:** 2026-05-22
> **Working codename:** Bridge (placeholder — rename freely)

---

## 0. How to read this document

This PRD describes a desktop environment that replaces the traditional application-and-pointer paradigm with an **AI-orchestrated, multi-modal interface** whose two primary input methods are **voice** and an **Xbox Adaptive Joystick**, with keyboard and mouse retained only for edge cases.

Several decisions below were made on the author's behalf because the open questions weren't resolved before drafting. Each such decision is flagged with **[ASSUMPTION]** and a one-line rationale. Treat every `[ASSUMPTION]` as an open decision you can override; the surrounding spec is written so that flipping one is a localized change, not a rewrite.

---

## 1. Vision & framing

### 1.1 What this is

Bridge is a Linux desktop environment built on the **Sway** Wayland compositor that reimagines the OS interface around **expressed intent** rather than **direct manipulation of applications**. The user states what they want (by voice) or navigates a structured, game-controller-style option surface (by joystick); an **orchestration layer** interprets that intent, drives existing Linux applications running in the background, and composes on-screen surfaces to present options, state, and results.

### 1.2 Why it matters — the two theses

1. **AI-first thesis.** The unit of interaction shifts from *application* to *intent*. Conventional apps don't disappear — they are demoted to background capabilities the orchestrator perceives and drives, surfacing to the user only when and how the task requires.
2. **Accessibility-first thesis.** **[ASSUMPTION]** This is framed primarily as an **assistive technology** project. The Xbox Adaptive Joystick is part of Microsoft's accessibility ecosystem, so the design optimizes for **reliability, predictability, low motor/cognitive load, and graceful degradation** over visual flash. *If the joystick is purely an ergonomic/aesthetic choice rather than an accessibility requirement, this framing should be revisited — it changes priority ordering throughout.*

The two theses reinforce each other: an intent-driven OS dramatically lowers the interaction burden, which is exactly what an accessibility-first design needs.

### 1.3 Non-goals (v1)

- Not a from-scratch compositor. Bridge **uses** Sway; it does not (yet) replace it. A custom compositor is explicitly deferred (see §11).
- Not a general-purpose "AI assistant app" bolted onto a normal desktop. The orchestrator must *drive* apps, not merely chat beside them.
- Not a mobile or web product. Target is a single Linux PC. *(A macOS full-screen-wrapper alternative is documented in Appendix A; an Android interface-layer future direction in Appendix B.)*
- Not a multi-user / enterprise product in v1.

---

## 2. Target user & primary scenarios

### 2.1 Primary user **[ASSUMPTION]**

A user for whom traditional keyboard-and-mouse interaction is difficult or impossible, who can operate an Xbox Adaptive Joystick and/or speak commands, and who wants to accomplish everyday computing tasks (browse, communicate, consume media, manage files) with minimal motor effort.

### 2.2 Representative scenarios

1. **Voice-driven task:** "Open my email and read the latest from Sarah." → orchestrator focuses/launches the mail client, extracts the message, reads it via TTS, and offers joystick-selectable follow-up options (Reply / Archive / Next).
2. **Joystick navigation:** With no voice, the user navigates a radial/list option surface using the D-pad and selects with face buttons — every actionable choice on screen is mapped to a controller input.
3. **Mixed:** Voice to express the goal, joystick to disambiguate among the options the orchestrator surfaces.
4. **Edge case / fallback:** A task the orchestrator can't handle is handed off to a focused, full-screened traditional app the user drives with keyboard/mouse.

---

## 3. Interaction model

### 3.1 Modalities & precedence

| Modality | Role | Primary use |
|---|---|---|
| Voice | Primary | Expressing intent, dictation, commands |
| Xbox Adaptive Joystick | Primary | Navigating + selecting surfaced options, simple menu/navigation |
| Keyboard / Mouse | Edge-case fallback | Tasks the orchestrator can't yet mediate; precise text entry; recovery |

### 3.2 Voice trigger model — wake word + PTT fallback *(confirmed)*

- **Wake word (primary):** Hands-free, always-listening activation. Default trigger.
- **Push-to-talk (fallback):** A dedicated joystick button / external accessibility switch starts/stops listening for situations where the wake word mis-fires or fails to fire.
- *Design caveat:* Wake-word reliability varies with individual speech patterns, ambient noise, and (for the accessibility user base) atypical speech. The PTT fallback must therefore be **bulletproof and always available**, never buried — it is the safety net when the primary path fails. Treat wake-word false-negatives and false-positives as a tracked quality metric.

### 3.3 Joystick interaction model — "game controller UX"

The on-screen surface mirrors console-game interaction:

- **Every actionable option renders with the controller input that triggers it** (e.g., an "A" glyph next to "Confirm", "B" next to "Back").
- **D-pad** drives simple, discrete menu/list navigation (up/down/left/right between options).
- **Face buttons** map to the most common verbs (confirm, back, context-menu, alternative action).
- **Analog stick** **[ASSUMPTION]** reserved for continuous control where needed (cursor-emulation fallback, scrolling, zoom on a canvas surface) — but discrete navigation should never *require* analog precision.
- **Consistency rule:** the same button means the same verb across surfaces (A = confirm everywhere). Spatial/positional memory is a hard requirement (see §6.3).

### 3.4 Output modalities

- **Visual:** the surfaced option/state UI (see §6).
- **Audio:** TTS for reading content and confirming actions; earcons for state changes. **[ASSUMPTION]** Audio feedback is first-class, not optional, given the accessibility framing.

---

## 4. System architecture

### 4.1 Layer stack (top to bottom)

```
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATION LAYER (the novel part)                     │
│  - Intent interpreter (offline LLM)                       │
│  - Surface lifecycle manager                              │
│  - Action planner + propose/confirm gate                  │
│  - Modality fusion (voice + joystick)                     │
└───────────────┬───────────────────────┬───────────────────┘
                │                       │
        ┌───────▼────────┐      ┌───────▼─────────┐
        │  PERCEPTION     │      │  ACTION PLANE    │
        │  - STT (voice)  │      │  - i3 IPC (Sway) │
        │  - AT-SPI read  │      │  - AT-SPI act    │
        │  - vision (fb)  │      │  - synthetic in. │
        └───────┬─────────┘      └───────┬──────────┘
                │                        │
┌───────────────▼────────────────────────▼──────────────────┐
│  SWAY (Wayland compositor) — hosts + renders surfaces      │
└───────────────┬────────────────────────────────────────────┘
                │
┌───────────────▼────────────────────────────────────────────┐
│  BACKGROUND LINUX APPS (browser, mail, media, files, …)    │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Component responsibilities

- **Sway** — renders and hosts all surfaces; routes input; exposes the window tree via **i3 IPC**. Sway is the *substrate*, not the top of the stack.
- **Orchestration layer** — the project's core contribution. Interprets intent, decides which surfaces exist, drives apps, mediates between user and machine. Owns the propose-then-confirm safety gate.
- **Perception** — converts the world into something the orchestrator can reason over: speech → text (STT), app state → structured data (accessibility tree), and a vision fallback for opaque apps.
- **Action plane** — how the orchestrator effects change: window-level via i3 IPC, in-app via the accessibility tree, and synthetic input / vision-driven action as fallback.
- **Background apps** — unmodified existing Linux software, normally invisible, surfaced only as the task requires.

### 4.3 App-driving strategy — tiered by integration depth *(confirmed)*

**Core principle:** Background apps are **never shown to the user directly.** They run hidden; the user only ever sees orchestrator-generated surfaces. The orchestrator perceives each app and re-presents its relevant state and actions through the radical surface layer. Apps are demoted from "things you look at and operate" to "invisible capability backends the orchestrator drives."

Integration uses three tiers, chosen by how much access a given app permits — **prefer the deepest tier available for each app:**

| Tier | Mechanism | Applies to | Strength |
|---|---|---|---|
| **T1 — Instrumented (deepest, preferred)** | Fork open-source OS-level apps and **add an interface that exposes their internal functions** to the orchestrator (IPC/API hooks, headless modes, exposing actions/state directly). Drive them via i3 IPC for window-level control + the app's new deep hooks for function-level control. | Open-source core apps you can modify (file manager, mail, media, terminal, browser-engine-based surfaces) | Full, reliable, structured access to app function — the basis of the most polished experiences |
| **T2 — Accessibility (AT-SPI)** | Read and act on UI via the Linux accessibility tree without modifying the app. | Closed-source apps that expose accessibility info | Good structured access where source isn't available |
| **T3 — Vision / CV (fallback)** | Screenshot capture + computer-vision analysis + synthetic input. Analyze the screen, locate elements, act. | Opaque apps exposing neither source nor accessibility | Last resort; fragile, slower, app-specific |

**Build implication:** T1 makes Bridge partly an *app-instrumentation project* — you select a small set of open-source OS-level apps, fork them, and add an "orchestrator interface." This is novel work and a genuine moat: deep, reliable control that pure-IPC or pure-accessibility approaches can't match. Curating that initial app set is a v1 scoping decision (see Open Questions).

> **Risk flag:** T1 forking is real engineering and creates a maintenance burden (tracking upstream). T2 accessibility coverage is uneven. T3 vision is fragile. The perception-and-action capability across all three tiers is the spine of the system and **must be prototyped first** (see §10), starting with one T1 app end to end.

### 4.4 Agent identity & naming *(decided)*

**Every agent has a globally unique name** — no two agents, on the same project or across different projects, ever share a name. The role picker previews each role with the first name from its pool that isn't already taken, so the preview matches what the agent will actually be called.

Two reasons this is a hard rule, not a nicety:

- **Agents are added infinitely.** Because spinning up another agent is a digital act with no headcount cost, a project (or the whole system) can accumulate many agents over time. A name has to disambiguate one agent from every other unambiguously — a role label alone ("Engineer") stops being a unique handle the moment there are two.
- **Each agent accrues its own memory and experience.** An agent is a persistent identity, not a disposable role slot: over its lifetime it builds up its own context, history, and working memory. The unique name is the stable handle the user (and the orchestrator) use to refer to *that specific* identity and its accumulated experience — so the name must belong to exactly one agent, permanently.

Implementation: name pools live per role in `app/server/roles.js`; `createProject`/`addAgent` allocate the next unused name, checking both names already on the project and names in use on every other project, so uniqueness holds system-wide.

---

## 5. AI / model architecture

**Architecture decision: Bridge is fully cloud-based for AI.** STT, intent interpretation, reasoning, and TTS all run as cloud services. The one pragmatic local exception is wake-word detection (see §5.4). This trades local-compute complexity for network dependence — see §5.5 for the consequences, which are significant for an accessibility product.

### 5.1 Hardware envelope & platform decision *(revised — fully cloud)*

**The fully-cloud decision collapses the GPU requirement.** With no local ML, Bridge no longer needs a capable GPU at all — the local machine only runs Sway, the orchestrator client, audio I/O, and joystick input. This materially changes the hardware recommendation:

| Need | Requirement under fully-cloud |
|---|---|
| GPU | **None required.** Integrated graphics drive Sway fine. No NVIDIA card, no CUDA, no VRAM budget. |
| CPU | Modest — runs the compositor, the orchestrator client, and a tiny CPU wake-word model. |
| Network | **Now critical infrastructure** — low-latency, reliable, always-on. The single most important hardware/environment requirement. |
| Machine | Any low-cost mini-PC / SFF PC running Ubuntu. The existing RTX 2060 PC is now over-specced and works fine; no upgrade needed. |

- **Platform note (still applies):** the target is still a **Linux PC**, because Sway / Wayland / i3 IPC / AT-SPI are Linux-only. The Mac contradiction from earlier drafts is now moot for *compute* reasons (no local ML to host) but unchanged for *architecture* reasons (the compositor stack is Linux-only). Bridge runs on cheap Linux hardware; a Mac is neither needed nor suitable as the target device.
- **Savings:** the ~$500 GPU is no longer in the budget; spend it on network reliability instead (see §5.5).

### 5.2 Model strategy — cloud services

| Function | Service type | Notes |
|---|---|---|
| **STT** | Cloud streaming speech-to-text | Streamed for low perceived latency; partial transcripts as the user speaks |
| **Intent interpretation** | Cloud LLM | Maps utterances to the action vocabulary |
| **Reasoning** | Cloud LLM (can be a larger/more capable model than any local card could host) | The upside of cloud — far more capability than 16 GB ever allowed |
| **TTS** | Cloud text-to-speech | High-quality voices; streamed back for fast first-audio |
| **Wake word** | **Local, on-device (exception)** | See §5.4 — must not be cloud |

- **The cloud upside, stated plainly:** access to far more capable models than local hardware could run, zero local-model maintenance, simpler deployment, and a cheap target machine.
- **Latency strategy (now a network problem, not a compute problem):** stream everything (STT in, TTS out), show immediate local UI acknowledgment of input *before* the cloud responds (a listening indicator, a "thinking" ambient state), and keep the most trivial navigation (D-pad movement between already-rendered options) **fully local** so basic joystick navigation never waits on the network. The interaction-loop "never blocks" rule survives only if local UI feedback is decoupled from cloud round-trips.

### 5.3 (Reserved)

*VRAM budgeting no longer applies under fully-cloud. Section retained as a placeholder so numbering is stable across drafts.*

### 5.4 Speech components — cloud, with a thin local wake word

- **STT:** a **cloud streaming STT API** (e.g., a hosted Whisper endpoint, Deepgram, Google/Azure speech, or equivalent — vendor TBD). Stream audio for low latency; consume partial results. *Note: VoiceInk and the local `faster-whisper`/`whisper.cpp` options from earlier drafts are now out of scope — they were local engines; the fully-cloud design replaces them with a hosted API.*
- **TTS:** a **cloud TTS API** with a low-latency streaming voice. (Piper, the earlier local recommendation, is dropped for the same reason — though it remains a viable *offline-fallback* TTS if §5.5's resilience option is pursued.)
- **Wake word — the mandatory local exception:** **openWakeWord** or **Porcupine**, running **on-device on CPU.** Continuously streaming live microphone audio to the cloud purely to detect a wake word is a privacy and bandwidth non-starter, so a tiny local model listens locally and only *gates* the start of cloud audio streaming once the wake word fires. This is the one piece of AI that must stay local even in a fully-cloud design. PTT (the fallback trigger) is local by nature — it's a button.

### 5.5 Consequences of fully-cloud *(must read — accessibility-critical)*

The fully-cloud decision has two consequences that bear directly on the accessibility-first thesis and must be designed around, not assumed away:

1. **Network = availability of the entire OS.** With cloud AI as the primary interface, **no network means the user cannot operate their computer.** For a general user this is an inconvenience; for an accessibility user who depends on Bridge as their primary input path, it is a critical lockout. Mitigations to decide on (Open Questions §12): a guaranteed-reliable connection (wired + cellular failover), and/or a **minimal local offline-survival mode** — a tiny on-device model that still provides core navigation and a few critical actions (and local TTS via Piper) when the network is down, so the user is never fully locked out. *Recommended: ship at least a degraded offline-survival mode, even if the primary experience is cloud.*
2. **Latency is now bounded by the network, not the GPU.** Every spoken interaction carries a round-trip. This is manageable with streaming + immediate local acknowledgment (§5.2), but it makes connection quality a first-class product requirement and a tracked metric.

Privacy also shifts: voice and screen context now leave the device. Cloud-use is no longer "occasional escalation" but the default, so the transparency requirements in §8 apply continuously, and vendor data-handling terms become a real selection criterion.

### 5.6 Model & service selection *(decided)*

The four candidates are different categories: **OpenRouter** is an aggregator (one API, many models, automatic failover), **Claude** and **ChatGPT/OpenAI** are first-party model families, and **Ollama** is a local runtime. The fully-cloud decision (§5) removes Ollama as a primary option — it returns only as a possible engine for the offline-survival mode (§5.5).

**Decision: OpenRouter as the sole AI integration, behind a thin model-abstraction layer, with task-based model routing.**

Rationale:

- **Why an abstraction layer (non-negotiable):** the integration sits behind Bridge's own interface so no model choice is a one-way door. Required for A/B testing during development and for swapping the routed models without a rewrite.
- **Why OpenRouter-only:** an accessibility OS that *depends* on a cloud model must not be hard-wired to one vendor — a single provider's outage, degradation, or price change would otherwise take down the user's entire computer. OpenRouter provides **automatic cross-provider failover** and access to many models through **one API and one integration**, with no first-party SDK dependency. This is the single integration Bridge maintains.
- **Task-based routing (within OpenRouter):** Bridge routes different jobs to different models *through* OpenRouter — see the configurable per-task model map below. This is essentially free to do and saves real money on the most-called paths; it does not reintroduce a vendor dependency because everything still flows through the one OpenRouter integration.
- The specific models chosen for each task are a routing-config decision, not an architectural one, and can change anytime (see note below).

**Configurable per-task model map.** Rather than two hard-coded tiers, Bridge maintains an editable mapping of *task type → model*, so each job runs on the most appropriate model for cost/latency/quality. Illustrative (models are config, not commitments):

| Task type | Model class | Optimize for |
|---|---|---|
| Wake-confirmation / trivial intent | Smallest/fastest | Latency, cost (highest frequency) |
| Intent → design-system spec (§6.4) | Small/fast | Latency + structured-output reliability (hot path) |
| Web reinterpretation (§13.5) | Mid, strong at extraction/summarization | Comprehension quality + cost (frequent) |
| Heavy reasoning / multi-step tasks | Largest/strongest | Quality (occasional; async, never blocks) |
| Dictation cleanup / drafting | Mid | Writing quality |

- The map is **user/operator-editable config** (e.g., swap the reinterpretation model, force everything to one model for cost, or upgrade the reasoning model) without code changes — the abstraction layer + OpenRouter make this a settings change.

> **Note:** model names, IDs, and prices change frequently. Verify the specific model identifiers and current rates at integration time rather than hard-coding today's choices — the abstraction layer + OpenRouter routing exist precisely so this is a config change, not a code change.

---

## 6. Surfaces (the UI model)

### 6.1 The surface primitive

The traditional "window" is replaced by the **surface**, of which there are four kinds:

| Surface kind | What it is | Example |
|---|---|---|
| **Backend (hidden)** | A background app the orchestrator drives but the **user never sees directly** | The browser engine, mail client, file manager — running, instrumented, invisible |
| **Generated** | Ephemeral UI the orchestrator composes for a task — the **primary thing the user sees** | A joystick-navigable list of "options for this email", a re-rendered reading view of a web page |
| **Conversational** | The voice/language interface state | Listening indicator, live transcript, spoken-response state |
| **Ambient** | Persistent, glanceable system/agent state | "Bridge is fetching your messages…" |

**Note on the "50/50" evolution:** Hiding all backend apps shifts the experience from "half traditional windows, half radical" to **predominantly radical** — the user almost always interacts with generated/conversational/ambient surfaces, while the "traditional" half is demoted to invisible backends the orchestrator perceives and operates. This is a *more* coherent and more radical position than side-by-side windows: traditional apps become capability, not interface. The rare exception is the edge-case fallback (§3.1), where a hosted app may be surfaced full-screen for direct keyboard/mouse operation when the orchestrator can't yet mediate a task.

### 6.2 Generated surface rendering

- **[ASSUMPTION]** Generated surfaces are built as a **programmable shell** layered over Sway rather than as separate native apps — candidates: **AGS/Astal** or **eww** (CSS-styled, scriptable widget systems designed exactly for custom bars/panels/overlays on wlroots compositors).
- Every generated surface must render its **controller-input affordances** (button glyphs) as a first-class element.

### 6.3 Consistency requirements (critical for accessibility + learnability)

- **Stable spatial anchors:** options appear in predictable positions; the same verb lives in the same place/button across surfaces.
- **Predictable input mapping:** A=confirm, B=back, etc., never reassigned contextually without explicit indication.
- **No purely-generative chaos:** even dynamically composed surfaces follow a fixed visual grammar so the user builds spatial/motor memory. *This is the subtlest design problem and a primary success/failure axis.*

### 6.4 Generative UI via a constrained design system *(Linux version — key feature)*

**Problem this solves:** If the orchestrator generates UI by emitting raw markup/styles from scratch on every interaction, three things go wrong at once — (1) token cost and latency balloon (the cloud model writes verbose layout/style code each time), (2) output is visually inconsistent run-to-run, which directly violates §6.3's spatial-memory requirement and is *especially* harmful for the accessibility user base, and (3) generation is error-prone (malformed UI, broken controller affordances). All three are mitigated by the same move.

**The feature: the model assembles, it does not author.** Generated surfaces are composed from a **predetermined UI kit / design system** — a fixed library of vetted, pre-styled components and layout templates. The orchestrator's job shrinks from "write the interface" to "**select components and fill slots**," emitting a tiny structured description rather than full markup.

**Mechanics:**

- **Component library:** a fixed set of accessibility-first, controller-aware primitives — e.g. `OptionList`, `RadialMenu`, `ConfirmPrompt`, `ReadingView`, `ProgressAmbient`, `Toast`. Each is pre-built with correct spatial anchoring, controller-glyph affordances (§3.3), focus/scan behavior, and styling baked in. The model never restyles them.
- **Layout templates:** a fixed set of slotted arrangements (e.g. "header + scrollable option list + persistent action bar") the model picks from, rather than positioning elements freely.
- **The model emits a compact spec, not UI code.** Instead of generating HTML/CSS, the orchestrator returns a small structured object — conceptually:
  ```json
  {
    "template": "list_with_actions",
    "title": "Messages from Sarah",
    "items": [{"id": "m1", "label": "Re: Friday", "glyph": "A"}, ...],
    "actions": [{"verb": "reply", "glyph": "X"}, {"verb": "archive", "glyph": "B"}]
  }
  ```
  A **deterministic local renderer** (part of the programmable shell, §6.2) turns that spec into the actual styled surface. The visual language lives in the renderer, not in the model output.

**Why this is the right design (benefits compound):**

1. **Token/latency reduction (the requested goal):** the model emits a handful of tokens describing *what*, not hundreds describing *how it looks*. Lower cost per interaction (important under the fully-cloud model, §5, where every interaction is a billed round-trip) and faster first-paint.
2. **Guaranteed consistency:** because styling/anchoring are fixed in the renderer, identical intents produce identical-looking surfaces every time — satisfying §6.3 spatial-memory needs by construction, not by hoping the model stays consistent.
3. **Reliability & safety:** the model can only choose from valid components and slots, so it cannot emit malformed UI, omit a controller affordance, or break the scan/focus order. The component contract enforces accessibility.
4. **Smaller/cheaper model headroom:** "pick a template + fill slots" is a far easier task than "author a UI," so a cheaper, faster cloud model (or, in offline-survival mode §5.5, a tiny local model) can drive the UI competently.
5. **Single source of design truth:** restyling the whole OS = updating the design system once; every generated surface inherits it. No regeneration, no drift.

**Design-system requirements:**

- Every component is **controller-navigable and screen-reader-describable** by construction (accessibility is in the kit, not bolted on per-surface).
- The kit defines a **fixed visual grammar** (spacing, color, typography, glyph placement) that the model cannot override.
- The component contract is **versioned**; the orchestrator targets a known component vocabulary, so model prompts can enumerate the available components cheaply.
- **Escape hatch:** for the rare surface the kit can't express, allow a constrained custom-layout component — but treat heavy reliance on it as a signal to add a new first-class component to the kit instead.

**Implementation note:** this pairs naturally with the §6.2 programmable shell (AGS/Astal or eww). The shell hosts the component library and the deterministic renderer; the cloud orchestrator only ever sends specs. This also cleanly separates *what the AI decides* (intent → spec) from *how it looks* (renderer → pixels), which is good architecture independent of the token savings.

### 6.5 The tile/widget catalog & composition model ("lego")

The §6.4 design system is realized as a **small vocabulary of tiles that snap into a fixed baseplate** — like lego. The model picks which tiles fill which slots; it never authors layout. A small set (~14 pieces) plus one baseplate covers essentially every everyday task, so new tasks are *new arrangements of known pieces*, not new UI.

**The pieces (tile vocabulary).** Three families:

- **Content pieces** (show information): `List` (pickable items — emails, results, songs, options), `Reader` (long-form text + TTS), `Detail` (one item in full), `Map` (location & routes), `Media` (now-playing / video — the only "render the real thing" piece), `Summary` (AI-condensed digest).
- **Input pieces** (take action): `Compose` (dictation/text capture), `Picker` (date/time/choose-from-set), `Confirm` (approve/cancel a consequential action), `Form` (fill labeled slots — rare; mostly from reinterpreted web forms, §13.5).
- **Frame pieces** (always present, structural): `ActionBar` (verbs available now, each with its controller glyph — pinned bottom), `ContextStrip` (where am I / current intent — pinned top), `ListeningIndicator` (voice state), `Ambient` (background agent status / now-playing mini).

**The baseplate (fixed slots).** The frame never changes — this is what builds spatial memory (§6.3): `ContextStrip` pinned top, a large **primary slot** + optional **secondary slot** in the center, `ActionBar` pinned bottom, `ListeningIndicator`/`Ambient` persistent in fixed corners. Pieces vary; the baseplate doesn't.

**Everyday use cases as compositions:**

| Task | Primary slot | Secondary slot | ActionBar verbs |
|---|---|---|---|
| Write an email | `Compose` | `Reader` (original, if reply) | Send · Discard · Add recipient |
| Reply to a message | `Reader` (thread) | `Compose` + `List` (suggested replies) | Send · Dismiss |
| Schedule a meeting | `Picker` (time) | `List` (attendees) → `Confirm` | Confirm · Change time |
| Plan a trip | `Map` | `List` (flights/hotels) → `Detail` | Pick dates · Compare · Book |
| Write a PRD/document | `Compose` (large) | `Summary` (live outline) | Save · Export · Read back |
| Morning briefing | `Summary` (mail+messages) | `List` (calendar) + weather | Open · Next |
| Listen to music | `List` (browse) | `Media` (now playing → `Ambient`) | Play · Skip |
| Get directions | `Map` | `List` (routes) → `Detail` | Go · Alternatives |
| Read the news | `List` (headlines) → `Reader` | `Summary` | Read aloud · Next · Save |
| Order food / shop | `List` (items) → `Detail` | `Summary` (cart) | Add · Checkout |

The recurring shapes: **`List` → `Detail` → `Confirm`** is the spine of most tasks (browse → inspect → commit); **`Compose` + `ActionBar`** is the spine of most creation.

**Composition rules:**

1. **Pieces are self-contained.** Each tile carries its own controller navigation (a `List` knows how to be D-pad-scrolled and A-selected anywhere it's placed) — like a lego brick with its own studs. Pieces compose without special-casing.
2. **Fixed verb → glyph → position mapping.** `A` = confirm everywhere, `B` = back everywhere, the `ActionBar` is always bottom. Never reassigned without explicit indication (§6.3).
3. **A task is a *sequence* of compositions, not one screen.** "Plan a trip" = `List` → `Detail` → `Picker` → `List` → `Confirm` → `Summary`. The screen *evolves* through the same baseplate rather than being *replaced*, so the user is never disoriented mid-task.
4. **Size-class layout contract (borrowed from Apple's iPad model).** A slot advertises a coarse **size class** (regular vs. compact width/height); the tile adapts to the class, not to exact pixels — a `List` renders full in the primary slot, compact in the secondary slot. This is cleaner than per-pixel layout and is the same adaptivity contract Apple's HIG uses for iPad multitasking slots. Corollary (also from Apple's guidance): never assume a fixed surface size, preserve state across resize, animate rather than reload — essential for surfaces that appear/resize dynamically.

**Payoff:** ~14 pieces + 1 baseplate cover essentially every everyday task. This is what makes generative UI (§6.4) shippable rather than chaotic — bounded, learnable, consistent, and token-cheap.

---

## 7. Functional requirements (v1)

### 7.1 Must-have (P0)

1. Voice capture (wake-word-gated, local; PTT fallback) → **cloud streaming STT** → intent interpretation.
2. **Cloud LLM intent interpreter** that maps utterances to a defined action vocabulary.
3. i3 IPC integration: query window tree, issue commands, subscribe to events.
4. App-driving across the three tiers (T1 instrumented / T2 AT-SPI / T3 vision) for a defined set of "supported" apps.
5. Joystick input pipeline: Xbox Adaptive Joystick → discrete navigation + selection of on-screen options (local; does not require network for already-rendered surfaces).
6. Generated option surfaces with controller-glyph affordances, **rendered from the constrained design system / UI kit (§6.4) — the orchestrator emits compact component specs, not raw UI markup.**
7. **Cloud TTS** output (streamed) for reading content and confirming actions.
8. **Propose-then-confirm gate** for any consequential action (see §8).
9. Keyboard/mouse fallback path that cleanly hands off to a focused (temporarily surfaced) app.
10. A defined set of end-to-end "supported tasks" that work reliably (quality over breadth).

### 7.2 Should-have (P1)

- **Degraded local offline-survival mode** (recommended; prevents full lockout on network loss).
- Vision/computer-use fallback (T3) for non-accessible apps.
- Analog-stick cursor emulation for the rare task needing it.
- User-configurable button→verb mapping (within consistency constraints).

### 7.3 Could-have (P2 / later)

- Custom Smithay compositor replacing Sway (see §11).
- Multi-step autonomous task execution.
- Personalization/memory of user preferences and routines.
- Additional switch/AAC device inputs beyond the joystick.

---

## 8. Safety, agency & trust

The agency boundary — *when does the OS act vs. ask?* — is the central UX of the system, not a footnote.

- **Propose-then-confirm by default** for any consequential or irreversible action (sending, deleting, purchasing, modifying files). The orchestrator proposes; the user confirms via a single joystick press or voice "yes."
- **Tiered autonomy:** trivial/reversible navigation acts immediately; consequential acts require confirmation; ambiguous intent triggers a clarifying option surface rather than a guess.
- **Always-available interrupt/cancel** mapped to a consistent control. The user must be able to stop the system at any time.
- **Transparency:** the ambient surface always shows what Bridge is doing or about to do. No silent action.
- **Cloud-use is continuous (not occasional):** because all primary AI runs in the cloud, voice and screen-context data leave the device by default. The user must understand this; provide a clear, persistent indication that processing is happening remotely, and surface vendor data-handling terms. Privacy is a continuous concern here, not an edge case.

---

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| **Latency** | Interaction-loop response (capture→visible/audible acknowledgment) must feel immediate. Achieved via streaming + immediate *local* UI acknowledgment that is decoupled from cloud round-trips. Cloud reasoning is async and must never block local navigation. *A dead-feeling interface fails the paradigm regardless of capability.* |
| **Reliability** | Core supported tasks must work consistently; predictability outranks feature breadth. |
| **Network** | **Cloud AI makes the network critical infrastructure.** Requires low-latency, reliable, always-on connectivity. Connection quality is a tracked product metric. |
| **Offline survivability** | Because the primary AI path is cloud, a **degraded local offline-survival mode is recommended** so a network outage never fully locks the user out of their own computer (accessibility-critical). At minimum: local wake word/PTT, basic local navigation of already-rendered surfaces, and a small set of critical local actions + local TTS. |
| **Accessibility** | Inputs usable with minimal/limited motor control; no task requires analog precision; audio + visual feedback for all state. |
| **Recoverability** | Always a path back / cancel; fallback to keyboard/mouse never fully blocked. |
| **Privacy** | Under fully-cloud, voice + screen context leave the device by default (§8). Requirement: continuous, clear indication of remote processing; vendor data-handling terms are a selection criterion; offline-survival mode (if shipped) keeps its limited processing local. |

---

## 10. Build sequence (recommended)

Build the **orchestration + action layer against stock Sway first** — do not start with novel UI or a custom compositor.

1. **Spike the riskiest thing first:** prove the orchestrator can reliably *perceive and drive* a hidden app end to end — start with **one T1 instrumented open-source app** (fork it, add the orchestrator interface, drive it via i3 IPC + the new hooks). If this doesn't work, the AI-first premise is decorative. *Validate before building anything else.*
2. Stand up the **cloud** STT → intent → action loop for a tiny fixed command vocabulary.
3. Add the joystick input pipeline and a single generated option surface with controller glyphs.
4. Add TTS output and the propose-then-confirm gate.
5. Expand the supported-task set; add wake word, cloud escalation, vision fallback as P1.
6. Only after the orchestrator's needs are well understood, evaluate a custom compositor (§11).

---

## 11. Deferred: custom compositor

A from-scratch compositor (e.g., **Smithay**, Rust) is the eventual route to surface kinds and input models that Sway's window-tree vocabulary can't express. **Deferred deliberately:** prototyping on Sway first means the orchestrator's real requirements design the compositor, rather than inventing the hard part blind. The gaps hit while prototyping against i3 IPC become the spec for the custom compositor's interface.

---

## 12. Open questions (please resolve)

**Resolved in v0.4:** voice trigger (wake-word primary + PTT fallback), app-driving (tiered T1/T2/T3, apps hidden), **AI architecture (fully cloud-based; GPU requirement removed; thin local wake word retained)**, **model/service (OpenRouter-only behind an abstraction layer, with a configurable per-task model map — §5.6)**, **OS feature set & bundle (§13)**, **messaging = Signal, documents = dictation-first, v1 must-haves = browser + email + Signal**, **browser mode selection rule (API/clean-DOM → reinterpret; interactive/media → render; per-task within a site — §13.5)**, **recommended headless backend tooling per feature (§13.7)**, **tile/widget catalog + composition model (§6.5)**, **platform alternatives documented (macOS wrapper — Appendix A; Android future direction — Appendix B)**.

**Still open:**

1. **Accessibility framing:** Is this primarily an assistive-technology product (current assumption) or is the joystick an ergonomic/aesthetic choice? *(Drives all priority ordering.)*
2. **Offline-survival mode:** Ship a degraded local fallback for network outages (recommended, given accessibility lockout risk), or accept pure cloud dependence? If yes, what minimal capability set must survive offline?
3. **Cloud vendor selection:** Which providers for STT, LLM, and TTS? Selection criteria now include latency, streaming support, and data-handling/privacy terms (since voice + screen context leave the device continuously).
4. **Network resilience:** What connectivity guarantee is acceptable — wired only, or wired + cellular/secondary failover? This is now critical infrastructure.
5. **T1 app set:** Which specific open-source OS-level apps will you fork and instrument first? (Candidates: file manager, mail client, media player, terminal, browser-engine surface.) Bounds the hardest/most novel work — pick a *small* starting set.
6. **Supported-task scope for v1:** Which concrete end-to-end tasks must work reliably? (Email? Browsing? Media? Files? Messaging?) Needed to bound v1.
7. **Joystick specifics:** Single Xbox Adaptive Joystick, or paired with the Xbox Adaptive Controller / external switches? Affects input vocabulary and PTT-button assignment.
8. **Target machine:** Any low-cost Linux mini-PC now suffices (no GPU needed). Confirm whether to prototype on the existing 2060 PC (fine) and what production hardware to standardize on.
9. **AI-native features (§13.6):** should v1 include capabilities a traditional OS lacks — "summarize this page," "draft a reply," cross-app intent, video calling, notes/journal? This is where the AI-first thesis pays off most; the Ubuntu-bundle framing doesn't capture it.
10. **Browser presentation registry (§13.5):** selection *rule* is decided (API → structured reinterpret; clean DOM → DOM reinterpret; interactive/media → render; switchable per-task within a site). Open: initial curated registry contents and the unknown-site "cleanly scrapable" heuristic threshold.
11. **Codename:** keep "Bridge" or rename.

---

## 13. OS feature set & application bundle

Defines which "default OS apps" (the bundle Ubuntu and similar ship) Bridge provides, and — critically — **how each is realized**, since in an AI-first OS most traditional apps are demoted to invisible capabilities or absorbed into surfaces rather than shipped as apps. Each entry maps to a §4.3 build tier and a v1/later priority.

### 13.1 Guiding principles (derived from design decisions)

- **Most content is web-delivered → the browser absorbs it.** Video, photos, articles, and general content are delivered through the browser surface rather than as separate apps. This is a major scope reduction and concentrates risk on one keystone capability.
- **Things the AI can answer or compute are not apps.** Calculator, unit conversion, definitions, quick facts, etc. collapse into the conversational/prompt surface — there is no calculator *app*.
- **Files are demoted, not removed.** No user-facing file manager; file operations (find, open, attach, save) become an invisible orchestrator capability. The user asks for *things*, not for files in folders.
- **Stateful/ambient functions earn a dedicated surface.** Persistent things (music playback) get a glanceable widget-style ambient surface; one-shot content does not.

### 13.2 Feature catalog

| Feature | How it's realized in Bridge | Tier | Priority |
|---|---|---|---|
| **Web browsing** | **Keystone.** A stripped-down, chromeless Chromium/CEF build acting as a *rendering surface only* — no tabs, toolbar, or omnibox. Orchestrator drives it via the **Chrome DevTools Protocol (CDP)** (navigate, read DOM, click, extract). User never touches browser UI; mouse/keyboard edge-case control added later. Supports **two presentation modes — faithful render vs. AI reinterpret (§13.5)**. Also delivers video, photos, and articles. | T1 (deep instrument via CDP) | **v1 — must work flawlessly** |
| **Email** | Capability + generated surfaces (read view, option list, dictated reply). Primary async comms channel. | T1/T2 | **v1 — must work flawlessly** |
| **Messaging / chat** | Capability + generated surfaces. **Signal for v1** (fits existing stack; `signal-cli` gives a clean automation path). | T1/T2 | **v1 — must work flawlessly** |
| **Word processing / documents** | **Dictation-first + light edits:** speak → document, "write me a letter that…" → output, light edits only. Full formatting/editing via voice+joystick deferred. | Capability + surfaces | v1 fast-follow |
| **Music / audio** | **Deliberate exception** — stateful & ambient, so a dedicated widget-style **ambient surface** (§6) driven by the **Spotify API**, not a browser page. | Dedicated surface + API | Later |
| **Video / photos / articles** | **No separate apps** — delivered through the browser surface. | (via browser) | (with browser) |
| **Reading (PDF/ebooks)** | Browser surface + reading-view component; pairs with TTS. | (via browser) | Later |
| **System settings** (wifi, volume, display, brightness) | Mostly **D-Bus** calls, not app-driving — relatively easy, high-value. Exposed as generated control surfaces. | System integration | v1 |
| **Calendar / reminders** | Capability + generated surfaces. | T2 / service API | v1 fast-follow |
| **File management** | **Demoted to invisible orchestrator capability** — no user-facing file manager. | Orchestrator capability | v1 (behind the scenes) |
| **Calculator / quick tools** | **Absorbed into the conversational/prompt surface** — no app. Represents the whole class of "AI just answers it" utilities. | Conversational surface | v1 (free with prompt system) |
| **Software/app store, archive manager, contacts** | Not user-facing apps in v1; contacts become an orchestrator capability backing email/messaging. | Orchestrator capability | Later / as-needed |

### 13.3 What this means for scope

- **The browser is the single highest-risk, highest-leverage build item** — it is both the hardest T1 instrumentation target *and* the delivery mechanism for most "media/content" features. If it works, a large fraction of the feature set comes free; if it's fragile, much breaks together. Prototype it early (it is a natural companion to the §10 first T1 spike).
- The feature set is **leaner than a traditional OS bundle**: collapsing media into the browser, absorbing utilities into the prompt, and demoting files removes roughly half the apps a normal distro ships.
- **Open items folded in here** (now confirmed): messaging network = **Signal**; word-processing depth = **dictation-first + light edits**; **v1 flawless-must-haves = browser surface + email + Signal messaging** (three communication-critical capabilities). Note this makes `signal-cli` integration a v1 launch requirement, not a fast-follow — a deliberate scope increase for an accessibility user whose primary need is staying connected.

### 13.5 Browser presentation modes — render vs. reinterpret *(core AI-first concept)*

The browser surface can present a web page in **two fundamentally different modes.** This distinction is arguably the clearest expression of the AI-first thesis in the whole product.

**Mode A — Render (faithful display).** The chromeless surface displays the *actual* web page as built. Universal (works for anything), pixel-faithful, but it is the *old* paradigm — the user faces a layout designed for mouse-and-pointer, ads, navigation chrome, and clutter, which is exactly what is hard for the target user.

**Mode B — Reinterpret (condensed & tailored).** The orchestrator reads the page via CDP/DOM extraction, a model *understands* the content, and Bridge **regenerates it as a condensed surface built from the §6.4 design-system components** — controller-navigable, TTS-friendly, stripped of ads/nav/clutter, surfacing only what's relevant to the user's actual intent. **The website becomes data; Bridge builds the interface.** Examples:

- A recipe page → ingredients + steps as an `OptionList`/`ReadingView`, no popups or life-story preamble.
- A news article → title + AI summary + read-aloud, no chrome.
- A booking/contact form → a controller-navigable `ConfirmPrompt` with only the needed fields.
- A search-results page → a clean ranked `OptionList` of results.

**Why Mode B is the thesis realized:** the web stops being pages you visually parse and becomes information the OS re-presents in the user's own accessible, consistent visual language. For the target user this is far more valuable than rendering the real, cluttered page — it removes the exact barrier (dense, pointer-oriented, inconsistent layouts) that makes the normal web hard.

**Mode selection is driven by data accessibility + user intent — not guessed per page.** The orchestrator chooses the mode based on *how cleanly the needed data can be obtained for the task at hand*, in this preference order:

| Condition | Mode | Why |
|---|---|---|
| Site exposes a usable **API** (YouTube Data API, Spotify, weather, transit, etc.) | **Reinterpret from structured data** | Best case — clean, reliable, no scraping fragility; the model gets real fields, not parsed HTML. Highest-quality reinterpretation. |
| Site is **cleanly scrapable** (articles, recipes, search results, sane mostly-static DOM) | **Reinterpret from extracted DOM (CDP)** | Good; slightly more fragile than an API. |
| Site is **interactive / media-centric / app-like** (YouTube *playback*, Google Maps, web games, canvas apps, video players) | **Render (faithful)** | Reinterpretation can't capture it, or destroys the point. |

**Mode can switch *within* a single site by task.** A site is not statically "render" or "reinterpret" — the choice is **per-(site capability × user intent)**. Canonical example: **YouTube** → *reinterpret* the search/browse results (it has an API) so the user picks a video from a clean controller-navigable `OptionList`, then *render* for the actual playback. The orchestrator selects the mode for the thing the user is doing *right now*, not for the domain as a whole.

**Per-site capability registry (ship-with-it asset).** This rule implies a maintained mapping of `site → { has_api?, cleanly_scrapable?, render-only regions/tasks }`:

- **Curated entries** for known high-value sites (YouTube, the Spotify integration, common mail/news/recipe sites) encode exactly which tasks reinterpret and which render — hard-won per-site knowledge that accrues over time.
- **Runtime heuristic** for unknown sites: API available? → structured reinterpret. DOM clean enough to extract? → DOM reinterpret. Otherwise → render. 
- The registry is a real product asset and a natural place for community/operator contributions later.

**Safeguards (unchanged, still critical):**

- **The user can always escape to faithful render.** A consistent, always-available control switches to Mode A. *The user must never be trapped in a bad or wrong reinterpretation with no way to reach the actual page.*
- **Reinterpretation is lossy — signal it.** Show a clear indicator when a surface is AI-reinterpreted (not the original), and prefer render automatically for content classes/tasks known to reduce poorly.

**Cost/latency note:** Mode B adds a model call per page (the reinterpretation), so it routes to a mid-tier extraction/summarization model in the §5.6 per-task map. Caching reinterpreted results per URL avoids re-paying for repeat visits.

**Open detail (not blocking):** the *selection rule* is decided (data-accessibility × intent, above). What remains is operational — the initial curated registry contents (which sites/tasks ship pre-mapped) and tuning the unknown-site heuristic's "cleanly scrapable" threshold. *(See §12.)*

---

### 13.6 Open question added

- **AI-native features beyond the traditional bundle:** should v1 include capabilities a normal OS lacks — e.g., "summarize this page," "draft a reply," cross-app intent ("find the email with the address and put it in the form"), video calling (often a priority for accessibility users), or a notes/journal capability? These are where the AI-first thesis pays off most and are not covered by the Ubuntu-bundle framing. *(Needs a decision — see §12.)*

### 13.7 Recommended backend tooling

**Selection principle:** because Bridge renders its own surfaces and the orchestrator drives everything (§4.3, §6), an app's GUI is dead weight. The optimal backend for each feature is a **daemon, CLI, or library** — headless and scriptable — which is also *easier to instrument (T1)* than a GUI app is to drive via accessibility (T2). Most "apps" therefore become backend capabilities, not shipped applications, reinforcing the lean bundle of §13.

| Feature | Recommended backend (headless/scriptable) | Form | Tier | Rationale |
|---|---|---|---|---|
| **Documents / word processing** | **Markdown** (working format) → **Pandoc** (convert to .docx/PDF/HTML/ODT) | CLI / format | Backend capability | Document is plain text the model can read/edit/regenerate; Pandoc handles export. No GUI editor needed. |
| ↳ fidelity-critical .docx | **LibreOffice `--headless`** (UNO API) | Daemon/CLI | Backend (fallback) | Open-source standard for true .docx manipulation without its GUI; heavier, use only when convert-on-export is insufficient. |
| **Email** | **mbsync (isync)** + **msmtp** + **notmuch** (indexed search/tag) | CLI primitives | Backend capability | Most AI-drivable email stack: sync, send, and query as scriptable primitives. Orchestrator composes/queries directly. |
| ↳ app-like alternative | **aerc** (or neomutt) | Terminal app | T2 | Minimal, scriptable, automation-friendly TUI clients if a client model is preferred over raw primitives. |
| **Messaging** | **signal-cli** *(decided)* | CLI/daemon | T1/backend | Headless Signal; the model integration pattern — capability with zero interface baggage. |
| **Calendar** | **khal** + **vdirsyncer** (CalDAV sync) | CLI | Backend capability | Plain-text-ish, scriptable; mirrors the email-primitives approach. |
| **Reminders / todos** | **todo.txt** tooling or **taskwarrior** | CLI / format | Backend capability | Machine-readable, headless task state. |
| **Music** | **Spotify Web API** *(decided)*; **mpd** for local playback | API / daemon | Dedicated surface + API | mpd is a UI-less daemon designed to be driven by clients — exactly Bridge's model — if local music is wanted alongside Spotify. |
| **Reading — render PDF** | **MuPDF / libmupdf** | Library | Backend capability | Minimal, fast, embeddable PDF rendering for a surface. |
| **Reading — extract PDF text** | **poppler-utils (`pdftotext`)** or MuPDF text extraction | CLI/lib | Backend capability | Feeds PDFs into the §13.5 reinterpret pipeline (clean reading surface + TTS). |
| **Articles** | (handled by browser reinterpret mode, §13.5) | — | — | No separate app. |
| **Notes / journal** (if added, §13.6) | **Obsidian + Local REST API plugin** (local CRUD + section-level PATCH; also speaks MCP). Fallback: plain **Markdown files** + the file capability below. | Local REST/MCP / files | Backend capability | Local-first (no new cloud dependency), content *is* Markdown (matches §13.7 doc format), surgical PATCH-by-heading suits dictation edits, native MCP for the orchestrator. Preferred over Notion, whose cloud API + proprietary block model add a network dependency and a translation layer. Plain-Markdown-files path is the zero-dependency fallback if the community plugin lapses. |
| **Files** (no file manager, §13.2) | **ripgrep (`rg`)** + **fd** | CLI | Orchestrator capability | Fast find-by-content/name primitives; the entire "file management" stack, no GUI. |
| **Web browsing** *(keystone)* | **Chromium / CEF**, chromeless, driven via **CDP** *(decided, §13.2/§13.5)* | Embedded engine | T1 | Rendering surface only; orchestrator controls via DevTools Protocol. |

**Notes:**

- The recurring shape across every row — `signal-cli`, `mbsync`/`notmuch`, `khal`/`vdirsyncer`, `mpd`, `pandoc`, `rg`, MuPDF — is *daemon/CLI/library, not GUI app*. This is the intended pattern, not coincidence.
- **Maintenance check:** the long-established tools (Pandoc, mbsync, notmuch, khal, vdirsyncer, mpd, ripgrep, MuPDF, LibreOffice) are safe long-term bets; verify active maintenance for anything newer (e.g., aerc) at integration time.
- **Word-processing flow, concretely:** Bridge's dictation surface → text stored as Markdown → model edits the Markdown on command → **Pandoc** exports to the requested format only when the user asks to save/send. LibreOffice-headless enters only for fidelity-critical .docx round-trips.

---

## Appendix A — Architecture alternative: macOS full-screen wrapper

This appendix records a seriously-considered alternative to the Linux/Sway approach and the reasoning for the chosen direction, so the decision is on the record.

### A.1 The two approaches, fundamentally

| | **Linux / Sway (chosen)** | **macOS full-screen wrapper (alternative)** |
|---|---|---|
| What Bridge *is* | **The desktop itself** — owns the compositor, surface lifecycle, input routing | **An app on someone else's desktop** — macOS remains the real OS; Bridge is a full-screen skin over it |
| Surface/window control | Total — apps can be fully hidden; nothing renders that Bridge didn't route | Shallow — WindowServer is closed; macOS chrome (menu bar, notifications, gestures, system modals) leaks through and reasserts its paradigm |
| Reaches depth-3 ("reimagine the OS")? | **Yes** — the only option that can | **No** — structurally capped at "a very different app on macOS," not a reimagined OS |
| App-driving (the 50/50 spine) | T1 fork-and-instrument (moat) + T2 AT-SPI (patchy) + T3 vision | **T2 is stronger** — mature AXUIElement accessibility API + AppleScript/Apple Events; **but T1 evaporates** (closed/commercial app ecosystem, nothing to fork) |
| Input (joystick + mic) | Raw access (evdev, full HID, USB/BLE) | More constrained (GameController framework, HID restrictions) **but** gains macOS **Switch Control** + best-in-class built-in accessibility (VoiceOver) for free |
| Build effort | Higher — own the whole stack | Lower — stand on macOS; faster to a working prototype |
| Hardware / reach | Niche (Linux PC; cheap under fully-cloud) | Runs on Macs the user may already own; far larger install base for an accessibility tool |
| Lock-down risk | Low — open stack | Higher — TCC privacy gates, accessibility-permission grants, sandboxing, SIP, notarization |

### A.2 How the fully-cloud pivot changed the scoring

The earlier (v0.1–v0.2) decisive technical argument for Linux over Mac was *"CUDA + the compositor must coexist, and a Mac can't host the local ML well."* The v0.3 **fully-cloud** decision **removed that argument entirely** — there is no local inference anymore, so the Mac's ML-tooling weakness is irrelevant and its strengths (already-owned hardware, excellent built-in accessibility) are no longer offset on the compute axis. Net effect: **the fully-cloud pivot made the macOS-wrapper option meaningfully more viable than it previously was.** The choice is now almost purely **paradigm-fidelity vs. pragmatism**, not compute.

### A.3 Trade-off summary

- **macOS wrapper:** faster to build, runs on owned hardware, ships to far more accessibility users, and inherits macOS's mature accessibility + Switch Control. **Ceiling:** cannot reach depth-3; macOS's interface keeps showing through; you'd be *extending Apple's paradigm*, not replacing it. Verdict: *a radically different app, not a reimagined OS.*
- **Linux / Sway:** the only path that delivers the stated depth-3 vision (apps as invisible backends, the entire interface yours). **Cost:** own the whole stack, niche hardware/distribution, patchier T2 app-driving than macOS.

### A.4 Recommended use of the alternative — prototype, then port

The alternative is most valuable **not as the destination but as a de-risking prototype**:

1. **Build the orchestrator + interaction model first as a macOS wrapper** — fast, on hardware already owned, validated against real accessibility users using macOS's mature accessibility stack. Prove the voice + joystick + generated-surface interaction *actually works for the user*.
2. **Then port the validated orchestrator onto Linux/Sway** for the true-OS version. The orchestrator is largely cloud API calls + accessibility-driving logic + the design-system spec emitter (§6.4), much of which is portable. What changes underneath: the compositor and the app-driving tier (macOS AX/AppleScript → Linux i3 IPC + AT-SPI + T1 instrumentation).

This matches the earlier finding that a Mac is fine for *developing the logic* but wrong as the *production target*.

### A.5 The condition that would flip the decision

Make the macOS wrapper the **actual product** (not just a prototype) **if reach and shippability beat paradigm purity** — i.e., if helping the most accessibility users *soon* matters more than reinventing the OS. That is a goals/values call, not a technical one, and should be made explicitly. *(Tied to Open Question §12.1 — the accessibility-framing decision.)*

### A.6 Portability map (what carries over from a Mac prototype)

| Layer | Portable Mac → Linux? | Notes |
|---|---|---|
| Cloud STT / LLM / TTS integration | **Yes** | Vendor APIs are platform-agnostic |
| Intent interpretation + orchestration logic | **Yes** | Core business logic |
| Design-system spec emitter (§6.4) | **Yes** | Model emits specs, not platform UI |
| Generated-surface **renderer** | **Partial** | Re-implemented per platform (native macOS UI vs. AGS/Astal/eww shell), but driven by the same specs |
| App-driving (perceive + act) | **No — rewritten** | macOS AXUIElement/AppleScript → Linux i3 IPC + AT-SPI + T1 forks |
| Input pipeline | **Partial** | GameController framework → evdev/HID; PTT/wake-word logic portable |
| Compositor / surface lifecycle | **No** | macOS WindowServer (borrowed) → Sway (owned) |

---

## Appendix B — Future direction: Android interface layer

Records Android as a *possible future direction*, the strategic reasoning, and why it is a separate implementation rather than a port. Parallel in spirit to Appendix A.

### B.1 The hard constraint

Bridge-as-specified is a **desktop-Linux artifact.** Its foundations — Sway, Wayland, i3 IPC, the chromeless CEF browser via CDP, AT-SPI, and the headless CLI backends (§13.7) — are desktop-Linux-specific and **do not exist on Android.** Android is not "Linux with a different UI"; for application purposes it is a different OS with a sandboxed app model. An Android version is therefore a **substantial rebuild of the perception/action layer**, not a retarget — similar in scope to the macOS-wrapper analysis (Appendix A).

### B.2 What changes on Android

| Bridge layer | Android equivalent | Viability |
|---|---|---|
| App-driving T1 (fork & instrument open-source apps) | **Largely collapses** — mobile app ecosystem is closed/packaged | Lost, as on macOS |
| App-driving T2 (AT-SPI) | **Android Accessibility Service API** (powerful — basis of screen readers/automation) + intents/deep links | Strong, but the primary tier |
| App-driving T3 (CV/screenshot) | MediaProjection + on-device vision | Available; fragile, as on desktop |
| Compositor / surface ownership | **Cannot own** — no replaceable compositor; a launcher/overlay/accessibility-service app at most | Capped |
| Input (joystick, mic) | Android input + Bluetooth/USB HID; mic via standard APIs | Workable, more restricted than evdev |
| Cloud AI, orchestration, design-system spec emitter, tile vocabulary | **Portable** (same as Appendix A.6 core) | Carries over |

### B.3 Strategic view — is the AI-first OS future mobile or desktop?

- **Mobile is where the mass market is** — the phone is the default (often only) computer for most people; it has the always-on sensors an ambient AI wants; and a voice-first, one-surface-at-a-time model fits a phone *more* naturally than a desktop (phones already can't show overlapping windows).
- **Desktop is where it's most *possible* and *powerful*** — complex multi-step work lives there, and **desktop Linux is the last place a builder can own the whole stack.** Mobile OSes are deliberately locked down to prevent exactly what Bridge's "hide and drive apps" paradigm requires.
- **Assessment:** the mass-market mobile AI-first OS will most likely be built by the **platform owners (Apple, Google)**, because on mobile only the platform owner has the necessary access. A third-party Android interface layer fights the platform owner on their turf with its strongest tier (T1) removed and subject to policy — real but capped, like the macOS wrapper. The **independent, depth-3 AI-first OS is buildable on desktop Linux precisely because it is open.**

### B.4 Why desktop remains right for *this* project

Bridge is **accessibility-first** (§1.2), not mass-market. For that mission the calculus favors desktop: openness enables the deep, reliable, fully-controllable assistive environment a disabled user needs, and the hardware (Adaptive Joystick, mounted switches, a dedicated mic) integrates far more easily over USB/Bluetooth on Linux than within Android's restrictions. The user who most needs "the OS adapts completely to me" is exactly the user for whom owning the whole stack matters most. Mobile's reach advantage is less decisive when the goal is *depth of adaptation for a specific user* rather than breadth.

### B.5 Recommended posture

Treat Android like the macOS wrapper: a **documented alternative with a known portable core** (B.2, last row), valuable **for reach if the goal ever shifts from depth to breadth**, but not where the real thing is built. If pursued, the natural form is an **Accessibility-Service-based layer + launcher**, accepting the capped ceiling. *(Conditioning decision tied to §12.1 — depth vs. reach.)*

### B.6 What would change this assessment

Platform trajectories are genuinely uncertain. Re-evaluate if: mobile platform owners meaningfully open up automation/accessibility access to third parties; a **Linux-phone ecosystem** (true Wayland/desktop-Linux stack on a phone) matures enough to run Bridge's actual stack on mobile hardware; or the project's goal shifts from depth-of-adaptation to maximum reach. Worth a periodic check of Android automation capabilities and Linux-phone maturity.

---

*End of PRD v0.3. Every `[ASSUMPTION]` is an open decision; resolving §12 will let this tighten into v1.*
