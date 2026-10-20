# Vision model endpoint: first-time setup

How to get a local vision model answering, so a handwritten remark comes back
as text the first time you try the endpoint path. User-facing entry points:
README → *Vision model endpoint*; *Settings → Reading handwriting (OCR)*.

## What this is

The endpoint path sends only the cropped remark images — the ink you wrote,
nothing else from the note — to a vision model that *you* run. With a local
server (Ollama or LM Studio) the ink never leaves your machine: it is an HTTP
call to a server on your own computer, not a cloud API. You point the plugin at
an OpenAI-compatible endpoint and name the model; the plugin does the rest.

## One-click setup (desktop)

On desktop, *Settings → Reading handwriting (OCR) → Set up local reading for
me* does step 1 and step 3 below for you:

- it looks for Ollama on this computer (`http://localhost:11434`); if it is not
  running, on macOS and Windows it offers *Download and install Ollama*: after
  you confirm (it shows the version and size — about 0.2 GB for macOS' `.dmg`,
  1.6 GB for Windows' `OllamaSetup.exe`), it downloads Ollama's official,
  signed installer from its GitHub release into your system's temp folder
  (`remarkable-ink-ollama`, outside the vault), checks it against the SHA-256
  GitHub publishes, and opens it. You finish the installation in the installer
  (on macOS: drag Ollama to Applications, then open it); the dialogue waits for
  Ollama to start and carries on. On Linux it shows the official command to run
  in a terminal — it asks for your password (sudo) and installs Ollama as a
  system service:

  ```
  curl -fsSL https://ollama.com/install.sh | sh
  ```

  If anything fails, it says why and falls back to the link to
  [ollama.com/download](https://ollama.com/download) — install or start
  Ollama, then press the button again;
- if Ollama is not running but LM Studio's server is (`http://localhost:1234`),
  it offers LM Studio instead, with the vision models already downloaded there
  to pick from — it downloads nothing into LM Studio. With no vision model
  there yet, it says how to get one; if the server requires an API token, it
  says to set *API key* and the endpoint `http://localhost:1234/v1` by hand;
- if the model (*Model*, or `qwen2.5vl:7b` when empty) is missing, it asks
  before downloading it (about 6 GB for the default) and shows the progress.
  Cancel stops the download; Ollama keeps what it already has and resumes from
  there next time;
- it sets *Reading handwriting* to the endpoint, the endpoint to
  `http://localhost:11434/v1` (or `http://localhost:1234/v1` for LM Studio) and
  the model, then runs *Test connection*.

No origin or CORS setting is needed. The manual steps below remain the
fallback, and the way to use another server, a remote machine, LM Studio with
an API token or a hosted API.

## Ollama, step by step

1. **Install Ollama** from [ollama.com](https://ollama.com/download), then pull
   the plugin's default model:

   ```
   ollama pull qwen2.5vl:7b
   ```

2. **No origin setting needed.** The plugin's requests carry no `Origin`
   header, and Ollama 0.1.42 and later accept Obsidian's `app://` origin by
   default, so there is nothing to set. If *Test connection* reports that the
   endpoint refused the request, update Ollama first.

   > **Only if you run an Ollama older than 0.1.42 and cannot update it:** set
   > `OLLAMA_ORIGINS` in Ollama's environment and restart Ollama.
   > `OLLAMA_ORIGINS=app://obsidian.md` allows just Obsidian;
   > `OLLAMA_ORIGINS=*` allows any origin (simpler, less strict).
   >
   > - **macOS** (Ollama runs as a launch agent):
   >
   >   ```
   >   launchctl setenv OLLAMA_ORIGINS "app://obsidian.md"
   >   ```
   >
   >   Then quit and reopen the Ollama app so it picks up the value.
   >
   > - **Linux** (systemd service):
   >
   >   ```
   >   systemctl edit ollama.service
   >   ```
   >
   >   Add, under `[Service]`:
   >
   >   ```
   >   Environment="OLLAMA_ORIGINS=app://obsidian.md"
   >   ```
   >
   >   Then `systemctl daemon-reload && systemctl restart ollama`.
   >
   > - **Windows:** set `OLLAMA_ORIGINS` through *Edit the system environment
   >   variables* (Start → search for it → *Environment Variables…*), add it as
   >   a new user or system variable, then quit and restart Ollama.

   You only need `OLLAMA_HOST` if the server must listen on a non-default
   address — for example Ollama running on another machine on your LAN. For a
   server on the same machine the default `127.0.0.1:11434` is fine and you can
   leave `OLLAMA_HOST` unset.

3. **Point the plugin at it.** In *Settings → Reading handwriting (OCR) → Read
   handwriting with*, choose **Vision model endpoint**, then set:

   | Field | Value |
   |---|---|
   | Endpoint | `http://localhost:11434/v1` |
   | Model | `qwen2.5vl:7b` |
   | API key | *(leave empty)* |

4. **Verify.** Use the *Test connection* action in settings — or, as a fallback
   that works today, ask the server directly:

   ```
   curl http://localhost:11434/v1/models
   ```

   A JSON list of models that includes `qwen2.5vl:7b` means the server is up, is
   reachable at that endpoint, and has the model. Then import a notebook with a
   handwritten remark and watch it come back as text.

## LM Studio equivalent

1. In LM Studio, **download a vision model** — for example a Qwen2.5-VL GGUF
   from the model search.
2. Open the **Local Server** tab, enable the **OpenAI-compatible server**, and
   start it. The default address is `http://localhost:1234/v1`.
3. In the plugin, set the endpoint to that address, the model to the id LM
   Studio shows for the loaded model, and leave the API key empty.

Neither LM Studio nor a current Ollama needs an origin allowlist for the
plugin — there is nothing to set.

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Connection refused | Server not running, or wrong port. Start Ollama / LM Studio and check the endpoint host and port match the running server. |
| 403 / forbidden | Ollama older than 0.1.42 → update it (or set `OLLAMA_ORIGINS` as in step 2's note). With an API key set → the key was refused. Otherwise a proxy or the server's own access rules refused the request. |
| 404 on `/v1/chat/completions` | The endpoint is missing the `/v1` suffix, or it is not an OpenAI-compatible route. Use `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio). |
| Model not found | The model is not pulled, or the tag is wrong. Run `ollama pull qwen2.5vl:7b` and confirm the Model field matches the tag exactly. |
