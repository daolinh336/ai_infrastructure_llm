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

const serviceSelectorJsonSchema = {
  type: 'object',
  properties: {
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
        'change-volume',
        'change-network',
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
        environment: { type: 'object', additionalProperties: { type: 'string' } },
        volumes: { type: 'array', items: { type: 'string', minLength: 1 } },
        networks: { type: 'array', items: { type: 'string', minLength: 1 } },
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
    environment: { type: 'object', additionalProperties: { type: 'string' } },
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
            required: ['op', 'target', 'replicas', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace-service-port'] },
              ...patchBaseProperties,
              from: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
              to: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: ['op', 'target', 'to', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-port'] },
              ...patchBaseProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: ['op', 'target', 'port', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-port'] },
              ...patchBaseProperties,
              port: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' },
            },
            required: ['op', 'target', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-image'] },
              ...patchBaseProperties,
              image: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'image', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service'] },
              service: infrastructureServiceJsonSchema,
              reason: { type: 'string', minLength: 1 },
            },
            required: ['op', 'service', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service'] },
              ...patchBaseProperties,
            },
            required: ['op', 'target', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-service'] },
              ...patchBaseProperties,
              name: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'name', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-env'] },
              ...patchBaseProperties,
              key: { type: 'string', minLength: 1 },
              value: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'key', 'value', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['remove-service-env'] },
              ...patchBaseProperties,
              key: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'key', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-volume', 'remove-service-volume'] },
              ...patchBaseProperties,
              volume: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'volume', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add-service-dependency', 'remove-service-dependency'] },
              ...patchBaseProperties,
              dependencyName: { type: 'string', minLength: 1 },
            },
            required: ['op', 'target', 'dependencyName', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-service-desired-status'] },
              ...patchBaseProperties,
              desiredStatus: { type: 'string', enum: ['running', 'stopped'] },
            },
            required: ['op', 'target', 'desiredStatus', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-project-name'] },
              name: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1 },
            },
            required: ['op', 'name', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['rename-network'] },
              from: { type: 'string', minLength: 1 },
              to: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1 },
            },
            required: ['op', 'to', 'reason'],
          },
          {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set-networks'] },
              networks: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
              reason: { type: 'string', minLength: 1 },
            },
            required: ['op', 'networks', 'reason'],
          },
        ],
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
