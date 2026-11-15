# dsh-lightrag-judge

A separate, optional [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) desktop plugin that lives in this repository but has nothing to do with the Discord plugin. It runs the RAGAS judge prompts of the COMP 4330 LightRAG project (`judge_setup.py`, transport `desktop`) inside the DSH desktop app, so every judgement can be watched live.

- The project posts each judge prompt to `http://127.0.0.1:18791/judge`. The plugin creates a fresh DSH session for it with the tool-less `lightrag-judge` agent preset, files it under the DSH workspace of the folder the caller names (the LightRAG repository), titles it (e.g. `naive q030 faithfulness`), and returns DeepSeek's reply when the turn ends. The session streams in the sidebar while it runs, thinking included.
- One session per prompt, so no judgement sees another one's conversation. Answers come from the DeepSeek account signed in to DSH.
- Tools are hidden and blocked in judge sessions, and DSH's runtime-context message is suppressed, so the judge sees only its persona and the prompt.
- Without this plugin the project falls back to headless DSH runs, which the app does not list; nothing in the project requires it.

## Install

```
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<path to this repo>/lightrag-judge"
```

Then restart DeepSeek Harness. Check it with `GET http://127.0.0.1:18791/status`, which reports the loaded `version`.

## Turning it on and off

The plugin has its own page in DSH under **Plugins**, titled **LightRAG Judge** (name, description and icon come from `locale/` and `icon.svg`, like the Discord plugin). The switch at the top right of that page turns the whole plugin on or off, and the switches under **Components** control its two parts: the `lightrag-judge` agent preset and the bridge itself. While the plugin is off its local API does not answer, and the LightRAG project's `judge_setup.py` quietly falls back to headless DSH, so switching it off never breaks scoring. Turning it back on restarts the API on port 18791 without restarting DeepSeek Harness.

## API (127.0.0.1 only, JSON, no browser origins)

| Route | Body | Result |
|---|---|---|
| `GET /status` | | `{ ok, plugin, version, agentPreset, provider, running }` |
| `POST /judge` | `{ cwd, prompt, model, title?, reasoningEffort? }` | `{ text, sessionId }` once the turn ends; 502 with DSH's error `code` if the turn fails, 504 on timeout |
| `POST /attach` | `{ sessionId, cwd }` | files an existing session under the workspace of `cwd` |

## Notes

- Save these files as UTF-8 **without a BOM**. A BOM in `package.json` makes DSH skip the whole bundle at boot with no visible error.
- DSH only lists a session under a workspace once it is attached to that workspace (what the app's own "New Session" button does); a session that only carries the folder as its `cwd` shows as Ungrouped. The plugin attaches every judge session, and `/attach` can file an older one.
- Plain JavaScript, so unlike the Discord plugin there is no build step.
