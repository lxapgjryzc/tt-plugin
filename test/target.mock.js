// Same shape as extension/src/target.js, fake origin. Used by unit tests.
export const target = {
  id: 'mock',
  base: 'https://mock.invalid',
  authStorageKey: 'mock-auth',
  authTokenPath: 'token',
  pendingStatuses: ['SUBMITTED', 'REVIEWING'],
  doneStatus: 'APPROVED',
  needsRevisionStatuses: ['REVIEWED', 'RETURNED', 'SHELVED'],
  maxUploadBytes: 10 * 1024 * 1024,
  uploadPrefix: 'assignments/',
};
