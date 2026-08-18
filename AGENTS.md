# Repository instructions

## Development conventions

- Fetch root server state once at the feature boundary and pass cohesive view models to rendering components. Do not add per-row queries for entities already present in the dashboard snapshot.
- Use query hooks for independently fetched and cached server state. Use variable-driven mutation hooks for operations; pass IDs or paths to the mutation instead of binding an entity when the hook is created.
- All dashboard count and status badges use `components/ds/badge.tsx`. Choose a semantic `variant` and an explicit `size`; do not rebuild badge geometry or colors at callsites.
- Consumers destructure and domain-alias only the mutation fields they use:

```ts
const { mutate: resumeSession, isPending: isResuming } =
  useResumeRecentSession();

resumeSession(recent.id);
```

- Extract `mutateAsync` instead when local work must await the operation. Do not extract both `mutate` and `mutateAsync` unless the component genuinely uses both.
- Prefer names such as `resumeSession`, `deleteWorktree`, and `isDeletingWorktree` over generic `mutation.mutate()` / `mutation.isPending` expressions.

## Release policy

Every commit to `main` must bump the `package.json` version using semantic versioning.
