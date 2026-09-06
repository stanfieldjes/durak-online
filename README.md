# Durak Online

Durak for 2 to 4 players with a rating ladder. The front end is static files on
GitHub Pages; Supabase holds accounts, tables, and ratings. No server to run.

```
GitHub Pages  ──►  static HTML/CSS/JS       (build.py generates dist/)
      │
      ▼
Supabase      ──►  Postgres + auth + realtime
                   writes go through SECURITY DEFINER functions only
```

## Setup

**1. Create the Supabase project**

Sign up at supabase.com, create a project, open the SQL editor, paste in all of
`supabase/schema.sql`, and run it. That creates the tables, the row-level
security policies, the RPCs, and the realtime publication.

In Authentication → Providers, make sure Email is on. For a private game among
friends, turn *off* "Confirm email" so sign-up works in one step. Leave it on if
the link will be public.

**2. Point the site at it**

Copy your project URL and **anon** key from Settings → API into `config.json`:

```json
{
  "site":     { "title": "Durak", "basePath": "/durak-online/" },
  "supabase": { "url": "https://abcd.supabase.co", "anonKey": "eyJhbGci..." },
  "game":     { "defaultPlayers": 4, "turnSeconds": 0 }
}
```

`basePath` must match your repo name, with slashes on both ends. For a
`username.github.io` repo, use `/`.

**3. Build and run it**

```bash
python3 build.py --serve     # http://localhost:8000
npm test                     # engine, concurrency, and rating tests
```

`build.py` needs nothing but Python 3.9+. The tests need Node 18+. Neither
installs anything.

**4. Deploy**

Push to `main`. In the repo's Settings → Pages, set Source to **GitHub Actions**.
The workflow runs the tests, builds, and publishes to
`https://username.github.io/durak-online/`.

## Rules implemented

36-card deck, six-card hands, lowest trump opens, 2 to 4 players.

The defender beats each attack with a higher card of the same suit or any trump;
trumps are beaten only by higher trumps. A defender who cannot or will not beat
everything takes the table and is skipped as attacker next round; otherwise the
cards are discarded and the defender attacks next. Hands refill to six from the
stock, attacker first and defender last. Once the stock is empty, a player who
empties their hand is out, and the last player still holding cards is the durak.

**Attacking is free-for-all.** Only the opening card of a round belongs to the
primary attacker. After that any attacker may throw in a matching rank at any
moment, with no order between them, up to six cards and never more than the
defender can answer. The defender can be beating one card while somebody throws
in another.

Anyone with no legal throw-in is passed automatically, so a round never waits on
a player who has nothing to add. A round closes when every attacker has passed
and either the defender has beaten everything or has taken.

Not implemented: transferring the attack (`perevodnoy`), the five-card cap on
the opening bout, and a turn clock. `config.json` has a `turnSeconds` slot
already threaded through for the last one.

## Why free-for-all needed a concurrency guard

With strict turns, only one player can write at a time and the database can just
check whose turn it is. Free-for-all breaks that. Two attackers really can throw
in at the same instant, both having read the same position, and a plain
last-write-wins update would silently discard one of the two cards — the card
leaves the player's hand on their screen and never appears on the table.

So every position carries a `version` that increments on each move.
`submit_move()` takes the version the caller built on and refuses the write if
the position has moved since. The client then re-reads and replays its move
against the fresh position; if the move stopped being legal in the meantime
(someone else took the last slot), it says so rather than forcing it through.

This is not a hypothetical. In the test suite's random playouts, more than one
player is eligible to act in roughly a quarter of all positions even at a
two-player table, and the concurrency test produces around 30,000 collisions —
every one either replayed cleanly or correctly abandoned.

## Rating

Everyone starts at **100**. Durak has exactly one loser per game, so the rating
is built around that: the durak drops points, and the survivors split them.

| Table | Durak | Each survivor |
|-------|-------|---------------|
| 4 players | −5.0 | +1.7 |
| 3 players | −5.0 | +2.5 |
| 2 players | −5.0 | +5.0 |

That is the "losing is punishing, winning is a small bonus" shape you wanted,
and at 3 and 4 players it falls out for free: whatever the durak loses is shared
among everyone else, so each individual gain is small.

**Two-player games are the exception, and it is a mathematical one.** With one
loser and one winner, every point the loser drops is a point the winner picks
up. Making the loss bigger than the gain means destroying points, which drags
the whole pool's average down over time. `LOSS_BIAS` in `src/js/elo.js` and
`loss_bias` in `finish_game()` are the dial for that if you want it; both
default to 1, which keeps the pool balanced. Set them to 1.5 and the durak drops
7.5 while the winner still gains 5, at the cost of steady deflation.

The scale leans the same way you do. At a four-player table, being the durak a
quarter of the time — the average share — settles you at exactly 100. Getting
worse than that costs more ground than getting better gains:

| Durak rate at a 4-player table | Settles near |
|--------------------------------|--------------|
| 10% | 135 |
| 25% | 100 |
| 40% | 65 |
| 60% | 12 |

Ratings never go below 0. A player who is always the durak sinks to the floor
and stays there. At the other end there is a natural ceiling near 160, because
survivors at a four-player table share a single score and no rating can outrun
that.

The maths, mirrored in `src/js/elo.js` and `finish_game()`:

```
expected_i = mean over j≠i of  1 / (1 + 10^((r_j − r_i) / 200))
actual_i   = 0                          if i is the durak
             (1 + 0.5(n−2)) / (n−1)     if i survived
             0.5                        for everyone, on a draw
delta_i    = 10 × (actual_i − expected_i)
```

Both sides sum to n/2, which is why the pool balances. If you change the
constants in `elo.js`, change them in `finish_game()` too — the database is what
actually applies ratings, and `tests/sync.test.mjs` checks the behaviour either
way.

## Why the anon key is in the repo

The anon key is *designed* to be public — it ships to every browser that loads
the page, and there is no way to hide it in a static site. It identifies your
project; it does not authorise anything by itself. What protects your data is
row-level security plus the fact that no table grants INSERT or UPDATE to
clients at all.

The key you must never commit is the **service role** key, which bypasses RLS
entirely. It is not used anywhere in this project. If you ever paste it into
front-end code, rotate it immediately.

## Trust model

**What the database enforces.** Turn ownership of the opening card, seat
membership, that the deal cannot change mid-game, that positions advance one
version at a time, and — the important one — ratings. `finish_game()` reads
every current rating out of the database, computes the changes itself, and
applies them in one transaction. A client never sends a rating or a delta. You
also cannot name someone else the durak unless the stored position agrees;
naming yourself is always allowed, which is how conceding works.

**What it does not enforce.** Two things:

1. *Move legality.* Postgres does not know the rules of Durak. Beyond the checks
   above it stores what you send. Someone with devtools open can post a position
   where they beat an ace with a six.
2. *Hidden information.* The whole position, including every hand, lives in one
   `jsonb` column that all players at the table can read.

For a ladder among people you know this is usually fine — cheating is visible
and socially expensive. If you want it airtight, move the engine server-side.
`src/js/durak.js` is deliberately pure and import-free so it can be dropped into
a Supabase Edge Function unchanged:

```ts
// supabase/functions/move/index.ts
import { applyMove, viewFor } from './durak.js';
// 1. load the game row with the service role key
// 2. state = applyMove(row.state, callerSeat, move)   ← rejects illegal moves
// 3. write it back under the same version check
// 4. return viewFor(state, callerSeat), which strips the other hands
```

Then have clients call the function instead of `submit_move`, and drop the
`select` policy on `games` so the position is never read directly. Edge
Functions are on the same free tier. `viewFor()` is already written for this.

## Layout

```
build.py                 static site generator, stdlib only
config.json              site + Supabase settings (safe to commit)
src/templates/           base.html and the view partials
src/styles/main.css
src/js/durak.js          rules engine — pure, no DOM, no network
src/js/elo.js            rating model, mirrored by finish_game()
src/js/db.js             every Supabase call lives here
src/js/game.js           table rendering, input, stale-write retry
src/js/{app,auth,lobby,leaderboard,ui}.js
supabase/schema.sql      tables, RLS, RPCs, rating maths
tests/engine.test.mjs    playouts at 2, 3 and 4 players
tests/sync.test.mjs      SQL contract, concurrency, rating behaviour
```

The generator supports four tags: `{{ include "partials/x.html" }}`,
`{{ config.some.key }}`, `{{ asset "styles/main.css" }}` (content-hashed URL),
and `{{ build.hash }}` / `{{ build.date }}`.

## Cost

GitHub Pages is free. Supabase's free tier covers 500 MB of database, 50,000
monthly active users, and 200 concurrent realtime connections, far more than a
friend group will use. The one thing to watch is that Supabase pauses free
projects after a week with no activity; opening the dashboard wakes it up.
