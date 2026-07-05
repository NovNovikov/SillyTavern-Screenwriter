# SillyTavern Screenwriter

Hidden planning-layer extension for SillyTavern roleplay. It keeps a per-chat story plan, silently regenerates it after RP milestones or external events, and injects that plan into the prompt without creating visible chat messages.

## What it does

- Adds a `Screenwriter` panel to the Extensions UI.
- Stores a hidden editable plan per chat.
- Counts only assistant messages that contain `Состояние:`.
- Can auto-replan every `N` RP messages.
- Can inject the current plan into the prompt in a hidden block.
- Exposes `window.STScreenwriter` for external scripts like Black Swan / Bird of Happiness.
- Never writes the plan into visible chat history unless you do that manually yourself.

## Installation path

This extension is intended to live as a folder symlinked into:

`SillyTavernData/default-user/extensions/st-screenwriter`

In this setup, the real working folder is:

`L:\AI_pictures_generate\SillyTavern-Screenwriter`

## How to enable

1. Open SillyTavern.
2. Open the Extensions menu.
3. Find `Screenwriter`.
4. Make sure `Enable Screenwriter` is checked.

## Main configuration

- `Auto-generate plans`: enables silent automatic replans.
- `Replan every N RP messages`: only counts assistant replies that contain `Состояние:`.
- `Inject current plan into prompt`: controls hidden prompt injection.
- `Injection position`: supports the current stable SillyTavern prompt slots:
  - `Before main prompt`
  - `After main prompt`
  - `In-chat at depth`
- `In-chat injection depth`: used only for the in-chat injection mode.
- `Include full World Info in plan generation`: when enabled, the extension injects the full currently resolved World Info into the hidden planner prompt.
- `Apply regex to planner raw block`: applies SillyTavern regex processing to recent chat and status-block message text before sending that material to the planner.
- `Automatic recent chat count`: when enabled, the extension calculates how much recent chat fits into the remaining token budget after subtracting the planner prompt and World Info.
- `Connection profile for generation`: optionally switches to a selected Connection Manager profile only for the duration of hidden plan generation, then restores the previous profile.
- `Recent chat messages to include`: how many recent non-system chat messages are copied into the planner prompt.
- `Max generation length`: passed to SillyTavern's quiet generation helper.

## Manual plan editing

1. Open `Current Hidden Plan`.
2. Edit the plan in the textarea.
3. Click `Save Plan`.

If auto-generation is disabled, the extension still keeps and injects your manual plan.

## External event integration

The minimum supported API is:

```js
window.STScreenwriter.requestReplan({
  type: "black_swan",
  note: "Внезапное плохое событие: ...",
  source: "Black Swan script"
});
```

Positive event example:

```js
window.STScreenwriter.requestReplan({
  type: "bird_of_happiness",
  note: "Внезапное хорошее событие: ...",
  source: "Bird of Happiness script"
});
```

Available methods:

```js
window.STScreenwriter.requestReplan({ type, note, source });
window.STScreenwriter.setEvent({ type, note, source });
window.STScreenwriter.getPlan();
window.STScreenwriter.setPlan(text);
window.STScreenwriter.clearPlan();
window.STScreenwriter.generateNow();
```

## Known limitations

- This MVP uses the current active SillyTavern connection/preset for quiet generation.
- Dedicated preset/profile switching is not implemented yet because the stable API for that is not guaranteed across builds.
- Full World Info is appended to the planner prompt only when the related setting is enabled and a readable WI snapshot can be resolved.
- Prompt injection positions are limited to the stable slots exposed by the current SillyTavern frontend API.

## Privacy warning

The plan is hidden from normal chat flow and does not become a visible message automatically, but it is still visible to the local user inside the extension UI.
