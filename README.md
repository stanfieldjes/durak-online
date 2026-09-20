# Durak Online

Durak for 2 to 8 players with a rating ladder. The front end is static files on
GitHub Pages; Supabase holds accounts, tables, and records. No server to run.

```
GitHub Pages  ──►  static HTML/CSS/JS       (build.py generates dist/)
      │
      ▼
Supabase      ──►  Postgres + auth + realtime + storage
                   writes go through SECURITY DEFINER functions only
```

## Setup

**1. Create the Supabase project**

Sign up at supabase.com, create a project, open the SQL editor, paste in all of
`supabase/schema.sql`, and run it. That creates the tables, the row-level
security policies, the RPCs, the rating maths, the avatars bucket, and the
realtime publication. It is safe to run again: everything in it is either
`if not exists` or an idempotent alter, and it never touches rows.

It is also safe to run over a database that held the *previous* schema, which
is a different and harder thing — a column cannot be dropped while a view or a
policy still refers to it, so those come down first and are rebuilt further
down. `npm run test:sql` exercises both paths: the new schema on an empty
database, and the new schema over the old one with rows already in it.

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
npm test                     # engine, concurrency, rating and markup tests
npm run test:sql             # the schema, against a throwaway Postgres
```

`build.py` needs nothing but Python 3.9+. The tests need Node 18+ and nothing
else, with one exception: the parts of `tests/view.test.mjs` that need a
document use jsdom, the one devDependency. Without `npm install` those skip
themselves and the rest of the suite still runs. `test:sql` additionally needs
a local `postgres` binary and is skipped in CI; everything it checks about the
rating is also checked in `tests/sync.test.mjs`, which needs nothing.

**4. Deploy**

Push to `main`. In the repo's Settings → Pages, set Source to **GitHub Actions**.
The workflow runs the tests, builds, and publishes to
`https://username.github.io/durak-online/`.

Once it's live, a plain reload is enough to pick up a new deploy — nothing
special to do on your end, for you or for anyone else at the table. Every
module the site ships carries a `?v=<hash>` on every local import, one shared
hash for the whole build (`build.py`, `_version_imports`), so a deploy that
touches one file still changes the URL of every file that imports it. That is
what stops a half-old, half-new page: without it, only the entry script's own
`<script src>` was versioned, and a browser could keep serving yesterday's
`ui.js` from disk underneath today's freshly-fetched `app.js` — which is
exactly what happened once, and is now what `tests/build.test.mjs` checks for.
If a page still looks like the old site right after a push, that is almost
certainly the browser's own disk cache rather than a failed deploy; a hard
refresh (Ctrl/Cmd+Shift+R) or an incognito window confirms it and clears it.

## Rules implemented

Six-card hands, lowest trump opens, 2 to 8 players.

The deck is cut to the table, so there is always a stock left after dealing
and never a heap of it. Four players get the usual 36 cards, sixes up, and
every seat either way moves the bottom rank by one: eights up at two players
(28 cards), sevens at three (32), fives at five (40), and so on to the full
52 at eight. `ranksFor()` and `deckSize()` in `durak.js` are the source of
that.

Nobody is dealt more than four cards of one suit. `newGame()` reshuffles until
that holds, drawing from the same seeded stream, so a seed still reproduces
its deal exactly. It gives up after 200 shuffles and deals what it has, which
in practice never happens: none of 140,000 test deals needed more than a few.

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

**Ending a round.** When the defender beats everything, nobody has to confirm
anything: the table stays up for ten seconds so everyone sees the defence
(attackers can still throw in during that time, with a countdown under the
prompt), then clears itself. Attackers who are finished can press Done to skip
the wait; once every attacker has, the table clears straight away. A new card
thrown in resets everyone's Done.

When the defender takes, attackers get a Done button and the defender picks the
cards up once every attacker has pressed it (an empty hand counts as done). If
no more cards can go down (six on the table, or nothing more the defender could
receive), nobody has to press Done; the cards go to the defender after a short
look.

**Full tables.** Whenever the table cannot take another card (six attacks
down, or the defender has nothing left to answer with) there is nothing to
wait for, so the pause is only 2.5 seconds, long enough to see the cards, and
there is no Done button. That applies to a fully beaten table and a full take
alike.

The engine cannot keep time, so the self-clearing is a `clear` move that every
browser at the table submits when its countdown ends. The version check below
makes sure exactly one of them lands, and `submit_move()` refuses a clear that
arrives before the pause is over, so an out-of-date or modified page cannot cut
it short. The pauses are the `clear_delay_ms` (default 10000) and `quick_clear_delay_ms`
(default 2500) columns on `games`; the migration files show how to change them.

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

## Watching a game

Any table being played can be watched from the lobby, which lists open and
running tables together. Opening one you are not seated at puts you in the
stands: every hand is face up, there is no hand of your own and nothing to
press, and the seats spread across the top and bottom of the table. A
spectator never writes anything — not a move, not the result — so a game
plays out exactly as it would unwatched.

Watching means seeing the cards, so `schema.sql` lets any signed-in player
read a running game's row. See "Trust model" for what that gives away.

## Rating

Everyone starts at **1000**. A game moves **24 points** between the durak and
the rest of the table, and nothing else moves them: no bonus for getting out
early, no allowance for how long you held on.

Durak has exactly one loser, so the natural thing to measure is not credit but
blame, and every game hands out exactly one unit of it. The durak carries all
of it and everyone else carries none. What each player was *expected* to carry
comes from the ratings at the table: a weaker player is likelier to be left
holding cards, so each seat is weighted by `10^(-rating / 400)` and the weights
are normalised to sum to one. The change is the gap between the two:

```
delta = -24 × (blame carried − blame expected)
```

At a table where everyone is rated the same, expectation is `1/n` each:

| Players | Durak | Each survivor |
|---|---|---|
| 2 | −12 | +12 |
| 3 | −16 | +8 |
| 4 | −18 | +6 |
| 5 | −19.2 | +4.8 |
| 6 | −20 | +4 |
| 7 | −20.57 | +3.43 |
| 8 | −21 | +3 |

Losing at a bigger table costs more, because the prior against it was longer:
an eight-handed table only expected you to lose an eighth of the time. Losing
to players rated below you costs more again, and surviving a table of players
rated above you pays more. Both sides always sum to zero, so the pool is
constant — points only ever move between players, never into or out of the
system.

**Why the changes have decimals.** The penalty has to grow with every extra
player at the table, and in whole numbers it does not. Round the survivors
first and hand the durak the remainder, and the durak's loss runs
`12, 16, 18, 20, 20, 18, 21` from two players to eight: it goes *backwards* at
seven and stalls between five and six. At a seven-player table each survivor's
true 3.43 rounds down to 3, six times over, all in the same direction, and
every one of those roundings lands on the same player — so the durak absorbs
only 18, less than a five-handed durak pays. So `profiles.rating` is
`numeric(12,6)` and changes are applied exactly. Rounding is a display concern
and nothing else.

**What you see.** Ratings are shown as whole numbers everywhere — a rating is
a position on a ladder, and the sixth decimal place is nobody's business.
Changes are shown to one decimal, trailing `.0` trimmed, so a four-player game
reads `+6 +6 +6 −18` and a seven-player one reads `+3.4 … −20.6`. That last is
not exactly balanced, and cannot be: no fixed number of decimal places can
represent a seventh. One decimal keeps the visible gap under a quarter of a
point, where whole numbers would be three points out.

**A floor at 100.** A rating never falls below it. This is the one place the
pool is not zero sum — points are created rather than taken from someone — and
it exists because a number that keeps falling with nothing to climb back from
is a worse thing to have on a ladder among friends than a slightly leaky
invariant. Reaching it from 1000 takes a run of losses no real player will
have.

**No placement games.** A rating is a running total rather than a rate, so
playing more can never dilute it and three lucky games cannot put anyone on
top: at K=24 they are worth about 50 points, which is mid-table. This is the
whole reason the old percentage-point score was replaced — there, score was
`(expected durak rate − actual durak rate) × 100`, a rate with games played in
the denominator, so a newcomer who avoided the durak twice scored +25 and a
veteran with 300 honest games was dragged toward the mean by the law of large
numbers. Evidence counted against you.

**Tuning.** `K` is what a game is worth; `SCALE` is how quickly a rating gap
turns into a lopsided expectation. Raising K makes results move faster but adds
noise; lowering SCALE makes gaps matter more per game but squeezes the ladder
into a narrower band. Both live at the top of `src/js/rating.js`, and
`public.rating_changes()` in `schema.sql` mirrors them — change one and you
must change the other, or the number the browser shows when a game ends stops
being the number the database stored. `tests/sync.test.mjs` fails if they drift
apart.

The database is what applies ratings. `finish_game()` reads every player's
rating, calls `public.rating_changes()`, and writes the results in one
transaction, locking the profiles first so two tables finishing at the same
instant cannot both work from the same stale number. A client never sends a
rating or any part of one.

## Names

Usernames may be in any script — Дурак and 田中 are names like any other. The
rule is 3 to 20 characters, no control characters, no padding spaces, and at
least one character that is not a space or punctuation.

That last test is written as "not space and not punctuation" rather than the
more obvious `[[:alnum:]]` because Postgres character classes follow the
database's ctype. Under a UTF-8 locale `[[:alpha:]]` does match Cyrillic and
CJK, but under the C locale it matches ASCII only — so an alnum test would
quietly reject every non-English name on a database created that way.

Two names that *look* the same cannot both exist. The unique index is on
`lower(normalize(username, NFC))`, so `Café` typed with a precomposed é and
`Café` typed as e plus a combining accent collide instead of sitting next to
each other on the leaderboard looking identical.

Length is counted in characters, not bytes and not UTF-16 code units, in both
the browser and the database. A "20 character" limit that quietly means ten
would be simply wrong to anyone typing in Japanese.

## Profile pictures

Pictures live in a public `avatars` bucket in Supabase Storage, one folder per
player named with their user id. Anyone may look; you may only write inside
your own folder, which is what stops one player replacing another's picture.
Uploads are capped at 2MB and limited to PNG, JPEG, WebP and GIF. Uploading a
new one removes the old file, so the bucket holds one picture per player.

Avatars are square, and the player picks which square. Choosing a file opens
the cropper (`src/js/cropper.js`): drag to move the picture about, scroll or
pull the slider to zoom, and the window shows exactly what will be kept. The
crop window and the file that leaves it are drawn by the same function from
the same three numbers — the centre of the square and its side, in the
picture's own pixels — so what is uploaded is what was on screen.

What is uploaded is therefore never the file that was picked. It is re-encoded
from a canvas, at most 512 square, as WebP where the browser can write it:

- A 4MB photograph becomes a couple of kilobytes, so the 2MB cap is only ever
  reached by the file *before* cropping.
- Camera metadata does not survive the canvas, so a holiday photo does not
  arrive carrying the coordinates of where it was taken.
- Orientation is resolved on the way in, through `createImageBitmap(file,
  { imageOrientation: 'from-image' })`. A phone photograph is usually stored
  sideways with a tag saying which way up it goes, and a canvas that ignores
  the tag produces an avatar lying on its side.

An animated GIF becomes a still, since a canvas holds one frame.

`schema.sql` creates the bucket and its policies. Storage lives in a schema
that file may not own, depending on how the project was created, so that part
is wrapped in a block that reports a notice instead of failing the whole run.
If you see `Skipped the avatars bucket`, do it by hand:

1. Storage → New bucket → name it `avatars`, tick **Public bucket**.
2. Storage → Policies → on `objects`, allow `SELECT` where
   `bucket_id = 'avatars'`.
3. Allow `INSERT`, `UPDATE` and `DELETE` for `authenticated` where
   `bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text`.

Players who have not set a picture get the first letter of their name on a
colour derived from it, so everyone is still distinguishable at a glance. That
same fallback catches a picture that fails to load, so a broken image icon
never appears at the table. The letter is taken by character rather than by
code unit, since slicing a string at index 1 cuts an emoji in half.

Resting the pointer on a player — at the table, in the lobby, or on the
leaderboard — opens a panel with a larger picture, their name and their
rating. There is one panel for the whole site, refilled and moved rather than
built per player: the table re-renders on every move, so a panel per seat
would mean building dozens that are almost never looked at. It is placed in
viewport coordinates on `<body>`, which keeps it clear of the felt's own
clipping, and it takes no pointer events, so it can never be in the way of the
table underneath. Triggers are focusable, so the panel is reachable from the
keyboard too.

## Your own rating, over time

The account page draws the rating as a line, one point per finished game.

The points are walked *backwards* from the rating on the profile rather than
forwards from 1000. The profile holds the true current figure, so anchoring
the line to it means the last point always agrees with the number printed
above it, even for a player with more games than the hundred the chart reads.

Games are spaced evenly along the line rather than placed by the clock. Eight
friends play in bursts; a true time axis would pile a fortnight of games into
one pixel and leave the rest of the chart empty. The dates still label the
axis, and the tooltip gives the exact one — along with the size of the table
and what the game did to the rating. When every game shown happened on the
same day the labels fall back to game numbers, rather than printing one date
four times.

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
version at a time, that you may only write a picture into your own folder, and
— the important one — ratings. `finish_game()` computes every change itself, in
one transaction, from ratings it has just locked. A client never sends a rating
or any part of one. You also cannot name someone else the durak unless the
stored position agrees; naming yourself is always allowed, which is how
conceding works.

**What it does not enforce.** Two things:

1. *Move legality.* Postgres does not know the rules of Durak. Beyond the checks
   above it stores what you send. Someone with devtools open can post a position
   where they beat an ace with a six.
2. *Hidden information.* The whole position, including every hand, lives in one
   `jsonb` column. Everyone at the table can read it, and so can anyone
   watching, since spectating is exactly the ability to see those hands. That
   also means a player could open another running table's position in
   devtools and read the cards there.

Finished games are readable by everyone, which is what the recent-games list on
the lobby is built from. That gives nothing away: the game is over.

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
src/js/fx.js             card movement, animated as copies that follow each card
src/js/tablesize.js      fits the table to the window; the drag-to-resize corner
src/js/sound.js          sound effects, pooled and mutable
src/audio/               the clips themselves
src/js/rating.js         rating model, mirrored by public.rating_changes()
src/js/db.js             every Supabase call lives here
src/js/game.js           table rendering, input, spectating, stale-write retry
src/js/account.js        your own name, picture and rating
src/js/cropper.js        picking the square of a picture that becomes an avatar
src/js/chart.js          the rating-over-time line
src/js/{app,auth,lobby,leaderboard,ui}.js
supabase/schema.sql      tables, RLS, RPCs, rating maths, avatars bucket
tests/engine.test.mjs    playouts at 2, 3 and 4 players
tests/sync.test.mjs      SQL contract, concurrency, rating behaviour
tests/rating.test.mjs    the rating model on its own
tests/markup.test.mjs    templates, stylesheet and scripts agree with each other
tests/view.test.mjs      the crop square, the rating line, the hover panel
tests/build.test.mjs     every shipped module is cache-busted together
tests/sql/               runs schema.sql against a throwaway Postgres, both on
                         an empty database and over the previous schema
```

The generator supports four tags: `{{ include "partials/x.html" }}`,
`{{ config.some.key }}`, `{{ asset "styles/main.css" }}` (content-hashed URL),
and `{{ build.hash }}` / `{{ build.date }}`.

## The lobby's recent games

Every finished game on the site, newest first, ten to a page. Each row says who
was left holding the cards, who else was at the table, and what the game did to
*your* rating — or `n/a` where you were not at that table. Games you played in
are marked down the left edge, green if you got out and red if you were the
durak, so your own history still stands out of the feed.

The list is ordered by when a game ended rather than when its table was opened,
since a long game started before a short one can finish after it. It refreshes
itself while you are on the newest page and leaves you alone while you are
paging back through the history.

## Cost

GitHub Pages is free. Supabase's free tier covers 500 MB of database, 1 GB of
storage, 50,000 monthly active users, and 200 concurrent realtime connections,
far more than a friend group will use. The one thing to watch is that Supabase
pauses free projects after a week with no activity; opening the dashboard wakes
it up.

## Card movement

Cards only ever travel four ways: stock to hand, hand to table, table to a
hand, and table to the beaten pile. `planMoves()` in `game.js` works out which
journeys to draw by comparing where every card is in the position on screen
with where it is in the new one, rather than by reading the log, so the
animation cannot disagree with the game: beaten cards can only fly to the
pile, because that is where the state put them.

The new position still renders at once. A card on its way to the table waits
invisibly in its slot (`is-landing`) until its copy arrives. A card on its way
to a hand flies to the middle of that hand, since where it goes in someone
else's hand is not the table's business; your own hand then slides apart to
fit it in its sorted place. Opponents' hands and the stock count cards as they
arrive and leave, not before.

Seats run clockwise around the table on screen, the way play does, so the
defender is always the next seat round from the attacker to look at as well
as in the rules. Playing, you are at the bottom: the player to your left
starts the top row, which fills left to right, and past the fourth the rest
carry on down the right-hand side back toward you (`TOP_ROW_SEATS` in
`game.js`). Watching, where the bottom of the table is free, the overflow
runs along it right to left instead, which is what closes the ring.

Opponents' cards are sized to fit their panel and wrap onto another row every
six. Each row after the first sits half a card up into the one above, so a
hand that grows during a long take costs little height; every card's rank and
suit are in its top corner, so the half left showing is the half worth
reading.

The durak's hand turns face up the moment the game is decided, before the
ratings come up, so everyone sees what they were left holding.

The stock is a tight stack of face-down cards lying over the trump card,
which is turned side on and sticks out to the right. The stack always spans
the same width (`--stack-span` in the CSS): the bottom card never moves, the
top card's left edge stays put while two or more cards remain, and the gaps
between cards widen as the stock runs down. Draws come off the top (left)
card, and the trump is drawn last, turning upright as it flies.

Timings are `FLIGHT_MS` and `SETTLE_MS` at the top of `fx.js`. With reduced
motion turned on, cards simply appear where they belong.

## Table size

Everything on the felt is sized from one number, `--table-scale`, set by
`src/js/tablesize.js`. Until a player picks a size, the table fits the window:
as large as it can be without scrolling, but never below 85% (a short screen
scrolls a little rather than shrinking the cards). Dragging the grip in the
felt's bottom-right corner sets a size, which the browser remembers;
double-clicking the grip, or pressing Home while it has focus, goes back to
fitting the window. Arrow keys resize it from the keyboard.

## Sound

Six short clips in `src/audio/`, played from `src/js/sound.js`: the game
starting, a card landing, the defender announcing a take, the table being
gathered up, and a result each way. `CLIPS` at the top of `sound.js` is the
list, and each entry carries a per-clip trim so the mix is balanced before the
volume slider touches it.

Everything runs through the Web Audio API rather than `<audio>` elements. The
obvious implementation sets `volume` on an element per clip, and that does not
work: iOS and Safari treat `HTMLMediaElement.volume` as read-only and silently
ignore writes, so the slider would appear to do nothing on exactly the devices
most likely to be used here. A GainNode gives real volume control everywhere,
and decoded buffers overlap freely, so two cards landing together need no pool.

There is deliberately no per-card sound while dealing or drawing. The gathering
slide already covers those moments, and a clip firing once per card turned into
a rattle. To bring one back, add it to `CLIPS` in `sound.js` and call it from
`playEventSounds` in `game.js` (the card sound itself plays from
`planMoves`, as each card lands on the table).

Browsers start an AudioContext suspended until the person interacts with the
page, so `setSoundActive()` resumes it when a table appears and again on the
next gesture after that. Nothing is fetched or decoded until then — sound
belongs to the game and nowhere else. The volume slider is remembered.

To swap a clip, drop a replacement into `src/audio/` under the same name and
rebuild. Anything a browser can play works; the files there are mono MP3 because
Ogg is unreliable in Safari.
