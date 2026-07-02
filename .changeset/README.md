# Changesets

Release flow (P6.6):

1. Every user-facing PR adds a changeset: `pnpm changeset` (pick packages +
   semver bump + summary). `zenzip` and `@zenzipjs/core-native` are version-fixed
   — they always release together (the TS API is pinned to its native binary).
2. Merging to main accumulates changesets.
3. To release: `pnpm changeset version` (bumps + writes CHANGELOGs), commit,
   then tag `v<version>` — the tag triggers `.github/workflows/release.yml`
   (prebuild matrix → npm publish).

SemVer policy (pre-1.0): minor = features + anything breaking (alpha rules),
patch = fixes. From 1.0: strict SemVer; the step API and store schemas are
the compatibility surface — schema changes require migrations, never breaking
reads of existing data.
