// Live values for tenten.art. The only place the origin and auth key are defined.
export const target = {
  id: 'tenten',
  base: 'https://tenten.art',
  authStorageKey: 'tenten-auth',
  authTokenPath: 'token',
  // Statuses that consume a pending slot (matches the SPA's own count).
  pendingStatuses: ['SUBMITTED', 'REVIEWING'],
  doneStatus: 'APPROVED',
  needsRevisionStatuses: ['REVIEWED', 'RETURNED', 'SHELVED'],
  // Upload size cap enforced by the SPA.
  maxUploadBytes: 10 * 1024 * 1024,
  uploadPrefix: 'assignments/',
};
