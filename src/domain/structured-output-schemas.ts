import type { JsonSchema } from './types.js';

const infrastructureIntentValues = ['create', 'update', 'status', 'destroy', 'drift'];

const nullableStringSchema = {
  type: 'string',
  nullable: true,
};

const nullableIntegerSchema = {
  type: 'integer',
  nullable: true,
};

const nullableNumberSchema = {
  type: 'number',
  nullable: true,
};

const nullableBooleanSchema = {
  type: 'boolean',
  nullable: true,
};

export const intentClassificationJsonSchema = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['infrastructure', 'out-of-scope', 'unsafe'],
    },
    intent: {
      type: 'string',
      enum: infrastructureIntentValues,
      nullable: true,
    },
    reason: {
      type: 'string',
      minLength: 1,
    },
  },
  required: ['scope', 'intent', 'reason'],
} satisfies JsonSchema;

export const draftQueryJsonSchema = {
  type: 'object',
  properties: {
    raw: {
      type: 'string',
      minLength: 1,
    },
    normalizedPrompt: {
      type: 'string',
      minLength: 1,
    },
    intent: {
      type: 'string',
      enum: infrastructureIntentValues,
    },
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: nullableStringSchema,
          image: nullableStringSchema,
          port: nullableIntegerSchema,
          replicas: nullableIntegerSchema,
          requestedMounts: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
          privileged: nullableBooleanSchema,
          networkMode: nullableStringSchema,
          pidMode: nullableStringSchema,
          ipcMode: nullableStringSchema,
          cpu: nullableNumberSchema,
          memoryGb: nullableNumberSchema,
        },
        required: [
          'name',
          'image',
          'port',
          'replicas',
          'requestedMounts',
          'privileged',
          'networkMode',
          'pidMode',
          'ipcMode',
          'cpu',
          'memoryGb',
        ],
      },
    },
    destructive: {
      type: 'boolean',
    },
    missingInformation: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  required: [
    'raw',
    'normalizedPrompt',
    'intent',
    'services',
    'destructive',
    'missingInformation',
  ],
} satisfies JsonSchema;

export const reactReasoningOutputJsonSchema = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
    },
    nextAction: {
      type: 'string',
      enum: ['continue_planning', 'ask_user', 'stop'],
    },
    rationale: {
      type: 'string',
      minLength: 1,
    },
    safetyNotes: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['summary', 'nextAction', 'rationale', 'safetyNotes'],
} satisfies JsonSchema;

export const semanticInfrastructureIntentJsonSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1 },
    projectHint: nullableStringSchema,
    services: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          role: { type: 'string', enum: ['reverse-proxy', 'backend', 'database'] },
          technology: nullableStringSchema,
          imageHint: nullableStringSchema,
          replicas: nullableIntegerSchema,
          ports: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                host: nullableIntegerSchema,
                container: nullableIntegerSchema,
              },
              required: ['host', 'container'],
            },
          },
          envHints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', minLength: 1 },
                value: { type: 'string', minLength: 1 },
              },
              required: ['key', 'value'],
            },
          },
          volumeHints: { type: 'array', items: { type: 'string', minLength: 1 } },
          dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['id', 'role', 'technology', 'imageHint', 'replicas', 'ports', 'envHints', 'volumeHints', 'dependsOn', 'confidence', 'ambiguities'],
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['depends-on', 'routes-to', 'connects-to'] },
        },
        required: ['from', 'to', 'type'],
      },
    },
    constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresUserInput: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['goal', 'projectHint', 'services', 'relationships', 'constraints', 'assumptions', 'ambiguities', 'requiresUserInput', 'confidence'],
} satisfies JsonSchema;

const serviceSelectorJsonSchema = {
  type: 'object',
  properties: {
    targetKind: { type: 'string', enum: ['service', 'replica-group'] },
    name: { type: 'string', minLength: 1 },
    nameLike: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['reverse-proxy', 'backend', 'database'] },
    imageFamily: { type: 'string', minLength: 1 },
    exposesHostPort: { type: 'boolean' },
    dependsOn: { type: 'string', minLength: 1 },
    dependentOf: { type: 'string', minLength: 1 },
  },
} satisfies JsonSchema;

const patchBaseProperties = {
  target: serviceSelectorJsonSchema,
  reason: { type: 'string', minLength: 1 },
};

const patchRelevanceJsonSchemaProperties = {
  resolvesIssueCodes: { type: 'array', items: { type: 'string', minLength: 1 } },
  affectedServiceNames: { type: 'array', items: { type: 'string', minLength: 1 } },
  resolutionReason: { type: 'string', minLength: 1 },
};

const patchRelevanceProperties = {
  reason: { type: 'string', minLength: 1 },
  ...patchRelevanceJsonSchemaProperties,
};

const patchBaseRequired = ['op', 'target', 'reason'];
const patchRelevanceRequired = ['reason'];
const verifierPatchBaseRequired = ['op', 'target', 'reason', 'resolvesIssueCodes', 'affectedServiceNames', 'resolutionReason'];
const verifierPatchRelevanceRequired = ['reason', 'resolvesIssueCodes', 'affectedServiceNames', 'resolutionReason'];

const environmentEntryJsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', minLength: 1 },
    value: { type: 'string', minLength: 1 },
  },
  required: ['key', 'value'],
} satisfies JsonSchema;

const environmentEntriesJsonSchema = {
  type: 'array',
  items: environmentEntryJsonSchema,
} satisfies JsonSchema;

export const feedbackIntentJsonSchema = {
  type: 'object',
  properties: {
    source: { type: 'string', enum: ['user-other-feedback'] },
    rawText: { type: 'string', minLength: 1 },
    intent: {
      type: 'string',
      enum: [
        'change-port',
        'change-name',
        'change-replicas',
        'change-image',
        'change-env',
        'remove-env',
        'change-volume',
        'remove-volume',
        'change-dependency',
        'remove-dependency',
        'change-network',
        'rename-network',
        'set-networks',
        'add-service',
        'remove-service',
        'rename-service',
        'change-status',
        'change-project',
        'remove-exposure',
        'yaml-edit-intent',
        'retry-as-is',
        'cancel',
        'unknown',
      ],
    },
    target: {
      type: 'object',
      properties: {
        resourceKind: {
          type: 'string',
          enum: ['project', 'service', 'container', 'port', 'image', 'volume', 'network', 'environment'],
        },
        serviceSelector: serviceSelectorJsonSchema,
        currentValue: { type: 'string', minLength: 1 },
      },
    },
    desiredChange: {
      type: 'object',
      properties: {
        hostPort: { type: 'integer', minimum: 1, maximum: 65535 },
        containerPort: { type: 'integer', minimum: 1, maximum: 65535 },
        name: { type: 'string', minLength: 1 },
        replicas: { type: 'integer', minimum: 1, maximum: 50 },
        image: { type: 'string', minLength: 1 },
        environment: environmentEntriesJsonSchema,
        volumes: { type: 'array', items: { type: 'string', minLength: 1 } },
        networks: { type: 'array', items: { type: 'string', minLength: 1 } },
        dependencies: { type: 'array', items: { type: 'string', minLength: 1 } },
        desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
        service: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['reverse-proxy', 'backend', 'database'] },
            name: { type: 'string', minLength: 1 },
            image: { type: 'string', minLength: 1 },
            desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
            replicas: { type: 'integer', minimum: 1, maximum: 50 },
            ports: { type: 'array', items: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' } },
            environment: environmentEntriesJsonSchema,
            dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } },
            volumes: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
          required: ['kind', 'name', 'image'],
        },
        yamlFragment: { type: 'string', minLength: 1 },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresUserInput: { type: 'boolean' },
  },
  required: ['source', 'rawText', 'intent', 'confidence', 'ambiguities', 'requiresUserInput'],
} satisfies JsonSchema;

const infrastructureServiceJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['reverse-proxy', 'backend', 'database'] },
    name: { type: 'string', minLength: 1 },
    image: { type: 'string', minLength: 1 },
    desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
    replicas: { type: 'integer', minimum: 1, maximum: 50 },
    ports: { type: 'array', items: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' } },
    environment: environmentEntriesJsonSchema,
    dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } },
    volumes: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: ['kind', 'name', 'image'],
} satisfies JsonSchema;

export const specPatchPlanJsonSchema = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-replicas'] },
              ...patchBaseProperties,
              replicas: { type: 'integer', minimum: 1, maximum: 50 },
            },
            required: [...patchBaseRequired, 'replicas'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace-service-port'] },
              ...patchBaseProperties,
              from: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
              to: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: [...patchBaseRequired, 'to'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-port'] },
              ...patchBaseProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: [...patchBaseRequired, 'port'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-port'] },
              ...patchBaseProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: patchBaseRequired,
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-image'] },
              ...patchBaseProperties,
              image: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'image'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service'] },
              service: infrastructureServiceJsonSchema,
              ...patchRelevanceProperties,
            },
            required: ['op', 'service', ...patchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service'] },
              ...patchBaseProperties,
            },
            required: patchBaseRequired,
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-service'] },
              ...patchBaseProperties,
              name: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'name'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-env'] },
              ...patchBaseProperties,
              key: { type: 'string', minLength: 1 },
              value: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'key', 'value'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-env'] },
              ...patchBaseProperties,
              key: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'key'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-volume', 'remove-service-volume'] },
              ...patchBaseProperties,
              volume: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'volume'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-dependency', 'remove-service-dependency'] },
              ...patchBaseProperties,
              dependencyName: { type: 'string', minLength: 1 },
            },
            required: [...patchBaseRequired, 'dependencyName'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-desired-status'] },
              ...patchBaseProperties,
              desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
            },
            required: [...patchBaseRequired, 'desiredStatus'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-project-name'] },
              name: { type: 'string', minLength: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'name', ...patchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-network'] },
              from: { type: 'string', minLength: 1 },
              to: { type: 'string', minLength: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'to', ...patchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-networks'] },
              networks: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'networks', ...patchRelevanceRequired],
          },
        ],
      },
    },
    issueAnalysis: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueCode: { type: 'string', minLength: 1 },
          affectedResource: { type: 'string', minLength: 1 },
          affectedServiceName: { type: 'string', minLength: 1 },
          intendedFix: { type: 'string', minLength: 1 },
          userActionNeeded: { type: 'string', minLength: 1 },
        },
        required: ['issueCode', 'affectedResource', 'intendedFix'],
      },
    },
    explanation: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresUserInput: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['patches', 'explanation', 'assumptions', 'ambiguities', 'requiresUserInput', 'confidence'],
} satisfies JsonSchema;

export const verifierRemediationPatchPlanJsonSchema = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-replicas'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              replicas: { type: 'integer', minimum: 1, maximum: 50 },
            },
            required: [...verifierPatchBaseRequired, 'replicas'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace-service-port'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              from: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
              to: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: [...verifierPatchBaseRequired, 'to'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-port'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: [...verifierPatchBaseRequired, 'port'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-port'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: verifierPatchBaseRequired,
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-image'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              image: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'image'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service'] },
              service: infrastructureServiceJsonSchema,
              ...patchRelevanceProperties,
            },
            required: ['op', 'service', ...verifierPatchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
            },
            required: verifierPatchBaseRequired,
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-service'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              name: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'name'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-env'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              key: { type: 'string', minLength: 1 },
              value: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'key', 'value'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-env'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              key: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'key'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-volume', 'remove-service-volume'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              volume: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'volume'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-dependency', 'remove-service-dependency'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              dependencyName: { type: 'string', minLength: 1 },
            },
            required: [...verifierPatchBaseRequired, 'dependencyName'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-desired-status'] },
              ...patchBaseProperties,
              ...patchRelevanceJsonSchemaProperties,
              desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
            },
            required: [...verifierPatchBaseRequired, 'desiredStatus'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-project-name'] },
              name: { type: 'string', minLength: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'name', ...verifierPatchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-network'] },
              from: { type: 'string', minLength: 1 },
              to: { type: 'string', minLength: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'to', ...verifierPatchRelevanceRequired],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-networks'] },
              networks: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
              ...patchRelevanceProperties,
            },
            required: ['op', 'networks', ...verifierPatchRelevanceRequired],
          },
        ],
      },
    },
    issueAnalysis: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issueCode: { type: 'string', minLength: 1 },
          affectedResource: { type: 'string', minLength: 1 },
          affectedServiceName: { type: 'string', minLength: 1 },
          intendedFix: { type: 'string', minLength: 1 },
          userActionNeeded: { type: 'string', minLength: 1 },
        },
        required: ['issueCode', 'affectedResource', 'intendedFix'],
      },
    },
    explanation: { type: 'string', minLength: 1 },
    assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    ambiguities: { type: 'array', items: { type: 'string', minLength: 1 } },
    requiresUserInput: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['issueAnalysis', 'patches', 'explanation', 'assumptions', 'ambiguities', 'requiresUserInput', 'confidence'],
} satisfies JsonSchema;
