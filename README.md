# codex-team

[English](./README.md) | [简体中文](./README.zh-CN.md)

`codex-team` provides the `codexm` CLI for managing multiple Codex ChatGPT login snapshots on one machine.

Use it when you regularly switch between multiple Codex accounts and want a simpler way to:

- save named account snapshots
- switch the active `~/.codex/auth.json`
- check quota usage across saved accounts
- export and import fully trusted share bundles without re-login
- automatically switch and restart when the current account is exhausted
- expose a local proxy account for Codex and OpenAI-compatible tools

## Platform support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | ✅ Full | Desktop launch, watch, and all CLI commands |
| Linux    | ✅ Full | CLI-only mode; Desktop commands gracefully degrade |
| WSL      | ✅ Full | WSL-aware browser opening; CLI-only mode |

## Install

```bash
npm install -g codex-team
```

After install, use the `codexm` command.

## Optional Agent Skill

This repo also maintains an optional agent skill for coding agents that can install `SKILL.md` bundles from GitHub. The skill is not required to run `codexm`; the npm package ships only the CLI runtime.

Any compatible coding agent can install the same `skills/codexm-usage` path from GitHub. If you are using Codex's built-in GitHub skill installer, pin the skill to the same release tag as the CLI you installed:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo HOOLC/codex-team \
  --path skills/codexm-usage \
  --ref v0.0.24
```

Replace `--ref` with the release tag that matches your installed CLI version. Restart or reload your coding agent after installing the skill if it caches available skills.

## Quick start

### 1. Save a couple of accounts and inspect them

```bash
codexm add plus1
codexm add team1
codexm list
codexm usage
```

Use `codexm list` for the account overview and `codexm usage` for local token usage plus estimated cost from session logs.

### 2. Open the dashboard

```bash
codexm
```

Inside the dashboard:

- `Enter`: switch the selected direct account, or toggle proxy on/off when the `proxy` row is selected
- `/`: enter filter mode
- `a`: enable or disable daemon-backed autoswitch
- `f`: reload the current account or force-switch
- `p`: toggle whether the selected account can be chosen as an auto-switch target
- `o`: run `codex` in the current terminal, then return to the dashboard when it exits
- `O`: run `codex` with an isolated managed snapshot, then return to the dashboard when it exits
- `d`: open or focus Codex Desktop without leaving the dashboard
- `Shift+D`: relaunch Codex Desktop for the selected account; when an unmanaged Desktop instance is already running, confirm before forcing it closed
- `q`: quit from the main dashboard; `Esc` backs out of prompts

For the full keymap, prompt controls, and proxy-row behavior, see [dashboard.md](./skills/codexm-usage/references/dashboard.md).

### 3. Keep working automatically

macOS + Codex Desktop:

```bash
codexm launch
codexm autoswitch enable
```

Linux / WSL + Codex CLI:

```bash
codexm watch
```

In another terminal:

```bash
codexm run -- --model o3
```

`codexm launch` starts Desktop and ensures the shared baseline daemon is running. `codexm autoswitch enable` turns on daemon-backed background auto-switching for managed Desktop and proxy flows. `codexm watch` remains the foreground quota monitor; when proxy mode is active, its structured quota lines switch to `account="proxy"` and include `upstream="..."` for the current real backend when known. `codexm run` wraps the `codex` CLI, survives repeated `~/.codex/auth.json` replacements, and auto-resumes the active interactive session after an account-triggered restart. If you end `codexm run` manually while a session is recoverable, it prints the resume command to use.

### 4. Enable proxy mode

```bash
codexm proxy enable
codexm proxy status
codexm run --proxy -- --model o3
codexm proxy disable
```

`codexm proxy enable` starts or reuses the shared local daemon, installs a synthetic `proxy` account (`proxy@codexm.local`), and rewrites the default runtime's transport URLs to that proxy. Live proxy and non-proxy sessions keep the same provider identity, so they continue sharing one live thread history. The synthetic `proxy` row always stays visible in `codexm list` and the dashboard; while proxy mode is enabled, `@` marks the configured real upstream row.

While proxy stays enabled, `codexm switch <name>` changes the current real upstream without replacing the default runtime's synthetic `proxy` auth or creating a `last-active-auth.json` backup; daemon autoswitch can move that upstream later after quota exhaustion. Before any downstream output starts, the proxy can replay one retryable quota-exhausted websocket turn or buffered REST request. The same daemon also exposes an OpenAI-compatible `/v1` surface for common tools.

Use `codexm proxy enable` for the default runtime and `codexm run --proxy` for an isolated overlay that should not touch the live `CODEX_HOME`. Use `codexm daemon status` to inspect daemon state. For quota aggregation, replay rules, Desktop behavior, ports, and logs, see [proxy.md](./skills/codexm-usage/references/proxy.md) and [managed-desktop.md](./skills/codexm-usage/references/managed-desktop.md).

## Example output

Redacted `codexm list` example:

```text
$ codexm list
Current managed account: plus-main
Daemon: off | Proxy: off | Autoswitch: off
Accounts: 2/3 usable | blocked: 1W 1, 5H 0 | plus x2, team x1
Available: bottleneck 0.84 | 5H->1W 0.84 | 1W 1.65 (plus 1W)
Usage 7d: in 182k/$0.42 | out 96k/$0.71 | total 278k/$1.13

   NAME         IDENTITY  PLAN  SCORE   ETA     USED      NEXT RESET
   -----------  --------  ----  -----  -----   5H   1W   ----------
*  plus-main    ac1..123  plus    72%   2.1h   58%  41%  04-14 18:30
   team-backup  ac9..987  team    64%   1.7h   61%  39%  04-14 19:10
   plus-old     ac4..456  plus     0%      -   43% 100%  04-16 09:00
```

This is the main command to use when deciding which account to switch to next.

## Core commands

<!-- GENERATED:CORE_COMMANDS:START -->
### Manage accounts

- `codexm add <name>`: add a new managed account snapshot
- `codexm save <name>`: save the currently active auth as a named snapshot
- `codexm replace <name>`: overwrite an existing saved snapshot with a new login or API key source
- `codexm update`: refresh the saved snapshot for the current managed account
- `codexm rename <old> <new>`: rename a saved snapshot
- `codexm protect <name>`: exclude a saved snapshot from automatic switch target selection
- `codexm unprotect <name>`: restore a saved snapshot to automatic switch target selection
- `codexm remove <name> --yes`: remove a saved snapshot
- `codexm export [name] [--output <file>]`: export the current auth or a saved snapshot as a share bundle
- `codexm import <file> --name <local-name>`: import a share bundle as a named managed account
- `codexm inspect <file>`: preview bundle metadata before importing

### Inspect quota and status

- `codexm`: open the interactive account dashboard when running in a TTY
- `codexm current`: show the current account plus best-effort quota
- `codexm doctor`: diagnose local auth, runtime probes, and managed Desktop consistency
- `codexm list [--refresh] [--usage-window <today|7d|30d|all-time>] [--verbose]`: show saved accounts plus an embedded local usage summary
- `codexm list <name>`: show one saved account in detail, including email, identity, quota, and the selected local usage window
- `codexm list --json`: machine-readable output for list and list <name>, including saved account paths, proxy current-upstream metadata, and last-upstream metadata when available
- `codexm list --debug`: include diagnostic details about quota normalization and observed ratios
- `codexm proxy status`: inspect the local proxy daemon and synthetic auth mode
- `codexm daemon status`: inspect the shared background daemon, enabled features, and log path
- `codexm autoswitch status`: inspect whether daemon-backed auto-switching is enabled
- `codexm tui [query]`: explicitly open the account dashboard, optionally with an initial filter; Enter on the proxy row toggles proxy on or off
- `codexm usage [--window <today|7d|30d|all-time>] [--daily] [--json]`: summarize local token usage and estimated cost from session logs

### Switch and launch

- `codexm switch <name>`: switch to a saved direct account; with proxy enabled, update only the proxy's current upstream without replacing the synthetic proxy auth
- `codexm switch --auto --dry-run`: preview the best auto-switch candidate
- `codexm launch [name] [--auto]`: launch Codex Desktop on macOS and ensure the shared daemon is running

### Watch and auto-restart

- `codexm watch`: watch quota changes and auto-switch on exhaustion
- `codexm autoswitch enable`: enable daemon-backed auto-switching, including proxy replay before user-visible output starts on quota exhaustion
- `codexm autoswitch disable`: disable auto-switching while keeping the baseline daemon alive
- `codexm daemon start`: start the shared background daemon without enabling extra features
- `codexm daemon stop`: stop the shared background daemon while preserving the last daemon feature state
- `codexm run [--account <name>] [-- ...codexArgs]`: run codex with global auth follow-restart or an isolated managed account snapshot
- `codexm run --proxy [-- ...codexArgs]`: run codex in an isolated CODEX_HOME through the local proxy
- `codexm proxy enable`: enable global synthetic ChatGPT auth backed by the local proxy, with one replay before user-visible output starts on proxy quota exhaustion
- `codexm proxy disable`: restore the previous direct auth/config backup while leaving the shared proxy daemon state untouched
- `codexm overlay create <name>`: create an isolated CODEX_HOME overlay for another tool to use
<!-- GENERATED:CORE_COMMANDS:END -->

Use `codexm --help` for the full command reference. Share bundles are plain auth snapshots intended only for fully trusted recipients.

In a TTY, plain `codexm` opens the dashboard directly. For the full keymap, prompt controls, confirmations, and proxy-row behavior, see [dashboard.md](./skills/codexm-usage/references/dashboard.md). High-frequency actions: `Enter` switches the selected direct account or toggles proxy on the `proxy` row, `f` reloads the current selection, `e` exports the selected managed direct account, `Esc` backs out of prompts, and `q` quits from the main list. The dashboard shares `codexm list` formatting for reset countdowns, `@` / `Last upstream` proxy markers, and `[stale]` quota fallback.

## When should I use each command?

- `codexm list` is the best overview when choosing the next account.
- `codexm usage` is the best view for local token volume and estimated cost.
- `codexm autoswitch enable` is the background daemon feature for managed Desktop and proxy auto-switching.
- `codexm watch` is the foreground quota-monitoring loop that reacts to quota exhaustion.
- `codexm daemon start` starts the shared baseline daemon without enabling autoswitch or proxy.
- `codexm daemon status` is the place to inspect the shared background daemon and log paths.
- `codexm run` is useful in CLI workflows where the running `codex` process should follow account switches.
- `codexm proxy enable` is useful when Codex or another tool should keep one stable local API/auth while `codexm` rotates the real upstream account internally.
- `codexm run --proxy` is the safer one-off mode when you want proxy behavior without writing sessions or auth/config into the live `CODEX_HOME`.
- Set `CODEXM_PROXY_PORT` when the shared proxy/daemon must avoid the default `14555`; `--port` still overrides it for `codexm proxy enable`.
- Use `--json` for scripting and `--debug` for diagnostics.

For ChatGPT auth snapshots, `codex-team` can save and switch different users under the same ChatGPT account or workspace as separate managed entries when the local login tokens distinguish them.

## Share accounts across machines

Keep a copy of every login in a small registry server so another machine can pull the same account instead of signing in again. See [server-python/README.md](./server-python/README.md) for running the server.

```bash
# once per machine
codexm remote add home http://127.0.0.1:8787 --token <token>

codexm remote accounts        # what the registry is holding
codexm remote push            # upload the account you are using now
codexm remote pull jsunhj     # download an account and switch to it
codexm remote sync            # upload anything newer than the registry copy
```

`remote sync` compares token expiry and skips accounts whose registry copy is already at least as fresh, so a stale machine can never rewind a token another one just refreshed.

For a browser view of the same accounts, start the console. It listens on loopback only and requires the one-shot token printed in the URL:

```bash
codexm ui                     # opens http://127.0.0.1:<port>/?token=...
codexm ui --port 8899 --no-open
codexm ui --tray              # keep it in the Windows system tray instead of opening a tab
```

`--tray` keeps the console resident in the Windows system tray: left-click opens the console, right-click offers refresh, sync, and quit. A tray-only start opens no window and no tab, so the icon announces itself with a balloon notification — clicking that bubble opens the console too. On macOS and Linux it falls back to the normal console.

Switching accounts from the console follows the same contract as `codexm switch`: local auth moves first, then a Desktop started by `codexm launch` picks up the new account — refreshed in place where DevTools allow it, and on Windows (where Codex Desktop ignores the debugging port) by restarting the codexm-managed session. A Codex Desktop that codexm did not start keeps its previous login state — the console surfaces that as a warning instead of restarting it. While proxy mode is active, a switch only moves the proxy upstream, so requests use the new account immediately and no Desktop refresh is attempted.

**Add account** in the console header adds a managed snapshot without touching current auth: pick device-code login to get a code plus the OpenAI authorization page (the console polls until you approve it — works even when the console runs on a remote or headless machine), browser-callback login to open the OpenAI authorization page directly (OpenAI redirects to `localhost:1455` on the machine running codexm, so use it when the console and your browser are on the same machine), or paste an API key. Overwriting an existing name asks for confirmation first.

When OpenAI rejects a saved login for good — an expired or revoked refresh token, a `401` such as "Your session has ended" — the card is marked **Re-login required** and offers a **Re-login** button that runs the same add flow under the same name and overwrites the stale snapshot. Switching to that account is hidden until it works again, because the switch would only put the dead auth in place. The CLI equivalent is `codexm replace <name>`.

Every card has a **⋯** menu in its top-right corner holding **Delete account**. The first click only arms the item (it turns red and reads `Confirm delete <name>`); a second click removes that account's snapshot directory. Closing the menu or waiting 6 seconds disarms it, so a stray click cannot delete anything. Deleting the account codex is currently using is allowed: the copy in `~/.codex/auth.json` keeps working, it simply stops belonging to any managed account, and the console warns you to switch. The CLI equivalent is `codexm remove <name>`.

When you want a real app restart instead of an in-place refresh, use **Restart Desktop** in the console header or the tray menu. It quits Codex Desktop and launches it again so the app re-reads the current auth. If the running Desktop was not started by `codexm launch`, the console asks for confirmation first — closing it can discard unsaved sessions; the tray menu treats the click itself as that confirmation.

## Shell completion

<!-- GENERATED:SHELL_COMPLETION:START -->
Generate a completion script and install it with your shell's standard mechanism:

```bash
mkdir -p ~/.zsh/completions
codexm completion zsh > ~/.zsh/completions/_codexm

mkdir -p ~/.local/share/bash-completion/completions
codexm completion bash > ~/.local/share/bash-completion/completions/codexm
```

The generated scripts complete commands, known subcommands, flags when the current word starts with `-`, and saved account names by calling `codexm completion --accounts`.
<!-- GENERATED:SHELL_COMPLETION:END -->

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Live-run validation may call live ChatGPT/OpenAI services when needed, but must use a temp `HOME`, isolated `CODEX_HOME`, or codexm overlay so local threads, sessions, auth/config, sockets, and live CLI/TUI/Desktop instances are not modified.

## License

MIT
