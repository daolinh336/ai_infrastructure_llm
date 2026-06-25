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
