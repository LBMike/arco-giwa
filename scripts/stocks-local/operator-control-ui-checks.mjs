// Stable identities shared by the real browser driver and CI acceptance.
// Each is recorded only after its scenario's assertions complete.
export const OPERATOR_CONTROL_UI_CHECK_IDS = Object.freeze([
  'initial-paused', 'single-submit-other-gate', 'lost-response-replay', 'operator-cas', 'role-denials',
  'other-operator-uncertainty', 'same-operator-other-key', 'history-pages-viewports',
  'deployment-history-isolation', 'unavailable-routes',
]);
