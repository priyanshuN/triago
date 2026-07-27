# Testing triago by hand

Two layers. The automated suite covers the seams that break silently; the manual
walkthrough covers what only a human can judge — whether triage actually feels
fast.

```bash
cd ~/Documents/tools/triago
npm run build && npm test        # 26 tests, ~9s
```

The suites set `TRIAGO_NO_BROWSER=1`, and one test asserts it: posting a card must
never open a real tab during a test run. Use the same variable in any script of
your own that posts cards in a loop.

That suite already covers: token auth (401 without, wrong token), `Host` header
rejection, card validation, long-poll timeout and wake-up, `triago wait` exit codes
(0 on submit, 3 on timeout, 1 on a bad id), decisions matching the request,
re-submit refusal, restart-from-disk, id-prefix resolution and ambiguity, the SSE
stream, the API-404 fall-through, `defer` round-tripping, editor deep-links being
off by default, the browser auto-open policy (12 cards in a row must produce one
tab, not twelve), and the four MCP tools with their generated schemas.

Everything below is what the suite cannot judge for you.

---

## 1. The two-minute version

```bash
triago demo
```

That posts an eight-finding card covering every field a finding can carry, opens
a tab (or prints the URL), and leaves the card open. Triage it:

- `j` / `k` — move. The focused row gets an amber border.
- `⏎` — expand. You should see detail, failure scenario, and a tinted diff.
- `f` `s` `d` `t` — fix / skip / discuss / defer. **After each one focus should
  jump to the next undecided row** — that auto-advance is the whole speed claim,
  so notice whether it feels right.
- `c` — comment on the focused finding. The box is a real multi-line field, so
  check a three-sentence comment fits without scrolling. Leave it with `Esc`
  (stay), `Tab` (next finding) or `Alt+j`/`Alt+k`; the keybar at the bottom
  switches to those hints while you type, and the text survives the move.
- `u` — undo the decision on the focused row.
- Expand the **last** finding in the list. The whole row, including its decision
  buttons and comment box, should scroll fully into view — this used to open
  below the fold.
- Watch the header tally, and the `rest → skip` link that appears once you are
  part-way through.
- `ctrl ⏎` — submit. The card locks, skips go struck-through and dim, and the
  returned payload appears at the bottom.

Then confirm the terminal side:

```bash
triago show <id>        # same decisions, rendered for the terminal
triago ls               # the card now reads "decided"
```

## 2. The loop that matters: does the agent actually get the answer

This is the feature. Everything else is decoration.

```bash
triago demo --wait 600
```

The command **blocks**. Triage in the browser, hit submit, and watch the terminal
print the decisions JSON and exit 0. Check the tally and any comments you typed
appear in that payload — what the agent acts on is this JSON, not your memory of
what you clicked.

Now the walk-away path:

```bash
triago demo --wait 15   # do nothing for 15s
echo "exit: $?"      # 3 — not an error, the card is still open
triago ls --open        # still there
triago wait <id>        # pick it up whenever; submit in the browser now
```

## 3. Browser tabs stay under control

Post several cards with no triago tab open. **Exactly one** tab should appear; the
rest print `no tab opened (a tab was opened Ns ago)`. Then leave a stale tab
pointing at a card you have deleted (`rm -rf ~/.triago/cards/<id>`) and reload it —
it should quietly land on the newest card instead of showing an error.

## 4. Live updates

With a tab open, post a second card from the terminal:

```bash
triago doc README.md
```

The tab should show it in the left rail immediately, without a reload, and switch
to it if you were not mid-triage. Then kill the server underneath it:

```bash
triago stop             # tab shows "server unreachable — reconnecting…"
triago ls               # any command respawns the server
```

The banner should clear on its own within a couple of seconds, and your cards
should all still be there — they live in `~/.triago/cards/`, the server just reads
them.

## 5. Editor deep-link

Click the `file:line` chip on any finding. It should open that file at that line
in the editor configured in `~/.triago/config.json`. Currently:

```
intellij-idea-ultimate --line {line} {abs}
```

If IntelliJ is not already running this cold-starts it, so give it time. If it
does not work, the fallback is one line — the config carries a working VS Code
command as `_alternative_vscode` (`code -g {abs}:{line}`).

The demo card's paths point at a fake `demo` repo, so they will not resolve. Use
a card whose paths are real — `triago findings` output from your own review, or the
self-review card in this repo's history.

Containment check (should both refuse, since neither path is inside a configured
`repo_roots`):

```bash
T=$(triago token)
curl -s -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"file":"/etc/passwd","line":1}' http://127.0.0.1:5599/api/open
curl -s -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"repo":"triago","file":"../../.ssh/id_rsa","line":1}' http://127.0.0.1:5599/api/open
```

## 6. tmux wake-up

Post from inside a tmux pane so triago captures `$TMUX_PANE`, then submit in the
browser. A line should be typed into that pane:

```
[triago] <id> submitted — 3 fix / 2 skip / 1 discuss / 2 defer
```

Point this at an agent's pane, not a shell prompt — a shell will try to run the
notice. Killing the pane before you submit is also a valid test: submission
should succeed and the injection should be skipped silently.

## 7. MCP, from a real client

The suite tests the protocol; this tests your client's wiring.

Both clients are already registered on this machine (`claude mcp list` and
`codex mcp get triago` to confirm). Start a session and ask the agent to post a
findings card and wait for you. It should block on
the tool call while you triage, and receive the decisions as the tool result —
no `triago wait` involved. Without `MCP_TOOL_TIMEOUT` raised, expect the call to
come back after ~60s with a card id and a hint to call `triago_await_decisions`;
that is the designed fallback, not a bug.

## 8. Security spot-checks

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5599/api/cards          # 401
ss -ltnp | grep 5599                                                              # 127.0.0.1 only
ls -l ~/.triago/token                                                                # -rw-------
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com' \
  -H "authorization: Bearer $(triago token)" http://127.0.0.1:5599/api/cards         # 403
```

The last one only works with curl, not `fetch` — the fetch spec forbids setting
`Host`, which is why the automated version of this test uses `node:http`.

## 9. Theme and layout

The rail footer offers auto / light / dark. Auto follows the OS, and the check
that actually matters is the override: set the OS to dark, pick **light**, and the
page must go light *and stay light through a reload*. Both palettes are designed,
so spend a minute in the one you do not normally use.

Narrow the window: below 1200px the card header wraps to two rows and keeps the
title whole, and below 860px the rail collapses. Zoom to 150% and the row layout
should hold — long summaries ellipsis rather than wrap.

## 10. A submitted card is frozen, and deleting one is not silent

Submit a card and try to change it. The decision buttons should be *gone* rather
than greyed out, a note you left should read as prose, and the keybar should offer
navigation only. Reload — it stays decided.

Then the delete path, which has a contract worth seeing work. In the rail, the ×
on a decided card asks once and removes it; on an open card it warns first,
because an agent may be parked on that card. Prove the parked case:

```bash
triago findings review.json --wait 120
```

Leave that blocked, and from another shell:

```bash
triago rm <id>
```

It must refuse — the card is still open. Then force it:

```bash
triago rm <id> --force
```

The blocked command should exit within a second or two saying the card is gone,
**not** sit out the remaining two minutes. That is the whole point of the 410.

---

## Cleaning up after a session

```bash
triago ls                     # what you have
triago rm <id>                # drop one
triago prune                  # every decided card (dry run; --yes to commit)
triago stop                   # and the server, if you want it gone
```

Cards are only files. Deleting `~/.triago` entirely resets triago to first-run state,
including minting a fresh token.
