# PoEStash Workers

Scheduled price/data refresh workers for PoEStash. Each worker pulls from a
third-party source (poe.ninja, poe.watch, the PoE trade API, GGG) and upserts
into the shared database the app reads from.

## Language

### Leagues

**Priced set**:
The leagues a price worker refreshes: Standard, Hardcore, every live challenge
league, and each one's Hardcore variant. SSF and Ruthless variants are never
priced. Some workers narrow it (gem-usage drops permanent Hardcore, poe.ninja
keeps no build snapshot for it).

**Challenge league**:
A temporary league (e.g. "Mirage"). Formally: a listed league that isn't
permanent, isn't an SSF/Ruthless variant, and hasn't ended. More than one can be
live at once (see Dual-list window), and all live ones are priced.
_Avoid_: temp league, seasonal league.

**Between-leagues gap**:
The window where no challenge league is live, one has ended and the next hasn't
launched. Expected, not an error: workers price only the permanent leagues and
exit cleanly.

**Dual-list window**:
The rollover window where the source lists both the old and the new challenge
league at once. Both are still live, so both are priced. The same applies to a
standalone event running alongside the main league.

### Discovery

**Per-source discovery**:
Each worker asks its own upstream which leagues exist right now, rather than
reading a central list. A worker only ever prices leagues its own source can
actually serve. See ADR 0001.

**Current challenge league**:
The single league the trade-API workers (cluster jewels, split bases, Roast
rares) price: the newest live challenge league, softcore only. Distinct from the
priced set — these spend one rate-limited trade request per row, so they commit
to one league instead of refreshing all. Resolved from GGG's league list, gated
on poe.ninja having priced it (chaos conversion). See ADR 0002.

**Player-seeded keyspace**:
A universe this repo does not enumerate. The cluster and split workers own their
catalogues (a combo list, a base list) and seed rows themselves; the Roast rare
worker prices only rows the *app* wrote when a player pasted a build guide, and
never invents one. Demand is the enumeration, so the keyspace tracks what people
actually play — and a row retires on a `last_seen_at` sweep once nobody pastes
that guide any more.

**Three-tier failure contract**:
How a worker decides between exiting quietly and failing loud. Discovery call
fails (upstream down) → fail loud. Discovery returns no challenge league
(between-leagues) → skip quietly. A single discovered league has no data yet
(404 / "doesn't exist" / empty) → skip that league, keep going, still exit 0.
