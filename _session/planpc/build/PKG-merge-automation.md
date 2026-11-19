# Merge 057297b, step "automation" (§6 step 3: pigment-genai and automation)

Branch `claude/pigment-merge-057297b`, commit **`51ac04f`** "Pigment merge 057297b, automation:
Pigment's agents gate on upstream's agent_link" on top of the engine commit `8cebf29`. Pushed. Tree
clean after it.

## What I did

Before any edit, `cargo test -p pigment-genai -p photocraft-automation --no-run` failed on one error
only: `crate::agent_link::SERVER_NAME` (used by `server/conventions.rs` for `serverInfo.name`) was gone
with the import's conflict hunks. Everything else in automation and genai (Pigment's `genai.rs`,
`headless.rs`, `files.rs` importer hooks, `security.rs`/`args.rs` with `PIGMENT_CONTROL_TOKEN*`,
`workspace.rs`, `server.rs` help text, `lib.rs` `pub mod genai`, `tests/it/main.rs` `mod legacy_pigment`)
had merged cleanly and compiled against NEW unchanged.

### Hand merges

1. **`crates/automation/src/agent_link.rs`** (4 conflict hunks of the import, all upstream's then).
   Upstream's file is now only `read_integrations`, `LAUNCHER_APP_ID` and `agents_allowed_now`; the
   connection file, token file, probe and switch moved to `craft::automation::agents` (craft-libs
   `18ffc07`, `crates/automation/src/agents/`). Kept upstream's code and put Pigment's gate on it:
   - module doc: Pigment's (own switch, never the launcher or the flag; the connection file is the
     framework's).
   - `pub const SERVER_NAME: &str = "pigment";` back (upstream now writes the literal `"photocraft"` in
     `conventions.rs`; Pigment's hook there, `crate::agent_link::SERVER_NAME`, merged cleanly).
   - `pub fn mcp_flag() -> bool { false }`, `pub fn launcher_allows_agents() -> bool { false }` back
     (FORK.md › AI agents and MCP names them; the CLI and app can use them in steps 4 and 6).
   - `agents_allowed_now(i)` = `agents::agents_allowed(mcp_flag(), launcher_allows_agents(),
     i.connect_agents)`: the framework's rule with Pigment's two `false`s, i.e. `connect_agents` alone.
     Upstream's version called `agents::mcp_flag()` and `agents::launcher_allows(LAUNCHER_APP_ID)`
     (reads `ArtCraft/flags.toml` / `CRAFT_FLAGS` and the launcher's app list): **D1, removed**.
   - Tests: upstream's `integrations_come_from_the_saved_preferences_or_default` (reads Pigment 0.5's
     `preferences.json` shape incl. `connectAgents`, `controlPort`, `readRoot`: passes) kept; Pigment's
     `pigment_reads_neither_the_suite_flag_nor_the_launcher` back, now also asserting the file's source
     never contains a call `agents::mcp_flag(` or `agents::launcher_allows(`; new
     `mcp_clients_list_pigment_as_pigment`. Pigment 0.5.0's tests of the connection file
     (round trip, damaged file, probe, stale file, folder trimming) and of its own `agents_allowed`
     (with the flag) are dropped: that code is craft's now and craft tests it.
2. **`crates/automation/src/live.rs`** (1 hunk): upstream's code (`integrations.agents.when_app_closed`,
   `read_folder()`, `write_folder()`, `craft::automation::agents::{read_connection, probe}`) with
   Pigment's words: "Pigment isn't running: open it, then try again." and "Pigment isn't running and its
   agent folders can't be used". The launch-timeout message with "Preferences › AI Integrations › Let AI
   apps use this window" and "Pigment's agent token" had merged cleanly. `LiveConfig::allowed` defaults to
   `agent_link::agents_allowed_now` (Pigment's gate).
3. **`crates/automation/tests/it/mcp_live.rs`** (script-only, listed by `--check`): the rebrand script's
   `rewrite()` applied to this one file (two `Connection::new(…, "PhotoCraft test")` → `"Pigment test"`),
   as the engine step did for its files. `--check` no longer lists any `crates/automation` or
   `crates/genai` file.

### Checked, nothing to change

- `security.rs`: upstream moved the challenge handshake (`ServerHandshake`, `handshake_proof`, …) to
  `craft::automation::security` and re-exports it; Pigment's message naming `PIGMENT_CONTROL_TOKEN` /
  `PIGMENT_CONTROL_TOKEN_FILE` is intact. `args.rs`: `env = "PIGMENT_CONTROL_TOKEN"`,
  `"PIGMENT_CONTROL_TOKEN_FILE"` and Pigment's test `token_variables_are_pigment_s_own` intact;
  upstream's new `EmptyRoot`/`Conflict` error types merged. `app_dirs.rs`: `PIGMENT_CONFIG_DIR` intact.
  No `PHOTOCRAFT_CONTROL_*`/`PHOTOCRAFT_AUTOMATION_*`/`PHOTOCRAFT_CONFIG_DIR` is read anywhere in
  automation, and nothing in Pigment's tree calls craft's `args::…::for_app(prefix)` (the framework's
  prefix-built names); if a later step starts using it, pass `"PIGMENT"`.
- `genai.rs` and the `ai.*` gate ("Allow agents to run AI commands", `pigment_genai` settings
  `allow_agents`): unchanged, tests pass. No string literal in `crates/automation/src` or
  `crates/genai/src` names PhotoCraft or ArtCraft outside comments.

## Changes to Pigment's code

Only the agent_link gate above (Pigment's functions re-placed on upstream's slimmer file, tests
updated). No Pigment-only file edited.

## Tests and checks (CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols, -j 4, TMPDIR=/dev/shm/pt, CRAFT_I18N_DIR, CRAFT_FONTS_DIR=craft-fonts at cc9269c)

| Command | Result |
|---|---|
| `cargo nextest run --profile ci -p photocraft-automation -p pigment-genai` (CI's runner) | **358 passed, 1 skipped, 0 failed** |
| `cargo test -p pigment-genai -p photocraft-automation --no-fail-fast` | automation lib 149 passed (incl. the 3 agent_link tests); `tests/it` **129 passed, 1 failed** (below), incl. `legacy_pigment::{a_pigment_0_4_document_named_pcraft_opens_from_bytes, files_open_draws_the_smart_filters_of_a_pigment_0_4_document}` and `mcp` (asserts `serverInfo.name == "pigment"`); genai lib 2 passed, `tests/genai` 77 passed, 1 ignored |
| `cargo clippy -p photocraft-automation -p pigment-genai --all-targets -- -D warnings` | clean |
| `cargo fmt -p photocraft-automation -p pigment-genai -- --check` | clean |
| `pigment-rebrand.py --check` | no automation/genai file listed |

**The one plain-`cargo test` failure is upstream's, not the merge's:**
`scratch_save::native_save_refuses_previews_rendered_from_unreadable_scratch`
(`assert_eq!(spill::stats().resident_bytes, 0)`, left 172 MB). The file is byte-identical to upstream's
at NEW; its own doc comment says "The scratch store is per process, so the test needs its own (nextest
runs every test in one)". Upstream moved it from its own test binary into the shared `tests/it/` binary
in this revision, so under `cargo test` other tests' spill tiles are resident in the same process. It
passes alone (`cargo test --test it scratch_save`), passes under nextest (CI), and fails/passes
alternately under plain `cargo test` even with Pigment's `legacy_pigment` tests skipped (`--skip
legacy_pigment`: 1 failure, then 0). Not added to `upstream-test-failures.txt` (CI runs nextest, where it
passes).

Disk: 16 GB free at the end (`df -h /`).

## Left for the next steps (not done here)

- **Step 4 (CLI):** `apps/photocraft-cli/src/automation.rs:77` still has upstream's
  `None if !a.headless && craft::automation::agents::mcp_flag() =>` — a D1 violation (reads the suite
  flags file) and it would stop `pigment-cli mcp` from ever going live. Put back
  `None if !a.headless => PhotocraftMcp::live(live_config(a)?),` (or `&& …agent_link::mcp_flag()`-free).
- **Step 6 (app):** `apps/photocraft/src/main.rs:663` starts `AgentSwitch::watch(agent_link::LAUNCHER_APP_ID, …)`:
  use `AgentSwitch::fixed(agent_link::mcp_flag(), agent_link::launcher_allows_agents())` (both false),
  and make the app's gate `agent_link::agents_allowed_now` / `connect_agents`. The app's `Connection::new(…, app)`
  / `AgentLink::new(dir, app)` app string should name Pigment.
- **Step 8 (FORK.md):** the endpoint table's "Control server, MCP bridge, …, agent connection" row
  names `apps/photocraft/src/control_server.rs` and `crates/automation/src/{bridge,agent_link}.rs`; the
  connection file and control server are now `craft::automation::{agents, server}`. The "AI agents and
  MCP" section is still true (`agent_link::mcp_flag()`/`launcher_allows_agents()` always false).
- Step 9: `crates/genai/tests/genai/` → `tests/it/` (the `test-binaries` check), as the plan says.
