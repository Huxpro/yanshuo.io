const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Product knobs for version history. The Worker is authoritative: clients use
// the returned policy to avoid needless requests, but cannot grant themselves
// a larger allowance. Set VERSION_HISTORY_POLICIES to a JSON object to change
// these without a code release; omitted fields keep these safe defaults.
export const DEFAULT_VERSION_HISTORY_POLICIES = {
  free: {
    enabled: true,
    autoIntervalMs: 5 * 60 * 1000,
    listLimit: 200,
    maxVersionsPerDeck: 200,
    maxVersionsPerUser: 1000,
    maxAutoVersionsPerDeck: 160,
    maxNamedVersionsPerDeck: 40,
    maxRestoreVersionsPerDeck: 20,
    retentionDays: { auto: 90, 'restore-point': 90, created: 0, named: 0 },
    maxSnapshotBytes: 50 * MiB,
    maxBytesPerDeck: 1 * GiB,
    maxBytesPerUser: 5 * GiB,
  },
  pro: {
    enabled: true,
    autoIntervalMs: 60 * 1000,
    listLimit: 500,
    maxVersionsPerDeck: 1000,
    maxVersionsPerUser: 10000,
    maxAutoVersionsPerDeck: 800,
    maxNamedVersionsPerDeck: 200,
    maxRestoreVersionsPerDeck: 100,
    retentionDays: { auto: 365, 'restore-point': 365, created: 0, named: 0 },
    maxSnapshotBytes: 250 * MiB,
    maxBytesPerDeck: 10 * GiB,
    maxBytesPerUser: 100 * GiB,
  },
};

const INTEGER_FIELDS = [
  'autoIntervalMs',
  'listLimit',
  'maxVersionsPerDeck',
  'maxVersionsPerUser',
  'maxAutoVersionsPerDeck',
  'maxNamedVersionsPerDeck',
  'maxRestoreVersionsPerDeck',
  'maxSnapshotBytes',
  'maxBytesPerDeck',
  'maxBytesPerUser',
];
const REASONS = ['auto', 'restore-point', 'created', 'named'];

function configuredPolicies(env) {
  if (!env.VERSION_HISTORY_POLICIES) return {};
  try {
    const parsed = JSON.parse(env.VERSION_HISTORY_POLICIES);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error('VERSION_HISTORY_POLICIES is not valid JSON; using defaults.');
    return {};
  }
}

function normalizedPolicy(base, override = {}) {
  const policy = { ...base };
  policy.enabled = typeof override.enabled === 'boolean' ? override.enabled : base.enabled;
  for (const field of INTEGER_FIELDS) {
    const value = Number(override[field] ?? policy[field]);
    policy[field] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : base[field];
  }
  policy.retentionDays = { ...base.retentionDays };
  for (const reason of REASONS) {
    const value = Number(override.retentionDays?.[reason] ?? policy.retentionDays[reason]);
    policy.retentionDays[reason] = Number.isFinite(value) ? Math.max(0, value) : base.retentionDays[reason];
  }
  return policy;
}

export function versionPolicy(env, user) {
  const configured = configuredPolicies(env);
  const requested = user?.plan || env.VERSION_HISTORY_DEFAULT_PLAN || 'free';
  const plan = Object.hasOwn(DEFAULT_VERSION_HISTORY_POLICIES, requested) || Object.hasOwn(configured, requested)
    ? requested
    : 'free';
  const base = DEFAULT_VERSION_HISTORY_POLICIES[plan] || DEFAULT_VERSION_HISTORY_POLICIES.free;
  return { plan, ...normalizedPolicy(base, configured[plan]) };
}

export const versionSize = (metadata) => new TextEncoder().encode(metadata).byteLength;
