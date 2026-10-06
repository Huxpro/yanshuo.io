const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// The cloud always keeps one current deck. These policies only govern extra,
// immutable recovery points. Free therefore costs close to the old model until
// the user explicitly names, publishes, or restores a version.
export const DEFAULT_VERSION_HISTORY_POLICIES = {
  free: {
    enabled: true,
    autoEnabled: false,
    createdEnabled: false,
    namedEnabled: true,
    publishedEnabled: true,
    restorePointEnabled: true,
    autoIntervalMs: 0,
    listLimit: 50,
    maxVersionsPerDeck: 10,
    maxVersionsPerUser: 50,
    maxAutoVersionsPerDeck: 0,
    maxCriticalVersionsPerDeck: 10,
    maxNamedVersionsPerDeck: 10,
    maxPublishedVersionsPerDeck: 10,
    maxRestoreVersionsPerDeck: 3,
    retentionDays: {
      auto: 0,
      created: 0,
      named: 0,
      published: 0,
      'restore-point': 0,
    },
    maxSnapshotBytes: 50 * MiB,
    maxBytesPerDeck: 250 * MiB,
    maxBytesPerUser: 1 * GiB,
  },
  pro: {
    enabled: true,
    autoEnabled: true,
    createdEnabled: false,
    namedEnabled: true,
    publishedEnabled: true,
    restorePointEnabled: true,
    autoIntervalMs: 15 * 60 * 1000,
    listLimit: 100,
    maxVersionsPerDeck: 100,
    maxVersionsPerUser: 2000,
    maxAutoVersionsPerDeck: 80,
    maxCriticalVersionsPerDeck: 30,
    maxNamedVersionsPerDeck: 30,
    maxPublishedVersionsPerDeck: 30,
    maxRestoreVersionsPerDeck: 10,
    retentionDays: {
      auto: 30,
      created: 30,
      named: 0,
      published: 0,
      'restore-point': 0,
    },
    maxSnapshotBytes: 150 * MiB,
    maxBytesPerDeck: 2 * GiB,
    maxBytesPerUser: 25 * GiB,
  },
  enterprise: {
    enabled: true,
    autoEnabled: true,
    createdEnabled: false,
    namedEnabled: true,
    publishedEnabled: true,
    restorePointEnabled: true,
    autoIntervalMs: 5 * 60 * 1000,
    listLimit: 500,
    maxVersionsPerDeck: 500,
    maxVersionsPerUser: 20000,
    maxAutoVersionsPerDeck: 450,
    maxCriticalVersionsPerDeck: 150,
    maxNamedVersionsPerDeck: 150,
    maxPublishedVersionsPerDeck: 150,
    maxRestoreVersionsPerDeck: 50,
    retentionDays: {
      auto: 365,
      created: 365,
      named: 0,
      published: 0,
      'restore-point': 0,
    },
    maxSnapshotBytes: 500 * MiB,
    maxBytesPerDeck: 20 * GiB,
    maxBytesPerUser: 500 * GiB,
  },
};

const BOOLEAN_FIELDS = [
  'enabled',
  'autoEnabled',
  'createdEnabled',
  'namedEnabled',
  'publishedEnabled',
  'restorePointEnabled',
];
const INTEGER_FIELDS = [
  'autoIntervalMs',
  'listLimit',
  'maxVersionsPerDeck',
  'maxVersionsPerUser',
  'maxAutoVersionsPerDeck',
  'maxCriticalVersionsPerDeck',
  'maxNamedVersionsPerDeck',
  'maxPublishedVersionsPerDeck',
  'maxRestoreVersionsPerDeck',
  'maxSnapshotBytes',
  'maxBytesPerDeck',
  'maxBytesPerUser',
];
export const VERSION_REASONS = ['auto', 'created', 'named', 'published', 'restore-point'];
export const CRITICAL_VERSION_REASONS = new Set(['named', 'published', 'restore-point']);

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
  for (const field of BOOLEAN_FIELDS) {
    policy[field] = typeof override[field] === 'boolean' ? override[field] : base[field];
  }
  for (const field of INTEGER_FIELDS) {
    const value = Number(override[field] ?? policy[field]);
    policy[field] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : base[field];
  }
  policy.retentionDays = { ...base.retentionDays };
  for (const reason of VERSION_REASONS) {
    const value = Number(override.retentionDays?.[reason] ?? policy.retentionDays[reason]);
    policy.retentionDays[reason] = Number.isFinite(value) ? Math.max(0, value) : base.retentionDays[reason];
  }
  return policy;
}

export function versionPlanExists(env, plan) {
  return (
    Object.hasOwn(DEFAULT_VERSION_HISTORY_POLICIES, plan) || Object.hasOwn(configuredPolicies(env), plan)
  );
}

export function versionPolicy(env, user) {
  const configured = configuredPolicies(env);
  const requested = user?.plan || env.VERSION_HISTORY_DEFAULT_PLAN || 'free';
  const plan = versionPlanExists(env, requested) ? requested : 'free';
  const base = DEFAULT_VERSION_HISTORY_POLICIES[plan] || DEFAULT_VERSION_HISTORY_POLICIES.free;
  return { plan, ...normalizedPolicy(base, configured[plan]) };
}

export function reasonEnabled(policy, reason) {
  return (
    {
      auto: policy.autoEnabled,
      created: policy.createdEnabled,
      named: policy.namedEnabled,
      published: policy.publishedEnabled,
      'restore-point': policy.restorePointEnabled,
    }[reason] ?? false
  );
}

export const versionSize = (metadata) => new TextEncoder().encode(metadata).byteLength;
