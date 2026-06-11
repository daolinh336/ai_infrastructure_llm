import type { JsonSchema } from './types.js';

const infrastructureIntentValues = ['create', 'update', 'status', 'destroy', 'drift'];

const nullableStringSchema = {
  anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
};

const nullableIntegerSchema = {
  anyOf: [{ type: 'integer' }, { type: 'null' }],
};

const nullableNumberSchema = {
  anyOf: [{ type: 'number' }, { type: 'null' }],
};

const nullableBooleanSchema = {
  anyOf: [{ type: 'boolean' }, { type: 'null' }],
};

export const intentClassificationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: {
      type: 'string',
      enum: ['infrastructure', 'out-of-scope', 'unsafe'],
    },
    intent: {
      anyOf: [{ type: 'string', enum: infrastructureIntentValues }, { type: 'null' }],
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
  additionalProperties: false,
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
        additionalProperties: false,
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
  additionalProperties: false,
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
